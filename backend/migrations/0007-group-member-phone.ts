import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Roster name resolution (ADR 0008 follow-up): Baileys group metadata
 * carries only participant JIDs, so LID-addressed groups show opaque
 * LIDs. Store the PN JID as a fallback identifier for the admin UI and
 * leave `name` to be filled from contacts / message push names.
 *
 * `phone` is a phone-number JID (`…@s.whatsapp.net`) — PII like the rest
 * of the roster, served on the authenticated admin API only.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("group_members", {
    phone: {
      type: "text",
      comment: "PN JID fallback identifier; PII (admin-only APIs)",
    },
  });
}

/** Drops the fallback identifier; names and JIDs are unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("group_members", ["phone"]);
}
