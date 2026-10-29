import { HttpError } from "./errors.js";

export interface LoginAttemptState {
  /** Failure timestamps inside the sliding window. */
  failures: number[];
  /** Current cooldown length in ms (doubles per attempt while cooling down). */
  cooldownMs: number;
  /** Epoch ms until which attempts are rejected. */
  cooldownUntil: number;
}

export interface LoginThrottleOptions {
  /** Sliding window for counting failures (default 60 s). */
  windowMs?: number;
  /** Failures within the window that start a cooldown (default 5). */
  threshold?: number;
  /** First cooldown after crossing the threshold (default 60 s). */
  baseCooldownMs?: number;
  /** Cap for the doubled cooldown (default 5 minutes). */
  maxCooldownMs?: number;
  /** Bounded memory: max tracked source IPs (default 10 000). */
  maxTrackedIps?: number;
}

const WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 5;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
// Bounded memory (N2): never track more than this many source IPs.
const MAX_TRACKED_IPS = 10_000;
// Upper bound for the per-IP failure list (the threshold is small; this
// only caps pathological hammering inside one window).
const MAX_WINDOW_FAILURES = 50;

/**
 * Soft throttle for credential guessing (login passwords and recovery
 * codes alike). Deliberately in-memory: it is an operational guard, not
 * business data, and a restart clearing it is an acceptable (and useful)
 * trade-off for a single-process self-hosted install.
 *
 * Semantics (replaces the old hard 5-failures → 15-minute lock, which was
 * a trivial availability attack once all clients shared one bucket):
 *
 *   - Failures are counted in a sliding window (60 s by default).
 *   - Reaching the threshold (5) starts a cooldown of 60 s: further
 *     attempts are rejected with 429 + an accurate `Retry-After`.
 *   - Every attempt made WHILE cooling down counts as a further failure
 *     and doubles the cooldown, capped at 5 minutes. After the last
 *     attempt the bucket is usable again within at most 5 minutes.
 *   - A successful login or recovery clears the state entirely.
 *   - The failure list is pruned to the window and the map is bounded
 *     (oldest-IP eviction).
 *
 * Buckets are keyed by the client IP Fastify derives (see trustProxy in
 * app.ts). Behind the dashboard proxy all clients share ONE bucket — the
 * proxy strips client-supplied forwarding headers — so one user's
 * wrong-password spree can briefly deny login to others. That
 * availability trade-off is deliberate and documented (docs/api.md,
 * docs/decisions/0002); operator escape hatches are the server-side CLI
 * password reset and restarting the backend.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttemptState>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxTrackedIps: number;

  constructor(options: LoginThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.threshold = options.threshold ?? FAILURE_THRESHOLD;
    this.baseCooldownMs = options.baseCooldownMs ?? BASE_COOLDOWN_MS;
    this.maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_IPS;
  }

  /**
   * Throws 429 (with an accurate `Retry-After`) while the bucket is
   * cooling down. An attempt during cooldown IS a further failure: the
   * cooldown doubles (capped) and restarts from this attempt before the
   * error is produced, so the reported `Retry-After` matches the
   * deadline this request actually ends up with.
   */
  assertNotRateLimited(ip: string): void {
    const state = this.attempts.get(ip);
    const now = Date.now();
    if (state === undefined || now >= state.cooldownUntil) return;
    state.cooldownMs = Math.min(state.cooldownMs * 2, this.maxCooldownMs);
    state.cooldownUntil = now + state.cooldownMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.cooldownUntil - now) / 1000),
    );
    throw new HttpError(
      429,
      "rate_limited",
      "Too many failed attempts. Try again later.",
      undefined,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  /** Records a genuine failed credential check (a 401, not a 429). */
  recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const state = this.getOrCreate(ip);
    // Sliding window: only recent failures count towards the threshold.
    state.failures = state.failures.filter((at) => now - at < this.windowMs);
    if (state.failures.length >= MAX_WINDOW_FAILURES) state.failures.shift();
    state.failures.push(now);
    if (now >= state.cooldownUntil && state.failures.length >= this.threshold) {
      state.cooldownMs = this.baseCooldownMs;
      state.cooldownUntil = now + this.baseCooldownMs;
      // Fresh counting after the cooldown: stale failures must not
      // immediately re-trigger it.
      state.failures = [];
    }
  }

  /** Clears the state after a successful authentication. */
  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  private getOrCreate(ip: string): LoginAttemptState {
    const existing = this.attempts.get(ip);
    if (existing !== undefined) return existing;
    if (this.attempts.size >= this.maxTrackedIps) {
      // Evict the oldest tracked IP (Map iteration order is insertion
      // order; re-recording an IP does not refresh its position).
      const oldest = this.attempts.keys().next();
      if (oldest.done !== true) this.attempts.delete(oldest.value);
    }
    const state: LoginAttemptState = {
      failures: [],
      cooldownMs: this.baseCooldownMs,
      cooldownUntil: 0,
    };
    this.attempts.set(ip, state);
    return state;
  }
}
