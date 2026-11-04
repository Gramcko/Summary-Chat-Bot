import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";

/**
 * Message kinds as normalized by capture (matches the
 * `messages.message_type` column constraint).
 */
export const MessageType = z.enum(["text", "link", "other"]);

/**
 * One captured message as served to the admin's chat view (ADR 0008).
 * `body` is the stored text as-is (or "" for caption-less media) —
 * this is admin-only data that the API already stores; the dashboard
 * renders it as a chat with a date-range filter. `senderName` is the
 * WhatsApp push name captured with the message (display only, PII).
 * No group name here: the caller already knows which group it asked
 * for, and this shape stays reusable.
 */
export const ApiMessage = z.object({
  id: Id,
  chatId: z.string().min(1).max(300).optional(),
  sentAt: IsoDateTime,
  senderId: z.string().min(1).max(300),
  senderName: z.string().min(1).max(300).nullable(),
  body: z.string(),
  messageType: MessageType,
});

/**
 * One page of a group's chat history as served to the admin's chat
 * view. `items` is newest first; `nextCursor` is the opaque cursor for
 * the next (older) page and is non-null ONLY when another page truly
 * exists (fix round A: exact-multiple page sizes must not emit a
 * dangling cursor).
 */
export const ApiMessagePage = z.object({
  items: z.array(ApiMessage),
  nextCursor: z.string().nullable(),
});

export type MessageType = z.infer<typeof MessageType>;
export type ApiMessage = z.infer<typeof ApiMessage>;
export type ApiMessagePage = z.infer<typeof ApiMessagePage>;
