import { describe, expect, it } from "vitest";
import {
  buildPurgePlan,
  parsePurgeArgs,
  PURGE_CONFIRMATION,
  PURGE_USAGE,
} from "../src/lib/purge-messages.js";

/**
 * Retention CLI selection semantics (ADR 0004 / audit M6): parse and
 * validate the operator's selectors before anything destructive can
 * happen, and build the two delete scopes (messages + group_members
 * roster) as pure, testable predicates. The DELETEs themselves are
 * executed only by the operator against a real database.
 */

describe("parsePurgeArgs (purge-messages CLI)", () => {
  it("accepts group id, chat id, and --before together", () => {
    const selection = parsePurgeArgs([
      "--group-id",
      "11111111-2222-3333-4444-555555555555",
      "--chat-id",
      "123@g.us",
      "--before",
      "2026-01-01T00:00:00Z",
    ]);
    expect(selection.groupIds).toEqual(["11111111-2222-3333-4444-555555555555"]);
    expect(selection.chatIds).toEqual(["123@g.us"]);
    expect(selection.before?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(selection.assumeYes).toBe(false);
  });

  it("accepts --before alone and repeats id selectors", () => {
    const onlyBefore = parsePurgeArgs(["--before", "2026-06-01"]);
    expect(onlyBefore.before).toBeInstanceOf(Date);
    expect(onlyBefore.groupIds).toEqual([]);

    const repeated = parsePurgeArgs([
      "--group-id",
      "a",
      "--group-id",
      "b",
      "--chat-id",
      "x@g.us",
      "--chat-id",
      "y@g.us",
    ]);
    expect(repeated.groupIds).toEqual(["a", "b"]);
    expect(repeated.chatIds).toEqual(["x@g.us", "y@g.us"]);
  });

  it("parses --yes (typed-confirmation bypass is explicit)", () => {
    expect(parsePurgeArgs(["--before", "2026-01-01", "--yes"]).assumeYes).toBe(true);
  });

  it("requires at least one selector (destructive safety)", () => {
    expect(() => parsePurgeArgs([])).toThrow(/nothing to purge/);
    expect(() => parsePurgeArgs(["--yes"])).toThrow(/nothing to purge/);
  });

  it("rejects malformed arguments", () => {
    expect(() => parsePurgeArgs(["--before", "not-a-date"])).toThrow(/ISO 8601/);
    expect(() => parsePurgeArgs(["--group-id"])).toThrow(/requires a value/);
    expect(() => parsePurgeArgs(["--before", "--yes"])).toThrow(/requires a value/);
    expect(() => parsePurgeArgs(["--unknown"])).toThrow(/unknown argument/);
  });

  it("uses the documented typed confirmation word", () => {
    expect(PURGE_CONFIRMATION).toBe("DELETE");
  });
});

describe("buildPurgePlan (messages + member roster scope, fix round A M-2/M5)", () => {
  it("applies chat AND date to messages, and the full roster to members on a chat-scoped purge", () => {
    const before = new Date("2026-01-01T00:00:00Z");
    const plan = buildPurgePlan({ chatIds: ["123@g.us"], before });
    expect(plan.messages.where).toBe("chat_id = ANY($1) AND sent_at < $2");
    expect(plan.messages.params).toEqual([["123@g.us"], before]);
    // The roster of a purged chat goes in full (departed members' names
    // are PII too) — no date gate.
    expect(plan.members.where).toBe("chat_id = ANY($1)");
    expect(plan.members.params).toEqual([["123@g.us"]]);
  });

  it("gates the roster by updated_at on a date-only purge", () => {
    const before = new Date("2026-01-01T00:00:00Z");
    const plan = buildPurgePlan({ chatIds: [], before });
    expect(plan.messages.where).toBe("sent_at < $1");
    expect(plan.members.where).toBe("updated_at < $1");
    expect(plan.members.params).toEqual([before]);
  });

  it("deletes the whole roster for a chat-scoped purge without a cutoff", () => {
    const plan = buildPurgePlan({ chatIds: ["123@g.us", "456@g.us"], before: null });
    expect(plan.messages.where).toBe("chat_id = ANY($1)");
    expect(plan.members.where).toBe("chat_id = ANY($1)");
    expect(plan.members.params).toEqual([["123@g.us", "456@g.us"]]);
  });

  it("never turns an empty resolved scope into 'delete everything'", () => {
    // e.g. a --group-id whose group has no linked chat: no chat resolved
    // and no cutoff -> the predicates must match NOTHING.
    const plan = buildPurgePlan({ chatIds: [], before: null });
    expect(plan.messages.where).toBe("FALSE");
    expect(plan.members.where).toBe("FALSE");
    expect(plan.messages.params).toEqual([]);
    expect(plan.members.params).toEqual([]);
  });

  it("lists the roster cleanup in the usage text", () => {
    expect(PURGE_USAGE).toContain("group_members");
    expect(PURGE_USAGE).toContain("roster");
  });
});
