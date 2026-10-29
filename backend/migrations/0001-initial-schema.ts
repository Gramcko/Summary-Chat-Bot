import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Initial schema for the PostgreSQL persistence milestone
 * (docs/architecture.md §4.5). Conventions:
 *
 * - uuid primary keys (gen_random_uuid(), built into PostgreSQL 13+).
 * - timestamptz for every timestamp; the app stores explicit IANA time
 *   zones as labels next to half-open intervals [start_at, end_at).
 * - Idempotency and run identity are enforced with database constraints,
 *   not only in application memory (architecture §5.1, §6).
 * - Only non-secret connection metadata is stored; WhatsApp session state
 *   stays in protected file storage (AGENTS.md).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---- WhatsApp connection metadata (single linked session) ----
  pgm.createTable("whatsapp_connections", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    state: {
      type: "text",
      notNull: true,
      default: "unavailable",
      check: "state IN ('connected', 'connecting', 'disconnected', 'unavailable')",
    },
    since: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_message_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // One linked WhatsApp session per installation (single-admin MVP).
  pgm.sql(
    "CREATE UNIQUE INDEX whatsapp_connections_single_row ON whatsapp_connections ((true))",
  );

  // ---- Monitored groups ----
  pgm.createTable("groups", {
    id: { type: "uuid", primaryKey: true },
    // WhatsApp chat identity (JID). Join path to captured messages:
    // groups.chat_id = messages.chat_id. Nullable for groups not yet
    // linked to a discovered chat (UNIQUE allows multiple NULLs);
    // UNIQUE because one chat is one group. Connection-scoping of the
    // join is a bot-worker/ADR-D4 decision — the MVP assumes one linked
    // WhatsApp session (architecture §3).
    chat_id: {
      type: "text",
      unique: true,
      comment:
        "WhatsApp chat JID; join path to messages: groups.chat_id = messages.chat_id. Connection-scoping is a bot-worker/D4 decision (MVP: one linked session)",
    },
    name: { type: "text", notNull: true },
    monitored: { type: "boolean", notNull: true, default: true },
    timezone: { type: "text", notNull: true },
    // Daily cutoff (HH:mm) local to `timezone`; null = no cutoff yet.
    summary_time: {
      type: "text",
      check: "summary_time IS NULL OR summary_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // ---- Normalized messages (written by bot-worker) ----
  pgm.createTable("messages", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    connection_id: {
      type: "uuid",
      notNull: true,
      references: "whatsapp_connections",
      onDelete: "CASCADE",
    },
    // Stable WhatsApp chat/group identifier (JID).
    chat_id: { type: "text", notNull: true },
    // Stable WhatsApp message identifier within the chat.
    whatsapp_message_id: { type: "text", notNull: true },
    sender_id: { type: "text" },
    sent_at: { type: "timestamptz", notNull: true },
    body: { type: "text", notNull: true },
    message_type: {
      type: "text",
      notNull: true,
      default: "text",
      check: "message_type IN ('text', 'link', 'other')",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  }, {
    // Idempotent ingestion: duplicate WhatsApp deliveries hit this
    // constraint and are treated as already captured (architecture §5.1).
    constraints: {
      unique: [["connection_id", "chat_id", "whatsapp_message_id"]],
    },
  });
  pgm.createIndex(
    "messages",
    ["chat_id", { name: "sent_at", sort: "ASC" }],
    { name: "messages_chat_sent_at_idx" },
  );

  // ---- Summary runs ----
  pgm.createTable("summary_runs", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    group_id: {
      type: "uuid",
      notNull: true,
      references: "groups",
      onDelete: "RESTRICT",
    },
    kind: {
      type: "text",
      notNull: true,
      check: "kind IN ('manual', 'scheduled')",
    },
    status: {
      type: "text",
      notNull: true,
      default: "pending",
      check: "status IN ('pending', 'processing', 'completed', 'failed')",
    },
    // Half-open interval [start_at, end_at); compared as instants.
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz", notNull: true },
    // IANA label for presentation; NOT part of run identity.
    timezone: { type: "text", notNull: true },
    attempts: {
      type: "integer",
      notNull: true,
      default: 0,
      check: "attempts >= 0",
    },
    // Safe error metadata only (category + short message), never content.
    error_code: { type: "text" },
    error_message: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  }, {
    constraints: {
      // Instant-based run identity (architecture §5.2/§5.3, §6): the
      // timezone label is deliberately excluded, so equivalent spellings
      // of the same interval map to the same run.
      unique: [["group_id", "start_at", "end_at", "kind"]],
      check: ["end_at > start_at"],
    },
  });
  pgm.createIndex(
    "summary_runs",
    [{ name: "created_at", sort: "DESC" }],
    { name: "summary_runs_created_at_idx" },
  );

  // ---- Validated summaries (written by summary-worker) ----
  pgm.createTable("summaries", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    // One summary per run; repeated job executions update this row
    // instead of creating duplicates (architecture §6).
    run_id: {
      type: "uuid",
      notNull: true,
      unique: true,
      references: "summary_runs",
      onDelete: "CASCADE",
    },
    provider: { type: "text", notNull: true },
    model: { type: "text", notNull: true },
    // Validated SummaryResult (packages/contracts/src/summary.ts).
    result: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // ---- AI provider configuration (single provider) ----
  pgm.createTable("ai_provider_configs", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    provider: { type: "text", notNull: true },
    model: { type: "text", notNull: true },
    base_url: { type: "text" },
    api_key_encrypted: {
      type: "text",
      comment:
        "AES-256-GCM envelope (enc:v1:<iv>:<auth tag>:<ciphertext>); never plaintext (AGENTS.md)",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.sql(
    "CREATE UNIQUE INDEX ai_provider_configs_single_row ON ai_provider_configs ((true))",
  );

  // ---- Administrator credentials (single administrator) ----
  pgm.createTable("admin_credentials", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    // scrypt hash (lib/password.ts); the password itself is never stored.
    password_hash: { type: "text", notNull: true },
    // SHA-256 hashes of the 128-bit one-time recovery codes.
    recovery_code_hashes: {
      type: "text",
      array: true,
      notNull: true,
      default: "{}",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.sql(
    "CREATE UNIQUE INDEX admin_credentials_single_row ON admin_credentials ((true))",
  );

  // ---- Admin sessions ----
  pgm.createTable("admin_sessions", {
    // SHA-256 of the opaque cookie token; the token itself is never stored.
    token_hash: { type: "text", primaryKey: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
}

/** Drops everything in reverse dependency order. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("admin_sessions");
  pgm.dropTable("admin_credentials");
  pgm.dropTable("ai_provider_configs");
  pgm.dropTable("summaries");
  pgm.dropTable("summary_runs");
  pgm.dropTable("messages");
  pgm.dropTable("groups");
  pgm.dropTable("whatsapp_connections");
}
