/**
 * Server-side CLI password reset — recovery option B from
 * docs/decisions/0002. Run on the server with:
 *
 *   npm run reset-password -w @summarly/backend
 *
 * Loads the repository-root .env (or reads DATABASE_URL from the
 * environment), prompts twice for the new password without echoing it,
 * then atomically sets the scrypt hash (lib/password.ts), rotates the
 * recovery codes, and invalidates every existing session. The new
 * recovery codes are printed exactly once.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { z } from "zod";
import { Pool } from "pg";
import { loadRepoEnv } from "../src/lib/load-env.js";
import { PostgresStore } from "../src/lib/postgres-store.js";
import { NoAdminError, resetAdminPassword } from "../src/lib/reset-password.js";

loadRepoEnv();

/** Discards writes so typed characters are never echoed to the terminal. */
class MuteStream extends Writable {
  /** Used by readline for line editing width. */
  readonly columns = 80;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

/**
 * Prompts for two input lines. Uses the readline async iterator rather
 * than question(): it buffers lines, so piped (non-TTY) input where both
 * lines arrive in one chunk cannot be lost between prompts.
 */
async function promptTwice(
  firstPrompt: string,
  secondPrompt: string,
): Promise<[string, string] | null> {
  const rl = createInterface({
    input: process.stdin,
    output: new MuteStream(),
    terminal: process.stdin.isTTY === true,
  });
  try {
    const lines = rl[Symbol.asyncIterator]();
    process.stdout.write(firstPrompt);
    const first = await lines.next();
    if (first.done === true) return null;
    process.stdout.write(secondPrompt);
    const second = await lines.next();
    if (second.done === true) return null;
    return [
      String(first.value).replace(/\r$/, ""),
      String(second.value).replace(/\r$/, ""),
    ];
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "DATABASE_URL is required. Copy .env.example to .env at the repository root (it is loaded automatically) or export it in the environment.",
    );
    process.exitCode = 1;
    return;
  }

  const prompted = await promptTwice(
    "New administrator password (min 12 characters): ",
    "Repeat the new password: ",
  );
  if (prompted === null) {
    console.error("No input received. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const [password, confirmation] = prompted;
  if (password !== confirmation) {
    console.error("Passwords do not match. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const recoveryCodes = await resetAdminPassword(
      new PostgresStore(pool),
      password,
    );
    console.log("Administrator password updated.");
    console.log("All existing sessions were invalidated; sign in again with the new password.");
    console.log("");
    console.log("Your previous recovery codes no longer work. Save these NEW recovery codes now;");
    console.log("they are shown exactly once and only their hashes are stored:");
    for (const code of recoveryCodes) {
      console.log(`  ${code}`);
    }
  } catch (error) {
    if (error instanceof NoAdminError) {
      console.error(error.message);
    } else if (error instanceof z.ZodError) {
      console.error(
        "Password does not meet the policy (minimum 12 characters, maximum 200). Nothing was changed.",
      );
    } else {
      console.error(
        `Reset failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
