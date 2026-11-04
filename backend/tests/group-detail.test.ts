import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError, ApiMessagePage, Group, GroupSummary, type ApiMessage, type GroupMember } from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

/**
 * Group detail surface (ADR 0008): single group, members, chat-view
 * messages with date filtering + pagination, and past summaries.
 * InMemoryStore-level behavior is exercised through the routes.
 */

const CHAT_ID = "120363000000000001@g.us";

async function detailApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  const groupId = randomUUID();
  await ctx.store.upsertGroup({
    id: groupId,
    chatId: CHAT_ID,
    name: "Detail Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
    historyImport: null,
  });
  const session = await login(ctx.app);
  return { ...ctx, groupId, session };
}

function message(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: randomUUID(),
    chatId: CHAT_ID,
    sentAt: "2026-11-01T10:00:00Z",
    senderId: "123456789@s.whatsapp.net",
    senderName: "Ana",
    body: "hello",
    messageType: "text",
    ...overrides,
  };
}

describe("GET /api/groups/:id", () => {
  it("returns the group and 404s for an unknown id", async () => {
    const { app, groupId, session } = await detailApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    expect(Group.parse(res.json()).name).toBe("Detail Group");

    const missing = await app.inject({
      method: "GET",
      url: "/api/groups/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/groups/not-a-uuid",
      headers: { cookie: session },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("GET /api/groups/:id/members", () => {
  it("lists the roster and 404s for unknown groups", async () => {
    const { app, store, groupId, session } = await detailApp();
    await store.upsertGroupMembers(CHAT_ID, [
      {
        userId: "2@s.whatsapp.net",
        name: "Bo",
        phone: "2@s.whatsapp.net",
        isAdmin: false,
        active: true,
      },
      {
        userId: "1@s.whatsapp.net",
        name: "Ana",
        phone: "1@s.whatsapp.net",
        isAdmin: true,
        active: true,
      },
      {
        userId: "3@s.whatsapp.net",
        name: null,
        phone: "3@s.whatsapp.net",
        isAdmin: false,
        active: false,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/members`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const members = res.json() as GroupMember[];
    expect(members).toHaveLength(3);
    // Admins first, then alphabetical.
    expect(members.map((member) => member.userId)).toEqual([
      "1@s.whatsapp.net",
      "2@s.whatsapp.net",
      "3@s.whatsapp.net",
    ]);
    expect(members[0]?.isAdmin).toBe(true);
    expect(members[0]?.phone).toBe("1@s.whatsapp.net");
    expect(members[2]?.name).toBeNull();
    expect(members[2]?.phone).toBe("3@s.whatsapp.net");
    expect(members[2]?.active).toBe(false);

    const missing = await app.inject({
      method: "GET",
      url: "/api/groups/00000000-0000-4000-8000-000000000000/members",
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("answers an empty roster for a group with no discovered chat", async () => {
    const { app, store, session } = await detailApp();
    const id = randomUUID();
    await store.upsertGroup({
      id,
      chatId: null,
      name: "Undiscovered",
      monitored: true,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${id}/members`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("serves rosters only for monitored groups (409 otherwise, H-1)", async () => {
    const { app, store, session } = await detailApp();
    const chatId = `${randomUUID()}@g.us`;
    const id = randomUUID();
    await store.upsertGroup({
      id,
      chatId,
      name: "Unmonitored",
      monitored: false,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    // The roster EXISTS in the store — the privacy gate is the API
    // boundary: an unmonitored group never serves one.
    await store.upsertGroupMembers(chatId, [
      {
        userId: "1@s.whatsapp.net",
        name: "Ana",
        phone: "1@s.whatsapp.net",
        isAdmin: true,
        active: true,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${id}/members`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(409);
    const body = ApiError.parse(res.json());
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toBe("Group is not monitored.");

    // The gate precedes the empty-roster case too: unmonitored is a
    // 409 even before any chat is discovered.
    const undiscovered = randomUUID();
    await store.upsertGroup({
      id: undiscovered,
      chatId: null,
      name: "Unmonitored undiscovered",
      monitored: false,
      timezone: "Europe/Madrid",
      summaryTime: null,
      historyImport: null,
    });
    const noChat = await app.inject({
      method: "GET",
      url: `/api/groups/${undiscovered}/members`,
      headers: { cookie: session },
    });
    expect(noChat.statusCode).toBe(409);
    expect(ApiError.parse(noChat.json()).error.message).toBe(
      "Group is not monitored.",
    );

    // Turning monitoring on serves the roster again (the gate follows
    // the current opt-in state).
    await store.updateGroup({
      ...(await store.getGroup(id))!,
      monitored: true,
    });
    const monitored = await app.inject({
      method: "GET",
      url: `/api/groups/${id}/members`,
      headers: { cookie: session },
    });
    expect(monitored.statusCode).toBe(200);
    expect((monitored.json() as GroupMember[]).map((m) => m.userId)).toEqual([
      "1@s.whatsapp.net",
    ]);
  });
});

describe("GET /api/groups/:id/messages (chat view, ADR 0008)", () => {
  it("returns newest-first with senderName and paginates with nextCursor", async () => {
    const { app, store, groupId, session } = await detailApp();
    store.seedMessages([
      message({ id: "00000000-0000-4000-8000-000000000001", sentAt: "2026-11-01T10:00:00Z", body: "first" }),
      message({ id: "00000000-0000-4000-8000-000000000002", sentAt: "2026-11-01T11:00:00Z", body: "second", senderName: null }),
      message({ id: "00000000-0000-4000-8000-000000000003", sentAt: "2026-11-01T12:00:00Z", body: "third" }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages?limit=2`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const page1 = ApiMessagePage.parse(res.json());
    expect(page1.items.map((item) => item.body)).toEqual(["third", "second"]);
    expect(page1.items[1]?.senderName).toBeNull();
    expect(page1.nextCursor).toBeTypeOf("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      headers: { cookie: session },
    });
    const page2Body = ApiMessagePage.parse(page2.json());
    expect(page2Body.items.map((item) => item.body)).toEqual(["first"]);
    expect(page2Body.nextCursor).toBeNull();
  });

  it("falls back to the roster name when the message has no sender name", async () => {
    const { app, store, groupId, session } = await detailApp();
    await store.upsertGroupMembers(CHAT_ID, [
      {
        userId: "123456789@s.whatsapp.net",
        name: "Ana From Roster",
        phone: null,
        isAdmin: false,
        active: true,
      },
    ]);
    store.seedMessages([
      message({
        id: "00000000-0000-4000-8000-000000000010",
        senderId: "123456789:4@s.whatsapp.net", // device suffix
        senderName: null,
      }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const page = ApiMessagePage.parse(res.json());
    expect(page.items[0]?.senderName).toBe("Ana From Roster");
  });

  it("emits nextCursor only when another page truly exists (exact multiples)", async () => {
    // 4 messages, page size 2: the second page is exactly full and is
    // the LAST page — its nextCursor must be null (fix round A, m1),
    // not a dangling cursor that resolves to an empty page.
    const { app, store, groupId, session } = await detailApp();
    store.seedMessages(
      [1, 2, 3, 4].map((n) =>
        message({
          id: `00000000-0000-4000-8000-00000000000${n}`,
          sentAt: new Date(Date.parse("2026-11-01T10:00:00Z") + n * 1000).toISOString(),
          body: `m${n}`,
        }),
      ),
    );

    const first = ApiMessagePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/groups/${groupId}/messages?limit=2`,
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(first.items.map((item) => item.body)).toEqual(["m4", "m3"]);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = ApiMessagePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/groups/${groupId}/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(second.items.map((item) => item.body)).toEqual(["m2", "m1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("compares cursor tie-breaks as instants, not strings (m2)", async () => {
    // Same instant, two spellings ("...Z" vs "+02:00"): the cursor
    // built from one spelling must still see the other side of the
    // tie-break instead of dropping the row.
    const { app, store, groupId, session } = await detailApp();
    store.seedMessages([
      message({ id: "00000000-0000-4000-8000-000000000001", sentAt: "2026-11-01T12:00:00Z", body: "z-spelling" }),
      message({ id: "00000000-0000-4000-8000-000000000002", sentAt: "2026-11-01T14:00:00+02:00", body: "offset-spelling" }),
    ]);

    const first = ApiMessagePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/groups/${groupId}/messages?limit=1`,
          headers: { cookie: session },
        })
      ).json(),
    );
    // Newest first with id DESC tie-break: the +02:00 spelling wins.
    expect(first.items.map((item) => item.body)).toEqual(["offset-spelling"]);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = ApiMessagePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/groups/${groupId}/messages?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(second.items.map((item) => item.body)).toEqual(["z-spelling"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters the half-open date range [from, to)", async () => {
    const { app, store, groupId, session } = await detailApp();
    store.seedMessages([
      message({ id: "00000000-0000-4000-8000-000000000001", sentAt: "2026-11-01T09:59:59Z", body: "before" }),
      message({ id: "00000000-0000-4000-8000-000000000002", sentAt: "2026-11-01T10:00:00Z", body: "at start" }),
      message({ id: "00000000-0000-4000-8000-000000000003", sentAt: "2026-11-01T11:00:00Z", body: "inside" }),
      message({ id: "00000000-0000-4000-8000-000000000004", sentAt: "2026-11-01T12:00:00Z", body: "at end" }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages?from=2026-11-01T10:00:00Z&to=2026-11-01T12:00:00Z`,
      headers: { cookie: session },
    });
    const body = ApiMessagePage.parse(res.json());
    expect(body.items.map((item) => item.body)).toEqual(["inside", "at start"]);
  });

  it("validates params: range, cursor, limit bounds", async () => {
    const { app, groupId, session } = await detailApp();
    const cases = [
      "/messages?from=2026-11-01T12:00:00Z&to=2026-11-01T10:00:00Z", // from >= to
      "/messages?from=yesterday", // not an instant
      "/messages?cursor=garbage", // unparseable cursor
      "/messages?cursor=2026-11-01T10:00:00Z|not-a-uuid", // L-4: bad cursor id
      "/messages?cursor=2026-11-01T10:00:00.000Z|zz", // L-4: short garbage id
      "/messages?limit=201", // above the max
      "/messages?limit=0", // below the min
    ];
    for (const suffix of cases) {
      const res = await app.inject({
        method: "GET",
        url: `/api/groups/${groupId}${suffix}`,
        headers: { cookie: session },
      });
      expect(res.statusCode, suffix).toBe(400);
    }
  });

  it("defaults to limit 50 and 404s for unknown groups", async () => {
    const { app, store, groupId, session } = await detailApp();
    store.seedMessages(
      Array.from({ length: 60 }, (_, index) =>
        message({
          id: randomUUID(),
          sentAt: new Date(Date.parse("2026-11-01T10:00:00Z") + index * 1000).toISOString(),
        }),
      ),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages`,
      headers: { cookie: session },
    });
    const body = ApiMessagePage.parse(res.json());
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).toBeTypeOf("string");

    const missing = await app.inject({
      method: "GET",
      url: "/api/groups/00000000-0000-4000-8000-000000000000/messages",
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /api/groups/:id/summaries", () => {
  it("returns past summaries newest-first with run intervals", async () => {
    const { app, store, groupId, session } = await detailApp();
    const run = await store.createOrFindRun({
      groupId,
      interval: {
        start: "2026-10-31T23:00:00.000Z",
        end: "2026-11-01T23:00:00.000Z",
        timezone: "Europe/Madrid",
      },
      kind: "scheduled",
      instructions: "Focus on decisions.",
    });
    await store.saveSummary({
      id: randomUUID(),
      runId: run.run.id,
      provider: "mock",
      model: "mock-1",
      result: {
        overview: "Test overview.",
        keyDiscussions: [],
        confirmedDecisions: [],
        proposals: [],
        unresolvedQuestions: [],
        tasks: [],
        links: [],
        aiGenerated: true,
      },
      createdAt: "2026-11-01T12:00:00.000Z",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/summaries`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const summaries = res.json() as GroupSummary[];
    expect(summaries).toHaveLength(1);
    expect(GroupSummary.parse(summaries[0])).toBeTypeOf("object");
    expect(summaries[0]?.interval.start).toBe("2026-10-31T23:00:00.000Z");
    expect(summaries[0]?.provider).toBe("mock");
    expect(summaries[0]?.model).toBe("mock-1");

    const missing = await app.inject({
      method: "GET",
      url: "/api/groups/00000000-0000-4000-8000-000000000000/summaries",
      headers: { cookie: session },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects an over-large limit with the standard envelope", async () => {
    const { app, groupId, session } = await detailApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/summaries?limit=201`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
  });
});
