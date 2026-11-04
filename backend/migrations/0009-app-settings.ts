import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Global application settings (ADR 0008 follow-up). Currently holds the
 * default IANA time zone used for NEW groups discovered by the
 * bot-worker and as the initial value of the summary request form.
 * Existing groups keep their own configured zone.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("app_settings", {
    id: {
      type: "smallint",
      primaryKey: true,
      default: 1,
      comment: "Single-row settings table",
    },
    default_timezone: {
      type: "text",
      notNull: true,
      default: "UTC",
      comment: "IANA zone for new groups / summary-form default",
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.sql(
    "INSERT INTO app_settings (id, default_timezone) VALUES (1, 'UTC') " +
      "ON CONFLICT (id) DO NOTHING",
  );
}

/** Drops the settings table; group time zones are unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("app_settings");
}
