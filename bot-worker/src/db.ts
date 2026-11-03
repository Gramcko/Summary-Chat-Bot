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

/** A claimed history import (ADR 0007). */
export interface HistoryImportClaim {
  groupId: string;
  chatJid: string;
  requestedAt: Date;
  /** Claim timestamp; guards completion against stale/older claims. */
  startedAt: Date;
}

export interface HistoryImportOutcome {
  /** `done` = completed within budget (partial by design); `failed`. */
  status: "done" | "failed";
  /** Messages INSERTED by this import (duplicates do not count). */
  importedCount: number;
  /** Safe code/short message only; null on success. */
  error: string | null;
}

export interface UpsertChatsResult {
  inserted: number;
  updated: number;
}

export interface ChatDefaults {
  /** Time zone for NEW groups only; never overwrites admin settings. */
  timezone: string;
}

export interface InsertMessagesOptions {
  /**
   * Whether the insert may update `whatsapp_connections.last_message_at`
   * (default true). History imports pass false: imported messages are
   * historical and must not masquerade as live traffic (ADR 0007).
   */
  touchLastMessage?: boolean;
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
    options?: InsertMessagesOptions,
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

  // ---- History imports (ADR 0007) ----

  /**
   * Atomically claims up to `limit` groups with
   * `history_import_status = 'pending'` that are ALSO `monitored`
   * (privacy boundary, SQL-enforced) and have a linked chat. Sets them
   * `running` with `started_at = now()` and returns the claims. Uses
   * FOR UPDATE SKIP LOCKED, so concurrent claimers never double-claim.
   */
  claimPendingHistoryImports(limit?: number): Promise<HistoryImportClaim[]>;
  /**
   * Finishes a claimed import (`done`/`failed` with counts and a safe
   * error code). Guarded by the claim's `started_at` so a stale claim
   * can never overwrite a newer import's outcome.
   */
  completeHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    outcome: HistoryImportOutcome,
  ): Promise<boolean>;
  /**
   * Publishes incremental progress (the running inserted count) so the
   * dashboard can render "N imported so far" before the terminal state
   * (CR-M2). Guarded exactly like completion (`running` + `started_at`
   * fence): a stale claim never overwrites a newer import's progress.
   */
  updateHistoryImportProgress(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    importedCount: number,
  ): Promise<boolean>;
  /**
   * Stale-claim recovery: `running` imports whose `started_at` is older
   * than `olderThanMs` (a crashed worker) go back to `pending` so they
   * can be claimed again. The staleness comparison runs in SQL against
   * the DATABASE clock (SA-L1) — never the worker clock — so clock skew
   * cannot requeue an active import. Returns how many rows were
   * requeued.
   */
  requeueStaleHistoryImports(olderThanMs: number): Promise<number>;
  /**
   * Graceful-shutdown release: the claim goes back to `pending`
   * immediately (guarded by `started_at`). Returns true when released.
   */
  releaseHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
  ): Promise<boolean>;
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
    options: InsertMessagesOptions = {},
  ): Promise<InsertMessagesResult> {
    const touchLastMessage = options.touchLastMessage !== false;
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
      if (inserted > 0 && touchLastMessage) {
        // Operational metadata only: when the latest LIVE captured
        // message happened (contracts ConnectionStatus.lastMessageAt).
        // Historical imports skip this — they must not masquerade as
        // live traffic (ADR 0007).
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

  // ---- History imports (ADR 0007) ----

  async claimPendingHistoryImports(
    limit = 1,
  ): Promise<HistoryImportClaim[]> {
    // Atomic claim (single statement, FOR UPDATE SKIP LOCKED in the
    // subselect): concurrent claimers pick disjoint rows. The privacy
    // boundary is IN the WHERE clause — an unmonitored group is never
    // claimed even if a pending request exists (its status stays
    // 'pending' until the admin opts the group in).
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      history_import_requested_at: Date | null;
      history_import_started_at: Date;
    }>(
      // date_trunc('milliseconds') keeps the timestamp exactly
      // round-trippable through JavaScript Dates (which have ms, not µs,
      // precision) — completion/release match on this value as the
      // claim guard.
      `UPDATE groups
       SET history_import_status = 'running',
           history_import_started_at = date_trunc('milliseconds', now()),
           updated_at = now()
       WHERE id IN (
         SELECT id FROM groups
         WHERE history_import_status = 'pending'
           AND monitored = true
           AND chat_id IS NOT NULL
         ORDER BY history_import_requested_at ASC NULLS LAST
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, chat_id, history_import_requested_at, history_import_started_at`,
      [Math.max(1, Math.floor(limit))],
    );
    return result.rows.map((row) => ({
      groupId: row.id,
      chatJid: row.chat_id,
      requestedAt: row.history_import_requested_at ?? row.history_import_started_at,
      startedAt: row.history_import_started_at,
    }));
  }

  async completeHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    outcome: HistoryImportOutcome,
  ): Promise<boolean> {
    // The started_at guard makes completion idempotent-safe against
    // stale claims: a released/requeued import that was re-claimed has
    // a newer started_at and this write becomes a no-op.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = $2,
           history_import_finished_at = now(),
           history_import_imported_count = $3,
           history_import_error = $4,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $5`,
      [
        claim.groupId,
        outcome.status,
        Math.max(0, Math.floor(outcome.importedCount)),
        outcome.error === null ? null : outcome.error.slice(0, 200),
        claim.startedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateHistoryImportProgress(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
    importedCount: number,
  ): Promise<boolean> {
    // Same fence as completion (CR-M2): stale claims never overwrite a
    // newer import's progress.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_imported_count = $2,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $3`,
      [
        claim.groupId,
        Math.max(0, Math.floor(importedCount)),
        claim.startedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async requeueStaleHistoryImports(olderThanMs: number): Promise<number> {
    // Crash recovery (ADR 0007): a 'running' claim whose worker died is
    // re-claimable after the staleness threshold. The comparison runs
    // against the DATABASE clock (make_interval + now(), SA-L1) so
    // worker/DB clock skew can never requeue a live import.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = 'pending',
           history_import_started_at = NULL,
           updated_at = now()
       WHERE history_import_status = 'running'
         AND history_import_started_at < now() - make_interval(secs => $1::double precision)`,
      [Math.max(0, olderThanMs) / 1000],
    );
    return result.rowCount ?? 0;
  }

  async releaseHistoryImport(
    claim: Pick<HistoryImportClaim, "groupId" | "startedAt">,
  ): Promise<boolean> {
    // Graceful shutdown: hand the claim back immediately so the next
    // start picks it up without waiting for the staleness threshold.
    const result = await this.pool.query(
      `UPDATE groups
       SET history_import_status = 'pending',
           history_import_started_at = NULL,
           updated_at = now()
       WHERE id = $1
         AND history_import_status = 'running'
         AND history_import_started_at = $2`,
      [claim.groupId, claim.startedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
