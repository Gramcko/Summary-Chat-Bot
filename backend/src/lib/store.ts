import { randomUUID } from "node:crypto";
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

export interface SessionRecord {
  createdAt: string;
}

export interface LoginAttemptRecord {
  count: number;
  lockedUntil: number;
}

export interface ProviderRecord {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Server-side only. Never part of any API response. */
  apiKey: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * TEMPORARY in-memory persistence for the skeleton milestone.
 * PostgreSQL is the source of truth (docs/decisions/0001); this class is
 * replaced by database-backed repositories at the persistence milestone.
 * Nothing stored here is durable across restarts.
 */
export class InMemoryStore {
  admin: AdminRecord | null = null;
  readonly sessions = new Map<string, SessionRecord>();
  readonly loginAttempts = new Map<string, LoginAttemptRecord>();
  readonly groups = new Map<string, Group>();
  readonly runs = new Map<string, SummaryRun>();
  readonly runsByIdentity = new Map<string, string>();
  readonly summaries = new Map<string, Summary>();
  provider: ProviderRecord | null = null;
  connection: ConnectionStatus = {
    state: "unavailable",
    since: nowIso(),
    lastMessageAt: null,
  };

  /**
   * Create-or-find semantics: a request for the same group, interval, and
   * kind returns the existing run instead of creating a duplicate.
   */
  createOrFindRun(input: {
    groupId: string;
    interval: Interval;
    kind: RunKind;
  }): { run: SummaryRun; created: boolean } {
    // Identity compares instants, not timestamp strings: equivalent
    // formats (e.g. "...Z" vs "+02:00") map to the same run. The
    // timezone label is presentation metadata, not part of identity —
    // the message set for [start, end) is identical regardless — so the
    // first request's label is kept on the run.
    const startMs = Date.parse(input.interval.start);
    const endMs = Date.parse(input.interval.end);
    const identity = `${input.groupId}|${startMs}|${endMs}|${input.kind}`;
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
}
