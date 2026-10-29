import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "../src/lib/crypto.js";

const KEY = randomBytes(32);

describe("parseEncryptionKey", () => {
  it("accepts standard base64 for exactly 32 bytes", () => {
    const raw = KEY.toString("base64");
    expect(parseEncryptionKey(raw).equals(KEY)).toBe(true);
  });

  it("rejects a missing or empty key with an actionable error", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(CryptoError);
    expect(() => parseEncryptionKey(undefined)).toThrow(/ENCRYPTION_KEY is required/);
    expect(() => parseEncryptionKey("   ")).toThrow(/ENCRYPTION_KEY is required/);
  });

  it("rejects malformed base64", () => {
    expect(() => parseEncryptionKey("not base64 !!")).toThrow(CryptoError);
  });

  it("rejects keys of the wrong length", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
      CryptoError,
    );
    expect(() => parseEncryptionKey(randomBytes(31).toString("base64"))).toThrow(
      CryptoError,
    );
    expect(() => parseEncryptionKey(randomBytes(33).toString("base64"))).toThrow(
      CryptoError,
    );
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    const secret = "sk-example-1234567890";
    const stored = encryptSecret(KEY, secret);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(KEY, stored)).toBe(secret);
  });

  it("round-trips unicode and delimiter characters", () => {
    const secret = "päss:word:with:colons ✓ ünïcode";
    expect(decryptSecret(KEY, encryptSecret(KEY, secret))).toBe(secret);
  });

  it("round-trips an empty secret", () => {
    expect(decryptSecret(KEY, encryptSecret(KEY, ""))).toBe("");
  });

  it("uses a fresh IV for every encryption", () => {
    const a = encryptSecret(KEY, "same-secret");
    const b = encryptSecret(KEY, "same-secret");
    expect(a).not.toBe(b);
  });

  it("detects tampering with the ciphertext", () => {
    const stored = encryptSecret(KEY, "sensitive");
    const parts = stored.split(":");
    const ciphertext = Buffer.from(parts[4] ?? "", "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    const tampered = [...parts.slice(0, 4), ciphertext.toString("base64")].join(":");
    expect(() => decryptSecret(KEY, tampered)).toThrow(CryptoError);
    expect(() => decryptSecret(KEY, tampered)).toThrow(/failed authentication/);
  });

  it("detects tampering with the auth tag and the IV", () => {
    const stored = encryptSecret(KEY, "sensitive");
    const parts = stored.split(":");
    const tag = Buffer.from(parts[3] ?? "", "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    const badTag = [
      parts[0],
      parts[1],
      parts[2],
      tag.toString("base64"),
      parts[4],
    ].join(":");
    expect(() => decryptSecret(KEY, badTag)).toThrow(CryptoError);

    const iv = Buffer.from(parts[2] ?? "", "base64");
    iv[0] = (iv[0] ?? 0) ^ 0xff;
    const badIv = [
      parts[0],
      parts[1],
      iv.toString("base64"),
      parts[3],
      parts[4],
    ].join(":");
    expect(() => decryptSecret(KEY, badIv)).toThrow(CryptoError);
  });

  it("rejects a value encrypted with a different key", () => {
    const stored = encryptSecret(KEY, "sensitive");
    expect(() => decryptSecret(randomBytes(32), stored)).toThrow(CryptoError);
  });

  it("rejects malformed stored values", () => {
    expect(() => decryptSecret(KEY, "")).toThrow(CryptoError);
    expect(() => decryptSecret(KEY, "garbage")).toThrow(CryptoError);
    expect(() => decryptSecret(KEY, "enc:v2:a:b:c")).toThrow(CryptoError);
    expect(() => decryptSecret(KEY, "enc:v1:AAAA:AAAA")).toThrow(CryptoError);
  });

  it("rejects a key that is not 32 bytes", () => {
    const shortKey = randomBytes(16);
    expect(() => encryptSecret(shortKey, "x")).toThrow(CryptoError);
    expect(() => decryptSecret(shortKey, encryptSecret(KEY, "x"))).toThrow(
      CryptoError,
    );
  });
});
