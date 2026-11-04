import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Session-state file handling (ADR 0004/0008). Plain fs — no Baileys
 * imports — so both the adapter and the tests can use it. The session
 * DIRECTORY PATH must never reach the logs (ADR 0004): failures are
 * re-thrown with error codes only.
 */

/**
 * The files `useMultiFileAuthState` writes, verified against the
 * installed Baileys 6.7.24 (`Utils/use-multi-file-auth-state.js` +
 * `Types/Auth.d.ts` SignalDataTypeMap): `creds.json` plus
 * `<category>-<id>.json` for categories `pre-key`, `session`,
 * `sender-key`, `sender-key-memory`, `app-state-sync-key`, and
 * `app-state-sync-version` (ids are `fixFileName`'d: `/` -> `__`,
 * `:` -> `-`, so ids may contain letters, digits, `__`, `-`, `.`).
 */
const SESSION_ARTEFACT =
  /^(?:creds\.json|(?:pre-key|session|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version)-[^/\\]+\.json)$/;

/** True for a file name `useMultiFileAuthState` owns (see above). */
export function isSessionArtefact(name: string): boolean {
  return SESSION_ARTEFACT.test(name);
}

export interface PurgeResult {
  /** Auth-state artefacts removed. */
  removed: number;
  /** Unknown entries left in place (never touched). */
  kept: number;
}

/**
 * Removes the auth-state FILES inside the session directory (the
 * directory itself may stay). ONLY known Baileys artefacts are deleted
 * (M-3): anything else — operator notes, backups, other tools' files —
 * is left in place and reported through `onUnknown` so the caller can
 * warn. Idempotent: a missing directory removes nothing and is not an
 * error. Used by the admin logout control — unlike ordinary reconnects,
 * a logout deliberately destroys the local session state so the account
 * can be re-linked cleanly.
 */
export function purgeSessionDir(
  sessionDir: string,
  onUnknown?: (count: number) => void,
): PurgeResult {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    if (code === "ENOENT") return { removed: 0, kept: 0 };
    throw new Error(`session storage purge failed (${code})`);
  }
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    // Only entries INSIDE the session directory are ever considered;
    // the join with a readdir name cannot escape the directory.
    if (!isSessionArtefact(entry)) {
      kept += 1;
      continue;
    }
    rmSync(join(sessionDir, entry), { recursive: true, force: true });
    removed += 1;
  }
  if (kept > 0) onUnknown?.(kept);
  return { removed, kept };
}
