import { describe, expect, it } from "vitest";
import {
  Group,
  GroupHistoryImport,
  HistoryImportStatus,
  UpdateGroupRequest,
} from "../src/index.js";

const BASE_GROUP = {
  id: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
  chatId: "120363000000000001@g.us",
  name: "Test Group",
  monitored: true,
  timezone: "Europe/Madrid",
  summaryTime: null,
};

const DONE_IMPORT = {
  status: "done",
  requestedAt: "2026-11-02T10:00:00Z",
  startedAt: "2026-11-02T10:00:05Z",
  finishedAt: "2026-11-02T10:03:00Z",
  importedCount: 812,
  error: null,
};

describe("GroupHistoryImport (system-managed state, ADR 0007)", () => {
  it("accepts every documented status", () => {
    for (const status of ["pending", "running", "done", "failed"] as const) {
      expect(HistoryImportStatus.parse(status)).toBe(status);
      expect(
        GroupHistoryImport.safeParse({
          ...DONE_IMPORT,
          status,
          error: status === "failed" ? "history_sync_failed" : null,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown statuses and non-countable imports", () => {
    expect(
      GroupHistoryImport.safeParse({ ...DONE_IMPORT, status: "queued" })
        .success,
    ).toBe(false);
    expect(
      GroupHistoryImport.safeParse({ ...DONE_IMPORT, importedCount: -1 })
        .success,
    ).toBe(false);
    expect(
      GroupHistoryImport.safeParse({ ...DONE_IMPORT, importedCount: 1.5 })
        .success,
    ).toBe(false);
    expect(
      GroupHistoryImport.safeParse({ ...DONE_IMPORT, error: "x".repeat(201) })
        .success,
    ).toBe(false);
  });
});

describe("Group.historyImport", () => {
  it("accepts null (never requested) and a full state", () => {
    expect(Group.parse({ ...BASE_GROUP, historyImport: null })).toEqual({
      ...BASE_GROUP,
      historyImport: null,
    });
    const parsed = Group.parse({ ...BASE_GROUP, historyImport: DONE_IMPORT });
    expect(parsed.historyImport).toEqual(DONE_IMPORT);
  });

  it("requires the field and rejects unknown statuses", () => {
    // The field is part of the Group shape (nullable, not optional).
    expect(Group.safeParse(BASE_GROUP).success).toBe(false);
    expect(
      Group.safeParse({
        ...BASE_GROUP,
        historyImport: { ...DONE_IMPORT, status: "unknown" },
      }).success,
    ).toBe(false);
  });
});

describe("UpdateGroupRequest (admin prefs only)", () => {
  it("never accepts historyImport — admin PATCH must not alter it", () => {
    // Zod strips unknown keys: even if a client sends the fields, they
    // cannot become part of the parsed update.
    const parsed = UpdateGroupRequest.parse({
      monitored: true,
      historyImport: { ...DONE_IMPORT, status: "failed" },
    });
    expect(parsed).toEqual({ monitored: true });
    expect("historyImport" in parsed).toBe(false);
  });
});
