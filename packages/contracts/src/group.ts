import { z } from "zod";
import { IanaTimeZone, Id } from "./common.js";

/**
 * Daily summary cutoff time (HH:mm, local to the group time zone).
 * Provisional: the default cutoff is still an open product decision.
 */
export const SummaryTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm in 24-hour format");

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
});

export const UpdateGroupRequest = z.object({
  monitored: z.boolean().optional(),
  timezone: IanaTimeZone.optional(),
  summaryTime: SummaryTime.nullable().optional(),
});

export type SummaryTime = z.infer<typeof SummaryTime>;
export type Group = z.infer<typeof Group>;
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>;
