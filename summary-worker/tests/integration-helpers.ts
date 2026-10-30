import { randomUUID } from "node:crypto";
import type { Job, JobsOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import type {
  AiProvider,
  AiSummaryInput,
  ProviderSummaryOutput,
  SummaryRunJob,
} from "@summarly/contracts";
import { SUMMARY_JOB } from "@summarly/contracts";
import { MockAiProvider } from "../src/ai/mock-provider.js";
import {
  PermanentRunError,
  RetryableRunError,
} from "../src/errors.js";
import type { PipelineOutcome } from "../src/pipeline.js";

/**
 * Infrastructure helpers for the integration suite (real PostgreSQL +
 * Redis via docker-compose.dev.yml). No file here is collected by
 * vitest: only `*.test.ts` files run.
 */

/** True when Redis answers PING; used to gate the suite loudly. */
export async function pingRedis(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    connectTimeout: 2000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export interface SeedMessage {
  sender?: string;
  sentAt: string;
  text: string;
}

export interface SeedOptions {
  start: string;
  end: string;
  timezone?: string;
  kind?: "manual" | "scheduled";
  messages?: SeedMessage[];
}

export interface SeedResult {
  groupId: string;
  chatId: string;
  runId: string;
  messageIds: string[];
}

/** Seeds one group with a pending run and optional messages. */
export async function seedRun(
  pool: Pool,
  options: SeedOptions,
): Promise<SeedResult> {
  const connectionId = randomUUID();
  const chatId = `${randomUUID()}@g.us`;
  const groupId = randomUUID();
  const timezone = options.timezone ?? "Europe/Madrid";

  await pool.query(
    "INSERT INTO whatsapp_connections (id, state) VALUES ($1, 'connected')",
    [connectionId],
  );
  await pool.query(
    "INSERT INTO groups (id, chat_id, name, timezone) VALUES ($1, $2, $3, $4)",
    [groupId, chatId, "Integration Group", timezone],
  );

  const messageIds: string[] = [];
  for (const [index, message] of (options.messages ?? []).entries()) {
    const id = randomUUID();
    messageIds.push(id);
    await pool.query(
      `INSERT INTO messages
         (id, connection_id, chat_id, whatsapp_message_id, sender_id, sent_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        connectionId,
        chatId,
        `wa-${index}-${id}`,
        message.sender ?? "unknown",
        new Date(message.sentAt),
        message.text,
      ],
    );
  }

  const run = await pool.query<{ id: string }>(
    `INSERT INTO summary_runs (group_id, kind, status, start_at, end_at, timezone)
     VALUES ($1, $2, 'pending', $3, $4, $5)
     RETURNING id`,
    [
      groupId,
      options.kind ?? "manual",
      new Date(options.start),
      new Date(options.end),
      timezone,
    ],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) throw new Error("seedRun returned no run id");
  return { groupId, chatId, runId, messageIds };
}

export interface RunRow {
  id: string;
  status: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
}

export async function readRunRow(
  pool: Pool,
  runId: string,
): Promise<RunRow | undefined> {
  const result = await pool.query<RunRow>(
    "SELECT id, status, attempts, error_code, error_message FROM summary_runs WHERE id = $1",
    [runId],
  );
  return result.rows[0];
}

export interface SummaryRow {
  id: string;
  run_id: string;
  provider: string;
  model: string;
  result: unknown;
  created_at: Date;
}

export async function readSummaryRows(
  pool: Pool,
  runId: string,
): Promise<SummaryRow[]> {
  const result = await pool.query<SummaryRow>(
    "SELECT id, run_id, provider, model, result, created_at FROM summaries WHERE run_id = $1",
    [runId],
  );
  return result.rows;
}

/** Polls until `fn` returns a defined value; fails loudly on timeout. */
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 20000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${description}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForRunStatus(
  pool: Pool,
  runId: string,
  status: RunRow["status"],
  timeoutMs = 20000,
): Promise<RunRow> {
  return waitFor(
    `run ${runId} to reach "${status}"`,
    async () => {
      const row = await readRunRow(pool, runId);
      return row?.status === status ? row : undefined;
    },
    timeoutMs,
  );
}

export type JobOutcome = "completed" | "failed";

export async function waitForJobFinished(
  job: Job<SummaryRunJob, PipelineOutcome, string>,
  timeoutMs = 20000,
): Promise<JobOutcome> {
  return waitFor(
    `job ${job.id ?? "?"} to finish`,
    async () => {
      const state = await job.getState();
      return state === "completed" || state === "failed" ? state : undefined;
    },
    timeoutMs,
  );
}

export type FailureMode = "retryable" | "permanent";

/**
 * AiProvider whose failures are scripted per call: each entry in
 * `script` replaces one call's result with a thrown error; calls beyond
 * the script succeed through the inner provider (MockAiProvider by
 * default). `"always-fail"` throws a retryable error forever.
 */
export class ControlledProvider implements AiProvider {
  readonly calls: AiSummaryInput[] = [];

  constructor(
    private readonly script: FailureMode[] | "always-fail",
    private readonly inner: AiProvider = new MockAiProvider(),
  ) {}

  async generate(input: AiSummaryInput): Promise<ProviderSummaryOutput> {
    this.calls.push(input);
    const mode = Array.isArray(this.script)
      ? this.script.shift()
      : "retryable";
    if (mode === "retryable") {
      throw new RetryableRunError(
        "provider_rate_limit",
        "The AI provider rate limit was exceeded.",
      );
    }
    if (mode === "permanent") {
      throw new PermanentRunError(
        "provider_config",
        "The AI provider is not configured correctly.",
      );
    }
    return this.inner.generate(input);
  }
}

/** Enqueues one generate-summary job with the agreed retry policy. */
export async function enqueueSummaryJob(
  queue: Queue<SummaryRunJob, PipelineOutcome, string>,
  summaryRunId: string,
  options: JobsOptions,
): Promise<Job<SummaryRunJob, PipelineOutcome, string>> {
  return queue.add(SUMMARY_JOB, { summaryRunId }, options);
}
