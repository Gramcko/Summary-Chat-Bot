import type { MigrationBuilder } from "node-pg-migrate";

/**
 * History import for monitored groups (ADR 0007): when the admin opts
 * a group into monitoring they may also ask for its older WhatsApp
 * history. The backend REQUESTS an import by setting these columns;
 * the bot-worker POLLS them, runs the bounded import, and reports
 * progress back — no new queue and no cross-service RPC (the DB flag
 * is the coordination point, consistent with architecture §4.3).
 *
 * Columns are system-managed: `PATCH /api/groups/:id` never writes
 * them (contracts exclude them from UpdateGroupRequest) and group
 * discovery never resets them (0001/0002 are not amended; existing
 * rows get NULL status and a 0 count, meaning "never requested").
 *
 * `history_import_error` holds a safe code/short message only — never
 * message content, credentials, or provider/WhatsApp internals
 * (same policy as summary_runs.error_*).
 *
 * Status flow: pending -> running -> done | failed. Repeated requests
 * are allowed after done/failed but are a no-op while pending/running.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("groups", {
    history_import_status: {
      type: "text",
      check: "history_import_status IN ('pending','running','done','failed')",
      comment: "System-managed history import state (ADR 0007)",
    },
    history_import_requested_at: { type: "timestamptz" },
    history_import_started_at: { type: "timestamptz" },
    history_import_finished_at: { type: "timestamptz" },
    history_import_imported_count: {
      type: "integer",
      notNull: true,
      default: 0,
      check: "history_import_imported_count >= 0",
    },
    history_import_error: {
      type: "text",
      comment: "Safe code/short message only; never content or secrets",
    },
  });
}

/** Drops the history-import columns; groups keep their data and prefs. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("groups", [
    "history_import_status",
    "history_import_requested_at",
    "history_import_started_at",
    "history_import_finished_at",
    "history_import_imported_count",
    "history_import_error",
  ]);
}
