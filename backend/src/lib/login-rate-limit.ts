import { HttpError } from "./errors.js";

export interface LoginAttemptRecord {
  count: number;
  lockedUntil: number;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
// Bounded memory (N2): never track more than this many source IPs.
const MAX_TRACKED_IPS = 10_000;

/**
 * Shared per-IP lockout for credential guessing (login passwords and
 * recovery codes alike). Deliberately in-memory: it is an operational
 * guard, not business data, and a restart resetting the counter is an
 * acceptable trade-off for a single-process self-hosted install.
 *
 * "Per-IP" means the client IP Fastify derives (see trustProxy in
 * app.ts): behind a reverse proxy, X-Forwarded-For is only honored for
 * trusted peers, so each real client gets its own bucket.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttemptRecord>();

  constructor(
    private readonly maxFailedAttempts: number = MAX_FAILED_ATTEMPTS,
    private readonly lockDurationMs: number = LOCK_DURATION_MS,
    private readonly maxTrackedIps: number = MAX_TRACKED_IPS,
  ) {}

  assertNotRateLimited(ip: string): void {
    const attempts = this.attempts.get(ip);
    if (attempts !== undefined && attempts.lockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((attempts.lockedUntil - Date.now()) / 1000),
      );
      throw new HttpError(
        429,
        "rate_limited",
        "Too many failed attempts. Try again later.",
        undefined,
        { "Retry-After": String(retryAfterSeconds) },
      );
    }
  }

  recordFailedAttempt(ip: string): void {
    const attempts = this.attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
    attempts.count += 1;
    if (attempts.count >= this.maxFailedAttempts) {
      attempts.count = 0;
      attempts.lockedUntil = Date.now() + this.lockDurationMs;
    }
    if (!this.attempts.has(ip) && this.attempts.size >= this.maxTrackedIps) {
      // Evict the oldest tracked IP (Map iteration order is insertion
      // order; re-recording an IP does not refresh its position).
      const oldest = this.attempts.keys().next();
      if (oldest.done !== true) this.attempts.delete(oldest.value);
    }
    this.attempts.set(ip, attempts);
  }

  /** Clears the counter after a successful authentication. */
  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}
