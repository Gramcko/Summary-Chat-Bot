/**
 * Retention CLI logic (ADR 0004 / audit M6): purge captured messages by
 * group id, chat id, and/or a sent_at cutoff. Pure argument parsing and
 * selection semantics live here so they are unit-testable; the CLI
 * script (backend/scripts/purge-messages.ts) owns prompting and SQL.
 *
 * Semantics: each supplied selector narrows the selection (AND):
 * - `--group-id <uuid>`  messages of that group's chat (repeatable)
 * - `--chat-id <jid>`    messages of that chat (repeatable)
 * - `--before <ISO>`     messages with sent_at strictly before the instant
 * At least one selector is required.
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
  "deletes captured messages; database backups taken before the purge still",
  "contain them (ADR 0004).",
].join("\n");
