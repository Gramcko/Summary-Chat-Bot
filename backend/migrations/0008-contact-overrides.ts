import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Manual contact display names (ADR 0008 follow-up). WhatsApp only
 * exposes saved-contact/push names, so the admin can override the
 * display name for a contact. The override is keyed by the canonical
 * contact id (PN JID when known, else LID) and wins over roster names;
 * automatic roster refreshes never overwrite it.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("contact_overrides", {
    contact_id: {
      type: "text",
      primaryKey: true,
      comment: "Canonical contact id (PN JID or LID; PII)",
    },
    name: {
      type: "text",
      notNull: true,
      comment: "Admin-provided display name (PII)",
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
}

/** Drops the overrides; roster names and messages are unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("contact_overrides");
}
