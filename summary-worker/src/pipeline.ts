import {
  AiSummaryInput,
  ProviderSummaryOutput,
  SummaryResult,
  type AiMessage,
  type AiProvider,
  type DecisionItem,
  type LinkItem,
  type RunError,
  type SummaryResult as SummaryResultType,
  type TaskItem,
} from "@summarly/contracts";
import { ZodError } from "zod";
import type { ProviderResolution } from "./ai/resolve-provider.js";
import type { RunContext, StoredMessage, WorkerDb } from "./db.js";
import {
  PermanentRunError,
  RetryableRunError,
  isPermanentFailure,
  toRunError,
} from "./errors.js";
import type { Logger } from "./lib/log.js";
import { truncateText } from "./lib/text.js";

/**
 * The summary-generation pipeline (architecture §4.4): load the durable
 * run, fetch its messages, call the AI provider (conversation as
 * untrusted data), consolidate chunked results, VALIDATE the assembled
 * SummaryResult against the contract, and persist it idempotently.
 *
 * Failure semantics:
 *
 * - Permanent failures (unknown run, invalid run state/data, provider
 *   configuration problems, oversized conversations) mark the run
 *   `failed` immediately and throw BullMQ's UnrecoverableError so the
 *   job is not retried.
 * - Retryable failures (timeouts, rate limits, malformed provider
 *   output) are rethrown unchanged: BullMQ retries with finite backoff
 *   and the worker's failed-event safety net marks the run `failed`
 *   when attempts are exhausted.
 */

/**
 * Chunking budget: conversations whose message text exceeds this many
 * characters are summarized in chunks and consolidated (§4.4 point 4).
 */
export const MAX_CHARS_PER_CHUNK = 20000;

/**
 * Cost/size caps (audit M3 remainder): a hostile or bloated
 * conversation must never translate into unbounded provider spend.
 * Exceeding either cap fails the run permanently with `too_large` —
 * retrying the same conversation cannot make it smaller. Both are
 * operator-configurable via env (see .env.example).
 */
export const DEFAULT_MAX_MESSAGES_PER_RUN = 2000;
export const DEFAULT_MAX_CHUNKS_PER_RUN = 10;

export interface RunLimits {
  maxMessagesPerRun: number;
  maxChunksPerRun: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxMessagesPerRun: DEFAULT_MAX_MESSAGES_PER_RUN,
  maxChunksPerRun: DEFAULT_MAX_CHUNKS_PER_RUN,
};

/**
 * Parses one positive-integer env knob (e.g. MAX_MESSAGES_PER_RUN,
 * AI_REQUEST_TIMEOUT_MS). Unset/empty → the fallback default; must be
 * a positive integer (fail fast on garbage, like every other config
 * knob in this repo).
 */
export function parsePositiveEnvInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

/**
 * Upper bound for honoring a provider Retry-After hint before
 * rethrowing (see callProvider). Longer hints are advisory metadata
 * only — the finite BullMQ backoff covers the gap.
 */
export const MAX_HONORED_RETRY_AFTER_MS = 30_000;

/** Pure clamp used before sleeping on a retry hint. */
export function retryAfterWaitMs(retryAfterMs: number): number {
  return Math.min(Math.max(retryAfterMs, 0), MAX_HONORED_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Contract maxima re-applied at consolidation so the result validates. */
const MAX_OVERVIEW_CHARS = 5000;
const MAX_SECTION_ITEMS = 100;
const MAX_SOURCE_REFS = 100;

/**
 * Assembles the final SummaryResult from per-chunk provider outputs:
 * consolidate, add the `aiGenerated` flag, and VALIDATE (never persist
 * unvalidated output).
 *
 * The final parse is wrapped like the per-chunk one (audit L2): a
 * validation failure is a retryable `provider_malformed_output` with a
 * FIXED message, because a raw ZodError embeds the received values and
 * would otherwise leak into BullMQ's failedReason in Redis.
 */
export function assembleResult(
  outputs: ProviderSummaryOutput[],
): SummaryResultType {
  try {
    return SummaryResult.parse({
      ...consolidate(outputs),
      aiGenerated: true,
    });
  } catch {
    throw new RetryableRunError(
      "provider_malformed_output",
      "The assembled summary does not match the SummaryResult contract.",
    );
  }
}

/**
 * Provenance verification (audit L3 / E-1): a provider-claimed
 * sourceRef is dropped unless its messageId is one of the messages
 * actually fetched for the run, and a surviving ref's `sentAt` is
 * NORMALIZED to the fetched message's real timestamp (the model's
 * timestamp is never trusted for display — review n3).
 *
 * Consequential items (confirmedDecisions, proposals,
 * unresolvedQuestions, tasks) require at least ONE surviving ref or
 * they are dropped — whether they cited nothing or only invented ids.
 * This enforces the AGENTS.md rule: "do not label a statement as a
 * confirmed decision, deadline, task, or owner unless source messages
 * support that claim". General observations without message support
 * belong in keyDiscussions, which is the only ref-less surface.
 */
export function verifySourceRefs<T extends { sourceRefs: DecisionItem["sourceRefs"] }>(
  items: T[],
  validMessages: ReadonlyMap<string, string>,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const survivingRefs = item.sourceRefs
      .filter((ref) => validMessages.has(ref.messageId))
      .map((ref) => ({
        messageId: ref.messageId,
        // Displayed truth: the fetched message's actual sentAt.
        sentAt: validMessages.get(ref.messageId) ?? ref.sentAt,
      }));
    if (survivingRefs.length === 0) {
      continue; // no message supports this claim — drop the item
    }
    // Always rebuild: surviving refs carry the normalized sentAt even
    // when no ref was dropped (review n3).
    kept.push({ ...item, sourceRefs: survivingRefs });
  }
  return kept;
}

/**
 * Applies {@link verifySourceRefs} to every section that carries
 * provenance. keyDiscussions (ref-less by contract) and links pass
 * through.
 */
export function verifyOutputSourceRefs(
  output: ProviderSummaryOutput,
  validMessages: ReadonlyMap<string, string>,
): ProviderSummaryOutput {
  return {
    ...output,
    confirmedDecisions: verifySourceRefs(
      output.confirmedDecisions,
      validMessages,
    ),
    proposals: verifySourceRefs(output.proposals, validMessages),
    unresolvedQuestions: verifySourceRefs(
      output.unresolvedQuestions,
      validMessages,
    ),
    tasks: verifySourceRefs(output.tasks, validMessages),
  };
}

export interface PipelineDeps {
  db: WorkerDb;
  provider: AiProvider;
  /** Provider/model identity persisted with the summary. */
  providerName: string;
  modelName: string;
  /**
   * Per-run provider resolution (ADR 0005): when present it OVERRIDES
   * the static provider/identity above, so saved provider config takes
   * effect without a worker restart. Resolution errors classify like
   * provider errors (config problems are permanent).
   */
  resolveProvider?: () => Promise<ProviderResolution>;
  /** Cost/size caps (audit M3); defaults to DEFAULT_RUN_LIMITS. */
  limits?: RunLimits;
  log?: Logger;
}

export type PipelineOutcome = "completed" | "already-completed";

/**
 * Splits messages into chunks whose combined text fits `maxChars`
 * (greedy, preserving order). A single message larger than the budget
 * becomes a chunk of its own — messages are never torn apart. Always
 * returns at least one chunk: an empty conversation is a single empty
 * chunk, because empty periods are valid provider input.
 */
export function splitIntoChunks(
  messages: AiMessage[],
  maxChars: number = MAX_CHARS_PER_CHUNK,
): AiMessage[][] {
  const chunks: AiMessage[][] = [];
  let current: AiMessage[] = [];
  let currentChars = 0;
  for (const message of messages) {
    const chars = message.text.length;
    if (current.length > 0 && currentChars + chars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(message);
    currentChars += chars;
  }
  chunks.push(current);
  return chunks;
}

function capRefs<T extends { sourceRefs: DecisionItem["sourceRefs"] }>(
  item: T,
): T {
  return item.sourceRefs.length <= MAX_SOURCE_REFS
    ? item
    : { ...item, sourceRefs: item.sourceRefs.slice(0, MAX_SOURCE_REFS) };
}

/**
 * Consolidates per-chunk provider outputs into one SummaryResult-shaped
 * object (without `aiGenerated`, which the pipeline adds afterwards).
 *
 * - Overviews are joined (paragraph break) and truncated to the
 *   contract limit, earliest chunks first.
 * - Section arrays are concatenated in chunk order with each item's
 *   source references preserved, capped at the contract maxima (first
 *   items win — deterministic).
 * - Links are deduplicated by URL, keeping the first occurrence.
 */
export function consolidate(
  outputs: ProviderSummaryOutput[],
): Omit<SummaryResultType, "aiGenerated"> {
  const overviews = outputs
    .map((output) => output.overview)
    .filter((overview) => overview.length > 0)
    .join("\n\n");
  const links: LinkItem[] = [];
  for (const output of outputs) {
    for (const link of output.links) {
      if (links.length >= MAX_SECTION_ITEMS) break;
      if (!links.some((existing) => existing.url === link.url)) {
        links.push(link);
      }
    }
  }
  return {
    // Overview truncation must not split a surrogate pair (audit L4).
    overview: truncateText(overviews, MAX_OVERVIEW_CHARS),
    keyDiscussions: outputs
      .flatMap((output) => output.keyDiscussions)
      .slice(0, MAX_SECTION_ITEMS),
    confirmedDecisions: outputs
      .flatMap((output) => output.confirmedDecisions)
      .map(capRefs)
      .slice(0, MAX_SECTION_ITEMS),
    proposals: outputs
      .flatMap((output) => output.proposals)
      .map(capRefs)
      .slice(0, MAX_SECTION_ITEMS),
    unresolvedQuestions: outputs
      .flatMap((output) => output.unresolvedQuestions)
      .map(capRefs)
      .slice(0, MAX_SECTION_ITEMS),
    tasks: outputs
      .flatMap((output) => output.tasks)
      .map(capRefs)
      .slice(0, MAX_SECTION_ITEMS),
    links,
  };
}

/**
 * Message-mapping boundary (audit M3): stored messages are truncated to
 * the AiMessage caps before they can fail `AiSummaryInput.parse` — a
 * long real message must never fail a run. Truncation is code-point
 * safe (audit L4). Constants mirror the AiMessage caps in
 * @summarly/contracts.
 */
const AI_SENDER_MAX_CHARS = 200;
const AI_TEXT_MAX_CHARS = 4096;

function toAiMessages(messages: StoredMessage[]): AiMessage[] {
  return messages.map((message) => ({
    id: message.id,
    sentAt: message.sentAt,
    sender:
      truncateText(message.sender, AI_SENDER_MAX_CHARS) ||
      // Never let an empty stored sender become a schema failure.
      "unknown",
    text: truncateText(message.text, AI_TEXT_MAX_CHARS),
  }));
}

/**
 * DB-call boundary (audit E-6): unexpected infrastructure errors (raw
 * pg/driver text — which can embed row values or connection details)
 * surface as retryable `db_unavailable` with a FIXED message so they
 * never reach BullMQ's failedReason, run metadata, or logs. Typed
 * pipeline errors pass through unchanged.
 */
async function withDbBoundary<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      error instanceof PermanentRunError ||
      error instanceof RetryableRunError
    ) {
      throw error;
    }
    throw new RetryableRunError(
      "db_unavailable",
      "A database operation failed; the run will be retried.",
    );
  }
}

async function loadRunOrThrow(
  db: WorkerDb,
  summaryRunId: string,
): Promise<RunContext> {
  let context: RunContext | undefined;
  try {
    context = await db.loadRun(summaryRunId);
  } catch (error) {
    if (error instanceof ZodError) {
      // The stored row violates the contract schema: invalid run data.
      // Retrying can never fix it (M1: permanent).
      throw new PermanentRunError(
        "invalid_run_data",
        "The summary run record does not match the SummaryRun contract.",
      );
    }
    // Any other failure (pool/network/timeout) is TRANSIENT: retrying
    // with finite backoff is the documented policy (AGENTS.md), so this
    // must stay retryable (M1).
    throw new RetryableRunError(
      "db_unavailable",
      "The summary run record could not be read; the run will be retried.",
    );
  }
  if (context === undefined) {
    throw new PermanentRunError(
      "run_not_found",
      `Summary run ${summaryRunId} does not exist.`,
    );
  }
  return context;
}

async function callProvider(
  provider: AiProvider,
  input: AiSummaryInput,
): Promise<ProviderSummaryOutput> {
  let output: unknown;
  try {
    output = await provider.generate(input);
  } catch (error) {
    if (
      error instanceof PermanentRunError ||
      error instanceof RetryableRunError
    ) {
      // Honor the provider's Retry-After hint (bounded): wait before
      // rethrowing so the BullMQ retry cannot fire earlier than the
      // provider asked for. BullMQ's built-in exponential strategy
      // cannot read per-error hints (verified in bullmq 6.5.2
      // `backoffs.js` — builtin strategies win for known backoff
      // types), so the bounded wait happens here. Hints beyond the
      // cap stay advisory metadata on the error (audit L1: numbers
      // only, never provider text).
      if (
        error instanceof RetryableRunError &&
        error.retryAfterMs !== undefined
      ) {
        await sleep(retryAfterWaitMs(error.retryAfterMs));
      }
      throw error;
    }
    // Unknown provider errors are retryable by default (timeouts, rate
    // limits, transient outages). Adapters signal configuration
    // problems as PermanentRunError. The message is fixed so arbitrary
    // provider error text (which could echo conversation content) is
    // never propagated into run metadata.
    throw new RetryableRunError(
      "provider_error",
      "The AI provider request failed; the run will be retried.",
    );
  }
  const parsed = ProviderSummaryOutput.safeParse(output);
  if (!parsed.success) {
    // Malformed provider output is retryable (§4.4 point 8): a later
    // attempt may produce valid output. The Zod details are not
    // propagated because they can embed the received values.
    throw new RetryableRunError(
      "provider_malformed_output",
      "The AI provider returned output that does not match ProviderSummaryOutput.",
    );
  }
  return parsed.data;
}

async function safeMarkRunFailed(
  db: WorkerDb,
  summaryRunId: string,
  error: RunError,
  log: Logger | undefined,
): Promise<void> {
  try {
    await db.markRunFailed(summaryRunId, error);
  } catch {
    // The safety net (worker failed-event handler) will try again, and
    // round-2 reconciliation covers runs left in `processing`.
    log?.("error", "run_fail_write_failed", { summaryRunId });
  }
}

/**
 * Processes one `generate-summary` job payload (already validated).
 * Idempotent: a run that is already `completed` returns without calling
 * the provider or touching the stored summary.
 */
export async function processSummaryRun(
  deps: PipelineDeps,
  summaryRunId: string,
): Promise<PipelineOutcome> {
  try {
    return await runPipeline(deps, summaryRunId);
  } catch (error) {
    const metadata = toRunError(error);
    if (isPermanentFailure(error)) {
      await safeMarkRunFailed(deps.db, summaryRunId, metadata, deps.log);
      deps.log?.("error", "run_permanently_failed", {
        summaryRunId,
        code: metadata.code,
      });
      // UnrecoverableError stops BullMQ retries permanently.
      const unrecoverable = new Error(
        `${metadata.code}: ${metadata.message}`,
      ) as Error & { name: string };
      unrecoverable.name = "UnrecoverableError";
      throw unrecoverable;
    }
    deps.log?.("warn", "run_attempt_failed", {
      summaryRunId,
      code: metadata.code,
    });
    throw error;
  }
}

async function runPipeline(
  deps: PipelineDeps,
  summaryRunId: string,
): Promise<PipelineOutcome> {
  const log = deps.log;
  const context = await loadRunOrThrow(deps.db, summaryRunId);
  const run = context.run;

  // Idempotent redelivery: a completed run is never reprocessed and its
  // summary is never rewritten (architecture §6).
  if (run.status === "completed") {
    log?.("info", "run_already_completed", { summaryRunId });
    return "already-completed";
  }

  const processing = await withDbBoundary(() =>
    deps.db.markRunProcessing(summaryRunId),
  );
  if (processing === undefined) {
    // The run vanished or reached a terminal state concurrently.
    const current = await deps.db.loadRun(summaryRunId);
    if (current?.run.status === "completed") {
      return "already-completed";
    }
    throw new PermanentRunError(
      "run_not_processable",
      `Summary run ${summaryRunId} is not pending or processing.`,
    );
  }

  // Resolve the configured provider for THIS run (ADR 0005): saved
  // provider config takes effect without a worker restart, and config
  // defects fail the run permanently through the usual classification.
  const resolved =
    deps.resolveProvider !== undefined
      ? await deps.resolveProvider()
      : {
          provider: deps.provider,
          providerName: deps.providerName,
          modelName: deps.modelName,
        };

  const limits = deps.limits ?? DEFAULT_RUN_LIMITS;
  // Fetch at most one row past the cap (audit M3/E-4): the too_large
  // decision is made without materializing an unbounded interval.
  const messages = await withDbBoundary(() =>
    deps.db.fetchMessages(run.groupId, run.interval, limits.maxMessagesPerRun + 1),
  );
  if (messages.length > limits.maxMessagesPerRun) {
    // Permanent by construction: the same conversation would fail the
    // same way on every retry, and never spend provider budget. The
    // fixed message names the knob that tripped (review n6).
    throw new PermanentRunError(
      "too_large",
      `This conversation exceeds MAX_MESSAGES_PER_RUN (limit ${limits.maxMessagesPerRun} messages).`,
    );
  }
  let input: AiSummaryInput;
  try {
    input = AiSummaryInput.parse({
      groupName: context.groupName,
      period: run.interval,
      messages: toAiMessages(messages),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      // Contract parse failure = invalid run/row data (m3): permanent.
      // Previously this surfaced as a retryable provider_error and was
      // retried five times against a defect retrying cannot fix.
      throw new PermanentRunError(
        "invalid_run_data",
        "The assembled AI input does not match the AiSummaryInput contract.",
      );
    }
    throw error;
  }

  const chunks = splitIntoChunks(input.messages);
  if (chunks.length > limits.maxChunksPerRun) {
    // Provider-spend guard (audit M3): bounded chunks per run; the
    // fixed message names the knob that tripped (review n6).
    throw new PermanentRunError(
      "too_large",
      `This conversation exceeds MAX_CHUNKS_PER_RUN (limit ${limits.maxChunksPerRun} chunks).`,
    );
  }
  log?.("info", "run_generating", {
    summaryRunId,
    messageCount: input.messages.length,
    chunkCount: chunks.length,
    attempt: processing.attempts,
  });

  const outputs: ProviderSummaryOutput[] = [];
  for (const chunk of chunks) {
    outputs.push(
      await callProvider(resolved.provider, { ...input, messages: chunk }),
    );
  }

  // Provenance verification (audit L3/E-1): provider-claimed sourceRefs
  // are checked against the messages actually fetched for THIS run —
  // invented ids are dropped, consequential items with no surviving
  // support disappear, and surviving timestamps come from the stored
  // message, not the model.
  const validMessages = new Map(
    input.messages.map((message) => [message.id, message.sentAt]),
  );
  const verifiedOutputs = outputs.map((output) =>
    verifyOutputSourceRefs(output, validMessages),
  );

  // Assemble, flag, and VALIDATE: never persist unvalidated provider
  // output. `aiGenerated` is application metadata, set here — providers
  // are never asked to echo it.
  const result = assembleResult(verifiedOutputs);

  await withDbBoundary(() =>
    deps.db.upsertSummary({
      runId: summaryRunId,
      provider: resolved.providerName,
      model: resolved.modelName,
      result,
    }),
  );

  const completed = await withDbBoundary(() =>
    deps.db.markRunCompleted(summaryRunId),
  );
  if (!completed) {
    // Another execution finalized the run first (duplicate delivery).
    // The summary write above is idempotent, so nothing is duplicated.
    // The concurrent outcome is not always "completed" — report what
    // the run actually became (m2).
    let currentStatus = "unknown";
    try {
      currentStatus = (await deps.db.loadRun(summaryRunId))?.run.status ?? "missing";
    } catch {
      // Status is log-only context; never fail the job to obtain it.
    }
    log?.("warn", "run_finalized_concurrently", { summaryRunId, currentStatus });
    return "already-completed";
  }

  log?.("info", "run_completed", {
    summaryRunId,
    messageCount: input.messages.length,
    chunkCount: chunks.length,
  });
  return "completed";
}
