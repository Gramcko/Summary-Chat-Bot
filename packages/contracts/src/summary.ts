import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";

/**
 * Reference to a source message supporting a summary claim.
 * An empty `sourceRefs` list means the item is not verifiable against
 * specific messages and must be presented with appropriate uncertainty.
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

export type SourceRef = z.infer<typeof SourceRef>;
export type DecisionItem = z.infer<typeof DecisionItem>;
export type TaskItem = z.infer<typeof TaskItem>;
export type LinkItem = z.infer<typeof LinkItem>;
export type SummaryResult = z.infer<typeof SummaryResult>;
export type Summary = z.infer<typeof Summary>;
