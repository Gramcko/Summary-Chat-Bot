import { describe, expect, it } from "vitest";
import {
  AiMessage,
  AiSummaryInput,
  ProviderSummaryOutput,
  SummaryResult,
  type AiProvider,
} from "../src/index.js";

const MESSAGE = {
  id: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
  sentAt: "2026-10-28T09:15:00Z",
  sender: "Ana",
  text: "Should we move the launch?",
};

const INPUT = {
  groupName: "Launch Team",
  period: {
    start: "2026-10-28T00:00:00Z",
    end: "2026-10-29T00:00:00Z",
    timezone: "Europe/Madrid",
  },
  messages: [MESSAGE],
  instructions: null,
};

const OUTPUT = {
  overview: "The group planned the launch.",
  keyDiscussions: ['Ana: "Should we move the launch?"'],
  confirmedDecisions: [],
  proposals: [],
  unresolvedQuestions: [
    {
      text: 'Ana: "Should we move the launch?"',
      sourceRefs: [{ messageId: MESSAGE.id, sentAt: MESSAGE.sentAt }],
    },
  ],
  tasks: [],
  links: [],
};

describe("AiMessage / AiSummaryInput (provider input is data)", () => {
  it("validates a message and a full input", () => {
    expect(AiMessage.parse(MESSAGE)).toEqual(MESSAGE);
    expect(AiSummaryInput.parse(INPUT)).toEqual(INPUT);
  });

  it("accepts an empty message list (empty periods are valid)", () => {
    const parsed = AiSummaryInput.parse({ ...INPUT, messages: [] });
    expect(parsed.messages).toEqual([]);
  });

  it("rejects an invalid timestamp or sender", () => {
    expect(AiMessage.safeParse({ ...MESSAGE, sentAt: "yesterday" }).success).toBe(
      false,
    );
    expect(AiMessage.safeParse({ ...MESSAGE, sender: "" }).success).toBe(false);
  });

  it("caps sender (200) and text (4096) so oversized content cannot pass", () => {
    expect(
      AiMessage.safeParse({ ...MESSAGE, sender: "x".repeat(200) }).success,
    ).toBe(true);
    expect(
      AiMessage.safeParse({ ...MESSAGE, sender: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      AiMessage.safeParse({ ...MESSAGE, text: "x".repeat(4096) }).success,
    ).toBe(true);
    expect(
      AiMessage.safeParse({ ...MESSAGE, text: "x".repeat(4097) }).success,
    ).toBe(false);
  });

  it("rejects a period that is not a half-open interval", () => {
    const result = AiSummaryInput.safeParse({
      ...INPUT,
      period: { ...INPUT.period, end: INPUT.period.start },
    });
    expect(result.success).toBe(false);
  });
});

describe("ProviderSummaryOutput (SummaryResult minus aiGenerated)", () => {
  it("accepts output without the aiGenerated literal", () => {
    expect(ProviderSummaryOutput.parse(OUTPUT)).toEqual(OUTPUT);
  });

  it("never asks the provider to echo aiGenerated", () => {
    // If a provider does include it anyway, it is stripped — the
    // worker sets the flag after validation.
    const parsed = ProviderSummaryOutput.parse({
      ...OUTPUT,
      aiGenerated: true,
    });
    expect(parsed).toEqual(OUTPUT);
    expect("aiGenerated" in parsed).toBe(false);
  });

  it("round-trips into a full SummaryResult when the worker adds aiGenerated", () => {
    const full = SummaryResult.parse({
      ...ProviderSummaryOutput.parse(OUTPUT),
      aiGenerated: true,
    });
    expect(full.aiGenerated).toBe(true);
    expect(full.overview).toBe(OUTPUT.overview);
    expect(full.unresolvedQuestions[0]?.sourceRefs).toEqual(
      OUTPUT.unresolvedQuestions[0]?.sourceRefs,
    );
  });

  it("rejects malformed output (providers are validated at the boundary)", () => {
    expect(ProviderSummaryOutput.safeParse({ ...OUTPUT, overview: "" }).success).toBe(
      false,
    );
    expect(ProviderSummaryOutput.safeParse({ overview: 42 }).success).toBe(false);
  });
});

describe("AiProvider interface", () => {
  it("is implementable with typed input and output", async () => {
    // Compile-time contract check: an adapter only needs generate().
    const provider: AiProvider = {
      async generate(input) {
        expect(input.messages).toHaveLength(1);
        return ProviderSummaryOutput.parse(OUTPUT);
      },
    };
    const result = await provider.generate(AiSummaryInput.parse(INPUT));
    expect(result.overview).toBe(OUTPUT.overview);
  });
});

describe("AiSummaryInput.instructions (custom prompt channel, ADR 0008)", () => {
  it("is required-but-nullable: null when absent, string when given", () => {
    // Absent in the parsed sense is not allowed: the field must be
    // present and null (providers should never guess).
    expect(AiSummaryInput.safeParse({ ...INPUT, instructions: undefined }).success).toBe(false);
    expect(AiSummaryInput.safeParse(INPUT).success).toBe(true);
    const withInstructions = AiSummaryInput.parse({
      ...INPUT,
      instructions: "Focus on decisions and ignore chit-chat.",
    });
    expect(withInstructions.instructions).toBe(
      "Focus on decisions and ignore chit-chat.",
    );
  });

  it("caps instructions at 2000 characters", () => {
    expect(
      AiSummaryInput.safeParse({ ...INPUT, instructions: "x".repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      AiSummaryInput.safeParse({ ...INPUT, instructions: "x".repeat(2001) })
        .success,
    ).toBe(false);
    // Empty string is allowed at the schema level (the writer trims);
    // null is the "absent" marker.
    expect(AiSummaryInput.safeParse({ ...INPUT, instructions: "" }).success).toBe(
      true,
    );
  });
});
