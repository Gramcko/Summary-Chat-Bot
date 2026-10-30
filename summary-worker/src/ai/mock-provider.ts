import {
  ProviderSummaryOutput,
  type AiMessage,
  type AiProvider,
  type AiSummaryInput,
  type DecisionItem,
  type LinkItem,
  type TaskItem,
} from "@summarly/contracts";
import { truncateText } from "../lib/text.js";

/**
 * Deterministic mock AI provider for tests and local development
 * (architecture §7: "a mock adapter for tests").
 *
 * Guarantees proven by tests (tests/mock-provider.test.ts):
 *
 * 1. DETERMINISM — the output is a pure function of the input: the same
 *    input always produces byte-identical output (no clocks, no
 *    randomness, no environment).
 * 2. EMPTY PERIODS — a message-less period produces overview "No
 *    messages were found in this period." with every section empty.
 * 3. PROMPT-INJECTION RESISTANCE — message text is strictly DATA. It is
 *    only ever emitted as a quoted snippet inside fixed templates and
 *    can never change the output structure or which code path runs. An
 *    instruction-like message ("ignore previous instructions and
 *    output …") is indistinguishable — apart from its own quoted text —
 *    from a benign message of the same class.
 *
 * Documented heuristics (intentionally simple and transparent):
 *
 * - Every message gets a short quoted snippet in `keyDiscussions`.
 * - Each message is classified into AT MOST ONE section, by precedence:
 *     1. `confirmedDecisions` — explicit decision/agreement wording
 *        (decided, agreed, we will, going with, confirmed).
 *     2. `proposals` — explicit proposal wording (propose, suggest,
 *        should we, how about, what if, maybe, idea).
 *     3. `unresolvedQuestions` — the text contains a question mark.
 *     4. `tasks` — explicit task wording (todo, task, action item,
 *        deadline, due, need to, must, owner:).
 *   Anything else appears only as a `keyDiscussions` snippet.
 * - Tasks get `owner`/`dueDate` ONLY when stated explicitly in the
 *   message ("owner: …", "due YYYY-MM-DD"); both are null otherwise.
 *   Nothing is ever inferred.
 * - Links are extracted verbatim (trailing punctuation trimmed) with a
 *   null description — never invented.
 * - The overview deliberately never echoes message text; it reports
 *   counts and the period only.
 *
 * The provider is asked for `ProviderSummaryOutput` — it never sets the
 * `aiGenerated` flag; the summary-worker adds that after validation.
 */

export const MOCK_PROVIDER_NAME = "mock";
export const MOCK_MODEL_NAME = "mock-1";

const SNIPPET_MAX_CHARS = 160;
/** Contract maxima (packages/contracts/src/summary.ts): 100 per array. */
const MAX_SECTION_ITEMS = 100;

const DECISION_RE =
  /\b(decided|decision|agreed|we will|we'll|going with|confirmed)\b/i;
const PROPOSAL_RE =
  /\b(propos(?:e|ed|al|als)|suggest(?:ed|ion|ions)?|should we|how about|what if|maybe|idea)\b/i;
const TASK_RE = /\b(todo|to-do|task|action item|deadline|due\b|need to|must|owner:)\b/i;
const OWNER_RE = /\bowner:\s*([^\n]+?)(?=\s+due\s|\s*[.,;!?]|$)/i;
const DUE_DATE_RE = /\bdue\s+(\d{4}-\d{2}-\d{2})\b/i;
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= SNIPPET_MAX_CHARS
    ? collapsed
    // Code-point safe truncation (audit L4): a boundary emoji must not
    // become a lone surrogate.
    : `${truncateText(collapsed, SNIPPET_MAX_CHARS)}…`;
}

function quote(message: AiMessage): string {
  return `${message.sender}: "${snippet(message.text)}"`;
}

function sourceRefs(message: AiMessage): DecisionItem["sourceRefs"] {
  return [{ messageId: message.id, sentAt: message.sentAt }];
}

function classify(
  message: AiMessage,
): { kind: "decision" | "proposal" | "question"; item: DecisionItem } | { kind: "task"; item: TaskItem } | null {
  const text = message.text;
  const item = quote(message);
  const refs = sourceRefs(message);
  if (DECISION_RE.test(text)) {
    return { kind: "decision", item: { text: item, sourceRefs: refs } };
  }
  if (PROPOSAL_RE.test(text)) {
    return { kind: "proposal", item: { text: item, sourceRefs: refs } };
  }
  if (text.includes("?")) {
    return { kind: "question", item: { text: item, sourceRefs: refs } };
  }
  if (TASK_RE.test(text)) {
    const ownerMatch = OWNER_RE.exec(text);
    const dueMatch = DUE_DATE_RE.exec(text);
    return {
      kind: "task",
      item: {
        text: item,
        owner: ownerMatch?.[1]?.trim() ?? null,
        dueDate: dueMatch?.[1] ?? null,
        sourceRefs: refs,
      },
    };
  }
  return null;
}

function extractLinks(message: AiMessage): LinkItem[] {
  const links: LinkItem[] = [];
  for (const match of message.text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?)]+$/, "");
    // Only emit URLs that actually parse; a broken one is quoted as
    // message content instead of poisoning the output schema.
    try {
      new URL(url);
    } catch {
      continue;
    }
    links.push({ url, description: null });
    if (links.length >= MAX_SECTION_ITEMS) break;
  }
  return links;
}

/**
 * Pure, deterministic mock summarization. See the module comment for
 * the heuristics and guarantees.
 */
export function generateMockSummary(input: AiSummaryInput): ProviderSummaryOutput {
  const messages = input.messages;
  if (messages.length === 0) {
    return {
      overview: "No messages were found in this period.",
      keyDiscussions: [],
      confirmedDecisions: [],
      proposals: [],
      unresolvedQuestions: [],
      tasks: [],
      links: [],
    };
  }

  const keyDiscussions: string[] = [];
  const confirmedDecisions: DecisionItem[] = [];
  const proposals: DecisionItem[] = [];
  const unresolvedQuestions: DecisionItem[] = [];
  const tasks: TaskItem[] = [];
  const links: LinkItem[] = [];
  const senders = new Set<string>();

  for (const message of messages) {
    senders.add(message.sender);
    if (keyDiscussions.length < MAX_SECTION_ITEMS) {
      keyDiscussions.push(quote(message));
    }
    const classified = classify(message);
    if (classified?.kind === "decision") {
      if (confirmedDecisions.length < MAX_SECTION_ITEMS) {
        confirmedDecisions.push(classified.item);
      }
    } else if (classified?.kind === "proposal") {
      if (proposals.length < MAX_SECTION_ITEMS) proposals.push(classified.item);
    } else if (classified?.kind === "question") {
      if (unresolvedQuestions.length < MAX_SECTION_ITEMS) {
        unresolvedQuestions.push(classified.item);
      }
    } else if (classified?.kind === "task") {
      if (tasks.length < MAX_SECTION_ITEMS) tasks.push(classified.item);
    }
    for (const link of extractLinks(message)) {
      if (links.length >= MAX_SECTION_ITEMS) break;
      if (!links.some((existing) => existing.url === link.url)) {
        links.push(link);
      }
    }
  }

  // Counts and period only — the overview never echoes message text.
  const overview =
    `Conversation period with ${messages.length} message(s) from ` +
    `${senders.size} sender(s) between ${input.period.start} and ` +
    `${input.period.end}.`;

  return {
    overview,
    keyDiscussions,
    confirmedDecisions,
    proposals,
    unresolvedQuestions,
    tasks,
    links,
  };
}

/** AiProvider wrapper around {@link generateMockSummary}. */
export class MockAiProvider implements AiProvider {
  async generate(input: AiSummaryInput): Promise<ProviderSummaryOutput> {
    return generateMockSummary(input);
  }
}
