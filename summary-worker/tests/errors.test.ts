import { describe, expect, it } from "vitest";
import {
  PermanentRunError,
  RetryableRunError,
  isPermanentFailure,
  retriesExhaustedError,
  toRunError,
} from "../src/errors.js";

/**
 * Error taxonomy (architecture A4.4 point 8): permanent failures fail
 * the run immediately and stop BullMQ retries; retryable failures are
 * retried with finite backoff. Run error metadata is SAFE: a short code
 * and a short message — never conversation content or credentials.
 */

/** Structural stand-in for BullMQ's UnrecoverableError (name-based). */
function fakeUnrecoverable(message: string): Error {
  const error = new Error(message);
  error.name = "UnrecoverableError";
  return error;
}

describe("isPermanentFailure", () => {
  it("classifies permanent and retryable errors", () => {
    expect(
      isPermanentFailure(new PermanentRunError("run_not_found", "gone")),
    ).toBe(true);
    expect(
      isPermanentFailure(new RetryableRunError("provider_rate_limit", "429")),
    ).toBe(false);
    expect(isPermanentFailure(new Error("boom"))).toBe(false);
  });

  it("treats BullMQ UnrecoverableError (by name) as permanent", () => {
    expect(isPermanentFailure(fakeUnrecoverable("stop"))).toBe(true);
  });

  it("treats unknown thrown values as retryable (safe default)", () => {
    expect(isPermanentFailure("a string")).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
    expect(isPermanentFailure({ name: "UnrecoverableError" })).toBe(false);
  });
});

describe("toRunError (safe metadata)", () => {
  it("keeps the code and message of our typed errors", () => {
    expect(
      toRunError(new PermanentRunError("provider_config", "Missing API key.")),
    ).toEqual({ code: "provider_config", message: "Missing API key." });
    expect(
      toRunError(
        new RetryableRunError("provider_rate_limit", "429 Too Many Requests"),
      ),
    ).toEqual({
      code: "provider_rate_limit",
      message: "429 Too Many Requests",
    });
  });

  it("never echoes uncontrolled provider/infrastructure error text", () => {
    // Arbitrary errors can embed conversation content or credentials;
    // their message must not reach summary_runs.
    const leaking = new Error(
      'provider said: "Let\'s meet at 5" (sk-SECRET-KEY-123)',
    );
    const metadata = toRunError(leaking);
    expect(metadata).toEqual({
      code: "provider_error",
      message: "The AI provider request failed.",
    });
    expect(metadata.message).not.toContain("meet at 5");
    expect(metadata.message).not.toContain("sk-SECRET");
  });

  it("does the same for non-Error thrown values", () => {
    expect(toRunError("raw string with secrets")).toEqual({
      code: "provider_error",
      message: "The AI provider request failed.",
    });
    expect(toRunError(undefined).message).not.toContain("undefined");
  });

  it("sanitizes codes and truncates overlong messages", () => {
    const weird = new PermanentRunError(
      "bad code!@#$%^&*()",
      `line one\nline two ${"x".repeat(600)}`,
    );
    const metadata = toRunError(weird);
    expect(metadata.code).toBe("badcode");
    expect(metadata.code.length).toBeLessThanOrEqual(100);
    expect(metadata.message).not.toContain("\n");
    expect(metadata.message.length).toBeLessThanOrEqual(500);
  });

  it("handles UnrecoverableError-shaped errors", () => {
    expect(toRunError(fakeUnrecoverable("run_not_found: gone"))).toEqual({
      code: "unrecoverable",
      message: "run_not_found: gone",
    });
  });
});

describe("retriesExhaustedError (terminal metadata)", () => {
  it("preserves the failure code and reflects the terminal state", () => {
    const metadata = retriesExhaustedError(
      new RetryableRunError("provider_rate_limit", "429 Too Many Requests"),
    );
    expect(metadata.code).toBe("provider_rate_limit");
    expect(metadata.message).toBe(
      "Retry attempts were exhausted without producing a summary.",
    );
  });

  it("never leaks the underlying error text", () => {
    const metadata = retriesExhaustedError(
      new Error('timeout while reading "secret conversation"'),
    );
    expect(metadata.code).toBe("provider_error");
    expect(metadata.message).not.toContain("secret conversation");
  });
});
