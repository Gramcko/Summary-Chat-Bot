import { randomUUID } from "node:crypto";
import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SUMMARY_QUEUE,
  SummaryResult,
  type SummaryRunJob,
} from "@summarly/contracts";
import {
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
  MockAiProvider,
} from "../src/ai/mock-provider.js";
import { PostgresWorkerDb, type WorkerDb } from "../src/db.js";
import { silentLogger } from "../src/lib/log.js";
import type { PipelineOutcome } from "../src/pipeline.js";
import {
  createSummaryWorker,
  summaryJobOptions,
} from "../src/worker.js";
import { assertTestDatabaseName } from "../scripts/test-db-guard.js";
import {
  ControlledProvider,
  enqueueSummaryJob,
  pingRedis,
  readRunRow,
  readSummaryRows,
  seedRun,
  waitForJobFinished,
  waitForRunStatus,
} from "./integration-helpers.js";

/**
 * summary-worker end-to-end integration tests against REAL
 * PostgreSQL + Redis (docker-compose.dev.yml).
 *
 * SAFETY (DEF-2): every test TRUNCATEs all application tables. NEVER
 * point DATABASE_URL at a database with real data — destructive setup
 * refuses to run unless the database name ends in `_test` or contains
 * `_e2e_` (or SUMMARLY_TEST_DB_CONFIRM=yes is set explicitly).
 *
 * Recommended entry point (fails fast instead of skipping):
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   createdb summarly_test
 *   npm run migrate -w @summarly/backend up
 *   DATABASE_URL=.../summarly_test REDIS_URL=... \
 *     npm run test:integration -w @summarly/summary-worker
 *
 * Without DATABASE_URL/REDIS_URL (or when Redis is unreachable) the
 * suite is SKIPPED and a loud warning is printed — never silently.
 */

const databaseUrl = process.env["DATABASE_URL"]?.trim();
const redisUrl = process.env["REDIS_URL"]?.trim();
const hasConfig =
  databaseUrl !== undefined &&
  databaseUrl !== "" &&
  redisUrl !== undefined &&
  redisUrl !== "";

if (!hasConfig) {
  process.stderr.write(
    "[summarly] WARNING: summary-worker integration tests were SKIPPED " +
      "(DATABASE_URL and/or REDIS_URL is not set). Run them with " +
      "`npm run test:integration -w @summarly/summary-worker` " +
      "(requires PostgreSQL + Redis — see docker-compose.dev.yml).\n",
  );
}

// Redis availability check (top-level await: collection-time, so the
// gate decision is made before any test is scheduled).
const redisReachable = hasConfig ? await pingRedis(redisUrl) : false;
if (hasConfig && !redisReachable) {
  process.stderr.write(
    "[summarly] WARNING: summary-worker integration tests were SKIPPED " +
      "(Redis is not reachable at REDIS_URL). Start the dev infrastructure " +
      "with `docker compose -f docker-compose.dev.yml up -d`.\n",
  );
}

const shouldRun = hasConfig && redisReachable;

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

const TEST_JOB_OPTIONS = summaryJobOptions(25); // tiny backoff for tests

/**
 * Dedicated BullMQ key-prefix namespace for this suite (audit M1): a
 * test worker must never steal jobs from a running dev instance
 * (`summarly`) — see docs/decisions/0003.
 */
const TEST_QUEUE_PREFIX = "summarly-test";

describe.skipIf(!shouldRun)(
  "summary-worker end-to-end (PostgreSQL + Redis integration)",
  () => {
    let pool: Pool;
    let redis: Redis;
    let db: WorkerDb;

    beforeAll(async () => {
      if (databaseUrl === undefined || redisUrl === undefined) {
        throw new Error("DATABASE_URL/REDIS_URL missing"); // unreachable: gated above
      }
      pool = new Pool({ connectionString: databaseUrl });
      // DEF-2: refuse before ANY destructive statement when the target is
      // not unmistakably a throwaway test database.
      const result = await pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      assertTestDatabaseName(result.rows[0]?.name ?? "");
      redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      db = new PostgresWorkerDb(pool);
    });

    afterAll(async () => {
      await pool?.end();
      redis?.disconnect();
    });

    beforeEach(async () => {
      // Test-database hygiene only; the dev database is disposable.
      await pool.query(
        "TRUNCATE TABLE summaries, summary_runs, messages, groups, " +
          "admin_sessions, admin_credentials, ai_provider_configs, " +
          "whatsapp_connections CASCADE",
      );
    });

    /** Runs `fn` with one live worker + queue pair, then tears them down. */
    async function withWorker<T>(
      provider: MockAiProvider | ControlledProvider,
      fn: (
        queue: Queue<SummaryRunJob, PipelineOutcome, string>,
        jobFor: (
          runId: string,
          options?: Parameters<typeof enqueueSummaryJob>[2],
        ) => Promise<Job<SummaryRunJob, PipelineOutcome, string>>,
      ) => Promise<T>,
    ): Promise<T> {
      const worker = createSummaryWorker({
        connection: redis,
        db,
        provider,
        providerName: MOCK_PROVIDER_NAME,
        modelName: MOCK_MODEL_NAME,
        concurrency: 1,
        prefix: TEST_QUEUE_PREFIX,
        log: silentLogger,
      });
      const queue = new Queue<SummaryRunJob, PipelineOutcome, string>(
        SUMMARY_QUEUE,
        { connection: redis, prefix: TEST_QUEUE_PREFIX },
      );
      try {
        return await fn(queue, (runId, options = TEST_JOB_OPTIONS) =>
          enqueueSummaryJob(queue, runId, options),
        );
      } finally {
        await worker.close();
        await queue.close();
      }
    }

    it(
      "maps senders to display names — the JID never reaches the AI input (M-5)",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Named sender." },
            { sentAt: "2026-10-28T10:00:00Z", text: "No push name." },
          ],
        });

        const messages = await db.fetchMessages(seed.groupId, INTERVAL);
        // Display name when captured; "unknown" when the message had
        // none — never the phone-bearing sender_id.
        expect(messages.map((message) => message.sender)).toEqual([
          "Ana",
          "unknown",
        ]);
        for (const message of messages) {
          expect(message.sender).not.toContain("@");
          expect(message.sender).not.toContain("123456789");
        }
      },
      20_000,
    );

    it(
      "processes an enqueued job end-to-end and stores a validated summary",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Good morning!" },
            { sender: "Bo", sentAt: "2026-10-28T10:00:00Z", text: "We agreed to ship on Friday." },
          ],
        });

        await withWorker(new MockAiProvider(), async (_queue, jobFor) => {
          await jobFor(seed.runId);
          const run = await waitForRunStatus(pool, seed.runId, "completed");

          expect(run.attempts).toBe(1);
          expect(run.error_code).toBeNull();
          expect(run.error_message).toBeNull();

          const summaries = await readSummaryRows(pool, seed.runId);
          expect(summaries).toHaveLength(1);
          const summary = summaries[0];
          if (summary === undefined) throw new Error("no summary row");

          // The persisted result is a valid SummaryResult with the
          // aiGenerated flag the worker adds after validation.
          const result = SummaryResult.parse(summary.result);
          expect(result.aiGenerated).toBe(true);
          expect(summary.provider).toBe(MOCK_PROVIDER_NAME);
          expect(summary.model).toBe(MOCK_MODEL_NAME);
          expect(result.keyDiscussions.join("\n")).toContain("Good morning!");
          expect(result.keyDiscussions.join("\n")).toContain(
            "We agreed to ship on Friday.",
          );
        });
      },
      30000,
    );

    it(
      "honors the half-open [start, end) interval with deterministic ordering",
      async () => {
        // Messages at the boundaries: `start` is INCLUDED, `end` is
        // EXCLUDED (architecture A5.3). Two messages share one sent_at:
        // the stable id tiebreak must decide their order.
        const tieLow = randomUUID();
        const tieHigh = randomUUID();
        const [lo, hi] = [tieLow, tieHigh].sort();
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sentAt: "2026-10-27T23:59:59Z", text: "before the window" },
            { sentAt: INTERVAL.start, text: "at start (included)" },
            { sentAt: "2026-10-28T12:00:00Z", text: "tie A" },
            { sentAt: "2026-10-28T12:00:00Z", text: "tie B" },
            { sentAt: "2026-10-28T23:59:59Z", text: "near the end" },
            { sentAt: INTERVAL.end, text: "at end (excluded)" },
          ],
        });
        // Re-key the two tie messages so ids sort as lo < hi in insertion
        // order independent of generation order.
        await pool.query("UPDATE messages SET id = $1 WHERE body = 'tie A'", [lo]);
        await pool.query("UPDATE messages SET id = $1 WHERE body = 'tie B'", [hi]);

        const messages = await db.fetchMessages(seed.groupId, INTERVAL);
        expect(messages.map((message) => message.text)).toEqual([
          "at start (included)",
          "tie A",
          "tie B",
          "near the end",
        ]);
        // Deterministic tiebreak: sent_at equal → ordered by stable id.
        const tieIds = messages
          .filter((message) => message.text.startsWith("tie"))
          .map((message) => message.id);
        expect(tieIds).toEqual([lo, hi]);
      },
      30000,
    );

    it(
      "is idempotent: re-delivery after completion never duplicates",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Only once." },
          ],
        });

        await withWorker(new MockAiProvider(), async (_queue, jobFor) => {
          await jobFor(seed.runId);
          await waitForRunStatus(pool, seed.runId, "completed");
          const before = await readSummaryRows(pool, seed.runId);
          expect(before).toHaveLength(1);

          // Simulated duplicate delivery (e.g. reconciliation re-enqueue
          // racing a completed job): same run id, second job.
          const redelivered = await jobFor(seed.runId);
          expect(await waitForJobFinished(redelivered)).toBe("completed");

          const after = await readSummaryRows(pool, seed.runId);
          expect(after).toHaveLength(1);
          // Same summary identity — never a second row.
          expect(after[0]?.id).toBe(before[0]?.id);
          expect(after[0]?.created_at.toISOString()).toBe(
            before[0]?.created_at.toISOString(),
          );
          // The run was not even reprocessed (already-completed path).
          const run = await readRunRow(pool, seed.runId);
          expect(run?.attempts).toBe(1);
        });
      },
      30000,
    );

    it(
      "retries a retryable provider failure and then succeeds",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Retry me." },
          ],
        });
        const provider = new ControlledProvider(["retryable"]);

        await withWorker(provider, async (_queue, jobFor) => {
          await jobFor(seed.runId);
          const run = await waitForRunStatus(pool, seed.runId, "completed");

          // First attempt failed retryably, second succeeded.
          expect(provider.calls).toHaveLength(2);
          expect(run.attempts).toBe(2);
          const summaries = await readSummaryRows(pool, seed.runId);
          expect(summaries).toHaveLength(1);
        });
      },
      30000,
    );

    it(
      "fails the run immediately on permanent provider errors, without retries",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Never summarized." },
          ],
        });
        // If the job were retried, the second call would SUCCEED — the
        // assertions below prove it never got that chance.
        const provider = new ControlledProvider(["permanent"]);

        await withWorker(provider, async (_queue, jobFor) => {
          const job = await jobFor(seed.runId);
          const run = await waitForRunStatus(pool, seed.runId, "failed");

          expect(await waitForJobFinished(job)).toBe("failed");
          expect(provider.calls).toHaveLength(1);
          expect(run.attempts).toBe(1);
          expect(run.error_code).toBe("provider_config");
          expect(run.error_message).toBe(
            "The AI provider is not configured correctly.",
          );
          expect(await readSummaryRows(pool, seed.runId)).toHaveLength(0);
        });
      },
      30000,
    );

    it(
      "marks the run failed with safe metadata when retry attempts are exhausted",
      async () => {
        const seed = await seedRun(pool, {
          ...INTERVAL,
          messages: [
            { sender: "Ana", sentAt: "2026-10-28T09:00:00Z", text: "Never summarized." },
          ],
        });
        const provider = new ControlledProvider("always-fail");

        await withWorker(provider, async (_queue, jobFor) => {
          const job = await jobFor(seed.runId, {
            ...TEST_JOB_OPTIONS,
            attempts: 2,
          });
          const run = await waitForRunStatus(pool, seed.runId, "failed");

          expect(await waitForJobFinished(job)).toBe("failed");
          expect(provider.calls).toHaveLength(2);
          expect(run.attempts).toBe(2);
          // Terminal metadata: safe code + honest message (architecture A6).
          expect(run.error_code).toBe("provider_rate_limit");
          expect(run.error_message).toBe(
            "Retry attempts were exhausted without producing a summary.",
          );
          expect(await readSummaryRows(pool, seed.runId)).toHaveLength(0);
        });
      },
      30000,
    );

    it(
      "treats an empty period as valid and summarizes it accordingly",
      async () => {
        const seed = await seedRun(pool, INTERVAL);

        await withWorker(new MockAiProvider(), async (_queue, jobFor) => {
          await jobFor(seed.runId);
          await waitForRunStatus(pool, seed.runId, "completed");

          const summaries = await readSummaryRows(pool, seed.runId);
          expect(summaries).toHaveLength(1);
          const result = SummaryResult.parse(summaries[0]?.result);
          expect(result.overview).toBe("No messages were found in this period.");
          expect(result.keyDiscussions).toEqual([]);
          expect(result.confirmedDecisions).toEqual([]);
          expect(result.proposals).toEqual([]);
          expect(result.unresolvedQuestions).toEqual([]);
          expect(result.tasks).toEqual([]);
          expect(result.links).toEqual([]);
        });
      },
      30000,
    );
  },
);
