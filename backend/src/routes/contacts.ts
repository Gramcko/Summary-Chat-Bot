import type { FastifyInstance } from "fastify";
import {
  ContactMessagePage,
  IsoDateTime,
  RenameContactRequest,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import {
  decodeMessageCursor,
  encodeMessageCursor,
  type Store,
} from "../lib/store.js";

/**
 * Contacts derived from MONITORED groups (ADR 0008 follow-up). There is
 * no global address book: only people on an opted-in group's roster are
 * listed, and only messages from monitored groups are returned. Names,
 * phones, and JIDs are PII served on the authenticated admin API only.
 */

const ContactParams = z.object({
  // Canonical contact id: a PN JID or a LID, not a UUID.
  id: z.string().min(1).max(300),
});

const ContactMessagesQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(400).optional(),
});

const DEFAULT_CONTACT_MESSAGES_LIMIT = 50;

export function registerContactRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  /** All contacts across monitored groups, names first then alphabetical. */
  app.get("/api/contacts", async () => store.listContacts());

  /** One contact: aliases + the monitored groups it belongs to. */
  app.get("/api/contacts/:id", async (request) => {
    const { id } = ContactParams.parse(request.params);
    const contact = await store.getContact(id);
    if (contact === undefined) {
      throw new HttpError(404, "not_found", "Contact not found.");
    }
    return contact;
  });

  /**
   * Admin display-name override. It wins over WhatsApp/roster names and
   * is not overwritten by automatic roster refreshes.
   */
  app.patch("/api/contacts/:id", async (request) => {
    const { id } = ContactParams.parse(request.params);
    const body = RenameContactRequest.parse(request.body);
    const contact = await store.renameContact(id, body.name);
    if (contact === undefined) {
      throw new HttpError(404, "not_found", "Contact not found.");
    }
    return contact;
  });

  /**
   * Messages sent by the contact across monitored groups, newest first.
   * `from`/`to` are optional half-open instant filters; `cursor` is the
   * previous page's `nextCursor`.
   */
  app.get("/api/contacts/:id/messages", async (request) => {
    const { id } = ContactParams.parse(request.params);
    const query = ContactMessagesQuery.parse(request.query);
    const contact = await store.getContact(id);
    if (contact === undefined) {
      throw new HttpError(404, "not_found", "Contact not found.");
    }
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) >= Date.parse(query.to)
    ) {
      throw new HttpError(
        400,
        "validation_error",
        "Invalid range: `from` must be an instant before `to`.",
      );
    }
    if (
      query.cursor !== undefined &&
      decodeMessageCursor(query.cursor) === undefined
    ) {
      throw new HttpError(400, "validation_error", "Invalid cursor.");
    }
    const limit = query.limit ?? DEFAULT_CONTACT_MESSAGES_LIMIT;
    // Fetch one extra row so `nextCursor` only exists when another page
    // truly does (same exact-multiple rule as the group chat view).
    const fetched = await store.listContactMessages(contact.aliases, {
      from: query.from,
      to: query.to,
      limit: limit + 1,
      cursor: query.cursor,
    });
    const items = fetched.slice(0, limit);
    const hasMore = fetched.length > limit;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeMessageCursor({ sentAt: last.sentAt, id: last.id })
          : null,
    } satisfies ContactMessagePage;
  });
}
