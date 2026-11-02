import { describe, expect, it } from "vitest";
import {
  CryptoError,
  decryptSecret,
  parseEncryptionKey,
} from "../src/lib/crypto.js";

/**
 * Cross-service crypto parity fixture (audit E-5): summary-worker's
 * lib/crypto.ts is a VERBATIM copy of backend/src/lib/crypto.ts (the
 * worker must not import the backend). These constants are duplicated
 * from backend/tests/crypto.test.ts — the SAME fixed ciphertext must
 * decrypt correctly in both copies. If either copy drifts, one of the
 * two parity suites fails. Test-only values; never reuse elsewhere.
 */
const PARITY_KEY_BASE64 = "c3VtbWFybHktY3J5cHRvLXBhcml0eS1rZXktdjEuLi4=";
const PARITY_CIPHERTEXT =
  "enc:v1:MDEyMzQ1Njc4OWFi:dKSHOWo4OAYatSq7oLeYfw==:B7D57k1QOjRf8HyZl9CrBIc9crGmY0ID";
const PARITY_PLAINTEXT = "sk-parity-fixture-secret";

describe("cross-service crypto parity fixture (audit E-5)", () => {
  it("decrypts the same fixed ciphertext as the backend copy", () => {
    const key = parseEncryptionKey(PARITY_KEY_BASE64);
    expect(decryptSecret(key, PARITY_CIPHERTEXT)).toBe(PARITY_PLAINTEXT);
  });

  it("rejects a tampered envelope (authenticated encryption intact)", () => {
    const key = parseEncryptionKey(PARITY_KEY_BASE64);
    const tampered = PARITY_CIPHERTEXT.replace(/.$/, "A");
    expect(() => decryptSecret(key, tampered)).toThrow(CryptoError);
  });

  it("rejects a different master key (no plaintext leak)", () => {
    const wrongKey = parseEncryptionKey(
      Buffer.alloc(32, 9).toString("base64"),
    );
    let message = "";
    try {
      decryptSecret(wrongKey, PARITY_CIPHERTEXT);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("authentication");
    expect(message).not.toContain(PARITY_PLAINTEXT);
  });
});
