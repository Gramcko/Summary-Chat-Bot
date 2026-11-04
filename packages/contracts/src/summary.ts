import { z } from "zod";
import { Id, Interval, IsoDateTime } from "./common.js";

/**
 * Reference to a source message supporting a summary claim. The
 * summary-worker VERIFIES every ref against the messages fetched for
 * the run and normalizes `sentAt` to the stored message's timestamp.
 *
 * Provenance policy (audit E-1, ADR 0005): consequential items
 * (`DecisionItem` in confirmedDecisions/proposals/unresolvedQuestions,
 * and `TaskItem`) require at least ONE verified sourceRef or the worker
 * drops the item — an empty list here means "no message supports this
 * claim", and such claims must not appear as decisions, proposals,
 * questions, or tasks (AGENTS.md). Ref-less content is only kept in
 * `keyDiscussions`. The schema still permits empty lists (a provider
 * may emit one; the verification boundary enforces the policy).
 */
export const SourceRef = z.object({
  messageId: Id,
  sentAt: IsoDateTime,
});

export const DecisionItem = z.object({
  text: z.string().min(1).max(2000),
  sourceRefs: z.array(SourceRef).max(100),
});

/**
 * `owner` and `dueDate` are null unless source messages explicitly support
 * them. Never infer an owner, deadline, or agreement the conversation
 * does not state.
 */
export const TaskItem = z.object({
  text: z.string().min(1).max(2000),
  owner: z.string().max(200).nullable(),
  dueDate: z.iso.date().nullable(),
  sourceRefs: z.array(SourceRef).max(100),
});

export const LinkItem = z.object({
  url: z.url(),
  description: z.string().max(500).nullable(),
});

/**
 * Validated summary output. The summary-worker must reject provider output
 * that fails this schema instead of persisting it.
 */
export const SummaryResult = z.object({
  overview: z.string().min(1).max(5000),
  keyDiscussions: z.array(z.string().min(1).max(2000)).max(100),
  confirmedDecisions: z.array(DecisionItem).max(100),
  proposals: z.array(DecisionItem).max(100),
  unresolvedQuestions: z.array(DecisionItem).max(100),
  tasks: z.array(TaskItem).max(100),
  links: z.array(LinkItem).max(100),
  /**
   * Every summary is AI-generated. The UI must say so, and consequential
   * items should be checked against source messages.
   */
  aiGenerated: z.literal(true),
});

export const Summary = z.object({
  id: Id,
  runId: Id,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  result: SummaryResult,
  createdAt: IsoDateTime,
});

/**
 * A summary as served in a group's "past summaries" list (ADR 0008):
 * the stored summary plus the interval of the run that produced it
 * (the run's kind is not needed here — the list is period-oriented).
 */
export const GroupSummary = Summary.extend({
  interval: Interval,
});

export type SourceRef = z.infer<typeof SourceRef>;
export type DecisionItem = z.infer<typeof DecisionItem>;
export type TaskItem = z.infer<typeof TaskItem>;
export type LinkItem = z.infer<typeof LinkItem>;
export type SummaryResult = z.infer<typeof SummaryResult>;
export type Summary = z.infer<typeof Summary>;
export type GroupSummary = z.infer<typeof GroupSummary>;
