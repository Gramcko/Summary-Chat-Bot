/**
 * Operator CLI: permanently delete captured messages and the member
 * roster (retention policy, ADR 0004 / audit M6, fix round A M-2/M5).
 * Run on the server with:
 *
 *   npm run purge-messages -w @summarly/backend -- \
 *     --group-id <uuid> [--chat-id <jid>] [--before <ISO date>] [--yes]
 *
 * Loads the repository-root .env (or reads DATABASE_URL from the
 * environment), resolves the selection (group ids -> chat ids), prints
 * the matched row counts (messages + group_members), and requires a
 * typed confirmation (or the explicit --yes flag) before deleting.
 * Destructive by design: there is no automatic retention yet, so THIS
 * is the deletion path. Only counts are printed — never message
 * content (AGENTS.md).
 */
import { createInterface } from "node:readline/promises";
import { Pool } from "pg";
import { loadRepoEnv } from "../src/lib/load-env.js";
import {
  PURGE_CONFIRMATION,
  PURGE_USAGE,
  buildPurgePlan,
  parsePurgeArgs,
  type PurgeSelection,
} from "../src/lib/purge-messages.js";

loadRepoEnv();

function fail(message: string): never {
  console.error(message);
  console.error("");
  console.error(PURGE_USAGE);
  process.exit(1);
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    fail(
      "DATABASE_URL is required. Copy .env.example to .env at the repository root " +
        "(it is loaded automatically) or export it in the environment.",
    );
  }

  let selection: PurgeSelection;
  try {
    selection = parsePurgeArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid arguments.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Resolve --group-id selectors to chat ids (messages join groups by
    // chat_id; migration 0001 documents the join path).
    const chatIds = [...selection.chatIds];
    if (selection.groupIds.length > 0) {
      const groups = await pool.query<{ id: string; chat_id: string | null }>(
        "SELECT id, chat_id FROM groups WHERE id = ANY($1)",
        [selection.groupIds],
      );
      const found = new Set(groups.rows.map((row) => row.id));
      const missing = selection.groupIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        // Not fail(): the pool must be closed by the finally block.
        console.error(
          `Unknown group id(s): ${missing.join(", ")}. Nothing was deleted.`,
        );
        console.error("");
        console.error(PURGE_USAGE);
        process.exitCode = 1;
        return;
      }
      const unlinked = groups.rows.filter((row) => row.chat_id === null);
      if (unlinked.length > 0) {
        console.warn(
          `Warning: ${unlinked.length} group(s) have no linked chat and cannot ` +
            "match any messages.",
        );
      }
      for (const row of groups.rows) {
        if (row.chat_id !== null) chatIds.push(row.chat_id);
      }
    }

    // Selectors combine with AND: a chat filter narrows what --before
    // deletes, and vice versa. The plan covers BOTH tables (fix round
    // A, audit M-2/M5): messages and the group_members roster — the
    // roster carries names/JIDs of departed members too.
    const plan = buildPurgePlan({ chatIds, before: selection.before });

    const counted = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM messages WHERE ${plan.messages.where}`,
      plan.messages.params,
    );
    const total = Number(counted.rows[0]?.count ?? "0");
    const membersCounted = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM group_members WHERE ${plan.members.where}`,
      plan.members.params,
    );
    const memberTotal = Number(membersCounted.rows[0]?.count ?? "0");
    console.log(`Matched ${total} message(s) and ${memberTotal} member row(s).`);
    if (total === 0 && memberTotal === 0) return;

    if (!selection.assumeYes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer = "";
      try {
        answer = await rl.question(
          `Type ${PURGE_CONFIRMATION} to PERMANENTLY delete ${total} message(s) ` +
            `and ${memberTotal} member row(s): `,
        );
      } finally {
        rl.close();
      }
      if (answer.trim() !== PURGE_CONFIRMATION) {
        console.error("Aborted (confirmation did not match). Nothing was deleted.");
        process.exitCode = 1;
        return;
      }
    }

    const deleted = await pool.query(
      `DELETE FROM messages WHERE ${plan.messages.where}`,
      plan.messages.params,
    );
    const membersDeleted = await pool.query(
      `DELETE FROM group_members WHERE ${plan.members.where}`,
      plan.members.params,
    );
    console.log(
      `Deleted ${deleted.rowCount ?? 0} message(s) and ` +
        `${membersDeleted.rowCount ?? 0} member row(s).`,
    );
    console.log(
      "Note: database backups taken before this purge still contain the " +
        "deleted rows — protect and rotate dumps accordingly (ADR 0004).",
    );
  } finally {
    await pool.end();
  }
}

await main();
