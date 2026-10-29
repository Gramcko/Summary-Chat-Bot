import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/errors.js";
import { LoginRateLimiter } from "../src/lib/login-rate-limit.js";

describe("LoginRateLimiter", () => {
  it("locks after the configured number of failures and sends Retry-After", () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    limiter.recordFailedAttempt("ip-1");
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
    limiter.recordFailedAttempt("ip-1");
    try {
      limiter.assertNotRateLimited("ip-1");
      throw new Error("expected rate_limited");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      expect(httpError.statusCode).toBe(429);
      expect(Number(httpError.headers?.["Retry-After"])).toBeGreaterThan(0);
    }
  });

  it("tracks IPs independently and resets per IP", () => {
    const limiter = new LoginRateLimiter(1, 60_000);
    limiter.recordFailedAttempt("ip-1");
    expect(() => limiter.assertNotRateLimited("ip-2")).not.toThrow();
    limiter.reset("ip-1");
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
  });

  it("bounds memory: the oldest tracked IP is evicted at the cap", () => {
    // Cap of 3; locking after 1 failure for easy assertions.
    const limiter = new LoginRateLimiter(1, 60_000, 3);
    limiter.recordFailedAttempt("ip-1"); // oldest
    limiter.recordFailedAttempt("ip-2");
    limiter.recordFailedAttempt("ip-3");
    limiter.recordFailedAttempt("ip-4"); // exceeds the cap: evicts ip-1

    // ip-1 was evicted, so its lockout is gone...
    expect(() => limiter.assertNotRateLimited("ip-1")).not.toThrow();
    // ...while recently tracked IPs remain locked.
    expect(() => limiter.assertNotRateLimited("ip-4")).toThrow(HttpError);
  });
});
