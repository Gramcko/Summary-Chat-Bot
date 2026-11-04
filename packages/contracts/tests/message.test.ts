import { describe, expect, it } from "vitest";
import { ApiMessage, ApiMessagePage, MessageType } from "../src/index.js";

const MESSAGE = {
  id: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
  sentAt: "2026-11-01T09:15:00Z",
  senderId: "123456789@s.whatsapp.net",
  senderName: "Ana",
  body: "Good morning!",
  messageType: "text",
};

describe("MessageType", () => {
  it("accepts the three normalized kinds and rejects others", () => {
    expect(MessageType.parse("text")).toBe("text");
    expect(MessageType.parse("link")).toBe("link");
    expect(MessageType.parse("other")).toBe("other");
    expect(MessageType.safeParse("image").success).toBe(false);
  });
});

describe("ApiMessage (admin chat view, ADR 0008)", () => {
  it("validates a full message and allows a null senderName", () => {
    expect(ApiMessage.parse(MESSAGE)).toEqual(MESSAGE);
    expect(
      ApiMessage.safeParse({ ...MESSAGE, senderName: null }).success,
    ).toBe(true);
  });

  it("keeps chatId optional (the caller knows the group)", () => {
    const parsed = ApiMessage.parse(MESSAGE);
    expect(parsed.chatId).toBeUndefined();
    expect(
      ApiMessage.parse({ ...MESSAGE, chatId: "120363000000000001@g.us" }).chatId,
    ).toBe("120363000000000001@g.us");
  });

  it("does not carry a group name (no echo of unrelated metadata)", () => {
    const parsed = ApiMessage.parse({ ...MESSAGE, name: "Secret Group" });
    expect("name" in parsed).toBe(false);
  });

  it("keeps body verbatim (already admin-only stored data)", () => {
    const parsed = ApiMessage.parse({
      ...MESSAGE,
      body: "multi\nline\n\nbody",
    });
    expect(parsed.body).toBe("multi\nline\n\nbody");
  });

  it("rejects missing identity or invalid timestamps", () => {
    expect(ApiMessage.safeParse({ ...MESSAGE, id: "nope" }).success).toBe(false);
    expect(ApiMessage.safeParse({ ...MESSAGE, sentAt: "yesterday" }).success).toBe(
      false,
    );
    expect(ApiMessage.safeParse({ ...MESSAGE, senderId: "" }).success).toBe(
      false,
    );
  });
});

describe("ApiMessagePage (chat-view pagination envelope, fix round A)", () => {
  it("validates a page with a cursor and an empty last page", () => {
    const withCursor = ApiMessagePage.parse({
      items: [MESSAGE],
      nextCursor: "2026-11-01T09:15:00Z|4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
    });
    expect(withCursor.items).toHaveLength(1);
    expect(withCursor.nextCursor).toBeTypeOf("string");

    const lastPage = ApiMessagePage.parse({ items: [], nextCursor: null });
    expect(lastPage.items).toEqual([]);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("requires both fields and validates items as ApiMessages", () => {
    expect(ApiMessagePage.safeParse({ items: [MESSAGE] }).success).toBe(false);
    expect(
      ApiMessagePage.safeParse({ items: [], nextCursor: 42 }).success,
    ).toBe(false);
    expect(
      ApiMessagePage.safeParse({ items: [{ id: "nope" }], nextCursor: null })
        .success,
    ).toBe(false);
  });
});
