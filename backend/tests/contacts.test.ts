import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContactDetail,
  ContactMessagePage,
  ContactSummary,
  type ApiMessage,
} from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

/**
 * Contacts (people observed in monitored groups): list, detail, and
 * cross-group messages. The privacy boundary is the same as the roster:
 * unmonitored groups never contribute members or messages.
 */

const CHAT_A = "120363000000000001@g.us";
const CHAT_B = "120363000000000002@g.us";

function message(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: randomUUID(),
    chatId: CHAT_A,
    sentAt: "2026-11-01T10:00:00Z",
    senderId: "111:4@s.whatsapp.net",
    senderName: null,
    body: "hello",
    messageType: "text",
    ...overrides,
  };
}

async function contactsApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  const groupA = randomUUID();
  const groupB = randomUUID();
  await ctx.store.upsertGroup({
    id: groupA,
    chatId: CHAT_A,
    name: "Monitored",
    monitored: true,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  await ctx.store.upsertGroup({
    id: groupB,
    chatId: CHAT_B,
    name: "Private",
    monitored: false,
    timezone: "UTC",
    summaryTime: null,
    historyImport: null,
  });
  await ctx.store.upsertGroupMembers(CHAT_A, [
    {
      userId: "111@lid",
      name: "Ana",
      phone: "111@s.whatsapp.net",
      isAdmin: false,
      active: true,
    },
    { userId: "222@lid", name: "Bob", phone: null, isAdmin: false, active: true },
  ]);
  await ctx.store.upsertGroupMembers(CHAT_B, [
    { userId: "333@lid", name: "Eve", phone: null, isAdmin: false, active: true },
  ]);
  ctx.store.seedMessages([
    message({ id: "00000000-0000-4000-8000-000000000001" }),
    message({
      id: "00000000-0000-4000-8000-000000000002",
      senderId: "222@lid",
      sentAt: "2026-11-01T11:00:00Z",
    }),
    message({
      id: "00000000-0000-4000-8000-000000000003",
      chatId: CHAT_B,
      senderId: "333@lid",
    }),
  ]);
  const session = await login(ctx.app);
  return { ...ctx, groupA, groupB, session };
}

describe("GET /api/contacts", () => {
  it("lists active members of monitored groups only, with groups and message counts", async () => {
    const { app, session } = await contactsApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const contacts = ContactSummary.array().parse(res.json());
    expect(contacts.map((contact) => contact.name)).toEqual(["Ana", "Bob"]);
    const ana = contacts.find((contact) => contact.name === "Ana");
    expect(ana?.id).toBe("111@s.whatsapp.net");
    expect(ana?.phone).toBe("111@s.whatsapp.net");
    expect(ana?.groups.map((group) => group.name)).toEqual(["Monitored"]);
    expect(ana?.messageCount).toBe(1);
    // Eve belongs to an unmonitored group and must never appear.
    expect(contacts.some((contact) => contact.name === "Eve")).toBe(false);
  });
});

describe("GET /api/contacts/:id", () => {
  it("returns aliases and groups; 404 for an unknown contact", async () => {
    const { app, session } = await contactsApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("111@s.whatsapp.net")}`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const detail = ContactDetail.parse(res.json());
    expect(detail.name).toBe("Ana");
    expect(detail.aliases).toEqual(["111@lid", "111@s.whatsapp.net"]);

    const missing = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("999@lid")}`,
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("PATCH /api/contacts/:id", () => {
  it("renames a contact and the override wins in the list, detail, and messages", async () => {
    const { app, session } = await contactsApp();
    const id = encodeURIComponent("111@s.whatsapp.net");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${id}`,
      headers: { cookie: session },
      payload: { name: "Ana Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(ContactDetail.parse(res.json()).name).toBe("Ana Renamed");

    const list = ContactSummary.array().parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/contacts",
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(list.find((contact) => contact.id === "111@s.whatsapp.net")?.name).toBe(
      "Ana Renamed",
    );

    const page = ContactMessagePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/contacts/${id}/messages`,
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(page.items[0]?.senderName).toBe("Ana Renamed");

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${id}`,
      headers: { cookie: session },
      payload: { name: "   " },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${encodeURIComponent("999@lid")}`,
      headers: { cookie: session },
      payload: { name: "Nobody" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /api/contacts/:id/messages", () => {  it("returns messages across monitored groups with the group name", async () => {
    const { app, session } = await contactsApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("111@s.whatsapp.net")}/messages`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const page = ContactMessagePage.parse(res.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.groupName).toBe("Monitored");
    // The message was captured before the name was learned; the roster
    // fallback supplies it.
    expect(page.items[0]?.senderName).toBe("Ana");
    expect(page.nextCursor).toBeNull();
  });

  it("paginates newest-first and 404s for an unknown contact", async () => {
    const { app, store, session } = await contactsApp();
    store.seedMessages(
      [3, 4, 5].map((n) =>
        message({
          id: `00000000-0000-4000-8000-00000000001${n}`,
          sentAt: new Date(Date.parse("2026-11-02T10:00:00Z") + n * 1000).toISOString(),
          body: `m${n}`,
        }),
      ),
    );
    const first = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("111@s.whatsapp.net")}/messages?limit=2`,
      headers: { cookie: session },
    });
    const page1 = ContactMessagePage.parse(first.json());
    expect(page1.items.map((item) => item.body)).toEqual(["m5", "m4"]);
    expect(page1.nextCursor).toBeTypeOf("string");

    const second = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("111@s.whatsapp.net")}/messages?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      headers: { cookie: session },
    });
    const page2 = ContactMessagePage.parse(second.json());
    expect(page2.items.map((item) => item.body)).toEqual(["m3", "hello"]);

    const missing = await app.inject({
      method: "GET",
      url: `/api/contacts/${encodeURIComponent("999@lid")}/messages`,
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);
  });
});
