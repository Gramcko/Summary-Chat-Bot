import {
  SUMMARY_JOB,
  SUMMARY_QUEUE,
  SUMMARY_FINISHED_JOBS_KEPT,
  SUMMARY_JOB_ATTEMPTS,
  SummaryRunJob,
  type RunError,
} from "@summarly/contracts";
import {
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type Job,
} from "bullmq";
import {
  isPermanentFailure,
  retriesExhaustedError,
  toRunError,
} from "./errors.js";
import type { Logger } from "./lib/log.js";
import {
  processSummaryRun,
  type PipelineDeps,
  type PipelineOutcome,
} from "./pipeline.js";

/**
 * The BullMQ worker around the summary pipeline (architecture A4.4/A4.6).
 *
 * Queue: {@link SUMMARY_QUEUE} ("summaries"). Job: {@link SUMMARY_JOB}
 * ("generate-summary") with a {@link SummaryRunJob} payload (identifiers
 * only). The worker never receives message content through Redis: it
 * loads everything from PostgreSQL via the run id.
 *
 * Retry semantics (A4.4 point 8, A6):
 *
 * - Permanent failures (unknown run, invalid run state/data, provider
 *   configuration problems) are marked `failed` by the pipeline and
 *   rethrown as BullMQ `UnrecoverableError` — the job is NOT retried.
 * - Retryable failures (timeouts, rate limits, malformed provider
 *   output) are retried with finite exponential backoff. The retry
 *   policy itself lives in {@link summaryJobOptions}: BullMQ stores
 *   `attempts`/`backoff` on the JOB at enqueue time (producer side), so
 *   round-2 enqueue code must add jobs with these options.
 * - When attempts are exhausted, the worker's `failed` handler is the
 *   safety net that records the terminal failure on the run.
 *
 * Retention (A4.6): the worker bounds how many finished jobs BullMQ
 * keeps in Redis ({@link KEEP_FINISHED_JOBS}); completed business
 * history lives in PostgreSQL, never in Redis.
 */

/**
 * The queue retry/retention policy lives in `@summarly/contracts`
 * (queue.ts) — one shared definition for every producer (backend
 * routes, reconciliation) and this worker. BullMQ stores attempts and
 * backoff on the job at enqueue time, so producers must add jobs with
 * {@link summaryJobOptions}. Aliases below keep this module's historical
 * export names for callers and tests.
 */
export { summaryJobOptions } from "@summarly/contracts";

/** @see SUMMARY_JOB_ATTEMPTS (contracts) */
export const SUMMARY_ATTEMPTS = SUMMARY_JOB_ATTEMPTS;

/** @see SUMMARY_FINISHED_JOBS_KEPT (contracts) */
export const KEEP_FINISHED_JOBS = SUMMARY_FINISHED_JOBS_KEPT;

export const DEFAULT_CONCURRENCY = 2;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

/**
 * Parses `SUMMARY_CONCURRENCY`. Unset/empty → default; anything that is
 * not an integer inside [MIN_CONCURRENCY, MAX_CONCURRENCY] fails fast —
 * bounded concurrency is an architecture requirement (A4.4), so a
 * misconfiguration must never silently run unbounded.
 */
export function parseConcurrency(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_CONCURRENCY;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_CONCURRENCY ||
    parsed > MAX_CONCURRENCY
  ) {
    throw new Error(
      `SUMMARY_CONCURRENCY must be an integer between ${MIN_CONCURRENCY} and ` +
        `${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY}), got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Builds the `generate-summary` processor. Payload and job-name
 * problems are permanent (an invalid job can never become valid): they
 * throw BullMQ's `UnrecoverableError` without touching the database,
 * because there is no trustworthy run id to update.
 */
export function createSummaryProcessor(
  deps: PipelineDeps,
): (job: Job<SummaryRunJob, PipelineOutcome, string>) => Promise<PipelineOutcome> {
  return async (job) => {
    if (job.name !== SUMMARY_JOB) {
      // Safe metadata only (job name, queue name) — never payload data.
      throw new UnrecoverableError(
        `unsupported job name on queue "${SUMMARY_QUEUE}" (expected "${SUMMARY_JOB}")`,
      );
    }
    const payload = SummaryRunJob.safeParse(job.data);
    if (!payload.success) {
      throw new UnrecoverableError(
        `invalid "${SUMMARY_JOB}" payload (expected exactly { summaryRunId: uuid })`,
      );
    }

    const summaryRunId = payload.data.summaryRunId;
    const attempt = job.attemptsMade + 1;
    deps.log?.("info", "job_started", {
      jobId: job.id ?? null,
      summaryRunId,
      attempt,
    });
    try {
      const outcome = await processSummaryRun(deps, summaryRunId);
      deps.log?.("info", "job_finished", {
        jobId: job.id ?? null,
        summaryRunId,
        attempt,
        outcome,
      });
      return outcome;
    } catch (error) {
      // Only the safe error code is logged (never provider output or
      // message content; toRunError already sanitizes).
      const metadata = toRunError(error);
      deps.log?.("warn", "job_attempt_failed", {
        jobId: job.id ?? null,
        summaryRunId,
        attempt,
        code: metadata.code,
      });
      throw error;
    }
  };
}

export interface FailureHandlerDeps {
  db: PipelineDeps["db"];
  log?: Logger;
}

/**
 * Safety net for BullMQ's `failed` event (architecture A6): when finite
 * retries are exhausted, the run must end `failed` with safe error
 * metadata instead of being left in `processing` forever. Round-2
 * reconciliation covers any run that still escapes (e.g. a crash
 * between queue and database).
 *
 * Rules:
 *
 * - Jobs with a foreign name or an invalid payload are ignored (no
 *   trustworthy run identity to update).
 * - Non-final failures do nothing: BullMQ will retry, and the run stays
 *   `processing` so a later attempt can still succeed.
 * - Final failures (attempts exhausted) and permanent failures record
 *   the terminal error. `markRunFailed` only transitions
 *   pending|processing runs, so it can never overwrite a `completed`
 *   run nor clobber the more precise metadata the pipeline already
 *   recorded for permanent failures (that write is a no-op then).
 */
export function createFailureHandler(
  deps: FailureHandlerDeps,
): (
  job: Job<SummaryRunJob, PipelineOutcome, string> | undefined,
  error: Error,
) => Promise<void> {
  return async (job, error) => {
    try {
      if (job === undefined) return;
      if (job.name !== SUMMARY_JOB) return;
      const payload = SummaryRunJob.safeParse(job.data);
      if (!payload.success) return;

      const summaryRunId = payload.data.summaryRunId;
      const permanent = isPermanentFailure(error);
      const totalAttempts = Math.max(1, job.opts.attempts ?? 1);
      if (!permanent && job.attemptsMade < totalAttempts) {
        return; // More retries left; do not touch the run.
      }

      const metadata: RunError = permanent
        ? toRunError(error)
        : retriesExhaustedError(error);
      const updated = await deps.db.markRunFailed(summaryRunId, metadata);
      deps.log?.("warn", permanent ? "run_permanent_failure_safety_net" : "run_retries_exhausted", {
        jobId: job.id ?? null,
        summaryRunId,
        code: metadata.code,
        runUpdated: updated,
      });
    } catch (failure) {
      // Never let the safety net crash the worker process; round-2
      // reconciliation covers runs stuck in `processing`.
      deps.log?.("error", "run_fail_write_failed", {
        summaryRunId: null,
        reason: failure instanceof Error ? failure.name : "unknown",
      });
    }
  };
}

export interface SummaryWorkerOptions extends PipelineDeps {
  /** BullMQ connection (ioredis instance or connection options). */
  connection: ConnectionOptions;
  /** Bounded parallelism (architecture A4.4); defaults to 2. */
  concurrency?: number;
  /**
   * BullMQ key-prefix namespace (audit M1): deployments use
   * `summarly` (the contracts default), test suites `summarly-test`,
   * the e2e `summarly-e2e` — so a test worker can never steal jobs
   * from a running dev instance (docs/decisions/0003).
   */
  prefix?: string;
}

/**
 * Builds the BullMQ Worker for the `summaries` queue. The caller owns
 * the connection lifecycle (index.ts closes worker, pool, then redis).
 */
export function createSummaryWorker(
  options: SummaryWorkerOptions,
): Worker<SummaryRunJob, PipelineOutcome, string> {
  const {
    connection,
    concurrency = DEFAULT_CONCURRENCY,
    prefix,
    ...pipelineDeps
  } = options;
  const effectiveConcurrency = parseConcurrency(String(concurrency));

  const worker = new Worker<SummaryRunJob, PipelineOutcome, string>(
    SUMMARY_QUEUE,
    createSummaryProcessor(pipelineDeps),
    {
      connection,
      concurrency: effectiveConcurrency,
      prefix,
      // Bounded retention (A4.6) even if a producer forgets job opts.
      removeOnComplete: { count: KEEP_FINISHED_JOBS },
      removeOnFail: { count: KEEP_FINISHED_JOBS },
    },
  );

  const onFailed = createFailureHandler({
    db: pipelineDeps.db,
    log: pipelineDeps.log,
  });
  worker.on("failed", (job, error) => {
    void onFailed(job, error);
  });
  worker.on("error", (error) => {
    // Connection/infrastructure errors; message text is BullMQ's own,
    // never conversation content or secrets.
    pipelineDeps.log?.("error", "worker_error", {
      reason: error.message.slice(0, 200),
    });
  });

  return worker;
}
