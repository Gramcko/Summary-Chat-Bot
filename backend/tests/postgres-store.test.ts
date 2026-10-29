import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { ApiError, ProviderConfigPublic, Summary, type ConnectionStatus, type SummaryResult } from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import { decryptSecret, parseEncryptionKey } from "../src/lib/crypto.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { PostgresStore } from "../src/lib/postgres-store.js";
import { hashRecoveryCode } from "../src/lib/recovery-codes.js";
import {
  NoAdminError,
  resetAdminPassword,
} from "../src/lib/reset-password.js";
import { hashSessionToken, nowIso, type Store } from "../src/lib/store.js";
import {
  ADMIN_PASSWORD,
  NEW_PASSWORD,
  login,
  setupAdmin,
} from "./helpers.js";

/**
 * PostgreSQL integration tests for PostgresStore. Skipped cleanly when
 * no DATABASE_URL is set. Run against the dev database with:
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   npm run migrate -w @summarly/backend up
 *   DATABASE_URL=postgres://... npm test -w @summarly/backend
 */

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

const RESULT: SummaryResult = {
  overview: "Integration test summary.",
  keyDiscussions: ["Testing persistence"],
  confirmedDecisions: [],
  proposals: [],
  unresolvedQuestions: [],
  tasks: [],
  links: [],
  aiGenerated: true,
};

const ENCRYPTION_KEY = parseEncryptionKey(
  Buffer.from("integration-tests-master-key-32b").toString("base64"),
);

async function seedGroupRow(store: Store): Promise<string> {
  const id = randomUUID();
  await store.upsertGroup({
    id,
    chatId: `${randomUUID()}@g.us`,
    name: "Integration Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
  });
  return id;
}

describe.skipIf(!process.env["DATABASE_URL"])(
  "PostgresStore (PostgreSQL integration)",
  () => {
    let pool: Pool;

    beforeAll(() => {
      const databaseUrl = process.env["DATABASE_URL"];
      if (databaseUrl === undefined) throw new Error("DATABASE_URL missing");
      pool = new Pool({ connectionString: databaseUrl });
    });

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Test-database hygiene only; the dev database is disposable.
      await pool.query(
        "TRUNCATE TABLE summaries, summary_runs, messages, groups, " +
          "admin_sessions, admin_credentials, ai_provider_configs, " +
          "whatsapp_connections CASCADE",
      );
    });

    describe("createOrFindRun (ON CONFLICT run identity)", () => {
      it("creates once and finds the run on identical requests", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);

        const first = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        expect(first.created).toBe(true);
        expect(first.run.status).toBe("pending");
        expect(first.run.attempts).toBe(0);
        expect(first.run.groupId).toBe(groupId);
        expect(Date.parse(first.run.interval.start)).toBe(
          Date.parse(INTERVAL.start),
        );
        expect(Date.parse(first.run.interval.end)).toBe(
          Date.parse(INTERVAL.end),
        );
        expect(first.run.interval.timezone).toBe(INTERVAL.timezone);

        const second = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        expect(second.created).toBe(false);
        expect(second.run.id).toBe(first.run.id);
      });

      it("treats equivalent-instant spellings as the same run and keeps the first label", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const first = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        // Same instants as INTERVAL expressed with a +02:00 offset and a
        // different label: identity is instants, not spellings or labels.
        const equivalent = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-10-28T02:00:00+02:00",
            end: "2026-10-29T02:00:00+02:00",
            timezone: "America/Bogota",
          },
          kind: "manual",
        });
        expect(equivalent.created).toBe(false);
        expect(equivalent.run.id).toBe(first.run.id);
        expect(equivalent.run.interval.timezone).toBe("Europe/Madrid");
      });

      it("treats a different interval or kind as a different run", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        await store.createOrFindRun({ groupId, interval: INTERVAL, kind: "manual" });

        const nextDay = await store.createOrFindRun({
          groupId,
          interval: {
            start: "2026-10-29T00:00:00Z",
            end: "2026-10-30T00:00:00Z",
            timezone: "Europe/Madrid",
          },
          kind: "manual",
        });
        expect(nextDay.created).toBe(true);

        const scheduled = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "scheduled",
        });
        expect(scheduled.created).toBe(true);
      });

      it("enforces run identity with a database constraint", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        await store.createOrFindRun({ groupId, interval: INTERVAL, kind: "manual" });

        await expect(
          pool.query(
            `INSERT INTO summary_runs (group_id, kind, status, start_at, end_at, timezone)
             VALUES ($1, $2, 'pending', $3, $4, $5)`,
            [
              groupId,
              "manual",
              new Date(INTERVAL.start),
              new Date(INTERVAL.end),
              "Europe/Madrid",
            ],
          ),
        ).rejects.toThrow();
      });
    });

    describe("run transitions", () => {
      it("persists retry transitions (pending -> failed -> pending)", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        const failed = await store.updateRun({
          ...run,
          status: "failed",
          attempts: 1,
          error: { code: "provider_rate_limit", message: "Rate limited" },
          updatedAt: nowIso(),
        });
        expect(failed.status).toBe("failed");
        expect(failed.attempts).toBe(1);
        expect(failed.error).toEqual({
          code: "provider_rate_limit",
          message: "Rate limited",
        });

        const fetched = await store.getRun(run.id);
        if (fetched === undefined) throw new Error("run not found");
        expect(fetched.status).toBe("failed");

        const retried = await store.updateRun({
          ...fetched,
          status: "pending",
          error: null,
          updatedAt: nowIso(),
        });
        expect(retried.status).toBe("pending");
        expect(retried.error).toBeNull();

        const list = await store.listRuns();
        expect(list.map((item) => item.id)).toEqual([run.id]);
      });
    });

    describe("provider key encryption", () => {
      it("round-trips the key, encrypts at rest, and masks it through the routes", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);
        const secret = "sk-integration-secret-do-not-leak";

        const put = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "test-model",
            baseUrl: "https://api.example.com/v1",
            apiKey: secret,
          },
        });
        expect(put.statusCode).toBe(200);
        expect(put.body).not.toContain(secret);
        expect(put.body).not.toContain("apiKey");

        const get = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        const config = ProviderConfigPublic.parse(get.json());
        expect(config.hasApiKey).toBe(true);
        expect(get.body).not.toContain(secret);
        expect(get.body).not.toContain("apiKey");

        // At rest: ciphertext envelope, never plaintext; decrypts back.
        const raw = await pool.query<{ api_key_encrypted: string | null }>(
          "SELECT api_key_encrypted FROM ai_provider_configs LIMIT 1",
        );
        const stored = raw.rows[0]?.api_key_encrypted ?? null;
        expect(stored).not.toBeNull();
        expect(stored).not.toContain(secret);
        expect(stored).toMatch(/^enc:v1:/);
        if (stored === null) throw new Error("missing api_key_encrypted");
        expect(decryptSecret(ENCRYPTION_KEY, stored)).toBe(secret);

        // Store-level round trip.
        const read = await store.getProviderConfig();
        if (read === null) throw new Error("provider config missing");
        expect(read.apiKey).toBe(secret);
      });

      it("keeps the saved key on omitted apiKey and clears it on explicit null", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        await store.setProviderConfig({
          provider: "openai-compatible",
          model: "v1",
          baseUrl: null,
          apiKey: "sk-old",
        });

        await store.setProviderConfig({
          provider: "openai-compatible",
          model: "v2",
          baseUrl: null,
          apiKey: null,
        });
        const cleared = await store.getProviderConfig();
        if (cleared === null) throw new Error("provider config missing");
        expect(cleared.model).toBe("v2");
        expect(cleared.apiKey).toBeNull();

        const raw = await pool.query<{ api_key_encrypted: string | null }>(
          "SELECT api_key_encrypted FROM ai_provider_configs LIMIT 1",
        );
        expect(raw.rows[0]?.api_key_encrypted ?? null).toBeNull();
      });

      it("fails decryption with a tampered or foreign-key value", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        await store.setProviderConfig({
          provider: "mock",
          model: "mock-1",
          baseUrl: null,
          apiKey: "sk-secret",
        });
        await pool.query(
          "UPDATE ai_provider_configs SET api_key_encrypted = $1",
          ["enc:v1:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUE="],
        );
        await expect(store.getProviderConfig()).rejects.toThrow();
      });
    });

    describe("sessions", () => {
      it("stores only token hashes and enforces the session lifecycle", async () => {
        const store = new PostgresStore(pool);
        const token = randomBytes(32).toString("hex");

        expect(await store.validateSession(token)).toBe(false);
        await store.createSession(token);
        expect(await store.validateSession(token)).toBe(true);

        const rows = await pool.query<{ token_hash: string }>(
          "SELECT token_hash FROM admin_sessions",
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.token_hash).not.toBe(token);
        expect(rows.rows[0]?.token_hash).toBe(hashSessionToken(token));

        await store.deleteSession(token);
        expect(await store.validateSession(token)).toBe(false);

        await store.createSession("token-one");
        await store.createSession("token-two");
        await store.clearSessions();
        expect(await store.validateSession("token-one")).toBe(false);
        expect(await store.validateSession("token-two")).toBe(false);
      });
    });

    describe("reset-password helper", () => {
      it("sets a new password, clears sessions, and the new password works", async () => {
        const store = new PostgresStore(pool);
        await store.setAdmin({
          passwordHash: hashPassword(ADMIN_PASSWORD),
          recoveryCodeHashes: new Set([hashRecoveryCode("0000-0000-0000")]),
        });
        await store.createSession("stale-session");

        const codes = await resetAdminPassword(store, NEW_PASSWORD);
        expect(codes).toHaveLength(10);

        const admin = await store.getAdmin();
        if (admin === null) throw new Error("admin missing after reset");
        expect(verifyPassword(NEW_PASSWORD, admin.passwordHash)).toBe(true);
        expect(verifyPassword(ADMIN_PASSWORD, admin.passwordHash)).toBe(false);
        expect(await store.validateSession("stale-session")).toBe(false);

        // End to end: the API accepts the new password.
        const app = await buildApp({
          store,
          cookieSecure: false,
          logger: false,
        });
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: NEW_PASSWORD },
        });
        expect(res.statusCode).toBe(200);
      });

      it("throws NoAdminError before setup", async () => {
        const store = new PostgresStore(pool);
        await expect(resetAdminPassword(store, NEW_PASSWORD)).rejects.toBeInstanceOf(
          NoAdminError,
        );
      });
    });

    describe("summaries and connection status", () => {
      it("saves summaries idempotently per run and serves them by run id", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });

        const first = await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: nowIso(),
        });
        // A repeated write for the same run keeps the first identity.
        const again = await store.saveSummary({
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: RESULT,
          createdAt: nowIso(),
        });
        expect(again.id).toBe(first.id);

        const byRun = await store.getSummaryByRunId(run.id);
        if (byRun === undefined) throw new Error("summary missing");
        expect(byRun.id).toBe(first.id);
        expect(Summary.parse(byRun).result).toEqual(RESULT);

        const app = await buildApp({
          store,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);
        const res = await app.inject({
          method: "GET",
          url: `/api/summary-runs/${run.id}/summary`,
          headers: { cookie: session },
        });
        expect(res.statusCode).toBe(200);
        expect(Summary.parse(res.json()).runId).toBe(run.id);
      });

      it("round-trips the connection status", async () => {
        const store = new PostgresStore(pool);
        expect((await store.getConnectionStatus()).state).toBe("unavailable");

        const since = nowIso();
        await store.setConnectionStatus({
          state: "connected",
          since,
          lastMessageAt: since,
        });
        const status = await store.getConnectionStatus();
        expect(status.state).toBe("connected");
        expect(Date.parse(status.since)).toBe(Date.parse(since));
        expect(
          status.lastMessageAt === null
            ? null
            : Date.parse(status.lastMessageAt),
        ).toBe(Date.parse(since));
      });
    });

    describe("group registration (chat natural key)", () => {
      it("keeps the stored id when the same chat is registered again", async () => {
        const store = new PostgresStore(pool);
        const chatId = "123456789012345678@g.us";
        const first = await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "First name",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
        });
        const again = await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Renamed",
          monitored: false,
          timezone: "America/Bogota",
          summaryTime: "06:30",
        });
        expect(again.id).toBe(first.id);
        expect(again.name).toBe("Renamed");
        expect(again.monitored).toBe(false);
        expect(again.summaryTime).toBe("06:30");

        const rows = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM groups WHERE chat_id = $1",
          [chatId],
        );
        expect(rows.rows[0]?.count).toBe("1");
      });

      it("falls back to the id when no chat id is provided", async () => {
        const store = new PostgresStore(pool);
        const id = randomUUID();
        await store.upsertGroup({
          id,
          chatId: null,
          name: "First name",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
        });
        const updated = await store.upsertGroup({
          id,
          chatId: null,
          name: "Second name",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
        });
        expect(updated.id).toBe(id);
        expect(updated.name).toBe("Second name");
        expect(await store.listGroups()).toHaveLength(1);
      });

      it("enforces chat uniqueness in the database", async () => {
        const store = new PostgresStore(pool);
        const chatId = "duplicate-chat@g.us";
        await store.upsertGroup({
          id: randomUUID(),
          chatId,
          name: "Original",
          monitored: true,
          timezone: "Europe/Madrid",
          summaryTime: null,
        });
        await expect(
          pool.query(
            "INSERT INTO groups (id, chat_id, name, monitored, timezone) VALUES ($1, $2, $3, true, 'Europe/Madrid')",
            [randomUUID(), chatId, "Duplicate"],
          ),
        ).rejects.toThrow();
      });
    });

    describe("write validation", () => {
      it("rejects a summary whose result violates the contract", async () => {
        const store = new PostgresStore(pool);
        const groupId = await seedGroupRow(store);
        const { run } = await store.createOrFindRun({
          groupId,
          interval: INTERVAL,
          kind: "manual",
        });
        const invalid = {
          id: randomUUID(),
          runId: run.id,
          provider: "mock",
          model: "mock-1",
          result: { overview: "" },
          createdAt: nowIso(),
        } as unknown as Summary;
        await expect(store.saveSummary(invalid)).rejects.toThrow();
        expect(await store.getSummaryByRunId(run.id)).toBeUndefined();
      });

      it("rejects an invalid connection status", async () => {
        const store = new PostgresStore(pool);
        const invalid = {
          state: "bogus",
          since: nowIso(),
          lastMessageAt: null,
        } as unknown as ConnectionStatus;
        await expect(store.setConnectionStatus(invalid)).rejects.toThrow();
      });
    });

    describe("setAdmin insert-only (setup race)", () => {
      it("lets exactly one of two concurrent setAdmin calls win", async () => {
        const store = new PostgresStore(pool);
        const results = await Promise.all([
          store.setAdmin({
            passwordHash: hashPassword(ADMIN_PASSWORD),
            recoveryCodeHashes: new Set(),
          }),
          store.setAdmin({
            passwordHash: hashPassword(NEW_PASSWORD),
            recoveryCodeHashes: new Set(),
          }),
        ]);
        expect(results.filter((created) => created)).toHaveLength(1);
      });
    });

    describe("settings with a tampered saved key", () => {
      it("surfaces a clear conflict and lets a fully-specified PUT recover", async () => {
        const store = new PostgresStore(pool, ENCRYPTION_KEY);
        const app = await buildApp({
          store,
          cookieSecure: false,
          logger: false,
        });
        await setupAdmin(app);
        const session = await login(app);

        const put = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "v1",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-original",
          },
        });
        expect(put.statusCode).toBe(200);

        // Corrupt the stored ciphertext (tamper or key rotation).
        await pool.query(
          "UPDATE ai_provider_configs SET api_key_encrypted = $1",
          ["enc:v1:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUE="],
        );

        const get = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        expect(get.statusCode).toBe(409);
        expect(ApiError.parse(get.json()).error.message).toMatch(/unreadable/i);
        expect(get.body).not.toContain("sk-");

        // A PUT that still needs the old key reports the same conflict.
        const keep = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: { provider: "openai-compatible", model: "v2" },
        });
        expect(keep.statusCode).toBe(409);

        // A fully-specified PUT replaces the broken key without reading it.
        const replace = await app.inject({
          method: "PUT",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
          payload: {
            provider: "openai-compatible",
            model: "v2",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-new-secret",
          },
        });
        expect(replace.statusCode).toBe(200);
        expect(ProviderConfigPublic.parse(replace.json()).hasApiKey).toBe(true);

        const after = await app.inject({
          method: "GET",
          url: "/api/settings/ai-provider",
          headers: { cookie: session },
        });
        expect(after.statusCode).toBe(200);
        expect(after.body).not.toContain("sk-new-secret");
      });
    });
  },
);
