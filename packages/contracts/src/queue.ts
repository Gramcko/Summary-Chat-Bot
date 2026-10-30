import { z } from "zod";
import { Id } from "./common.js";

/**
 * BullMQ queue carrying summary-generation work (architecture §4.6).
 * Redis holds queue state only — PostgreSQL remains the source of truth
 * for messages, runs, and completed summaries.
 */
export const SUMMARY_QUEUE = "summaries";

/** The only job name processed on {@link SUMMARY_QUEUE}. */
export const SUMMARY_JOB = "generate-summary";

/**
 * Payload for a `generate-summary` job.
 *
 * Queue payloads carry ONLY identifiers — never message content, API
 * keys, or WhatsApp session secrets (AGENTS.md). The worker loads the
 * conversation, run, and provider configuration from PostgreSQL using
 * this id. Validation is strict about what it keeps: any extra key is
 * stripped, so accidental content in a payload can never become part of
 * the job contract.
 */
export const SummaryRunJob = z.object({
  summaryRunId: Id,
});

export type SummaryRunJob = z.infer<typeof SummaryRunJob>;

// ---- Retry and retention policy (shared producer/worker contract) ----

/**
 * Total attempts per `generate-summary` job (one initial try plus four
 * retries). Finite: permanent failures never retry, and exhausted
 * retries end the run `failed` with safe metadata (architecture A6).
 */
export const SUMMARY_JOB_ATTEMPTS = 5;

/**
 * Default base delay of the exponential retry backoff: attempt N waits
 * about `SUMMARY_RETRY_BASE_MS * 2^(N-1)` ms before retrying. Producers
 * override it via {@link summaryJobOptions} (tests use small values);
 * `SUMMARY_RETRY_BASE_MS` is the documented env knob in each service.
 */
export const SUMMARY_RETRY_BASE_MS = 30000;

/**
 * Finished BullMQ jobs retained per state (completed/failed). Bounded
 * so Redis queue state cannot grow without limit (architecture A4.6) —
 * completed business history lives in PostgreSQL, never in Redis.
 */
export const SUMMARY_FINISHED_JOBS_KEPT = 1000;

/** Structural backoff shape accepted by BullMQ (`BackoffOptions`). */
export interface SummaryJobBackoff {
  type: "exponential";
  delay: number;
}

/**
 * Structural (bullmq-free) shape of the job options every
 * `generate-summary` job is added with. It is deliberately expressed as
 * plain data so `@summarly/contracts` stays free of infrastructure
 * dependencies while remaining assignable to BullMQ's `JobsOptions`.
 */
export interface SummaryJobOptions {
  attempts: number;
  backoff: SummaryJobBackoff;
  /** Keep only the most recent finished jobs (max count per state). */
  removeOnComplete: number;
  removeOnFail: number;
}

/**
 * The one agreed job policy for `generate-summary`: finite attempts,
 * exponential backoff from `retryBaseMs`, and bounded finished-job
 * retention.
 *
 * IMPORTANT (queue semantics): BullMQ stores `attempts`/`backoff` on
 * the job at ENQUEUE time — there are no worker-level retry defaults.
 * Every producer (backend routes, the reconciliation pass, tests) MUST
 * add jobs with these options, otherwise a job fails after a single
 * attempt (see docs/decisions/0003-queue-strategy.md).
 */
export function summaryJobOptions(
  retryBaseMs: number = SUMMARY_RETRY_BASE_MS,
): SummaryJobOptions {
  if (!Number.isInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new Error(
      `summaryJobOptions retryBaseMs must be a positive integer (milliseconds), got ${retryBaseMs}.`,
    );
  }
  return {
    attempts: SUMMARY_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: retryBaseMs },
    removeOnComplete: SUMMARY_FINISHED_JOBS_KEPT,
    removeOnFail: SUMMARY_FINISHED_JOBS_KEPT,
  };
}

/**
 * Parses `SUMMARY_RETRY_BASE_MS`, the base delay of the exponential
 * job-retry backoff. This knob is PRODUCER-side (BullMQ stores the
 * retry policy on the job at enqueue time): the backend passes the
 * parsed value to its queue producer; the summary-worker does not use
 * it. Unset/empty → default (30s); must be a positive integer.
 */
export function parseRetryBaseMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return SUMMARY_RETRY_BASE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `SUMMARY_RETRY_BASE_MS must be a positive integer (milliseconds), got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Default BullMQ key prefix for the summary queue. A prefix namespaces
 * ALL of a queue's Redis keys (bullmq `KeyPrefixOptions`), so distinct
 * environments can share one Redis without stealing each other's jobs:
 * deployments use `summarly`, test suites `summarly-test`, and the e2e
 * `summarly-e2e` (docs/decisions/0003).
 */
export const SUMMARY_QUEUE_PREFIX_DEFAULT = "summarly";

const QUEUE_PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Parses `SUMMARY_QUEUE_PREFIX`. Unset/empty → `summarly`. The value
 * becomes part of every Redis key for the queue, so it is restricted
 * to a safe charset and fails fast on anything else.
 */
export function parseQueuePrefix(raw: string | undefined): string {
  const value = raw?.trim();
  if (value === undefined || value === "") return SUMMARY_QUEUE_PREFIX_DEFAULT;
  if (!QUEUE_PREFIX_PATTERN.test(value)) {
    throw new Error(
      `SUMMARY_QUEUE_PREFIX must be 1-64 characters of [A-Za-z0-9._-], got "${raw}".`,
    );
  }
  return value;
}
