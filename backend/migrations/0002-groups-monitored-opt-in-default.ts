import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Privacy default (audit M4 / ADR 0004): groups discovered by
 * bot-worker are registered UNMONITORED and the admin opts each group
 * in explicitly (AGENTS.md: minimize collection). The 0001 schema
 * defaulted `monitored` to true, which contradicted that policy for any
 * insert that omitted the column (e.g. test seeds and future writers).
 *
 * Existing rows are NOT modified: a group the admin already made
 * monitored keeps its state (this migration changes only the DEFAULT
 * for future inserts). The capture write path enforces the monitored
 * boundary inside its INSERT (bot-worker/src/db.ts), so the default is
 * defense in depth, not the only line of defense.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("groups", "monitored", { default: false });
}

/** Restores the 0001 default (true). */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("groups", "monitored", { default: true });
}
