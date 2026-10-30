import { describe, expect, it } from "vitest";
import {
  SUMMARY_JOB,
  SUMMARY_RETRY_BASE_MS,
  type SummaryRunJob,
} from "@summarly/contracts";
import type { Job } from "bullmq";
import { PermanentRunError, RetryableRunError } from "../src/errors.js";
import { processSummaryRun, type PipelineOutcome } from "../src/pipeline.js";
import {
  createFailureHandler,
  createSummaryProcessor,
  DEFAULT_CONCURRENCY,
  KEEP_FINISHED_JOBS,
  parseConcurrency,
  summaryJobOptions,
  SUMMARY_ATTEMPTS,
} from "../src/worker.js";
import { FakeDb, FakeProvider, fakeOutput, makeRun } from "./fakes.js";

/**
 * Worker wiring (architecture A4.6): bounded concurrency and finite
 * retry configuration, strict job/payload validation, and the
 * failed-event safety net that records terminal run failures.
 */

type TestJob = Job<SummaryRunJob, PipelineOutcome, string>;

function makeJob(overrides?: {
  name?: string;
  data?: unknown;
  attemptsMade?: number;
  attempts?: number;
}): TestJob {
  return {
    id: "job-1",
    name: overrides?.name ?? SUMMARY_JOB,
    data: overrides?.data ?? { summaryRunId: makeRun().id },
    attemptsMade: overrides?.attemptsMade ?? 0,
    opts: { attempts: overrides?.attempts },
  } as unknown as TestJob;
}

describe("parseConcurrency (bounded parallelism)", () => {
  it("defaults to 2 when unset or empty", () => {
    expect(parseConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(parseConcurrency("")).toBe(DEFAULT_CONCURRENCY);
    expect(parseConcurrency("   ")).toBe(DEFAULT_CONCURRENCY);
  });

  it("accepts integers inside the bounds", () => {
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("5")).toBe(5);
    expect(parseConcurrency("16")).toBe(16);
  });

  it("fails fast on out-of-range or malformed values", () => {
    for (const raw of ["0", "17", "-1", "abc", "2.5", "Infinity"]) {
      expect(() => parseConcurrency(raw), raw).toThrow(/SUMMARY_CONCURRENCY/);
    }
  });
});

describe("summaryJobOptions (producer-side retry policy)", () => {
  it("pins finite attempts with exponential backoff and bounded retention", () => {
    expect(summaryJobOptions(25)).toEqual({
      attempts: SUMMARY_ATTEMPTS,
      backoff: { type: "exponential", delay: 25 },
      removeOnComplete: KEEP_FINISHED_JOBS,
      removeOnFail: KEEP_FINISHED_JOBS,
    });
    expect(SUMMARY_ATTEMPTS).toBe(5);
    expect(KEEP_FINISHED_JOBS).toBe(1000);
    expect(summaryJobOptions().backoff).toEqual({
      type: "exponential",
      delay: SUMMARY_RETRY_BASE_MS,
    });
  });
});

describe("createSummaryProcessor (payload validation is permanent)", () => {
  const deps = {
    providerName: "test-provider",
    modelName: "test-model",
  };

  it("rejects foreign job names with UnrecoverableError", async () => {
    const db = new FakeDb(makeRun());
    const provider = new FakeProvider(() => fakeOutput());
    const processor = createSummaryProcessor({ ...deps, db, provider });

    const error = await processor(makeJob({ name: "other-job" })).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).name).toBe("UnrecoverableError");
    expect(db.processingCalls).toBe(0);
  });

  it("rejects invalid payloads with UnrecoverableError and never touches the db", async () => {
    const db = new FakeDb(makeRun());
    const provider = new FakeProvider(() => fakeOutput());
    const processor = createSummaryProcessor({ ...deps, db, provider });

    for (const data of [{}, { summaryRunId: "not-a-uuid" }, "raw", null]) {
      const error = await processor(makeJob({ data })).catch(
        (caught: unknown) => caught,
      );
      expect((error as Error).name).toBe("UnrecoverableError");
    }
    expect(db.processingCalls).toBe(0);
    expect(db.summaries.size).toBe(0);
  });

  it("strips extra payload keys down to the run identity (contract)", async () => {
    // SummaryRunJob validation is strict about what it keeps: extra
    // keys (content, secrets) can never become part of the job contract.
    const run = makeRun();
    const db = new FakeDb(run);
    const provider = new FakeProvider(() => fakeOutput());
    const processor = createSummaryProcessor({ ...deps, db, provider });

    const outcome = await processor(
      makeJob({
        data: {
          summaryRunId: run.id,
          apiKey: "sk-secret",
          messages: [{ text: "private conversation" }],
        },
      }),
    );
    expect(outcome).toBe("completed");
    expect(db.summaries.size).toBe(1);
  });

  it("processes a valid payload through the pipeline", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider = new FakeProvider(() => fakeOutput());
    const processor = createSummaryProcessor({ ...deps, db, provider });

    const outcome = await processor(makeJob({ data: { summaryRunId: run.id } }));
    expect(outcome).toBe("completed");
    expect(db.summaries.size).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("createFailureHandler (attempts-exhaustion safety net)", () => {
  const runId = makeRun().id;

  it("ignores missing jobs and jobs with foreign names", async () => {
    const db = new FakeDb(makeRun());
    const handler = createFailureHandler({ db });

    await handler(undefined, new Error("stalled"));
    await handler(
      makeJob({ name: "other-job", data: { summaryRunId: runId }, attemptsMade: 5, attempts: 5 }),
      new Error("boom"),
    );
    expect(db.failedWrites).toEqual([]);
  });

  it("ignores jobs without a valid run identity", async () => {
    const db = new FakeDb(makeRun());
    const handler = createFailureHandler({ db });
    await handler(makeJob({ data: { bogus: true } }), new Error("boom"));
    expect(db.failedWrites).toEqual([]);
  });

  it("does nothing while retries remain (the run stays processable)", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const handler = createFailureHandler({ db });
    await handler(
      makeJob({ data: { summaryRunId: run.id }, attemptsMade: 1, attempts: 5 }),
      new RetryableRunError("provider_rate_limit", "429"),
    );
    expect(db.failedWrites).toEqual([]);
    expect(db.run?.status).toBe("pending");
  });

  it("marks the run failed with safe metadata when attempts are exhausted", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const handler = createFailureHandler({ db });
    await handler(
      makeJob({ data: { summaryRunId: run.id }, attemptsMade: 5, attempts: 5 }),
      new RetryableRunError("provider_rate_limit", "429"),
    );
    expect(db.failedWrites).toEqual([
      {
        code: "provider_rate_limit",
        message: "Retry attempts were exhausted without producing a summary.",
      },
    ]);
    expect(db.run?.status).toBe("failed");
  });

  it("treats a job without retry configuration as final on first failure", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const handler = createFailureHandler({ db });
    await handler(
      makeJob({ data: { summaryRunId: run.id }, attemptsMade: 1 }),
      new Error("boom"),
    );
    expect(db.failedWrites).toHaveLength(1);
  });

  it("records permanent failures too (covers a failed pipeline write)", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const handler = createFailureHandler({ db });
    await handler(
      makeJob({ data: { summaryRunId: run.id }, attemptsMade: 1, attempts: 5 }),
      new PermanentRunError("provider_config", "Missing credentials."),
    );
    expect(db.failedWrites).toEqual([
      { code: "provider_config", message: "Missing credentials." },
    ]);
  });

  it("never overwrites a completed run", async () => {
    const run = makeRun({ status: "completed" });
    const db = new FakeDb(run);
    const handler = createFailureHandler({ db });
    await handler(
      makeJob({ data: { summaryRunId: run.id }, attemptsMade: 5, attempts: 5 }),
      new Error("late failure"),
    );
    // The safety net tries, but the conditional update refuses to
    // downgrade a terminal (here: completed) run.
    expect(db.failedWriteCalls).toHaveLength(1);
    expect(db.failedWrites).toEqual([]);
    expect(db.run?.status).toBe("completed");
  });

  it("swallows db errors (the safety net must never crash the worker)", async () => {
    const handler = createFailureHandler({
      db: {
        markRunFailed: async () => {
          throw new Error("database unavailable");
        },
      } as unknown as FakeDb,
    });
    await expect(
      handler(
        makeJob({ data: { summaryRunId: runId }, attemptsMade: 1, attempts: 1 }),
        new Error("boom"),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("pipeline integration via the processor", () => {
  it("propagates retryable failures unchanged for BullMQ to retry", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider: FakeProvider = new FakeProvider(() => {
      throw new RetryableRunError("provider_rate_limit", "429");
    });
    const processor = createSummaryProcessor({
      db,
      provider,
      providerName: "test-provider",
      modelName: "test-model",
    });

    const error = await processor(makeJob({ data: { summaryRunId: run.id } })).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).name).toBe("RetryableRunError");
    expect(db.run?.status).toBe("processing");
    // The same code path is what processSummaryRun exposes.
    await expect(
      processSummaryRun(
        { db, provider, providerName: "test-provider", modelName: "test-model" },
        run.id,
      ),
    ).rejects.toMatchObject({ name: "RetryableRunError" });
  });
});
