import { z } from "zod";
import { Id, Interval, IsoDateTime } from "./common.js";
import { SummaryResult } from "./summary.js";

/**
 * One conversation message as presented to the AI provider.
 *
 * Message text is strictly DATA: provider adapters must place it in the
 * data position of their prompts and never interpret it as instructions
 * (AGENTS.md — chat content is untrusted). System-level instructions
 * live outside these types, inside the provider adapter.
 *
 * Caps (defense in depth, audit M3): `sender` and `text` are bounded so
 * oversized content can never blow up a request; producers truncate at
 * their mapping boundary (the summary-worker does) instead of failing.
 */
export const AiMessage = z.object({
  /** Stable message id; the anchor for source references. */
  id: Id,
  sentAt: IsoDateTime,
  /** Sender display identity. Unknown senders use a placeholder. */
  sender: z.string().min(1).max(200),
  text: z.string().max(4096),
});

/**
 * Input for one AI summarization request. `period` is the half-open
 * interval [start, end) of the run being summarized; `messages` is
 * ordered deterministically and may be empty (empty periods are valid).
 */
export const AiSummaryInput = z.object({
  groupName: z.string().min(1),
  period: Interval,
  messages: z.array(AiMessage),
});

/**
 * What an AI provider must return: `SummaryResult` WITHOUT the
 * `aiGenerated` flag. That literal is application metadata set by the
 * summary-worker after validation — a provider must never be asked to
 * echo it back (a pointless, failure-prone instruction). Add it back
 * with `SummaryResult.parse({ ...output, aiGenerated: true })`.
 */
export const ProviderSummaryOutput = SummaryResult.omit({ aiGenerated: true });

/**
 * Provider-neutral AI adapter contract (architecture §7).
 *
 * Implementations must be deterministic only where the engine allows it;
 * callers must tolerate retries. Error expectations:
 *
 * - Permanent problems (bad provider configuration, missing credentials)
 *   should be signaled as errors the caller classifies as permanent
 *   (see summary-worker/src/errors.ts) — they fail the run immediately.
 * - Transient problems (timeouts, rate limits) and malformed output are
 *   retryable; the caller classifies unknown errors as retryable.
 */
export interface AiProvider {
  generate(input: AiSummaryInput): Promise<ProviderSummaryOutput>;
}

export type AiMessage = z.infer<typeof AiMessage>;
export type AiSummaryInput = z.infer<typeof AiSummaryInput>;
export type ProviderSummaryOutput = z.infer<typeof ProviderSummaryOutput>;

// ---- Provider identity strings (ADR 0005) ----
//
// These are the exact strings the admin enters in the settings screen
// (`PUT /api/settings/ai-provider`) and the summary-worker uses to
// select an adapter. Unknown values fail the run with a permanent
// `provider_config` error instead of guessing.

/** Deterministic mock adapter: the default and the test provider. */
export const AI_PROVIDER_MOCK = "mock";

/** Google Gemini REST adapter (see docs/decisions/0005-ai-provider.md). */
export const AI_PROVIDER_GOOGLE_GEMINI = "google-gemini";

/**
 * Default model for {@link AI_PROVIDER_GOOGLE_GEMINI}: the stable
 * Flash-tier model verified against the Gemini API docs on 2026-11-02
 * (`gemini-3.8-flash`, 1M input / 65,536 output tokens). Model ids are
 * version-sensitive — the saved config's `model` overrides this.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
