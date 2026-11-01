import type { BackoffPolicy } from "./config.js";

/**
 * Capped exponential backoff for reconnect attempts (ADR 0004):
 * attempt 1 waits `baseMs`, each further attempt doubles the delay, and
 * no delay ever exceeds `capMs`. The attempt counter resets after a
 * successful open.
 */
export function reconnectDelayMs(
  attempt: number,
  policy: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 },
): number {
  const n = Math.max(1, Math.floor(attempt));
  if (policy.capMs <= 0) return 0;
  // Guard against numeric overflow on absurd attempt counts.
  if (n > 31) return policy.capMs;
  return Math.min(policy.capMs, policy.baseMs * 2 ** (n - 1));
}
