import { PermanentRunError, RetryableRunError } from "../errors.js";

/**
 * Centralized AI-provider error mapping (audit L1 — fixed
 * error-message-per-code policy).
 *
 * Provider error bodies are UNTRUSTED DATA: they can echo prompt
 * fragments, message content, keys, or URLs. Raw provider text must
 * NEVER reach summary_runs.error_message, operational logs, or
 * BullMQ's failedReason — every error leaving this module carries a
 * code and a FIXED message authored here. Raw bodies are used only
 * internally to classify a response (pattern checks), never propagated.
 *
 * Mapping table (verified against the Gemini API error docs
 * 2026-10-27 / 2026-10-30; other providers map onto the same codes):
 *
 *   trigger                                   | code                      | class
 *   ------------------------------------------+---------------------------+-----------
 *   401, 403, or 400 + invalid-key pattern    | provider_auth             | permanent
 *   404, or 400 + unknown-model pattern       | provider_config           | permanent
 *   400 context/token overflow pattern        | provider_input_too_large  | permanent
 *   blocked generation (safety etc.)          | provider_blocked          | permanent
 *   other 4xx (bad request, 402 credits ...)  | provider_request_rejected | permanent
 *   429 RESOURCE_EXHAUSTED (+retry hint)      | provider_rate_limit       | retryable
 *   500 / 502 / 503 (overloaded/unavailable)  | provider_overloaded       | retryable
 *   408 / 504, client timeout / abort         | provider_timeout          | retryable
 *   network-level fetch failure               | provider_unavailable      | retryable
 *   malformed / unparseable model output      | provider_malformed_output | retryable
 *
 * Retrying client-side errors (4xx) is pointless — Google's own
 * troubleshooting guidance says so — hence their permanent class.
 */

/** Canonical FIXED message per provider error code (audit L1). */
export const PROVIDER_ERROR_MESSAGES = {
  provider_auth: "The AI provider rejected the configured credentials.",
  provider_config: "The AI provider configuration is invalid or unsupported.",
  provider_request_rejected: "The AI provider rejected the request.",
  provider_input_too_large:
    "The conversation is too large for the configured model.",
  provider_blocked: "The AI provider declined to process this conversation.",
  provider_rate_limit: "The AI provider rate limit was reached.",
  provider_overloaded: "The AI provider is temporarily unavailable.",
  provider_timeout: "The AI provider request timed out.",
  provider_unavailable: "The AI provider could not be reached.",
  provider_malformed_output:
    "The AI provider returned output that does not match the expected format.",
} as const;

export type ProviderErrorCode = keyof typeof PROVIDER_ERROR_MESSAGES;

const PERMANENT_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "provider_auth",
  "provider_config",
  "provider_request_rejected",
  "provider_input_too_large",
  "provider_blocked",
]);

/**
 * Builds the typed run error for a provider code with its FIXED
 * message. Retryable errors may carry a provider retry hint (see
 * RetryableRunError.retryAfterMs) — numeric metadata only.
 */
export function providerError(
  code: ProviderErrorCode,
  retryAfterMs?: number,
): PermanentRunError | RetryableRunError {
  const message = PROVIDER_ERROR_MESSAGES[code];
  return PERMANENT_CODES.has(code)
    ? new PermanentRunError(code, message)
    : new RetryableRunError(code, message, retryAfterMs);
}

export function isPermanentProviderCode(code: ProviderErrorCode): boolean {
  return PERMANENT_CODES.has(code);
}

/**
 * Upper bound for a stored retry hint. A provider can suggest absurd
 * delays (daily quotas reset in hours); the hint is advisory metadata,
 * never an unbounded wait.
 */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into a
 * clamped millisecond delay. Never throws.
 */
export function parseRetryAfterHeader(
  value: string | null | undefined,
): number | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

const RETRY_DELAY_SECONDS_RE = /^(\d+(?:\.\d+)?)s$/;

/**
 * Extracts google.rpc.RetryInfo.retryDelay ("48.805646254s") from a
 * parsed error body's `details` array (the authoritative hint per the
 * Gemini docs when present). Returns undefined otherwise. The body is
 * inspected structurally only — no text is ever returned or logged.
 */
export function parseRetryInfoDelay(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const entry of details) {
    if (typeof entry !== "object" || entry === null) continue;
    const type = (entry as { "@type"?: unknown })["@type"];
    if (typeof type !== "string" || !type.endsWith("google.rpc.RetryInfo")) {
      continue;
    }
    const delay = (entry as { retryDelay?: unknown }).retryDelay;
    if (typeof delay !== "string") continue;
    const match = RETRY_DELAY_SECONDS_RE.exec(delay.trim());
    if (match?.[1] !== undefined) {
      return Math.min(Math.floor(Number(match[1]) * 1000), MAX_RETRY_AFTER_MS);
    }
  }
  return undefined;
}

/**
 * Best available retry hint for a failed response: the Retry-After
 * header first, then google.rpc.RetryInfo. Raw values are clamped and
 * reduced to a number — nothing else survives.
 */
export function extractRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  parsedBody: unknown,
): number | undefined {
  const fromHeader = parseRetryAfterHeader(retryAfterHeader);
  if (fromHeader !== undefined) return fromHeader;
  if (typeof parsedBody === "object" && parsedBody !== null) {
    const error = (parsedBody as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      return parseRetryInfoDelay((error as { details?: unknown }).details);
    }
  }
  return undefined;
}

// Internal classifiers over raw provider text. These patterns are used
// ONLY to choose a code; matches are never echoed anywhere (audit L1).
const INVALID_KEY_RE = /api[ _-]?key/i;
const CONTEXT_OVERFLOW_RE =
  /(input|prompt|context)[\s\S]{0,80}(too (long|large)|exceeds|exceeded)|(exceeds|exceeding)[\s\S]{0,40}(token|context|maximum)|maximum[ \w]{0,30}tokens[\s\S]{0,30}(exceed|reach)/i;
const UNKNOWN_MODEL_RE =
  /(model[\s\S]{0,80}(not found|not supported|does not exist|is unavailable)|is not found for model|unsupported model)/i;

/**
 * Maps a failed HTTP response to the canonical provider error. The raw
 * body text is consulted only for the internal patterns above and is
 * never included in the returned error (fixed messages only).
 */
export function mapProviderHttpError(
  status: number,
  rawBodyText: string | undefined,
  retryAfterMs?: number,
): PermanentRunError | RetryableRunError {
  if (status === 401 || status === 403) {
    return providerError("provider_auth");
  }
  if (status === 429) {
    return providerError("provider_rate_limit", retryAfterMs);
  }
  if (status === 408 || status === 504) {
    // 408 Request Timeout and 504 Gateway Timeout are both transient
    // timeouts (review n4: 408 used to be lumped into the permanent
    // 4xx bucket).
    return providerError("provider_timeout", retryAfterMs);
  }
  if (status === 500 || status === 502 || status === 503) {
    return providerError("provider_overloaded", retryAfterMs);
  }
  if (status === 404) {
    return providerError("provider_config");
  }
  if (status >= 400 && status < 500) {
    // 400 carries several distinct causes; classify by internal pattern
    // match on the body (never propagated).
    if (INVALID_KEY_RE.test(rawBodyText ?? "")) {
      return providerError("provider_auth");
    }
    if (CONTEXT_OVERFLOW_RE.test(rawBodyText ?? "")) {
      return providerError("provider_input_too_large");
    }
    if (UNKNOWN_MODEL_RE.test(rawBodyText ?? "")) {
      return providerError("provider_config");
    }
    return providerError("provider_request_rejected");
  }
  // Remaining 5xx and anything unexpected: transient by default.
  return providerError("provider_overloaded", retryAfterMs);
}
