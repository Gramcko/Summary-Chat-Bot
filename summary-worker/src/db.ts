import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  RunError,
  Summary,
  SummaryResult,
  SummaryRun,
  type Interval,
} from "@summarly/contracts";

/**
 * summary-worker's own thin PostgreSQL access layer (architecture
 * §4.4/§4.5). Deliberately NOT the backend's Store: the worker is an
 * independent service and depends only on the database schema plus the
 * shared message contract. All SQL is parameterized; values are never
 * interpolated into query strings. Rows are validated through the
 * contract schemas at the boundary.
 *
 * Run status transitions are conditional (UPDATE ... WHERE status IN
 * (...)) so repeated job executions, concurrent workers, and the
 * failed-event safety net can never resurrect or downgrade a run that
 * already reached a terminal state.
 */

/** A message row as needed for summarization (never logged). */
export interface StoredMessage {
  id: string;
  /**
   * Sender DISPLAY NAME (WhatsApp push name), or "unknown" when the
   * message carried none — NEVER the phone-bearing JID (fix round A,
   * audit M-5: identity for attribution travels in sourceRefs only).
   */
  sender: string;
  /** ISO 8601 timestamp with offset. */
  sentAt: string;
  text: string;
}

/** A loaded summary run plus the context needed to build AI input. */
export interface RunContext {
  run: SummaryRun;
  groupName: string;
}

/**
 * The `ai_provider_configs` row as the worker needs it (single-row
 * table; written by the backend's settings API). The API key stays
 * ENCRYPTED here — decryption happens in ai/resolve-provider.ts and
 * the plaintext is never logged (AGENTS.md).
 */
export interface StoredProviderConfig {
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
}

export interface UpsertSummaryInput {
  runId: string;
  provider: string;
  model: string;
  /** Already validated against the SummaryResult contract. */
  result: SummaryResult;
}

export interface WorkerDb {
  /** Undefined when the run does not exist. */
  loadRun(summaryRunId: string): Promise<RunContext | undefined>;
  /**
   * Messages for a group over the half-open interval [start, end),
   * ordered deterministically (sent_at, then the stable message id).
   * `limit` caps the rows RETURNED (audit M3/E-4: callers decide
   * too_large from a bounded slice instead of materializing a whole
   * interval); omitted = no limit.
   */
  fetchMessages(
    groupId: string,
    interval: Interval,
    limit?: number,
  ): Promise<StoredMessage[]>;
  /**
   * Idempotent write keyed by runId (UNIQUE(summaries.run_id)): a
   * repeated write replaces the result and keeps the original id and
   * createdAt. Mirrors the backend's saveSummary semantics.
   */
  upsertSummary(input: UpsertSummaryInput): Promise<Summary>;
  /**
   * pending|processing -> processing, incrementing `attempts`.
   * Undefined when the run is missing or already terminal.
   */
  markRunProcessing(summaryRunId: string): Promise<SummaryRun | undefined>;
  /**
   * pending|processing -> completed. False when the transition did not
   * happen (missing or already terminal run).
   */
  markRunCompleted(summaryRunId: string): Promise<boolean>;
  /**
   * pending|processing -> failed with safe error metadata (code and
   * short message only). False when the transition did not happen — a
   * completed run is never downgraded by a late failure.
   */
  markRunFailed(summaryRunId: string, error: RunError): Promise<boolean>;
  /**
   * The saved AI provider configuration (ai_provider_configs, at most
   * one row), or undefined when the admin has not configured one —
   * in that case the mock adapter is used (ADR 0005).
   */
  loadProviderConfig(): Promise<StoredProviderConfig | undefined>;
}

type RunRow = QueryResultRow & {
  id: string;
  group_id: string;
  kind: string;
  status: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  attempts: number;
  instructions: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type RunWithGroupRow = RunRow & { group_name: string };

type MessageRow = QueryResultRow & {
  id: string;
  /** COALESCE(sender_name, 'unknown') — display name, never the JID. */
  sender: string;
  sent_at: Date;
  body: string;
};

type SummaryRow = QueryResultRow & {
  id: string;
  run_id: string;
  provider: string;
  model: string;
  result: unknown;
  created_at: Date;
};

type ProviderConfigRow = QueryResultRow & {
  provider: string;
  model: string;
  base_url: string | null;
  api_key_encrypted: string | null;
};

const RUN_COLUMNS =
  "id, group_id, kind, status, start_at, end_at, timezone, " +
  "attempts, instructions, error_code, error_message, created_at, updated_at";

/** Same columns qualified for queries that alias summary_runs as `r`. */
const RUN_COLUMNS_R =
  "r.id, r.group_id, r.kind, r.status, r.start_at, r.end_at, r.timezone, " +
  "r.attempts, r.instructions, r.error_code, r.error_message, r.created_at, r.updated_at";

const SUMMARY_COLUMNS = "id, run_id, provider, model, result, created_at";

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
    instructions: row.instructions,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    error:
      row.error_code !== null && row.error_message !== null
        ? { code: row.error_code, message: row.error_message }
        : null,
  });
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    // Already COALESCE'd in SQL (display name, never the JID).
    sender: row.sender,
    sentAt: row.sent_at.toISOString(),
    text: row.body,
  };
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

export class PostgresWorkerDb implements WorkerDb {
  constructor(private readonly pool: Pool) {}

  async loadRun(summaryRunId: string): Promise<RunContext | undefined> {
    const result = await this.pool.query<RunWithGroupRow>(
      `SELECT ${RUN_COLUMNS_R}, g.name AS group_name
       FROM summary_runs r
       JOIN groups g ON g.id = r.group_id
       WHERE r.id = $1`,
      [summaryRunId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { run: toSummaryRun(row), groupName: row.group_name };
  }

  async fetchMessages(
    groupId: string,
    interval: Interval,
    limit?: number,
  ): Promise<StoredMessage[]> {
    // Half-open [start, end): `sent_at >= start AND sent_at < end`, so
    // adjacent periods never overlap or double-count (architecture §5.3).
    // ORDER BY sent_at, id gives a deterministic order independent of
    // insertion/visibility timing. LIMIT $4 bounds the rows returned
    // (LIMIT NULL = unbounded) — audit M3/E-4.
    const result = await this.pool.query<MessageRow>(
      // Sender as DISPLAY NAME (fix round A, audit M-5): the phone-
      // bearing JID (sender_id) never reaches the AI provider —
      // attribution happens through sourceRefs (message ids) instead.
      // A captured message without a push name becomes "unknown".
      `SELECT m.id, COALESCE(m.sender_name, 'unknown') AS sender,
              m.sent_at, m.body
       FROM messages m
       JOIN groups g ON g.chat_id = m.chat_id
       WHERE g.id = $1 AND m.sent_at >= $2 AND m.sent_at < $3
       ORDER BY m.sent_at ASC, m.id ASC
       LIMIT $4`,
      [groupId, new Date(interval.start), new Date(interval.end), limit ?? null],
    );
    return result.rows.map(toStoredMessage);
  }

  async upsertSummary(input: UpsertSummaryInput): Promise<Summary> {
    // Validate before writing: the read path parses rows through the
    // contract schemas, so the write path must never persist a row those
    // schemas reject.
    const result = SummaryResult.parse(input.result);
    // UNIQUE(run_id) + ON CONFLICT makes the write idempotent: a
    // repeated job execution replaces the result and keeps the original
    // id/createdAt (they are not in the SET list; RETURNING yields the
    // surviving row). No duplicate completed summary, ever (§6).
    const inserted = await this.pool.query<SummaryRow>(
      `INSERT INTO summaries (id, run_id, provider, model, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         result = EXCLUDED.result
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        randomUUID(),
        input.runId,
        input.provider,
        input.model,
        result,
        new Date(),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("upsertSummary returned no row");
    return toSummary(row);
  }

  async markRunProcessing(
    summaryRunId: string,
  ): Promise<SummaryRun | undefined> {
    // A redelivered job may find the run already `processing` (crash or
    // stalled job mid-run): reprocessing from `processing` is allowed;
    // only terminal states are protected.
    const result = await this.pool.query<RunRow>(
      `UPDATE summary_runs
       SET status = 'processing',
           attempts = attempts + 1,
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'processing')
       RETURNING ${RUN_COLUMNS}`,
      [summaryRunId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummaryRun(row);
  }

  async markRunCompleted(summaryRunId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE summary_runs
       SET status = 'completed',
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'processing')
       RETURNING id`,
      [summaryRunId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markRunFailed(summaryRunId: string, error: RunError): Promise<boolean> {
    // Safe metadata only: short code + short message. Never message
    // content, credentials, or provider secrets (contracts/run.ts).
    const safe = RunError.parse(error);
    const result = await this.pool.query(
      `UPDATE summary_runs
       SET status = 'failed',
           error_code = $2,
           error_message = $3,
           updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'processing')
       RETURNING id`,
      [summaryRunId, safe.code, safe.message],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async loadProviderConfig(): Promise<StoredProviderConfig | undefined> {
    // Single-row table (backend enforces one row); the key stays
    // encrypted in transit through this layer.
    const result = await this.pool.query<ProviderConfigRow>(
      `SELECT provider, model, base_url, api_key_encrypted
       FROM ai_provider_configs
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKeyEncrypted: row.api_key_encrypted,
    };
  }
}
