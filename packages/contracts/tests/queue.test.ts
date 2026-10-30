import { describe, expect, it } from "vitest";
import {
  SUMMARY_JOB,
  SUMMARY_JOB_ATTEMPTS,
  SUMMARY_QUEUE,
  SUMMARY_FINISHED_JOBS_KEPT,
  SUMMARY_QUEUE_PREFIX_DEFAULT,
  SUMMARY_RETRY_BASE_MS,
  SummaryRunJob,
  parseQueuePrefix,
  parseRetryBaseMs,
  summaryJobOptions,
} from "../src/index.js";

const RUN_ID = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";

describe("summary queue contract (architecture §4.6)", () => {
  it("pins the queue and job names", () => {
    expect(SUMMARY_QUEUE).toBe("summaries");
    expect(SUMMARY_JOB).toBe("generate-summary");
  });

  it("accepts a payload carrying only the run identifier", () => {
    const parsed = SummaryRunJob.parse({ summaryRunId: RUN_ID });
    expect(parsed).toEqual({ summaryRunId: RUN_ID });
  });

  it("keeps ONLY identifiers even when a producer adds extra keys", () => {
    // Queue payloads must never carry message content, API keys, or
    // session secrets (AGENTS.md). Validation strips anything extra so
    // it can never become part of the job contract.
    const parsed = SummaryRunJob.parse({
      summaryRunId: RUN_ID,
      messages: [{ text: "private conversation" }],
      apiKey: "sk-secret",
    });
    expect(parsed).toEqual({ summaryRunId: RUN_ID });
    expect(JSON.stringify(parsed)).not.toContain("private conversation");
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  });

  it("rejects a missing or non-UUID summaryRunId", () => {
    expect(SummaryRunJob.safeParse({}).success).toBe(false);
    expect(SummaryRunJob.safeParse({ summaryRunId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});

describe("summaryJobOptions (shared producer/worker retry policy)", () => {
  it("pins finite attempts with exponential backoff and bounded retention", () => {
    expect(summaryJobOptions(25)).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 25 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    expect(SUMMARY_JOB_ATTEMPTS).toBe(5);
    expect(SUMMARY_FINISHED_JOBS_KEPT).toBe(1000);
  });

  it("defaults the backoff base to 30s and honors overrides", () => {
    expect(summaryJobOptions().backoff).toEqual({
      type: "exponential",
      delay: SUMMARY_RETRY_BASE_MS,
    });
    expect(SUMMARY_RETRY_BASE_MS).toBe(30000);
    expect(summaryJobOptions(50).backoff.delay).toBe(50);
  });

  it("is plain data (no bullmq types needed) and rejects invalid bases", () => {
    // Structural shape: assignable to any BullMQ JobsOptions consumer.
    const options: {
      attempts: number;
      backoff: { type: string; delay: number };
    } = summaryJobOptions(10);
    expect(options.attempts).toBe(SUMMARY_JOB_ATTEMPTS);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => summaryJobOptions(bad), String(bad)).toThrow(
        /retryBaseMs/,
      );
    }
  });
});

describe("parseRetryBaseMs (producer-side backoff knob)", () => {
  it("defaults to 30s and accepts explicit overrides", () => {
    expect(parseRetryBaseMs(undefined)).toBe(SUMMARY_RETRY_BASE_MS);
    expect(parseRetryBaseMs("")).toBe(SUMMARY_RETRY_BASE_MS);
    expect(parseRetryBaseMs("25")).toBe(25);
  });

  it("fails fast on invalid values", () => {
    for (const raw of ["0", "-5", "abc", "1.5"]) {
      expect(() => parseRetryBaseMs(raw), raw).toThrow(
        /SUMMARY_RETRY_BASE_MS/,
      );
    }
  });
});

describe("parseQueuePrefix (Redis key namespace isolation)", () => {
  it("defaults to the shared 'summarly' prefix", () => {
    expect(parseQueuePrefix(undefined)).toBe(SUMMARY_QUEUE_PREFIX_DEFAULT);
    expect(parseQueuePrefix("")).toBe("summarly");
  });

  it("accepts safe namespace values (tests/e2e use their own)", () => {
    expect(parseQueuePrefix("summarly-test")).toBe("summarly-test");
    expect(parseQueuePrefix("summarly-e2e")).toBe("summarly-e2e");
    expect(parseQueuePrefix(" team.a_1 ")).toBe("team.a_1");
  });

  it("fails fast on values that would pollute Redis keys", () => {
    for (const raw of ["has space", "a:b", "a/b", "x".repeat(65), "ü"]) {
      expect(() => parseQueuePrefix(raw), raw).toThrow(/SUMMARY_QUEUE_PREFIX/);
    }
  });
});
