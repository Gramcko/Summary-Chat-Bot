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
 *   configuration problems) mark the run `failed` immediately and throw
 *   BullMQ's UnrecoverableError so the job is not retried.
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

export interface PipelineDeps {
  db: WorkerDb;
  provider: AiProvider;
  /** Provider/model identity persisted with the summary. */
  providerName: string;
  modelName: string;
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

  const processing = await deps.db.markRunProcessing(summaryRunId);
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

  const messages = await deps.db.fetchMessages(run.groupId, run.interval);
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
  log?.("info", "run_generating", {
    summaryRunId,
    messageCount: input.messages.length,
    chunkCount: chunks.length,
    attempt: processing.attempts,
  });

  const outputs: ProviderSummaryOutput[] = [];
  for (const chunk of chunks) {
    outputs.push(await callProvider(deps.provider, { ...input, messages: chunk }));
  }

  // Assemble, flag, and VALIDATE: never persist unvalidated provider
  // output. `aiGenerated` is application metadata, set here — providers
  // are never asked to echo it.
  const result = assembleResult(outputs);

  await deps.db.upsertSummary({
    runId: summaryRunId,
    provider: deps.providerName,
    model: deps.modelName,
    result,
  });

  const completed = await deps.db.markRunCompleted(summaryRunId);
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
