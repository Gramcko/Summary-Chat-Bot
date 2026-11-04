import { describe, expect, it } from "vitest";
import { CreateRunRequest, SummaryRun } from "../src/index.js";

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

const RUN = {
  id: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
  groupId: "9a2b7c60-2f44-4a63-9c31-7b1f0d8e5a21",
  kind: "manual",
  status: "pending",
  interval: INTERVAL,
  attempts: 0,
  instructions: null,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  error: null,
};

describe("CreateRunRequest.instructions (custom prompt, ADR 0008)", () => {
  it("is optional and trimmed", () => {
    expect(CreateRunRequest.safeParse({ groupId: RUN.groupId, interval: INTERVAL }).success).toBe(true);
    const parsed = CreateRunRequest.parse({
      groupId: RUN.groupId,
      interval: INTERVAL,
      instructions: "  Focus on decisions.  ",
    });
    expect(parsed.instructions).toBe("Focus on decisions.");
  });

  it("enforces 1..2000 characters", () => {
    const base = { groupId: RUN.groupId, interval: INTERVAL };
    expect(
      CreateRunRequest.safeParse({ ...base, instructions: "   " }).success,
    ).toBe(false); // trims to empty
    expect(
      CreateRunRequest.safeParse({ ...base, instructions: "" }).success,
    ).toBe(false);
    expect(
      CreateRunRequest.safeParse({ ...base, instructions: "x".repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      CreateRunRequest.safeParse({ ...base, instructions: "x".repeat(2001) })
        .success,
    ).toBe(false);
  });
});

describe("SummaryRun.instructions", () => {
  it("is required-but-nullable on the run", () => {
    expect(SummaryRun.safeParse(RUN).success).toBe(true);
    expect(
      SummaryRun.safeParse({ ...RUN, instructions: "Focus on decisions." })
        .success,
    ).toBe(true);
    expect(SummaryRun.safeParse({ ...RUN, instructions: undefined }).success).toBe(
      false,
    );
    expect(
      SummaryRun.safeParse({ ...RUN, instructions: "x".repeat(2001) }).success,
    ).toBe(false);
  });
});
