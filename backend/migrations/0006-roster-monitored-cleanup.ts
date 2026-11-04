import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Fix round B (audit H-1): rosters are MONITORED-GROUP-ONLY. The API
 * gate landed in the same round (GET /api/groups/:id/members answers
 * 409 for unmonitored groups) and the bot-worker only syncs rosters for
 * monitored groups from now on — this migration removes the rows that
 * the earlier ungated capture left behind for chats no monitored group
 * claims.
 *
 * The DELETE matches the cleanup scope exactly: a roster row survives
 * only when SOME monitored group points at its chat_id (groups.chat_id
 * is the documented join path). Rows for chats whose group was
 * un-monitored after capture go too — un-monitoring revokes consent
 * (ADR 0004 privacy boundary), so their names/JIDs must not linger.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM group_members gm
    WHERE NOT EXISTS (
      SELECT 1 FROM groups g
      WHERE g.chat_id = gm.chat_id
        AND g.monitored = true
    )
  `);
}

/**
 * Deliberate NO-OP: the deleted rows are PII (member names and JIDs)
 * whose removal is exactly what this migration accomplishes. A down
 * migration cannot restore them from anywhere, and inventing rows
 * would recreate the privacy exposure the cleanup removed — so `down`
 * restores schema (there is none here) and nothing else. Rolling back
 * this migration therefore keeps the cleanup in effect.
 */
export async function down(_pgm: MigrationBuilder): Promise<void> {
  // Intentionally empty — see the doc comment.
}
