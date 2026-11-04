import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Product upgrade round 1 (ADR 0008): group detail data and session
 * control surfaces.
 *
 * - `messages.sender_name`: WhatsApp push name of the sender (display
 *   only — names are PII; admin-only APIs, retention applies).
 * - `summary_runs.instructions`: admin-supplied custom summary
 *   instructions (contract caps at 2000 chars; NULL when absent).
 * - `group_members`: best-effort roster snapshot per chat (membership
 *   events are not replayable; the bot-worker refreshes it).
 * - `whatsapp_connections.linking_qr` / `linking_qr_expires_at`: the
 *   current pairing-code/QR payload. It is a LIVE PAIRING TICKET —
 *   exposed only through the authenticated API, never logged.
 *   `logout_requested_at`: admin "end/unlink session" control flag the
 *   bot-worker consumes and clears.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("messages", {
    sender_name: {
      type: "text",
      comment: "WhatsApp push name of the sender; display only (PII)",
    },
  });

  pgm.addColumns("summary_runs", {
    instructions: {
      type: "text",
      comment: "Admin custom summary instructions; NULL when absent",
    },
  });

  pgm.createTable("group_members", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    chat_id: { type: "text", notNull: true },
    user_id: {
      type: "text",
      notNull: true,
      comment: "WhatsApp user JID (PII; admin-only APIs)",
    },
    name: { type: "text", comment: "WhatsApp push name; display only (PII)" },
    is_admin: { type: "boolean", notNull: true, default: false },
    active: {
      type: "boolean",
      notNull: true,
      default: true,
      comment: "false once the member left the chat (kept as history)",
    },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("group_members", "group_members_chat_user_uniq", {
    unique: ["chat_id", "user_id"],
  });
  pgm.createIndex("group_members", ["chat_id"], {
    name: "group_members_chat_id_idx",
  });

  pgm.addColumns("whatsapp_connections", {
    linking_qr: {
      type: "text",
      comment: "Current pairing QR/payload — a live pairing ticket; auth-only API, never logged",
    },
    linking_qr_expires_at: { type: "timestamptz" },
    logout_requested_at: {
      type: "timestamptz",
      comment: "Admin end/unlink request; consumed and cleared by bot-worker",
    },
  });
}

/** Drops everything this migration added; captured data lives elsewhere. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("whatsapp_connections", [
    "linking_qr",
    "linking_qr_expires_at",
    "logout_requested_at",
  ]);
  pgm.dropTable("group_members");
  pgm.dropColumns("summary_runs", ["instructions"]);
  pgm.dropColumns("messages", ["sender_name"]);
}
