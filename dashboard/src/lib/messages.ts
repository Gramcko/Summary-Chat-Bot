/** Shared user-facing copy for API failures. */

/**
 * Required copy for `429 rate_limited` on the sign-in and recovery flows
 * (docs/api.md: 5 failed attempts → 15-minute lock).
 */
export const RATE_LIMITED_MESSAGE = "Too many attempts — try again later.";

interface ErrorLike {
  code: string;
  message: string;
}

/** Backend message, with the rate-limit case expressed in plain language. */
export function errorMessage(error: ErrorLike): string {
  if (error.code === "rate_limited") return RATE_LIMITED_MESSAGE;
  return error.message;
}
