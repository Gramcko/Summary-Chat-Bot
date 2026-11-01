import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { NewMessage } from "./normalize.js";
import type { DiscoveredChat } from "./whatsapp/adapter.js";

/**
 * bot-worker's own thin PostgreSQL access layer (architecture §4.3/§4.5,
 * ADR 0004). Deliberately NOT the backend's Store: bot-worker is an
 * independent service and depends only on the database schema. All SQL
 * is parameterized; values are never interpolated into query strings.
 *
 * Ingestion idempotency is enforced by the database constraint
 * UNIQUE(connection_id, chat_id, whatsapp_message_id): duplicate
 * deliveries hit ON CONFLICT DO NOTHING and count as already captured
 * (architecture §5.1).
 */

/**
 * Connection states persisted in `whatsapp_connections.state`. Mirrors
 * the CHECK constraint in backend/migrations/0001 and the
 * `ConnectionState` enum in @summarly/contracts/connection.ts (kept as a
 * local type on purpose: the bot-worker does not depend on the API
 * contract package).
 */
export type ConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "unavailable";

export interface InsertMessagesResult {
  inserted: number;
  /** Duplicate deliveries already captured by an earlier insert. */
  duplicates: number;
  /**
   * Rows for chats that were not monitored at INSERT time and were
   * refused by the database-level privacy boundary (see insertMessages).
   */
  droppedUnmonitored: number;
}

export interface UpsertChatsResult {
  inserted: number;
  updated: number;
}

export interface ChatDefaults {
  /** Time zone for NEW groups only; never overwrites admin settings. */
  timezone: string;
}

export interface BotDb {
  /**
   * Returns the id of the single linked-session row
   * (`whatsapp_connections`), creating it on first use.
   */
  ensureConnection(): Promise<string>;
  /** Persists a connection-state transition (updates state and since). */
  setConnectionState(connectionId: string, state: ConnectionState): Promise<void>;
  /** Subset of `chatJids` whose group row exists and is monitored. */
  filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>>;
  /** Idempotent batch insert; returns inserted vs already-captured counts. */
  insertMessages(
    connectionId: string,
    rows: NewMessage[],
  ): Promise<InsertMessagesResult>;
  /**
   * Privacy-first discovery upsert (ADR 0004): inserts NEW groups with
   * monitored = false and the default time zone; on an existing chat_id
   * ONLY the name is updated — monitored, timezone, summary_time, and id
   * are never clobbered.
   */
  upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult>;
}

type ConnectionRow = QueryResultRow & { id: string };
type ChatIdRow = QueryResultRow & { chat_id: string };
type InsertCountRow = QueryResultRow & { inserted: boolean };

/** Rows per INSERT statement (7 params each; stays far below limits). */
const INSERT_CHUNK = 200;

export class PostgresBotDb implements BotDb {
  constructor(private readonly pool: Pool) {}

  async ensureConnection(): Promise<string> {
    // The table has a single-row unique index; ON CONFLICT DO NOTHING
    // (no target: matches the expression index) makes concurrent starts
    // race-safe — the loser falls through to the SELECT.
    const inserted = await this.pool.query<ConnectionRow>(
      "INSERT INTO whatsapp_connections (state) VALUES ('connecting') " +
        "ON CONFLICT DO NOTHING RETURNING id",
    );
    const row = inserted.rows[0];
    if (row !== undefined) return row.id;
    const selected = await this.pool.query<ConnectionRow>(
      "SELECT id FROM whatsapp_connections LIMIT 1",
    );
    const existing = selected.rows[0];
    if (existing === undefined) {
      throw new Error("ensureConnection inserted nothing and found nothing");
    }
    return existing.id;
  }

  async setConnectionState(
    connectionId: string,
    state: ConnectionState,
  ): Promise<void> {
    // `since` marks when the current state started (contracts
    // ConnectionStatus). updated_at keeps the row auditable.
    await this.pool.query(
      "UPDATE whatsapp_connections SET state = $2, since = now(), " +
        "updated_at = now() WHERE id = $1",
      [connectionId, state],
    );
  }

  async filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>> {
    if (chatJids.length === 0) return new Set();
    const result = await this.pool.query<ChatIdRow>(
      "SELECT chat_id FROM groups WHERE monitored = true AND chat_id = ANY($1::text[])",
      [chatJids],
    );
    return new Set(result.rows.map((row) => row.chat_id));
  }

  async insertMessages(
    connectionId: string,
    rows: NewMessage[],
  ): Promise<InsertMessagesResult> {
    if (rows.length === 0) {
      return { inserted: 0, duplicates: 0, droppedUnmonitored: 0 };
    }
    const client = await this.pool.connect();
    let inserted = 0;
    let monitoredNow = 0;
    try {
      await client.query("BEGIN");
      // Counting aid ONLY (not the privacy boundary): which chats are
      // monitored right now, for accurate log counts. Enforcement is the
      // EXISTS clause inside the INSERT below (CR-M2/audit M4: the row
      // must not depend on an earlier filter that could be stale).
      const monitoredResult = await client.query<{ chat_id: string }>(
        "SELECT chat_id FROM groups WHERE monitored = true AND chat_id = ANY($1::text[])",
        [[...new Set(rows.map((row) => row.chatJid))]],
      );
      const monitoredSet = new Set(
        monitoredResult.rows.map((row) => row.chat_id),
      );
      monitoredNow = rows.filter((row) => monitoredSet.has(row.chatJid)).length;

      for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
        const chunk = rows.slice(offset, offset + INSERT_CHUNK);
        const values: unknown[] = [connectionId];
        const tuples: string[] = [];
        let param = 2;
        for (const row of chunk) {
          tuples.push(
            `($1::uuid, $${param}::text, $${param + 1}::text, $${param + 2}::text, $${param + 3}::timestamptz, $${param + 4}::text, $${param + 5}::text)`,
          );
          values.push(
            row.chatJid,
            row.whatsappMessageId,
            row.senderJid,
            row.sentAt,
            row.body,
            row.messageType,
          );
          param += 6;
        }
        // Privacy boundary INSIDE the write (audit M4): a row is only
        // inserted when its chat is currently monitored — even if the
        // caller's earlier filter said otherwise (a group unmonitored
        // between filter and insert is never written).
        const result = await client.query(
          `INSERT INTO messages
             (connection_id, chat_id, whatsapp_message_id, sender_id, sent_at, body, message_type)
           SELECT t.connection_id, t.chat_id, t.whatsapp_message_id,
                  t.sender_id, t.sent_at, t.body, t.message_type
           FROM (VALUES ${tuples.join(", ")}) AS t
             (connection_id, chat_id, whatsapp_message_id, sender_id, sent_at, body, message_type)
           WHERE EXISTS (
             SELECT 1 FROM groups g
             WHERE g.chat_id = t.chat_id AND g.monitored = true
           )
           ON CONFLICT (connection_id, chat_id, whatsapp_message_id) DO NOTHING`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
      if (inserted > 0) {
        // Operational metadata only: when the latest captured message
        // happened (contracts ConnectionStatus.lastMessageAt).
        const newest = rows.reduce(
          (max, row) => (row.sentAt > max ? row.sentAt : max),
          rows[0]!.sentAt,
        );
        await client.query(
          "UPDATE whatsapp_connections SET " +
            "last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), " +
            "updated_at = now() WHERE id = $1",
          [connectionId, newest],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    // Counting note: rows refused by the EXISTS clause in a race window
    // (unmonitored between the counting aid and the INSERT) are counted
    // as duplicates; counts feed logs only, the data outcome is exact.
    const droppedUnmonitored = rows.length - monitoredNow;
    const duplicates = Math.max(0, monitoredNow - inserted);
    return { inserted, duplicates, droppedUnmonitored };
  }

  async upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult> {
    // One row per chat: a repeated chatJid in the input would make
    // ON CONFLICT DO UPDATE fail ("cannot affect row a second time").
    const byJid = new Map<string, string>();
    for (const chat of chats) {
      if (chat.chatJid !== "") byJid.set(chat.chatJid, chat.name);
    }
    const entries = [...byJid.entries()];
    if (entries.length === 0) return { inserted: 0, updated: 0 };

    let inserted = 0;
    let updated = 0;
    for (let offset = 0; offset < entries.length; offset += INSERT_CHUNK) {
      const chunk = entries.slice(offset, offset + INSERT_CHUNK);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let param = 1;
      for (const [chatJid, name] of chunk) {
        // groups.id has no database default (ADR 0004): generate uuids
        // at insert. NEW rows are opt-out of collection: monitored=false
        // and the DEFAULT_GROUP_TIMEZONE; the admin opts in per group in
        // the dashboard (AGENTS.md: minimize collection).
        tuples.push(`($${param}, $${param + 1}, $${param + 2}, false, $${param + 3}, NULL)`);
        values.push(randomUUID(), chatJid, name, defaults.timezone);
        param += 4;
      }
      // NEVER-clobber rule (ADR 0004, regression-tested): on an existing
      // chat_id ONLY the name is updated. monitored, timezone,
      // summary_time, and id keep whatever the admin configured.
      const result = await this.pool.query<InsertCountRow>(
        `INSERT INTO groups (id, chat_id, name, monitored, timezone, summary_time)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (chat_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        values,
      );
      for (const row of result.rows) {
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
    }
    return { inserted, updated };
  }
}
