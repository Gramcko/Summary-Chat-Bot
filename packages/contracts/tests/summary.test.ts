import { describe, expect, it } from "vitest";
import { SummaryResult } from "../src/index.js";

const valid = {
  overview: "The group planned the launch.",
  keyDiscussions: ["Launch date moved to November."],
  confirmedDecisions: [
    {
      text: "Launch moves to 2026-11-10.",
      sourceRefs: [
        {
          messageId: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
          sentAt: "2026-10-28T09:15:00Z",
        },
      ],
    },
  ],
  proposals: [],
  unresolvedQuestions: [
    { text: "Who owns the newsletter copy?", sourceRefs: [] },
  ],
  tasks: [
    {
      text: "Update the pricing page.",
      owner: null,
      dueDate: null,
      sourceRefs: [],
    },
    {
      text: "Send the vendor contract.",
      owner: "Ana",
      dueDate: "2026-11-01",
      sourceRefs: [],
    },
  ],
  links: [{ url: "https://example.invalid/doc", description: "Launch plan" }],
  aiGenerated: true,
};

describe("SummaryResult (validated provider output)", () => {
  it("accepts a complete valid summary", () => {
    expect(SummaryResult.safeParse(valid).success).toBe(true);
  });

  it("allows null owner and dueDate when messages do not support them", () => {
    const parsed = SummaryResult.parse(valid);
    expect(parsed.tasks[0]?.owner).toBeNull();
    expect(parsed.tasks[0]?.dueDate).toBeNull();
  });

  it("rejects output not marked aiGenerated", () => {
    const result = SummaryResult.safeParse({ ...valid, aiGenerated: false });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid due date", () => {
    const result = SummaryResult.safeParse({
      ...valid,
      tasks: [
        {
          text: "Update the pricing page.",
          owner: null,
          dueDate: "2026-13-40",
          sourceRefs: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed link url", () => {
    const result = SummaryResult.safeParse({
      ...valid,
      links: [{ url: "not a url", description: null }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an overview that is missing", () => {
    const bad = { ...valid } as Record<string, unknown>;
    delete bad["overview"];
    expect(SummaryResult.safeParse(bad).success).toBe(false);
  });
});
