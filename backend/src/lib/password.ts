import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/**
 * Password hashing with Node's built-in scrypt. An upgrade path to
 * argon2id is recorded in docs/decisions/0002; scrypt keeps the skeleton
 * free of native build dependencies.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, derivedHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !derivedHex) return false;
  const expected = Buffer.from(derivedHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
