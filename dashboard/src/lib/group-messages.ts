import type { ApiMessage } from "@summarly/contracts";
// Explicit `.ts` extension: this module is also imported by `node:test` directly
// (type stripping needs a full specifier); `allowImportingTsExtensions` is on.
import { instantToWallTimeInZone, wallTimeInZoneToInstant } from "./time.ts";

/**
 * Pure helpers for the group "Messages" tab.
 *
 * The API filters a half-open instant range `[from, to)` (start inclusive, end
 * exclusive) and returns newest-first pages with a `nextCursor`. The form takes
 * `datetime-local` wall times in the group's time zone and converts them to
 * instants, exactly like a summary request.
 */

export const MESSAGE_PAGE_SIZE = 50;
export const DEFAULT_RANGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageRangeInput {
  /** `datetime-local` wall time in the group time zone. */
  from: string;
  to: string;
}

export interface ResolvedMessageRange {
  fromIso: string;
  toIso: string;
}

export interface MessageRangeResult {
  /** `null` when the input is invalid; `error` then explains why. */
  range: ResolvedMessageRange | null;
  error: string | null;
}

/**
 * Default filter window: the last seven days, as wall times in `timeZone`.
 * `to` is exclusive, so it is rounded UP to the next minute — otherwise the
 * admin's current minute would be silently excluded.
 */
export function defaultMessageRange(
  timeZone: string,
  now: Date = new Date(),
): MessageRangeInput {
  const nextMinute = new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
  const to =
    instantToWallTimeInZone(nextMinute, timeZone) ??
    instantToWallTimeInZone(nextMinute, "UTC") ??
    "";
  const from =
    instantToWallTimeInZone(new Date(now.getTime() - DEFAULT_RANGE_DAYS * DAY_MS), timeZone) ??
    "";
  return { from, to };
}

/**
 * Validates the wall-time inputs and converts them to the instants the API
 * expects. Keeps the half-open semantics explicit: `from` inclusive, `to`
 * exclusive.
 */
export function resolveMessageRange(
  input: MessageRangeInput,
  timeZone: string,
): MessageRangeResult {
  if (input.from === "" || input.to === "") {
    return { range: null, error: "Choose a start and an end date." };
  }

  const from = wallTimeInZoneToInstant(input.from, timeZone);
  const to = wallTimeInZoneToInstant(input.to, timeZone);
  if (from === null || to === null) {
    return { range: null, error: "Enter a valid date and time." };
  }
  if (to.getTime() <= from.getTime()) {
    return {
      range: null,
      error: "The end of the range must be after the start.",
    };
  }

  return {
    range: { fromIso: from.toISOString(), toIso: to.toISOString() },
    error: null,
  };
}

/**
 * Appends an older page (the API returns newest first) and drops ids that are
 * already loaded, so "Load older" is idempotent even if the cursor repeats.
 */
export function mergeOlderMessages(
  current: readonly ApiMessage[],
  older: readonly ApiMessage[],
): ApiMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const merged = [...current];
  for (const message of older) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

/** Display name for a message sender (`senderName` is PII from WhatsApp). */
export function senderLabel(message: ApiMessage): string {
  return message.senderName ?? message.senderId;
}
