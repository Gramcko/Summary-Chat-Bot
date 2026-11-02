import { createHash, randomUUID } from "node:crypto";
import type {
  ConnectionStatus,
  Group,
  Interval,
  RunKind,
  Summary,
  SummaryRun,
} from "@summarly/contracts";

export interface AdminRecord {
  passwordHash: string;
  recoveryCodeHashes: Set<string>;
}

export interface ProviderRecord {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Server-side only. Never part of any API response. */
  apiKey: string | null;
}

export interface CreateRunInput {
  groupId: string;
  interval: Interval;
  kind: RunKind;
}

/**
 * Run identity key: (group, start instant, end instant, kind) — the
 * exact tuple protected by the database's UNIQUE constraint. The
 * timezone label is deliberately excluded (presentation metadata).
 */
export function runIdentity(input: CreateRunInput): string {
  return `${input.groupId}|${Date.parse(input.interval.start)}|${Date.parse(input.interval.end)}|${input.kind}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Session tokens are opaque random secrets carried by the cookie. Only a
 * SHA-256 hash of the token is ever persisted (admin_sessions.token_hash),
 * so a database leak does not yield usable sessions.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Persistence boundary for everything the API reads or writes. The
 * in-memory implementation keeps the skeleton testable; PostgresStore is
 * the durable implementation (PostgreSQL is the source of truth per
 * docs/decisions/0001). Routes must depend on this interface only.
 */
export interface Store {
  // ---- Admin credentials (single administrator) ----
  getAdmin(): Promise<AdminRecord | null>;
  /**
   * First-run setup: insert-only. Returns true when the record was
   * created and false when an administrator already exists — concurrent
   * setup attempts must never overwrite each other (one caller wins).
   */
  setAdmin(record: AdminRecord): Promise<boolean>;
  /**
   * Atomically replaces the password hash — and, when provided, rotates
   * the recovery-code hashes — and deletes ALL sessions in the same
   * statement/transaction. Password changes and resets must never leave
   * sessions alive after a partial failure.
   */
  updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void>;
  /**
   * Single-use recovery: removes the consumed code, sets the new
   * password hash, and evicts all sessions atomically. Returns false
   * when the code is unknown.
   */
  consumeRecoveryCode(codeHash: string, newPasswordHash: string): Promise<boolean>;

  // ---- Sessions (implementations persist only token hashes) ----
  createSession(token: string): Promise<void>;
  validateSession(token: string): Promise<boolean>;
  deleteSession(token: string): Promise<void>;
  clearSessions(): Promise<void>;

  // ---- Monitored groups ----
  listGroups(): Promise<Group[]>;
  getGroup(id: string): Promise<Group | undefined>;
  /** Full replacement of mutable group fields. Undefined when unknown. */
  updateGroup(group: Group): Promise<Group | undefined>;
  /**
   * Natural-key registration for discovered chats. When `chatId` is
   * provided it is the identity: repeated upserts of the same chat keep
   * the stored id (so run/message foreign keys stay stable) and update
   * ONLY the name — never-clobber (ADR 0004 / audit M3): monitored,
   * timezone, and summary_time are admin preferences and are never
   * overwritten here (updateGroup is the only admin-preference writer).
   * Without a chatId the id is the key (insert or full replace).
   */
  upsertGroup(group: Group): Promise<Group>;

  // ---- Summary runs ----
  /**
   * Create-or-find semantics: a request for the same group, half-open
   * interval (compared as instants), and kind returns the existing run
   * instead of creating a duplicate. The first request's timezone label
   * is kept on the run; the label is presentation metadata, not identity.
   */
  createOrFindRun(input: CreateRunInput): Promise<{ run: SummaryRun; created: boolean }>;
  /**
   * Read-only identity lookup (group, interval instants, kind) — used
   * by the scheduler to ask "does a run already exist for this
   * window?" WITHOUT creating one. Undefined when there is none.
   */
  findRunByIdentity(input: CreateRunInput): Promise<SummaryRun | undefined>;
  getRun(id: string): Promise<SummaryRun | undefined>;
  /** Newest first. */
  listRuns(): Promise<SummaryRun[]>;
  /** Replaces the mutable run fields (status, attempts, error, updatedAt). */
  updateRun(run: SummaryRun): Promise<SummaryRun>;

  // ---- Summaries ----
  /**
   * Idempotent write keyed by runId (one summary per run): a repeated
   * write for the same run replaces the result and returns the stored
   * summary with its original id/createdAt.
   */
  saveSummary(summary: Summary): Promise<Summary>;
  getSummary(id: string): Promise<Summary | undefined>;
  getSummaryByRunId(runId: string): Promise<Summary | undefined>;

  // ---- AI provider configuration ----
  /** apiKey is server-side only; routes mask it before responding. */
  getProviderConfig(): Promise<ProviderRecord | null>;
  setProviderConfig(record: ProviderRecord): Promise<ProviderRecord>;

  // ---- WhatsApp connection status (non-secret) ----
  getConnectionStatus(): Promise<ConnectionStatus>;
  setConnectionStatus(status: ConnectionStatus): Promise<void>;
}

/**
 * TEMPORARY in-memory persistence for the skeleton milestone.
 * PostgreSQL is the source of truth (docs/decisions/0001); this class is
 * superseded by PostgresStore for the running application. Nothing stored
 * here is durable across restarts. Behavior is kept identical to the
 * original skeleton store so the existing test suite passes unchanged
 * in meaning.
 */
export class InMemoryStore implements Store {
  private admin: AdminRecord | null = null;
  private readonly sessions = new Map<string, { createdAt: string }>();
  private readonly groups = new Map<string, Group>();
  private readonly runs = new Map<string, SummaryRun>();
  private readonly runsByIdentity = new Map<string, string>();
  private readonly summaries = new Map<string, Summary>();
  private readonly summariesByRunId = new Map<string, string>();
  private provider: ProviderRecord | null = null;
  private connection: ConnectionStatus = {
    state: "unavailable",
    since: nowIso(),
    lastMessageAt: null,
  };

  async getAdmin(): Promise<AdminRecord | null> {
    return this.admin;
  }

  async setAdmin(record: AdminRecord): Promise<boolean> {
    // Insert-only: concurrent setup attempts must not overwrite each other.
    if (this.admin !== null) return false;
    this.admin = record;
    return true;
  }

  async updateAdminPassword(input: {
    passwordHash: string;
    recoveryCodeHashes?: Set<string>;
  }): Promise<void> {
    const admin = this.admin;
    if (admin === null) return;
    admin.passwordHash = input.passwordHash;
    if (input.recoveryCodeHashes !== undefined) {
      admin.recoveryCodeHashes = input.recoveryCodeHashes;
    }
    this.sessions.clear();
  }

  async consumeRecoveryCode(codeHash: string, newPasswordHash: string): Promise<boolean> {
    const admin = this.admin;
    if (admin === null || !admin.recoveryCodeHashes.has(codeHash)) return false;
    admin.recoveryCodeHashes.delete(codeHash);
    admin.passwordHash = newPasswordHash;
    this.sessions.clear();
    return true;
  }

  async createSession(token: string): Promise<void> {
    this.sessions.set(hashSessionToken(token), { createdAt: nowIso() });
  }

  async validateSession(token: string): Promise<boolean> {
    return this.sessions.has(hashSessionToken(token));
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(hashSessionToken(token));
  }

  async clearSessions(): Promise<void> {
    this.sessions.clear();
  }

  async listGroups(): Promise<Group[]> {
    return [...this.groups.values()];
  }

  async getGroup(id: string): Promise<Group | undefined> {
    return this.groups.get(id);
  }

  async updateGroup(group: Group): Promise<Group | undefined> {
    if (!this.groups.has(group.id)) return undefined;
    this.groups.set(group.id, group);
    return group;
  }

  async upsertGroup(group: Group): Promise<Group> {
    // Natural key is chatId when provided (see Store.upsertGroup): the
    // stored id wins so foreign keys stay stable across rediscovery, and
    // ONLY the name is updated — never-clobber (ADR 0004): admin
    // preferences (monitored/timezone/summaryTime) survive re-registration.
    if (group.chatId !== null) {
      for (const [id, existing] of this.groups) {
        if (existing.chatId === group.chatId) {
          const stored: Group = { ...existing, name: group.name };
          this.groups.set(id, stored);
          return stored;
        }
      }
    }
    this.groups.set(group.id, group);
    return group;
  }

  async createOrFindRun(
    input: CreateRunInput,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    // Identity compares instants, not timestamp strings: equivalent
    // formats (e.g. "...Z" vs "+02:00") map to the same run. The
    // timezone label is presentation metadata, not part of identity —
    // the message set for [start, end) is identical regardless — so the
    // first request's label is kept on the run.
    const identity = runIdentity(input);
    const existingId = this.runsByIdentity.get(identity);
    if (existingId !== undefined) {
      const existing = this.runs.get(existingId);
      if (existing !== undefined) return { run: existing, created: false };
    }
    const now = nowIso();
    const run: SummaryRun = {
      id: randomUUID(),
      groupId: input.groupId,
      kind: input.kind,
      status: "pending",
      interval: input.interval,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.runs.set(run.id, run);
    this.runsByIdentity.set(identity, run.id);
    return { run, created: true };
  }

  async findRunByIdentity(
    input: CreateRunInput,
  ): Promise<SummaryRun | undefined> {
    const existingId = this.runsByIdentity.get(runIdentity(input));
    return existingId === undefined ? undefined : this.runs.get(existingId);
  }

  async getRun(id: string): Promise<SummaryRun | undefined> {
    return this.runs.get(id);
  }

  async listRuns(): Promise<SummaryRun[]> {
    return [...this.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async updateRun(run: SummaryRun): Promise<SummaryRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async saveSummary(summary: Summary): Promise<Summary> {
    const existingId = this.summariesByRunId.get(summary.runId);
    if (existingId !== undefined) {
      // One summary per run: replace the result but keep the stored
      // identity (idempotent worker writes).
      const stored: Summary = { ...summary, id: existingId };
      this.summaries.set(existingId, stored);
      return stored;
    }
    this.summaries.set(summary.id, summary);
    this.summariesByRunId.set(summary.runId, summary.id);
    return summary;
  }

  async getSummary(id: string): Promise<Summary | undefined> {
    return this.summaries.get(id);
  }

  async getSummaryByRunId(runId: string): Promise<Summary | undefined> {
    const id = this.summariesByRunId.get(runId);
    return id === undefined ? undefined : this.summaries.get(id);
  }

  async getProviderConfig(): Promise<ProviderRecord | null> {
    return this.provider;
  }

  async setProviderConfig(record: ProviderRecord): Promise<ProviderRecord> {
    this.provider = record;
    return record;
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return this.connection;
  }

  async setConnectionStatus(status: ConnectionStatus): Promise<void> {
    this.connection = status;
  }
}
