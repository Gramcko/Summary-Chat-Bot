import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM) for stored secrets such as the
 * AI provider API key. Copied VERBATIM from backend/src/lib/crypto.ts
 * on purpose: summary-worker is an independent service and must not
 * import from @summarly/backend (architecture A4.4) — keep the two
 * copies in sync. The master key comes from the ENCRYPTION_KEY
 * environment variable (base64 for exactly 32 random bytes) and is kept
 * outside the database (AGENTS.md; architecture A7). The database only
 * ever stores `enc:v1:<iv>:<auth tag>:<ciphertext>` — never plaintext.
 *
 * summary-worker only DECRYPTS: the dashboard's settings screen writes
 * the key through the backend; the worker reads it when a real AI
 * provider is configured (ADR 0005).
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const FORMAT_PREFIX = "enc:v1";

/** Raised for key, format, or authentication failures. Never carries secret material. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Validates and decodes the master key. Throws a clear, actionable error
 * when ENCRYPTION_KEY is missing or malformed so the process can fail
 * fast at startup instead of at the first encrypted write.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    throw new CryptoError(
      "ENCRYPTION_KEY is required. Generate one with " +
        "`node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"` " +
        "and keep it outside the database. Never commit the real value.",
    );
  }
  const key = Buffer.from(value, "base64");
  // Round-trip check: rejects non-base64 input and non-canonical spellings
  // that would silently decode to the wrong bytes.
  if (key.length !== KEY_LENGTH_BYTES || key.toString("base64") !== value) {
    throw new CryptoError(
      `ENCRYPTION_KEY must be standard base64 for exactly ${KEY_LENGTH_BYTES} bytes ` +
        "(44 characters ending in '='). See .env.example for how to generate one.",
    );
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new CryptoError(
      `Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes (got ${key.length}).`,
    );
  }
}

/** Returns `enc:v1:<iv>:<auth tag>:<ciphertext>` (all base64). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Reverses encryptSecret. Throws CryptoError when the stored value is
 * malformed, was produced with a different key, or fails authentication
 * (tampering or corruption).
 */
export function decryptSecret(key: Buffer, stored: string): string {
  assertKey(key);
  // ["enc", "v1", iv, authTag, ciphertext] — FORMAT_PREFIX is "enc:v1".
  const parts = stored.split(":");
  const ivPart = parts[2];
  const tagPart = parts[3];
  const ciphertextPart = parts[4];
  if (
    parts.length !== 5 ||
    `${parts[0] ?? ""}:${parts[1] ?? ""}` !== FORMAT_PREFIX ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    throw new CryptoError("Stored secret has an unrecognized format.");
  }
  const iv = Buffer.from(ivPart, "base64");
  const authTag = Buffer.from(tagPart, "base64");
  const ciphertext = Buffer.from(ciphertextPart, "base64");
  if (iv.length !== IV_LENGTH_BYTES || authTag.length !== 16) {
    throw new CryptoError("Stored secret has an unrecognized format.");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, tampering, or corruption — never echo key or plaintext.
    throw new CryptoError(
      "Stored secret failed authentication; it was corrupted, tampered " +
        "with, or encrypted with a different ENCRYPTION_KEY.",
    );
  }
}
