/**
 * Retention CLI logic (ADR 0004 / audit M6, fix round A audit M-2/M5):
 * purge captured messages AND the member roster by group id, chat id,
 * and/or a sent_at cutoff. Pure argument parsing and selection
 * semantics live here so they are unit-testable; the CLI script
 * (backend/scripts/purge-messages.ts) owns prompting and execution.
 *
 * Semantics: each supplied selector narrows the selection (AND):
 * - `--group-id <uuid>`  messages of that group's chat (repeatable)
 * - `--chat-id <jid>`    messages of that chat (repeatable)
 * - `--before <ISO>`     messages with sent_at strictly before the instant
 * At least one selector is required.
 *
 * Scope rules (buildPurgePlan):
 * - messages: the chat scope AND the date cutoff both apply.
 * - group_members: a chat-scoped purge removes the FULL roster of those
 *   chats (roster rows are that chat's PII — including departed
 *   members kept as history); a date-only purge removes roster rows
 *   last updated before the cutoff. With no resolved scope NOTHING is
 *   deleted — an empty scope must never mean "everything".
 */

export interface PurgeSelection {
  groupIds: string[];
  chatIds: string[];
  /** Cutoff instant (inclusive of nothing at/after it); null = no cutoff. */
  before: Date | null;
  /** Skip the typed confirmation (explicit --yes for automation). */
  assumeYes: boolean;
}

export const PURGE_CONFIRMATION = "DELETE";

export function parsePurgeArgs(argv: string[]): PurgeSelection {
  const groupIds: string[] = [];
  const chatIds: string[] = [];
  let before: Date | null = null;
  let assumeYes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--group-id":
        groupIds.push(next());
        break;
      case "--chat-id":
        chatIds.push(next());
        break;
      case "--before": {
        const raw = next();
        const parsed = Date.parse(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`--before must be an ISO 8601 date/time (got "${raw}")`);
        }
        before = new Date(parsed);
        break;
      }
      case "--yes":
        assumeYes = true;
        break;
      default:
        throw new Error(`unknown argument "${arg ?? ""}"`);
    }
  }

  if (groupIds.length === 0 && chatIds.length === 0 && before === null) {
    throw new Error(
      "nothing to purge: pass --group-id <uuid>, --chat-id <jid>, and/or --before <ISO date>",
    );
  }

  return { groupIds, chatIds, before, assumeYes };
}

export const PURGE_USAGE = [
  "Usage: npm run purge-messages -w @summarly/backend -- [selectors] [--yes]",
  "  --group-id <uuid>   purge messages of this group (repeatable)",
  "  --chat-id <jid>     purge messages of this chat (repeatable)",
  "  --before <ISO>      purge messages sent strictly before this instant",
  "  --yes               skip the typed confirmation (automation)",
  "Selectors combine with AND. At least one is required. This PERMANENTLY",
  "deletes captured messages AND the group_members roster rows of the",
  "purged chats (names/JIDs are PII; a chat-scoped purge removes the",
  "full roster of those chats, a date-only purge removes roster rows",
  "updated before the cutoff). Database backups taken before the purge",
  "still contain them (ADR 0004).",
].join("\n");

/** One SQL WHERE scope: a predicate and its positional parameters. */
export interface PurgeConditions {
  where: string;
  params: unknown[];
}

/**
 * The delete scope for one purge: `messages` and `members` (the
 * group_members roster). Pure and unit-testable; the CLI executes both
 * DELETEs with these exact predicates. An EMPTY resolved scope yields
 * `FALSE` — never a predicate that could match everything.
 */
export interface PurgePlan {
  messages: PurgeConditions;
  members: PurgeConditions;
}

export function buildPurgePlan(selection: {
  chatIds: string[];
  before: Date | null;
}): PurgePlan {
  const { chatIds, before } = selection;

  // Messages: the chat scope AND the date cutoff both apply.
  const messageParams: unknown[] = [];
  const messageWhere: string[] = [];
  if (chatIds.length > 0) {
    messageParams.push(chatIds);
    messageWhere.push(`chat_id = ANY($${messageParams.length})`);
  }
  if (before !== null) {
    messageParams.push(before);
    messageWhere.push(`sent_at < $${messageParams.length}`);
  }

  // Members (fix round A, audit M-2/M5): a chat-scoped purge removes
  // the FULL roster of those chats (roster rows carry names/JIDs of
  // departed members too); a date-only purge removes roster rows last
  // updated before the cutoff. With no resolved scope (e.g. a group
  // selector with no linked chat) nothing is deleted.
  const memberParams: unknown[] = [];
  const memberWhere: string[] = [];
  if (chatIds.length > 0) {
    memberParams.push(chatIds);
    memberWhere.push(`chat_id = ANY($${memberParams.length})`);
  } else if (before !== null) {
    memberParams.push(before);
    memberWhere.push(`updated_at < $${memberParams.length}`);
  }

  return {
    messages: {
      where: messageWhere.length > 0 ? messageWhere.join(" AND ") : "FALSE",
      params: messageParams,
    },
    members: {
      where: memberWhere.length > 0 ? memberWhere.join(" AND ") : "FALSE",
      params: memberParams,
    },
  };
}
