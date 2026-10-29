import { PasswordPolicy } from "@summarly/contracts";
import { hashPassword } from "./password.js";
import { generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes.js";
import type { Store } from "./store.js";

/**
 * Server-side CLI password reset — recovery option B from
 * docs/decisions/0002. Used by `npm run reset-password -w @summarly/backend`.
 */
export class NoAdminError extends Error {
  constructor() {
    super(
      "No administrator account exists yet. Complete first-run setup in the dashboard first.",
    );
    this.name = "NoAdminError";
  }
}

/**
 * Sets a new administrator password, rotates the recovery codes (the
 * old ones must stop working after a last-resort reset — the machine
 * may have been compromised), and invalidates all existing sessions.
 * Password update, code rotation, and session eviction commit together
 * in one store operation (M9). Enforces the same password policy as the
 * API. Throws NoAdminError when setup has not been completed.
 *
 * Returns the new plaintext recovery codes — shown exactly once, like at
 * setup; only their hashes are stored.
 */
export async function resetAdminPassword(
  store: Store,
  newPassword: string,
): Promise<string[]> {
  const password = PasswordPolicy.parse(newPassword);
  const admin = await store.getAdmin();
  if (admin === null) throw new NoAdminError();
  const recoveryCodes = generateRecoveryCodes();
  await store.updateAdminPassword({
    passwordHash: hashPassword(password),
    recoveryCodeHashes: new Set(recoveryCodes.map(hashRecoveryCode)),
  });
  return recoveryCodes;
}
