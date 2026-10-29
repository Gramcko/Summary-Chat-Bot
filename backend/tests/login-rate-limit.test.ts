import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/errors.js";
import { LoginRateLimiter } from "../src/lib/login-rate-limit.js";

/**
 * Soft-throttle semantics (F1): sliding failure window (60 s) → 60 s
 * cooldown; every attempt while cooling down doubles the cooldown, capped
 * at 5 minutes; successful auth clears the state. The first blocked
 * attempt already counts as "a further failure", so its Retry-After is
 * the doubled cooldown (120 s with the defaults used here).
 */
const OPTIONS = {
  windowMs: 60_000,
  threshold: 5,
  baseCooldownMs: 60_000,
  maxCooldownMs: 300_000,
  maxTrackedIps: 3,
};

function blocked(limiter: LoginRateLimiter, ip: string): HttpError {
  try {
    limiter.assertNotRateLimited(ip);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected the attempt to be rate limited");
}

function retryAfter(error: HttpError): number {
  expect(error.code).toBe("rate_limited");
  expect(error.statusCode).toBe(429);
  const raw = error.headers?.["Retry-After"];
  expect(raw).toBeDefined();
  return Number(raw);
}

describe("LoginRateLimiter (soft throttle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not throttle below the threshold", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("slides the failure window: stale failures do not add up", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    vi.advanceTimersByTime(61_000); // older than the 60 s window
    limiter.recordFailedAttempt("ip-1"); // 5th overall, 1st in the window
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("starts a 60 s cooldown at the threshold; the first blocked attempt doubles it to 120 s", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    // The 5 failures produce the 60 s cooldown; the next attempt is a
    // further failure while cooling down → doubles to 120 s and reports it.
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(120);
  });

  it("doubles the cooldown per attempt while cooling down, capped at 5 minutes", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(120); // 60 → 120
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(240); // 120 → 240
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(300); // 480 capped to 300
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(300); // still capped
  });

  it("the reported Retry-After is accurate for the deadline in effect", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(120);
    // 100 s later the cooldown is still active (ends 20 s from now), and
    // this attempt doubles it to 240 s from now.
    vi.advanceTimersByTime(100_000);
    expect(retryAfter(blocked(limiter, "ip-1"))).toBe(240);
    // 241 s later the cooldown has expired: the bucket works again.
    vi.advanceTimersByTime(241_000);
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("counts from scratch after a cooldown expires", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    blocked(limiter, "ip-1"); // cooldown now runs 120 s
    vi.advanceTimersByTime(121_000);
    // Old failures were cleared when the cooldown started: 4 new failures
    // must NOT re-trigger it.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("a successful login clears the state", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    limiter.reset("ip-1");
    // The counter is gone: one more failure is far below the threshold.
    limiter.recordFailedAttempt("ip-1");
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();

    // Same for an active cooldown.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    blocked(limiter, "ip-1");
    limiter.reset("ip-1");
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("tracks IPs independently", () => {
    const limiter = new LoginRateLimiter(OPTIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailedAttempt("ip-1");
    }
    blocked(limiter, "ip-1");
    expect(() => limiter.assertNotRateLimited("ip-2")).not.toThrow();
  });

  it("bounds memory: the oldest tracked IP is evicted at the cap", () => {
    // Cap of 3; threshold of 1 for easy assertions.
    const limiter = new LoginRateLimiter({
      ...OPTIONS,
      threshold: 1,
      maxTrackedIps: 3,
    });
    limiter.recordFailedAttempt("ip-1"); // oldest
    limiter.recordFailedAttempt("ip-2");
    limiter.recordFailedAttempt("ip-3");
    limiter.recordFailedAttempt("ip-4"); // exceeds the cap: evicts ip-1

    // ip-1 was evicted, so its state is gone...
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
    // ...while recently tracked IPs remain throttled.
    expect(() => limiter.assertNotRateLimited("ip-4")).toThrow(HttpError);
  });
});
