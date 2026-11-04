/** Custom summary instructions (`CreateRunRequest.instructions`, ADR 0008). */

/** Matches the contract's `z.string().trim().min(1).max(2000)`. */
export const INSTRUCTIONS_MAX_LENGTH = 2000;

/** `null` when valid, otherwise a user-facing error. */
export function validateInstructions(value: string): string | null {
  if (value.trim().length > INSTRUCTIONS_MAX_LENGTH) {
    return `Use at most ${INSTRUCTIONS_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * The value sent to the API: trimmed, or `undefined` when the admin left the
 * field blank (the request then carries no `instructions`).
 */
export function normalizeInstructions(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
