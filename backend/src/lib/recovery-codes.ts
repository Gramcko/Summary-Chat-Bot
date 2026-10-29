import { createHash, randomBytes } from "node:crypto";

const CODE_BYTES = 16; // 128 bits per code

/**
 * Human-transcribable one-time codes: 32 hex chars (128 bits) in groups
 * of four (xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx).
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(CODE_BYTES).toString("hex");
    return hex.match(/.{4}/g)?.join("-") ?? hex;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Codes are 128-bit one-time secrets shown to the user only once, so a
 * plain SHA-256 hash is sufficient storage for them (a slow KDF would
 * add nothing against offline guessing of a 128-bit secret).
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(normalizeRecoveryCode(code))
    .digest("hex");
}
