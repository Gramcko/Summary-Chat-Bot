import { randomUUID } from "node:crypto";
import {
  SummaryResult,
  SummaryRun,
  type AiMessage,
  type AiProvider,
  type AiSummaryInput,
  type Interval,
  type ProviderSummaryOutput,
  type RunError,
  type Summary,
} from "@summarly/contracts";
import type {
  RunContext,
  StoredMessage,
  StoredProviderConfig,
  UpsertSummaryInput,
  WorkerDb,
} from "../src/db.js";

/** Deterministic half-open interval used across unit tests. */
export const INTERVAL: Interval = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

export function makeRun(overrides?: Partial<SummaryRun>): SummaryRun {
  return SummaryRun.parse({
    id: randomUUID(),
    groupId: randomUUID(),
    kind: "manual",
    status: "pending",
    interval: INTERVAL,
    attempts: 0,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    error: null,
    ...overrides,
  });
}

export function makeStoredMessages(
  count: number,
  text = "hello",
): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    sender: `sender-${index}`,
    sentAt: `2026-10-28T0${index % 10}:00:00.000Z`,
    text,
  }));
}

export function makeAiMessage(
  text: string,
  sender = "Ana",
  sentAt = "2026-10-28T09:00:00Z",
): AiMessage {
  return { id: randomUUID(), sentAt, sender, text };
}

/** A minimal valid provider output; override any section per test. */
export function fakeOutput(
  overrides?: Partial<ProviderSummaryOutput>,
): ProviderSummaryOutput {
  return {
    overview: "A short overview.",
    keyDiscussions: [],
    confirmedDecisions: [],
    proposals: [],
    unresolvedQuestions: [],
    tasks: [],
    links: [],
    ...overrides,
  };
}

/**
 * AiProvider whose behavior is scripted per call. The implementation
 * sees the exact input the pipeline assembled (chunks included).
 */
export class FakeProvider implements AiProvider {
  readonly calls: AiSummaryInput[] = [];

  constructor(
    private readonly impl: (
      input: AiSummaryInput,
      index: number,
    ) => ProviderSummaryOutput,
  ) {}

  async generate(input: AiSummaryInput): Promise<ProviderSummaryOutput> {
    this.calls.push(input);
    return this.impl(input, this.calls.length - 1);
  }
}

/**
 * In-memory WorkerDb mirroring the PostgresWorkerDb semantics that the
 * unit tests depend on: terminal states are protected, `attempts`
 * increments per processing pass, and the summary upsert is keyed by
 * runId (repeated writes keep the original id/createdAt).
 */
export class FakeDb implements WorkerDb {
  run: SummaryRun | undefined;
  groupName = "Fake Group";
  messages: StoredMessage[] = [];
  readonly summaries = new Map<string, Summary>();
  /** Every markRunFailed call, whether or not it transitioned a run. */
  readonly failedWriteCalls: RunError[] = [];
  /** markRunFailed calls that actually transitioned a run to failed. */
  readonly failedWrites: RunError[] = [];
  processingCalls = 0;
  completedCalls = 0;

  constructor(run?: SummaryRun) {
    this.run = run;
  }

  async loadRun(summaryRunId: string): Promise<RunContext | undefined> {
    if (this.run === undefined || this.run.id !== summaryRunId) return undefined;
    return { run: this.run, groupName: this.groupName };
  }

  /** Last requested fetch limit (audit M3/E-4 tests). */
  fetchLimitUsed: number | undefined;
  /** Set to throw a pg-like error from fetchMessages (audit E-6). */
  fetchMessagesError: Error | undefined;

  async fetchMessages(
    _groupId?: string,
    _interval?: Interval,
    limit?: number,
  ): Promise<StoredMessage[]> {
    if (this.fetchMessagesError !== undefined) throw this.fetchMessagesError;
    this.fetchLimitUsed = limit;
    return limit === undefined ? this.messages : this.messages.slice(0, limit);
  }

  async upsertSummary(input: UpsertSummaryInput): Promise<Summary> {
    const result = SummaryResult.parse(input.result);
    const existing = this.summaries.get(input.runId);
    const summary: Summary = {
      id: existing?.id ?? randomUUID(),
      runId: input.runId,
      provider: input.provider,
      model: input.model,
      result,
      createdAt: existing?.createdAt ?? "2026-10-29T01:00:00.000Z",
    };
    this.summaries.set(input.runId, summary);
    return summary;
  }

  async markRunProcessing(
    summaryRunId: string,
  ): Promise<SummaryRun | undefined> {
    if (this.run === undefined || this.run.id !== summaryRunId) return undefined;
    if (this.run.status !== "pending" && this.run.status !== "processing") {
      return undefined;
    }
    this.run = {
      ...this.run,
      status: "processing",
      attempts: this.run.attempts + 1,
      error: null,
    };
    this.processingCalls += 1;
    return this.run;
  }

  async markRunCompleted(summaryRunId: string): Promise<boolean> {
    if (this.run === undefined || this.run.id !== summaryRunId) return false;
    if (this.run.status !== "pending" && this.run.status !== "processing") {
      return false;
    }
    this.run = { ...this.run, status: "completed", error: null };
    this.completedCalls += 1;
    return true;
  }

  async markRunFailed(summaryRunId: string, error: RunError): Promise<boolean> {
    this.failedWriteCalls.push(error);
    if (this.run === undefined || this.run.id !== summaryRunId) return false;
    if (this.run.status !== "pending" && this.run.status !== "processing") {
      return false;
    }
    this.run = { ...this.run, status: "failed", error };
    this.failedWrites.push(error);
    return true;
  }

  /** Saved provider config; undefined = unconfigured (mock). */
  providerConfig: StoredProviderConfig | undefined = undefined;
  /** Set to make loadProviderConfig throw (transient read failure). */
  providerConfigError: Error | undefined = undefined;

  async loadProviderConfig(): Promise<StoredProviderConfig | undefined> {
    if (this.providerConfigError !== undefined) throw this.providerConfigError;
    return this.providerConfig;
  }
}
