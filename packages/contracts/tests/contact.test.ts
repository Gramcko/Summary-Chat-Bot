import { describe, expect, it } from "vitest";
import {
  ContactDetail,
  ContactMessage,
  ContactMessagePage,
  ContactSummary,
  RenameContactRequest,
} from "../src/contact.js";

const GROUP = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Team",
};

const SUMMARY = {
  id: "123456789@s.whatsapp.net",
  name: "Ana",
  phone: "123456789@s.whatsapp.net",
  groups: [GROUP],
  messageCount: 3,
  lastMessageAt: "2026-11-01T10:00:00Z",
};

describe("ContactSummary", () => {
  it("parses a complete contact", () => {
    expect(ContactSummary.parse(SUMMARY)).toEqual(SUMMARY);
  });

  it("allows a null name/phone/last message (LID-only contact)", () => {
    const parsed = ContactSummary.parse({
      ...SUMMARY,
      id: "999@lid",
      name: null,
      phone: null,
      groups: [],
      messageCount: 0,
      lastMessageAt: null,
    });
    expect(parsed.name).toBeNull();
    expect(parsed.phone).toBeNull();
    expect(parsed.groups).toEqual([]);
  });

  it("rejects negative counts and oversized groups", () => {
    expect(
      ContactSummary.safeParse({ ...SUMMARY, messageCount: -1 }).success,
    ).toBe(false);
    expect(
      ContactSummary.safeParse({
        ...SUMMARY,
        groups: Array.from({ length: 501 }, () => GROUP),
      }).success,
    ).toBe(false);
  });
});

describe("ContactDetail", () => {
  it("carries aliases and caps them at 20", () => {
    const detail = { ...SUMMARY, aliases: ["123@lid", "123@s.whatsapp.net"] };
    expect(ContactDetail.parse(detail).aliases).toHaveLength(2);
    expect(
      ContactDetail.safeParse({
        ...detail,
        aliases: Array.from({ length: 21 }, (_, i) => `${i}@lid`),
      }).success,
    ).toBe(false);
  });
});

describe("ContactMessagePage", () => {
  it("parses a message with its group and a cursor", () => {
    const message = {
      id: "00000000-0000-4000-8000-000000000002",
      sentAt: "2026-11-01T10:00:00Z",
      senderId: "123456789@s.whatsapp.net",
      senderName: "Ana",
      body: "hello",
      messageType: "text",
      groupId: GROUP.id,
      groupName: GROUP.name,
    };
    const page = ContactMessagePage.parse({
      items: [message],
      nextCursor: "cursor",
    });
    expect(page.items[0]?.groupName).toBe("Team");
    expect(ContactMessage.parse(message).senderName).toBe("Ana");
  });
});

describe("RenameContactRequest", () => {
  it("trims and bounds the display name", () => {
    expect(RenameContactRequest.parse({ name: "  Ana  " }).name).toBe("Ana");
    expect(RenameContactRequest.safeParse({ name: "   " }).success).toBe(false);
    expect(
      RenameContactRequest.safeParse({ name: "x".repeat(301) }).success,
    ).toBe(false);
  });
});
