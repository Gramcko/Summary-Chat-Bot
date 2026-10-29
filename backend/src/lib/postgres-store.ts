import type { Pool, QueryResultRow } from "pg";
import {
  ConnectionStatus,
  Group,
  Summary,
  SummaryRun,
} from "@summarly/contracts";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  hashSessionToken,
  nowIso,
  type AdminRecord,
  type CreateRunInput,
  type ProviderRecord,
  type Store,
} from "./store.js";

/**
 * PostgreSQL implementation of the Store interface (the durable source of
 * truth, docs/decisions/0001). All SQL is parameterized; values are never
 * interpolated into query strings. Contract schemas are used to validate
 * rows at the database boundary.
 *
 * Provider API keys are encrypted at rest with AES-256-GCM
 * (lib/crypto.ts); plaintext keys only ever exist in process memory and
 * are never included in API responses (routes mask them).
 */

type AdminRow = QueryResultRow & {
  password_hash: string;
  recovery_code_hashes: string[];
};

type GroupRow = QueryResultRow & {
  id: string;
  chat_id: string | null;
  name: string;
  monitored: boolean;
  timezone: string;
  summary_time: string | null;
};

type RunRow = QueryResultRow & {
  id: string;
  group_id: string;
  kind: string;
  status: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type CreatedRunRow = RunRow & { created: boolean };

type SummaryRow = QueryResultRow & {
  id: string;
  run_id: string;
  provider: string;
  model: string;
  result: unknown;
  created_at: Date;
};

type ProviderRow = QueryResultRow & {
  provider: string;
  model: string;
  base_url: string | null;
  api_key_encrypted: string | null;
};

type ConnectionRow = QueryResultRow & {
  state: string;
  since: Date;
  last_message_at: Date | null;
};

const RUN_COLUMNS =
  "id, group_id, kind, status, start_at, end_at, timezone, attempts, " +
  "error_code, error_message, created_at, updated_at";

const SUMMARY_COLUMNS = "id, run_id, provider, model, result, created_at";

const GROUP_COLUMNS = "id, chat_id, name, monitored, timezone, summary_time";

function toAdminRecord(row: AdminRow): AdminRecord {
  return {
    passwordHash: row.password_hash,
    recoveryCodeHashes: new Set(row.recovery_code_hashes),
  };
}

function toGroup(row: GroupRow): Group {
  return Group.parse({
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    monitored: row.monitored,
    timezone: row.timezone,
    summaryTime: row.summary_time,
  });
}

function toSummaryRun(row: RunRow): SummaryRun {
  return SummaryRun.parse({
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    status: row.status,
    interval: {
      start: row.start_at.toISOString(),
      end: row.end_at.toISOString(),
      timezone: row.timezone,
    },
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    error:
      row.error_code !== null && row.error_message !== null
        ? { code: row.error_code, message: row.error_message }
        : null,
  });
}

function toSummary(row: SummaryRow): Summary {
  return Summary.parse({
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    result: row.result,
    createdAt: row.created_at.toISOString(),
  });
}

export class PostgresStore implements Store {
  constructor(
    private readonly pool: Pool,
    /** AES-256-GCM master key for provider credentials; see lib/crypto.ts. */
    private readonly encryptionKey: Buffer | null = null,
  ) {}

  private requireKey(): Buffer {
    if (this.encryptionKey === null) {
      throw new Error(
        "ENCRYPTION_KEY is required to read or write AI provider credentials.",
      );
    }
    return this.encryptionKey;
  }

  // ---- Admin credentials ----

  async getAdmin(): Promise<AdminRecord | null> {
    const result = await this.pool.query<AdminRow>(
      "SELECT password_hash, recovery_code_hashes FROM admin_credentials LIMIT 1",
    );
    const row = result.rows[0];
    return row === undefined ? null : toAdminRecord(row);
  }

  async setAdmin(record: AdminRecord): Promise<boolean> {
    // Insert-only (M8): concurrent first-run setup attempts race on the
    // single-row constraint; exactly one wins and the losers' recovery
    // codes are never silently discarded by an overwrite.
    const result = await this.pool.query(
      `INSERT INTO admin_credentials (password_hash, recovery_code_hashes)
       VALUES ($1, $2)
       ON CONFLICT ((true)) DO NOTHING
       RETURNING id`,
      [record.passwordHash, [...record.recoveryCodeHashes]],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void> {
    // One statement = one transaction: the password update and the
    // session eviction commit together or not at all (M9).
    await this.pool.query(
      `WITH updated AS (
         UPDATE admin_credentials
         SET password_hash = $1,
             recovery_code_hashes = COALESCE($2::text[], recovery_code_hashes),
             updated_at = now()
       ),
       cleared AS (
         DELETE FROM admin_sessions
       )
       SELECT 1`,
      [
        input.passwordHash,
        input.recoveryCodeHashes === undefined
          ? null
          : [...input.recoveryCodeHashes],
      ],
    );
  }

  async consumeRecoveryCode(
    codeHash: string,
    newPasswordHash: string,
  ): Promise<boolean> {
    // One statement = one transaction (M9): consuming the one-time code,
    // setting the new password, and evicting all sessions commit
    // together, so a code can never be used twice and a reset can never
    // leave sessions alive.
    const result = await this.pool.query(
      `WITH consumed AS (
         UPDATE admin_credentials
         SET password_hash = $2,
             recovery_code_hashes = array_remove(recovery_code_hashes, $1),
             updated_at = now()
         WHERE $1 = ANY(recovery_code_hashes)
         RETURNING id
       ),
       cleared AS (
         DELETE FROM admin_sessions
         WHERE EXISTS (SELECT 1 FROM consumed)
       )
       SELECT id FROM consumed`,
      [codeHash, newPasswordHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Sessions ----

  async createSession(token: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO admin_sessions (token_hash) VALUES ($1) ON CONFLICT (token_hash) DO NOTHING",
      [hashSessionToken(token)],
    );
  }

  async validateSession(token: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM admin_sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [
      hashSessionToken(token),
    ]);
  }

  async clearSessions(): Promise<void> {
    await this.pool.query("DELETE FROM admin_sessions");
  }

  // ---- Groups ----

  async listGroups(): Promise<Group[]> {
    const result = await this.pool.query<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM groups ORDER BY name ASC, id ASC`,
    );
    return result.rows.map(toGroup);
  }

  async getGroup(id: string): Promise<Group | undefined> {
    const result = await this.pool.query<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toGroup(row);
  }

  async updateGroup(group: Group): Promise<Group | undefined> {
    const result = await this.pool.query<GroupRow>(
      `UPDATE groups
       SET name = $2, monitored = $3, timezone = $4, summary_time = $5, updated_at = now()
       WHERE id = $1
       RETURNING ${GROUP_COLUMNS}`,
      [group.id, group.name, group.monitored, group.timezone, group.summaryTime],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toGroup(row);
  }

  async upsertGroup(group: Group): Promise<Group> {
    // Natural key is chat_id when provided (bot-worker idempotent
    // registration). The stored id wins over the caller's id so foreign
    // keys (messages, summary_runs) stay stable across rediscovery.
    if (group.chatId !== null) {
      const byChat = await this.pool.query<GroupRow>(
        `UPDATE groups
         SET name = $2, monitored = $3, timezone = $4, summary_time = $5, updated_at = now()
         WHERE chat_id = $1
         RETURNING ${GROUP_COLUMNS}`,
        [group.chatId, group.name, group.monitored, group.timezone, group.summaryTime],
      );
      const chatRow = byChat.rows[0];
      if (chatRow !== undefined) return toGroup(chatRow);
    }
    const inserted = await this.pool.query<GroupRow>(
      `INSERT INTO groups (id, chat_id, name, monitored, timezone, summary_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING ${GROUP_COLUMNS}`,
      [group.id, group.chatId, group.name, group.monitored, group.timezone, group.summaryTime],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) return toGroup(insertedRow);
    // The insert lost to an existing row: either the id is already
    // registered (replace it, including its chat_id) or a concurrent
    // upsert registered the same chat first (keep that stored id).
    const byId = await this.pool.query<GroupRow>(
      `UPDATE groups
       SET chat_id = $2, name = $3, monitored = $4, timezone = $5, summary_time = $6, updated_at = now()
       WHERE id = $1
       RETURNING ${GROUP_COLUMNS}`,
      [group.id, group.chatId, group.name, group.monitored, group.timezone, group.summaryTime],
    );
    const idRow = byId.rows[0];
    if (idRow !== undefined) return toGroup(idRow);
    if (group.chatId !== null) {
      const byChat = await this.pool.query<GroupRow>(
        `UPDATE groups
         SET name = $2, monitored = $3, timezone = $4, summary_time = $5, updated_at = now()
         WHERE chat_id = $1
         RETURNING ${GROUP_COLUMNS}`,
        [group.chatId, group.name, group.monitored, group.timezone, group.summaryTime],
      );
      const chatRow = byChat.rows[0];
      if (chatRow !== undefined) return toGroup(chatRow);
    }
    throw new Error("upsertGroup failed to persist the group");
  }

  // ---- Summary runs ----

  async createOrFindRun(
    input: CreateRunInput,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    // Identity is (group_id, start_at, end_at, kind). timestamptz equality
    // is instant-based, so "…Z" and "+02:00" spellings of the same moment
    // hit the same row via ON CONFLICT. The timezone label is presentation
    // metadata, not identity: the first request's label is kept (the
    // conflicting insert performs a no-op update and returns the stored row).
    //
    // Implementation note (deliberate trade-off): the conflict branch uses
    // `DO UPDATE SET group_id = summary_runs.group_id` (a no-op update)
    // rather than `DO NOTHING` + a follow-up `SELECT`, because only
    // DO UPDATE guarantees a RETURNING row for both branches in a single
    // round-trip, race-free. `(xmax = 0)` then distinguishes a fresh
    // insert (true) from a reused row (false).
    // Cost: every duplicate create-or-find call writes a new row version
    // of the run (dead tuple for autovacuum). Duplicates are rare and
    // bounded (API retries and reconciliation), so this trades a little
    // write amplification for simpler, provably-correct semantics. If
    // measurement ever shows bloat here, switch to DO NOTHING + SELECT.
    const result = await this.pool.query<CreatedRunRow>(
      `INSERT INTO summary_runs (group_id, kind, status, start_at, end_at, timezone, attempts)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0)
       ON CONFLICT (group_id, start_at, end_at, kind)
       DO UPDATE SET group_id = summary_runs.group_id
       RETURNING ${RUN_COLUMNS}, (xmax = 0) AS created`,
      [
        input.groupId,
        input.kind,
        new Date(input.interval.start),
        new Date(input.interval.end),
        input.interval.timezone,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createOrFindRun returned no row");
    return { run: toSummaryRun(row), created: row.created };
  }

  async getRun(id: string): Promise<SummaryRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM summary_runs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummaryRun(row);
  }

  async listRuns(): Promise<SummaryRun[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM summary_runs ORDER BY created_at DESC, id DESC`,
    );
    return result.rows.map(toSummaryRun);
  }

  async updateRun(run: SummaryRun): Promise<SummaryRun> {
    const result = await this.pool.query<RunRow>(
      `UPDATE summary_runs
       SET status = $2, attempts = $3, error_code = $4, error_message = $5, updated_at = $6
       WHERE id = $1
       RETURNING ${RUN_COLUMNS}`,
      [
        run.id,
        run.status,
        run.attempts,
        run.error?.code ?? null,
        run.error?.message ?? null,
        new Date(run.updatedAt),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Summary run not found: ${run.id}`);
    return toSummaryRun(row);
  }

  // ---- Summaries ----

  async saveSummary(summary: Summary): Promise<Summary> {
    // Validate before writing (M7): the read path parses rows through
    // the contract schemas, so the write path must never be able to
    // persist a row those schemas reject.
    const valid = Summary.parse(summary);
    // UNIQUE(run_id) makes writes idempotent: a repeated job execution
    // replaces the result instead of creating a duplicate completed
    // summary (architecture §6). The first write's id/createdAt are kept.
    const result = await this.pool.query<SummaryRow>(
      `INSERT INTO summaries (id, run_id, provider, model, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         result = EXCLUDED.result
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        valid.id,
        valid.runId,
        valid.provider,
        valid.model,
        valid.result,
        new Date(valid.createdAt),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("saveSummary returned no row");
    return toSummary(row);
  }

  async getSummary(id: string): Promise<Summary | undefined> {
    const result = await this.pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummary(row);
  }

  async getSummaryByRunId(runId: string): Promise<Summary | undefined> {
    const result = await this.pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummary(row);
  }

  // ---- AI provider configuration ----

  async getProviderConfig(): Promise<ProviderRecord | null> {
    const result = await this.pool.query<ProviderRow>(
      "SELECT provider, model, base_url, api_key_encrypted FROM ai_provider_configs LIMIT 1",
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKey:
        row.api_key_encrypted === null
          ? null
          : decryptSecret(this.requireKey(), row.api_key_encrypted),
    };
  }

  async setProviderConfig(record: ProviderRecord): Promise<ProviderRecord> {
    const encrypted =
      record.apiKey === null
        ? null
        : encryptSecret(this.requireKey(), record.apiKey);
    await this.pool.query(
      `INSERT INTO ai_provider_configs (provider, model, base_url, api_key_encrypted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ((true)) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         base_url = EXCLUDED.base_url,
         api_key_encrypted = EXCLUDED.api_key_encrypted,
         updated_at = now()`,
      [record.provider, record.model, record.baseUrl, encrypted],
    );
    return record;
  }

  // ---- WhatsApp connection status ----

  async getConnectionStatus(): Promise<ConnectionStatus> {
    const result = await this.pool.query<ConnectionRow>(
      "SELECT state, since, last_message_at FROM whatsapp_connections LIMIT 1",
    );
    const row = result.rows[0];
    if (row === undefined) {
      // No row has ever been written (bot-worker has not reported yet).
      return ConnectionStatus.parse({
        state: "unavailable",
        since: nowIso(),
        lastMessageAt: null,
      });
    }
    return ConnectionStatus.parse({
      state: row.state,
      since: row.since.toISOString(),
      lastMessageAt:
        row.last_message_at === null ? null : row.last_message_at.toISOString(),
    });
  }

  async setConnectionStatus(status: ConnectionStatus): Promise<void> {
    // Validate before writing (M7), mirroring the read-path validation.
    const valid = ConnectionStatus.parse(status);
    await this.pool.query(
      `INSERT INTO whatsapp_connections (state, since, last_message_at)
       VALUES ($1, $2, $3)
       ON CONFLICT ((true)) DO UPDATE SET
         state = EXCLUDED.state,
         since = EXCLUDED.since,
         last_message_at = EXCLUDED.last_message_at,
         updated_at = now()`,
      [valid.state, new Date(valid.since), valid.lastMessageAt],
    );
  }
}
