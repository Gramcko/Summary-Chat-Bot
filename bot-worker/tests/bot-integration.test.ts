import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresBotDb, type BotDb } from "../src/db.js";
import { HistoryImportService } from "../src/history-import.js";
import { CaptureService } from "../src/service.js";
import type { NewMessage } from "../src/normalize.js";
import { assertTestDatabaseName } from "../scripts/test-db-guard.js";
import { FakeAdapter, findEvents, rawMessage, recordingLogger, type LogEntry } from "./fakes.js";

/**
 * bot-worker integration tests against REAL PostgreSQL
 * (docker-compose.dev.yml).
 *
 * SAFETY (DEF-2): every test TRUNCATEs all application tables. NEVER
 * point DATABASE_URL at a database with real data — destructive setup
 * refuses to run unless the database name ends in `_test` or contains
 * `_e2e_` (or SUMMARLY_TEST_DB_CONFIRM=yes is set explicitly).
 *
 * Recommended entry point (fails fast instead of skipping):
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   createdb summarly_bot_test
 *   npm run migrate -w @summarly/backend up
 *   DATABASE_URL=.../summarly_bot_test \
 *     npm run test:integration -w @summarly/bot-worker
 *
 * Without DATABASE_URL the suite is SKIPPED and a loud warning is
 * printed — never silently.
 */

const databaseUrl = process.env["DATABASE_URL"]?.trim();
const hasConfig = databaseUrl !== undefined && databaseUrl !== "";

if (!hasConfig) {
  process.stderr.write(
    "[summarly] WARNING: bot-worker integration tests were SKIPPED " +
      "(DATABASE_URL is not set). Run them with " +
      "`npm run test:integration -w @summarly/bot-worker` " +
      "(requires PostgreSQL — see docker-compose.dev.yml).\n",
  );
}

const shouldRun = hasConfig;

const GROUP_A = "111111111111-22222222@g.us";
const GROUP_B = "333333333333-44444444@g.us";

function newMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    chatJid: GROUP_A,
    whatsappMessageId: `WA-${randomUUID()}`,
    senderJid: "sender@s.whatsapp.net",
    sentAt: new Date("2026-11-01T10:00:00Z"),
    body: "hello",
    messageType: "text",
    ...overrides,
  };
}

describe.skipIf(!shouldRun)(
  "bot-worker PostgreSQL integration",
  () => {
    let pool: Pool;
    let db: BotDb;

    beforeAll(async () => {
      if (databaseUrl === undefined) {
        throw new Error("DATABASE_URL missing"); // unreachable: gated above
      }
      pool = new Pool({ connectionString: databaseUrl });
      // DEF-2: refuse before ANY destructive statement when the target is
      // not unmistakably a throwaway test database.
      const result = await pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      assertTestDatabaseName(result.rows[0]?.name ?? "");
      db = new PostgresBotDb(pool);
    });

    beforeEach(async () => {
      // Destructive: only ever safe against a throwaway database (the
      // guard above). Mirrors the summary-worker suite.
      await pool.query(
        "TRUNCATE TABLE messages, groups, whatsapp_connections, " +
          "summary_runs, summaries, ai_provider_configs, " +
          "admin_credentials, admin_sessions",
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it("ensureConnection creates and reuses the single connection row", async () => {
      const first = await db.ensureConnection();
      const second = await db.ensureConnection();
      expect(second).toBe(first);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM whatsapp_connections",
      );
      expect(count.rows[0]?.count).toBe("1");
    });

    it("setConnectionState persists the state and refreshes since", async () => {
      const connectionId = await db.ensureConnection();
      await db.setConnectionState(connectionId, "connected");
      let row = await pool.query<{
        state: string;
        since: Date;
      }>("SELECT state, since FROM whatsapp_connections WHERE id = $1", [
        connectionId,
      ]);
      expect(row.rows[0]?.state).toBe("connected");

      await db.setConnectionState(connectionId, "unavailable");
      row = await pool.query<{
        state: string;
        since: Date;
      }>("SELECT state, since FROM whatsapp_connections WHERE id = $1", [
        connectionId,
      ]);
      expect(row.rows[0]?.state).toBe("unavailable");
    });

    it("insertMessages is idempotent on (connection_id, chat_id, whatsapp_message_id)", async () => {
      const connectionId = await db.ensureConnection();
      // The write refuses unmonitored chats (audit M4), so the group must
      // exist and be monitored first.
      await db.upsertDiscoveredChats(
        [{ chatJid: GROUP_A, name: "Group A" }],
        { timezone: "UTC" },
      );
      await pool.query(
        "UPDATE groups SET monitored = true WHERE chat_id = $1",
        [GROUP_A],
      );
      const rows = [
        newMessage({ whatsappMessageId: "WA-1", body: "one" }),
        newMessage({ whatsappMessageId: "WA-2", body: "two" }),
      ];

      const first = await db.insertMessages(connectionId, rows);
      expect(first).toEqual({ inserted: 2, duplicates: 0, droppedUnmonitored: 0 });

      // The same deliveries arrive again (Baileys redelivery/replay).
      const second = await db.insertMessages(connectionId, rows);
      expect(second).toEqual({ inserted: 0, duplicates: 2, droppedUnmonitored: 0 });

      // A third delivery of one id plus one genuinely new message.
      const third = await db.insertMessages(connectionId, [
        rows[0]!,
        newMessage({ whatsappMessageId: "WA-3", body: "three" }),
      ]);
      expect(third).toEqual({ inserted: 1, duplicates: 1, droppedUnmonitored: 0 });

      const count = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM messages",
      );
      expect(count.rows[0]?.count).toBe("3");

      // last_message_at tracks the newest captured message.
      const conn = await pool.query<{ last_message_at: Date | null }>(
        "SELECT last_message_at FROM whatsapp_connections WHERE id = $1",
        [connectionId],
      );
      expect(conn.rows[0]?.last_message_at).not.toBeNull();
    });

    it("the INSERT itself refuses rows for unmonitored chats (audit M4)", async () => {
      const connectionId = await db.ensureConnection();
      await db.upsertDiscoveredChats(
        [{ chatJid: GROUP_A, name: "Monitored" }, { chatJid: GROUP_B, name: "Unmonitored" }],
        { timezone: "UTC" },
      );
      await pool.query(
        "UPDATE groups SET monitored = true WHERE chat_id = $1",
        [GROUP_A],
      );

      const result = await db.insertMessages(connectionId, [
        newMessage({ chatJid: GROUP_A, whatsappMessageId: "WA-A1" }),
        newMessage({ chatJid: GROUP_B, whatsappMessageId: "WA-B1" }),
      ]);
      expect(result).toEqual({ inserted: 1, duplicates: 0, droppedUnmonitored: 1 });
      const rows = await pool.query<{ whatsapp_message_id: string }>(
        "SELECT whatsapp_message_id FROM messages ORDER BY whatsapp_message_id",
      );
      expect(rows.rows.map((row) => row.whatsapp_message_id)).toEqual(["WA-A1"]);
    });

    it("regression: unmonitoring BETWEEN filter and insert drops the row (audit M4)", async () => {
      const connectionId = await db.ensureConnection();
      await db.upsertDiscoveredChats(
        [{ chatJid: GROUP_A, name: "Race Group" }],
        { timezone: "UTC" },
      );
      await pool.query(
        "UPDATE groups SET monitored = true WHERE chat_id = $1",
        [GROUP_A],
      );

      // The service-side filter passes…
      const seen = await db.filterMonitoredChatIds([GROUP_A]);
      expect(seen.has(GROUP_A)).toBe(true);

      // …then the admin unmonitors the group before the write lands.
      await pool.query(
        "UPDATE groups SET monitored = false WHERE chat_id = $1",
        [GROUP_A],
      );

      const result = await db.insertMessages(connectionId, [
        newMessage({ chatJid: GROUP_A, whatsappMessageId: "WA-RACE" }),
      ]);
      // The database-level privacy boundary refuses the row: the earlier
      // filter must never be the only line of defense.
      expect(result.inserted).toBe(0);
      expect(result.droppedUnmonitored).toBe(1);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM messages",
      );
      expect(count.rows[0]?.count).toBe("0");
    });

    it("discovery upsert never clobbers admin preferences (regression)", async () => {
      // First discovery: new group, privacy-first defaults.
      let result = await db.upsertDiscoveredChats(
        [{ chatJid: GROUP_A, name: "Team" }],
        { timezone: "UTC" },
      );
      expect(result).toEqual({ inserted: 1, updated: 0 });

      let row = await pool.query<{
        id: string;
        name: string;
        monitored: boolean;
        timezone: string;
        summary_time: string | null;
      }>(
        "SELECT id, name, monitored, timezone, summary_time FROM groups WHERE chat_id = $1",
        [GROUP_A],
      );
      expect(row.rows[0]).toMatchObject({
        name: "Team",
        monitored: false,
        timezone: "UTC",
        summary_time: null,
      });
      const originalId = row.rows[0]?.id;

      // The admin opts in and configures the group (as the dashboard does).
      await pool.query(
        "UPDATE groups SET monitored = true, timezone = 'Europe/Madrid', " +
          "summary_time = '09:00' WHERE chat_id = $1",
        [GROUP_A],
      );

      // A subject rename (live event) updates ONLY the name.
      result = await db.upsertDiscoveredChats(
        [{ chatJid: GROUP_A, name: "Team Renamed" }],
        { timezone: "UTC" },
      );
      expect(result).toEqual({ inserted: 0, updated: 1 });
      row = await pool.query(
        "SELECT id, name, monitored, timezone, summary_time FROM groups WHERE chat_id = $1",
        [GROUP_A],
      );
      expect(row.rows[0]).toMatchObject({
        id: originalId,
        name: "Team Renamed",
        monitored: true,
        timezone: "Europe/Madrid",
        summary_time: "09:00",
      });

      // A full re-discovery (reconnect) also keeps the preferences and
      // registers new chats next to existing ones.
      result = await db.upsertDiscoveredChats(
        [
          { chatJid: GROUP_A, name: "Team v3" },
          { chatJid: GROUP_B, name: "Other" },
        ],
        { timezone: "Asia/Tokyo" },
      );
      expect(result).toEqual({ inserted: 1, updated: 1 });
      row = await pool.query(
        "SELECT id, name, monitored, timezone, summary_time FROM groups WHERE chat_id = $1",
        [GROUP_A],
      );
      expect(row.rows[0]).toMatchObject({
        id: originalId,
        name: "Team v3",
        monitored: true,
        timezone: "Europe/Madrid",
        summary_time: "09:00",
      });
      const other = await pool.query<{
        monitored: boolean;
        timezone: string;
      }>("SELECT monitored, timezone FROM groups WHERE chat_id = $1", [
        GROUP_B,
      ]);
      expect(other.rows[0]).toMatchObject({
        monitored: false,
        timezone: "Asia/Tokyo",
      });
    });

    it("full flow: fake adapter emits messages and rows land exactly once", async () => {
      const adapter = new FakeAdapter();
      const logs: LogEntry[] = [];
      const service = new CaptureService({
        adapter,
        db,
        log: recordingLogger(logs),
        defaultTimezone: "UTC",
        backoff: { baseMs: 1, capMs: 2 },
      });

      await service.start();
      // Discovery registers GROUP_A (unmonitored) and GROUP_B.
      adapter.fetchChatsResults = [
        { chatJid: GROUP_A, name: "Integration Group" },
        { chatJid: GROUP_B, name: "Unmonitored Group" },
      ];
      adapter.emit({ type: "open" });
      await service.idle();

      // The admin opts GROUP_A in (GROUP_B stays unmonitored).
      await pool.query(
        "UPDATE groups SET monitored = true WHERE chat_id = $1",
        [GROUP_A],
      );

      const messageOne = rawMessage({
        chatJid: GROUP_A,
        messageId: "WA-A1",
        text: "first",
        timestampSec: 1_772_000_000,
      });
      const messageTwo = rawMessage({
        chatJid: GROUP_A,
        messageId: "WA-A2",
        text: "second",
        timestampSec: 1_772_000_100,
      });
      const unmonitored = rawMessage({
        chatJid: GROUP_B,
        messageId: "WA-B1",
        text: "not captured",
      });
      const reaction = rawMessage({
        chatJid: GROUP_A,
        messageId: "WA-A3",
        kind: "reaction",
      });

      adapter.emitMessages(messageOne, messageTwo, unmonitored, reaction);
      await service.idle();

      // A duplicate delivery of WA-A2 arrives later.
      adapter.emitMessages(messageTwo);
      await service.idle();

      const rows = await pool.query<{
        whatsapp_message_id: string;
        body: string;
        message_type: string;
        sender_id: string | null;
        chat_id: string;
      }>(
        "SELECT whatsapp_message_id, body, message_type, sender_id, chat_id " +
          "FROM messages ORDER BY whatsapp_message_id",
      );
      expect(rows.rows).toEqual([
        {
          whatsapp_message_id: "WA-A1",
          body: "first",
          message_type: "text",
          sender_id: "sender@s.whatsapp.net",
          chat_id: GROUP_A,
        },
        {
          whatsapp_message_id: "WA-A2",
          body: "second",
          message_type: "text",
          sender_id: "sender@s.whatsapp.net",
          chat_id: GROUP_A,
        },
      ]);

      // Skip counting is preserved end to end.
      const skipped = findEvents(logs, "messages_skipped");
      expect(skipped.length).toBeGreaterThanOrEqual(1);
      expect(skipped[0]?.fields["reaction"]).toBe(1);

      // The persisted connection status reflects the open connection.
      const connection = await pool.query<{ state: string }>(
        "SELECT state FROM whatsapp_connections",
      );
      expect(connection.rows[0]?.state).toBe("connected");

      await service.stop();
      expect(logs.length).toBeGreaterThan(0);
    });

    // ---- History import (ADR 0007) ----

    /** Seeds a group row with a pending history-import request. */
    async function seedHistoryImport(
      chatJid: string,
      monitored: boolean,
    ): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO groups
           (id, chat_id, name, monitored, timezone,
            history_import_status, history_import_requested_at)
         VALUES ($1, $2, 'Import Group', $3, 'UTC', 'pending', now())`,
        [id, chatJid, monitored],
      );
      return id;
    }

    async function readHistoryRow(groupId: string): Promise<{
      history_import_status: string | null;
      history_import_started_at: Date | null;
      history_import_finished_at: Date | null;
      history_import_imported_count: number;
      history_import_error: string | null;
    }> {
      const row = await pool.query<{
        history_import_status: string | null;
        history_import_started_at: Date | null;
        history_import_finished_at: Date | null;
        history_import_imported_count: number;
        history_import_error: string | null;
      }>(
        `SELECT history_import_status, history_import_started_at,
                history_import_finished_at, history_import_imported_count,
                history_import_error
         FROM groups WHERE id = $1`,
        [groupId],
      );
      const result = row.rows[0];
      if (result === undefined) throw new Error("group row missing");
      return result;
    }

    it("claim SQL only claims pending+monitored rows (privacy boundary)", async () => {
      const claimedId = await seedHistoryImport(GROUP_A, true);
      const unmonitoredId = await seedHistoryImport(GROUP_B, false);
      await pool.query(
        `INSERT INTO groups (id, chat_id, name, monitored, timezone,
                            history_import_status, history_import_requested_at,
                            history_import_started_at, history_import_finished_at,
                            history_import_imported_count)
         VALUES ($1, 'done-group@g.us', 'Done', true, 'UTC', 'done', now(), now(), now(), 5)`,
        [randomUUID()],
      );

      const claims = await db.claimPendingHistoryImports(5);
      expect(claims.map((claim) => claim.groupId)).toEqual([claimedId]);
      expect(claims[0]?.chatJid).toBe(GROUP_A);
      expect(claims[0]?.startedAt).toBeInstanceOf(Date);

      // The unmonitored request is NEVER claimed; the finished one is
      // not claimable either.
      expect((await readHistoryRow(unmonitoredId)).history_import_status).toBe(
        "pending",
      );
      expect((await db.claimPendingHistoryImports(5))).toEqual([]);
    });

    it("concurrent claims never double-claim (FOR UPDATE SKIP LOCKED)", async () => {
      const ids = [
        await seedHistoryImport("c1@g.us", true),
        await seedHistoryImport("c2@g.us", true),
        await seedHistoryImport("c3@g.us", true),
      ];
      const results = await Promise.all([
        db.claimPendingHistoryImports(1),
        db.claimPendingHistoryImports(1),
        db.claimPendingHistoryImports(1),
      ]);
      const claimed = results.flatMap((claims) => claims.map((c) => c.groupId));
      // Every row claimed exactly once across the three concurrent calls.
      expect(claimed.sort()).toEqual([...ids].sort());
    });

    it("completeHistoryImport writes the outcome and is idempotent-safe", async () => {
      const groupId = await seedHistoryImport(GROUP_A, true);
      const [claim] = await db.claimPendingHistoryImports(1);
      if (claim === undefined) throw new Error("claim failed");

      const completed = await db.completeHistoryImport(claim, {
        status: "done",
        importedCount: 42,
        error: null,
      });
      expect(completed).toBe(true);
      let row = await readHistoryRow(groupId);
      expect(row.history_import_status).toBe("done");
      expect(row.history_import_imported_count).toBe(42);
      expect(row.history_import_finished_at).toBeInstanceOf(Date);
      expect(row.history_import_error).toBeNull();

      // Repeating the completion is a no-op (status no longer 'running').
      const again = await db.completeHistoryImport(claim, {
        status: "failed",
        importedCount: 0,
        error: "history_timeout",
      });
      expect(again).toBe(false);
      row = await readHistoryRow(groupId);
      expect(row.history_import_status).toBe("done");
      expect(row.history_import_error).toBeNull();
    });

    it("a stale claim cannot overwrite a newer import's outcome", async () => {
      const groupId = await seedHistoryImport(GROUP_A, true);
      const [staleClaim] = await db.claimPendingHistoryImports(1);
      if (staleClaim === undefined) throw new Error("claim failed");
      // The stale claim is released and the import re-claimed later.
      expect(
        await db.releaseHistoryImport({
          groupId: staleClaim.groupId,
          startedAt: staleClaim.startedAt,
        }),
      ).toBe(true);
      expect((await readHistoryRow(groupId)).history_import_status).toBe("pending");

      const [freshClaim] = await db.claimPendingHistoryImports(1);
      if (freshClaim === undefined) throw new Error("re-claim failed");
      // The old worker's completion must NOT touch the newer import.
      expect(
        await db.completeHistoryImport(
          { groupId: staleClaim.groupId, startedAt: staleClaim.startedAt },
          { status: "failed", importedCount: 0, error: "history_internal" },
        ),
      ).toBe(false);
      expect((await readHistoryRow(groupId)).history_import_status).toBe("running");

      expect(
        await db.completeHistoryImport(freshClaim, {
          status: "done",
          importedCount: 1,
          error: null,
        }),
      ).toBe(true);
      expect((await readHistoryRow(groupId)).history_import_status).toBe("done");
    });

    it("requeueStaleHistoryImports requeues only stale running claims", async () => {
      const staleId = await seedHistoryImport(GROUP_A, true);
      const freshChat = "fresh-claim@g.us";
      const freshId = await seedHistoryImport(freshChat, true);
      await pool.query(
        `UPDATE groups SET history_import_status = 'running',
                           history_import_started_at = now() - interval '20 minutes'
         WHERE id = $1`,
        [staleId],
      );
      await pool.query(
        `UPDATE groups SET history_import_status = 'running',
                           history_import_started_at = now()
         WHERE id = $1`,
        [freshId],
      );

      const requeued = await db.requeueStaleHistoryImports(600_000);
      expect(requeued).toBe(1);
      const staleRow = await readHistoryRow(staleId);
      expect(staleRow.history_import_status).toBe("pending");
      expect(staleRow.history_import_started_at).toBeNull();
      expect((await readHistoryRow(freshId)).history_import_status).toBe("running");
    });

    it("staleness compares against the DATABASE clock (SA-L1)", async () => {
      // The comparison must not use the worker clock: only started_at
      // values older than now() - threshold (in DB time) move back.
      const oldId = await seedHistoryImport("old-claim@g.us", true);
      const futureId = await seedHistoryImport("future-claim@g.us", true);
      await pool.query(
        `UPDATE groups SET history_import_status = 'running',
                           history_import_started_at = now() - interval '30 minutes'
         WHERE id = $1`,
        [oldId],
      );
      // A started_at in the future (odd clock value) must NEVER look
      // stale, regardless of the threshold arithmetic.
      await pool.query(
        `UPDATE groups SET history_import_status = 'running',
                           history_import_started_at = now() + interval '10 minutes'
         WHERE id = $1`,
        [futureId],
      );

      expect(await db.requeueStaleHistoryImports(600_000)).toBe(1);
      expect((await readHistoryRow(oldId)).history_import_status).toBe("pending");
      expect((await readHistoryRow(futureId)).history_import_status).toBe("running");
    });

    it("updateHistoryImportProgress is fenced like completion (CR-M2)", async () => {
      const groupId = await seedHistoryImport(GROUP_A, true);
      const [claim] = await db.claimPendingHistoryImports(1);
      if (claim === undefined) throw new Error("claim failed");

      // Incremental write while running: the dashboard can render it.
      expect(
        await db.updateHistoryImportProgress(
          { groupId: claim.groupId, startedAt: claim.startedAt },
          5,
        ),
      ).toBe(true);
      expect((await readHistoryRow(groupId)).history_import_imported_count).toBe(5);

      // A STALE claim (older started_at) can never overwrite progress.
      const stale = { groupId: claim.groupId, startedAt: new Date(0) };
      expect(await db.updateHistoryImportProgress(stale, 99)).toBe(false);
      expect((await readHistoryRow(groupId)).history_import_imported_count).toBe(5);

      // After completion the progress write is a no-op too; the exact
      // terminal count stands.
      expect(
        await db.completeHistoryImport(
          { groupId: claim.groupId, startedAt: claim.startedAt },
          { status: "done", importedCount: 7, error: null },
        ),
      ).toBe(true);
      expect(
        await db.updateHistoryImportProgress(
          { groupId: claim.groupId, startedAt: claim.startedAt },
          99,
        ),
      ).toBe(false);
      expect((await readHistoryRow(groupId)).history_import_imported_count).toBe(7);
    });

    it("full import flow: rows land exactly once, count = inserts, no last_message_at", async () => {
      const groupId = await seedHistoryImport(GROUP_A, true);
      const adapter = new FakeAdapter();
      const logs: LogEntry[] = [];
      const imports = new HistoryImportService({
        adapter,
        db,
        log: recordingLogger(logs),
        budgets: { roundSettleMs: 20, roundTimeoutMs: 120, pollMs: 5 },
      });

      // Round 1: two new; round 2: one duplicate + one new; round 3: a
      // duplicate only (no progress → the import stops).
      const script: Array<() => void> = [
        () =>
          adapter.emitHistory(GROUP_A, [
            rawMessage({ messageId: "H1", timestampSec: 300 }),
            rawMessage({ messageId: "H2", timestampSec: 200 }),
          ]),
        () =>
          adapter.emitHistory(GROUP_A, [
            rawMessage({ messageId: "H2", timestampSec: 200 }),
            rawMessage({ messageId: "H3", timestampSec: 100 }),
          ]),
        () => adapter.emitHistory(GROUP_A, [rawMessage({ messageId: "H3", timestampSec: 100 })]),
      ];
      adapter.onRequestHistory = () => {
        const respond = script.shift();
        if (respond !== undefined) setTimeout(respond, 1);
      };

      await imports.runOnce();

      const rows = await pool.query<{ whatsapp_message_id: string }>(
        "SELECT whatsapp_message_id FROM messages ORDER BY whatsapp_message_id",
      );
      expect(rows.rows.map((row) => row.whatsapp_message_id)).toEqual([
        "H1",
        "H2",
        "H3",
      ]);
      const row = await readHistoryRow(groupId);
      expect(row.history_import_status).toBe("done");
      expect(row.history_import_imported_count).toBe(3); // inserted, not received
      expect(row.history_import_error).toBeNull();

      // Historical imports must NOT masquerade as live traffic (ADR
      // 0007): last_message_at stays untouched.
      const connection = await pool.query<{ last_message_at: Date | null }>(
        "SELECT last_message_at FROM whatsapp_connections",
      );
      expect(connection.rows[0]?.last_message_at).toBeNull();
    });
  },
);
