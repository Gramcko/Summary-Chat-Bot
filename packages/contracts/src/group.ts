import { z } from "zod";
import { IanaTimeZone, Id, IsoDateTime } from "./common.js";

/**
 * Daily summary cutoff time (HH:mm, local to the group time zone).
 * Provisional: the default cutoff is still an open product decision.
 */
export const SummaryTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm in 24-hour format");

/**
 * History import lifecycle for a group (ADR 0007):
 * `pending` (requested, not started) -> `running` -> `done` | `failed`.
 * Set only by the backend (request) and bot-worker (progress) — see
 * {@link GroupHistoryImport}.
 */
export const HistoryImportStatus = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);

/**
 * System-managed history-import state (ADR 0007). The admin requests
 * an import (POST /api/groups/:id/history-import) but cannot SET these
 * fields — they are excluded from UpdateGroupRequest and group
 * discovery never resets them. `importedCount` is the number of
 * messages the import actually inserted (WhatsApp history is bounded
 * and partial — see ADR 0007). `error` is a safe code/short message
 * only (never message content or secrets).
 */
export const GroupHistoryImport = z.object({
  status: HistoryImportStatus,
  requestedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  importedCount: z.number().int().min(0),
  error: z.string().max(200).nullable(),
});

export const Group = z.object({
  id: Id,
  /**
   * WhatsApp chat identity (JID). Read-only API metadata; NOT part of
   * UpdateGroupRequest. Natural key for idempotent group registration:
   * it joins groups to captured messages (groups.chat_id = messages.chat_id).
   * Null for groups not yet linked to a discovered chat.
   */
  chatId: z.string().min(1).max(300).nullable(),
  name: z.string().min(1).max(300),
  monitored: z.boolean(),
  timezone: IanaTimeZone,
  summaryTime: SummaryTime.nullable(),
  /**
   * History-import state (ADR 0007). `null` = never requested.
   * System-managed: PATCH never alters it (the field is stripped from
   * UpdateGroupRequest) and discovery never resets it.
   */
  historyImport: GroupHistoryImport.nullable(),
});

export const UpdateGroupRequest = z.object({
  monitored: z.boolean().optional(),
  timezone: IanaTimeZone.optional(),
  summaryTime: SummaryTime.nullable().optional(),
});

/**
 * A member of a monitored group's chat (ADR 0008). Best-effort roster
 * maintained by the bot-worker: WhatsApp does not replay membership
 * history, so this is a snapshot that drifts toward reality on each
 * update. `userId` is the WhatsApp user JID and `name` the push name —
 * both PII, served on the authenticated API only and covered by the
 * normal retention rules. `active: false` means the member left the
 * chat (kept as history).
 */
export const GroupMember = z.object({
  userId: z.string().min(1).max(300),
  name: z.string().min(1).max(300).nullable(),
  isAdmin: z.boolean(),
  active: z.boolean(),
  updatedAt: IsoDateTime,
});

export type SummaryTime = z.infer<typeof SummaryTime>;
export type HistoryImportStatus = z.infer<typeof HistoryImportStatus>;
export type GroupHistoryImport = z.infer<typeof GroupHistoryImport>;
export type Group = z.infer<typeof Group>;
export type GroupMember = z.infer<typeof GroupMember>;
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>;
