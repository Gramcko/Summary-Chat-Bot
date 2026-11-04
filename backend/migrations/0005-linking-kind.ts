import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Fix round A (ADR 0008): the pairing payload's KIND — `qr` or
 * `pairing-code` (typed-code linking, WA_PHONE_NUMBER) — is published
 * by the bot-worker alongside `linking_qr`. NULL means "not published
 * yet": those payloads are served as `qr`, the documented default for
 * QR payloads (ConnectionLinking.kind, packages/contracts).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("whatsapp_connections", {
    linking_kind: {
      type: "text",
      check: "linking_kind IS NULL OR linking_kind IN ('qr', 'pairing-code')",
      comment:
        "Pairing payload kind published by bot-worker; NULL = qr (default)",
    },
  });
}

/** Drops only what this migration added. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("whatsapp_connections", ["linking_kind"]);
}
