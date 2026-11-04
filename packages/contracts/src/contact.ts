import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";
import { ApiMessage } from "./message.js";

/**
 * Contacts (people observed in MONITORED groups). A contact is derived
 * from `group_members`; WhatsApp does not expose a global address book
 * through the bot-worker, so only members of opted-in groups appear.
 *
 * `id` is the canonical identity used in URLs: the PN JID when known,
 * otherwise the LID. Names/phones/JIDs are PII served on the
 * authenticated admin API only, under the normal retention rules.
 */
export const ContactGroup = z.object({
  id: Id,
  name: z.string().min(1).max(300),
});

export const ContactSummary = z.object({
  /** Canonical identity: PN JID when known, else the LID (PII). */
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300).nullable(),
  /** PN JID fallback when known (null for LID-only contacts). */
  phone: z.string().max(100).nullable(),
  /** Monitored groups where the contact is currently an active member. */
  groups: z.array(ContactGroup).max(500),
  /** Messages sent by this contact across monitored groups. */
  messageCount: z.number().int().min(0),
  lastMessageAt: IsoDateTime.nullable(),
});

/**
 * Contact detail: the summary plus every JID alias the contact is known
 * by (LID and PN). Aliases are used internally to match messages; they
 * are exposed only to the authenticated admin.
 */
export const ContactDetail = ContactSummary.extend({
  aliases: z.array(z.string().min(1).max(300)).max(20),
});

/** One message in a contact's cross-group history. */
export const ContactMessage = ApiMessage.extend({
  groupId: Id,
  groupName: z.string().min(1).max(300),
});

/** Newest-first page of a contact's messages. */
export const ContactMessagePage = z.object({
  items: z.array(ContactMessage),
  nextCursor: z.string().nullable(),
});

/** Admin override for a contact's display name (ADR 0008 follow-up). */
export const RenameContactRequest = z.object({
  name: z.string().trim().min(1).max(300),
});

export type ContactGroup = z.infer<typeof ContactGroup>;
export type ContactSummary = z.infer<typeof ContactSummary>;
export type ContactDetail = z.infer<typeof ContactDetail>;
export type ContactMessage = z.infer<typeof ContactMessage>;
export type ContactMessagePage = z.infer<typeof ContactMessagePage>;
export type RenameContactRequest = z.infer<typeof RenameContactRequest>;
