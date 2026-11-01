import { describe, expect, it } from "vitest";
import { parsePurgeArgs, PURGE_CONFIRMATION } from "../src/lib/purge-messages.js";

/**
 * Retention CLI selection semantics (ADR 0004 / audit M6): parse and
 * validate the operator's selectors before anything destructive can
 * happen. The deletion SQL itself is exercised only by the operator
 * against a real database (it is intentionally not part of any test).
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
