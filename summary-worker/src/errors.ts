import { RunError } from "@summarly/contracts";

/**
 * Error taxonomy for summary processing (architecture §4.4 point 8).
 *
 * - Permanent failures (unknown run, invalid run state/data, provider
 *   configuration problems) can never succeed on retry: the run is
 *   marked failed immediately and the job must NOT be retried.
 * - Retryable failures (timeouts, rate limits, malformed provider
 *   output) may succeed later: the job is retried with finite backoff
 *   and the run ends `failed` only when attempts are exhausted.
 *
 * Unknown errors are classified as retryable by default; adapters must
 * explicitly report configuration problems as PermanentRunError.
 */

export class PermanentRunError extends Error {
  /** Short machine-readable category (e.g. "provider_config"). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentRunError";
    this.code = code;
  }
}

export class RetryableRunError extends Error {
  /** Short machine-readable category (e.g. "provider_rate_limit"). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetryableRunError";
    this.code = code;
  }
}

/**
 * BullMQ's UnrecoverableError (checked structurally so the test suite
 * does not need a live queue) is also permanent: it stops retries.
 */
function isUnrecoverableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "UnrecoverableError" ||
      error.constructor.name === "UnrecoverableError")
  );
}

export function isPermanentFailure(error: unknown): boolean {
  return error instanceof PermanentRunError || isUnrecoverableError(error);
}

function sanitizeCode(code: string): string {
  const cleaned = code.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 100);
  return cleaned === "" ? "error" : cleaned;
}

function sanitizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Converts any error into safe run error metadata: a short code and a
 * short message (RunError contract). Never store message content,
 * credentials, or provider secrets here. Errors with uncontrolled
 * messages (arbitrary provider/infrastructure errors) get a fixed,
 * non-echoing message so conversation content can never leak into the
 * `summary_runs` error columns; the raw error stays in operational logs
 * and BullMQ's own job failure record instead.
 */
export function toRunError(error: unknown): RunError {
  if (
    error instanceof PermanentRunError ||
    error instanceof RetryableRunError
  ) {
    return RunError.parse({
      code: sanitizeCode(error.code),
      message: sanitizeMessage(error.message),
    });
  }
  if (isUnrecoverableError(error)) {
    return RunError.parse({
      code: "unrecoverable",
      message: sanitizeMessage(
        error instanceof Error ? error.message : "Unrecoverable error.",
      ),
    });
  }
  return RunError.parse({
    code: "provider_error",
    message: "The AI provider request failed.",
  });
}

/**
 * Terminal error metadata when finite retries are exhausted: the code
 * of the underlying failure is preserved (when it is one of ours) with a
 * message that reflects the terminal state accurately.
 */
export function retriesExhaustedError(error: unknown): RunError {
  return RunError.parse({
    code: sanitizeCode(toRunError(error).code),
    message: "Retry attempts were exhausted without producing a summary.",
  });
}
