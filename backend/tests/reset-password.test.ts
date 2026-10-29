import { describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, NEW_PASSWORD, makeApp } from "./helpers.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { hashRecoveryCode } from "../src/lib/recovery-codes.js";
import { NoAdminError, resetAdminPassword } from "../src/lib/reset-password.js";

describe("resetAdminPassword (CLI reset helper)", () => {
  it("sets a new password and invalidates all sessions", async () => {
    const { store } = await makeApp();
    await store.setAdmin({
      passwordHash: hashPassword(ADMIN_PASSWORD),
      recoveryCodeHashes: new Set(),
    });
    await store.createSession("session-a");
    await store.createSession("session-b");

    await resetAdminPassword(store, NEW_PASSWORD);

    const admin = await store.getAdmin();
    if (admin === null) throw new Error("admin missing after reset");
    expect(verifyPassword(NEW_PASSWORD, admin.passwordHash)).toBe(true);
    expect(verifyPassword(ADMIN_PASSWORD, admin.passwordHash)).toBe(false);
    expect(await store.validateSession("session-a")).toBe(false);
    expect(await store.validateSession("session-b")).toBe(false);
  });

  it("rotates the recovery codes and returns the new ones exactly once", async () => {
    const { store } = await makeApp();
    const oldCode = "0000-1111-2222-3333-4444-5555-6666-7777";
    await store.setAdmin({
      passwordHash: hashPassword(ADMIN_PASSWORD),
      recoveryCodeHashes: new Set([hashRecoveryCode(oldCode)]),
    });

    const codes = await resetAdminPassword(store, NEW_PASSWORD);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const admin = await store.getAdmin();
    if (admin === null) throw new Error("admin missing after reset");
    // Only hashes are stored; the old code no longer works.
    expect(admin.recoveryCodeHashes.has(hashRecoveryCode(oldCode))).toBe(false);
    for (const code of codes) {
      expect(admin.recoveryCodeHashes.has(hashRecoveryCode(code))).toBe(true);
      expect([...admin.recoveryCodeHashes]).not.toContain(code);
    }
  });

  it("throws NoAdminError when setup has not been completed", async () => {
    const { store } = await makeApp();
    await expect(resetAdminPassword(store, NEW_PASSWORD)).rejects.toBeInstanceOf(
      NoAdminError,
    );
  });

  it("enforces the same password policy as the API", async () => {
    const { store } = await makeApp();
    await store.setAdmin({
      passwordHash: hashPassword(ADMIN_PASSWORD),
      recoveryCodeHashes: new Set(),
    });
    await expect(resetAdminPassword(store, "short")).rejects.toThrow();
    // The existing password is untouched after a rejected reset.
    const admin = await store.getAdmin();
    if (admin === null) throw new Error("admin missing");
    expect(verifyPassword(ADMIN_PASSWORD, admin.passwordHash)).toBe(true);
  });
});
