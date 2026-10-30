import { describe, expect, it } from "vitest";
import {
  AiSummaryInput,
  SummaryResult,
  SummaryRun,
  type AiProvider,
  type DecisionItem,
  type ProviderSummaryOutput,
} from "@summarly/contracts";
import { MockAiProvider } from "../src/ai/mock-provider.js";
import {
  isPermanentFailure,
  PermanentRunError,
  RetryableRunError,
} from "../src/errors.js";
import {
  assembleResult,
  consolidate,
  MAX_CHARS_PER_CHUNK,
  processSummaryRun,
  splitIntoChunks,
  type PipelineDeps,
} from "../src/pipeline.js";
import {
  FakeDb,
  FakeProvider,
  fakeOutput,
  INTERVAL,
  makeAiMessage,
  makeRun,
  makeStoredMessages,
} from "./fakes.js";

/**
 * Pipeline behavior (architecture A4.4): chunking, consolidation with
 * preserved source references, validation before persistence, error
 * classification, and idempotent redelivery (A6).
 */

function makeDeps(db: FakeDb, provider: AiProvider): PipelineDeps {
  return {
    db,
    provider,
    providerName: "test-provider",
    modelName: "test-model",
  };
}

describe("splitIntoChunks (boundaries)", () => {
  it("returns a single empty chunk for an empty conversation", () => {
    expect(splitIntoChunks([])).toEqual([[]]);
  });

  it("keeps messages below the budget in one chunk", () => {
    const messages = makeStoredMessages(3, "x".repeat(1000));
    expect(splitIntoChunks(messages)).toEqual([messages]);
  });

  it("splits exactly at the budget boundary", () => {
    // Three 10000-char messages against a 20000 budget: two fit
    // exactly, the third starts a new chunk.
    const messages = makeStoredMessages(3, "x".repeat(10000));
    const chunks = splitIntoChunks(messages);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([messages[0], messages[1]]);
    expect(chunks[1]).toEqual([messages[2]]);
  });

  it("never tears a single oversized message apart", () => {
    const huge = makeStoredMessages(1, "x".repeat(MAX_CHARS_PER_CHUNK * 3));
    expect(splitIntoChunks(huge)).toEqual([huge]);
  });

  it("preserves deterministic order across chunks", () => {
    const messages = makeStoredMessages(7, "x".repeat(9000));
    const chunks = splitIntoChunks(messages);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(messages);
  });

  it("honors a custom budget", () => {
    const messages = makeStoredMessages(3, "abcd");
    const chunks = splitIntoChunks(messages, 8);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 1]);
  });
});

describe("consolidate (chunked results, source references preserved)", () => {
  it("joins overviews and concatenates sections in chunk order", () => {
    const refs = (id: string): DecisionItem["sourceRefs"] => [
      { messageId: id, sentAt: "2026-10-28T09:00:00Z" },
    ];
    const consolidated = consolidate([
      fakeOutput({
        overview: "Chunk zero.",
        keyDiscussions: ["zero"],
        confirmedDecisions: [{ text: "d0", sourceRefs: refs("m-0") }],
      }),
      fakeOutput({
        overview: "Chunk one.",
        keyDiscussions: ["one"],
        confirmedDecisions: [{ text: "d1", sourceRefs: refs("m-1") }],
      }),
    ]);
    expect(consolidated.overview).toBe("Chunk zero.\n\nChunk one.");
    expect(consolidated.keyDiscussions).toEqual(["zero", "one"]);
    // Source references survive consolidation untouched.
    expect(consolidated.confirmedDecisions).toEqual([
      { text: "d0", sourceRefs: refs("m-0") },
      { text: "d1", sourceRefs: refs("m-1") },
    ]);
  });

  it("skips empty overviews and truncates to the contract limit", () => {
    const consolidated = consolidate([
      fakeOutput({ overview: "A" }),
      fakeOutput({ overview: "" }),
      fakeOutput({ overview: "B" }),
      fakeOutput({ overview: "y".repeat(6000) }),
    ]);
    expect(consolidated.overview.startsWith("A\n\nB\n\n")).toBe(true);
    expect(consolidated.overview).toHaveLength(5000);
  });

  it("caps section arrays at the contract maxima (first items win)", () => {
    const many = (n: number): string[] =>
      Array.from({ length: n }, (_, index) => `item ${index}`);
    const manyTasks = (n: number) =>
      many(n).map((text) => ({
        text,
        owner: null,
        dueDate: null,
        sourceRefs: [],
      }));
    const consolidated = consolidate([
      fakeOutput({ keyDiscussions: many(60), tasks: manyTasks(60) }),
      fakeOutput({ keyDiscussions: many(60), tasks: manyTasks(60) }),
    ]);
    expect(consolidated.keyDiscussions).toHaveLength(100);
    expect(consolidated.tasks).toHaveLength(100);
    expect(consolidated.keyDiscussions[0]).toBe("item 0");
  });

  it("caps runaway source reference lists", () => {
    const refs = Array.from({ length: 250 }, (_, index) => ({
      messageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sentAt: "2026-10-28T09:00:00Z",
    }));
    const consolidated = consolidate([
      fakeOutput({ proposals: [{ text: "p", sourceRefs: refs }] }),
    ]);
    expect(consolidated.proposals[0]?.sourceRefs).toHaveLength(100);
  });

  it("deduplicates links by URL, keeping the first occurrence", () => {
    const consolidated = consolidate([
      fakeOutput({
        links: [
          { url: "https://a.example", description: "first" },
          { url: "https://a.example", description: "duplicate" },
        ],
      }),
      fakeOutput({
        links: [{ url: "https://b.example", description: null }],
      }),
    ]);
    expect(consolidated.links).toEqual([
      { url: "https://a.example", description: "first" },
      { url: "https://b.example", description: null },
    ]);
  });
});

describe("processSummaryRun (fake provider + fake db)", () => {
  it("returns already-completed for a completed run without reprocessing", async () => {
    const run = makeRun({ status: "completed" });
    const db = new FakeDb(run);
    const provider = new FakeProvider(() => fakeOutput());

    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("already-completed");
    expect(provider.calls).toHaveLength(0);
    expect(db.summaries.size).toBe(0);
  });

  it("fails an unknown run permanently with safe metadata", async () => {
    const db = new FakeDb(undefined);
    const provider = new FakeProvider(() => fakeOutput());
    const runId = makeRun().id;

    const error = await processSummaryRun(makeDeps(db, provider), runId).catch(
      (caught: unknown) => caught,
    );
    expect(isPermanentFailure(error)).toBe(true);
    expect((error as Error).name).toBe("UnrecoverableError");
    // The pipeline attempts to record terminal metadata even though an
    // unknown run has nothing to transition (safety-net semantics).
    expect(db.failedWriteCalls).toEqual([
      { code: "run_not_found", message: expect.stringContaining("does not exist") },
    ]);
    expect(db.failedWrites).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("produces, validates, and persists a summary (happy path)", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    db.messages = makeStoredMessages(2);
    const provider = new FakeProvider((input) =>
      fakeOutput({
        overview: "Everything went well.",
        keyDiscussions: input.messages.map((message) => message.text),
      }),
    );

    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("completed");
    expect(db.completedCalls).toBe(1);
    expect(db.summaries.size).toBe(1);

    const summary = db.summaries.get(run.id);
    // The worker sets aiGenerated; the provider is never asked for it.
    expect(summary?.result.aiGenerated).toBe(true);
    expect(SummaryResult.parse(summary?.result)).toStrictEqual(summary?.result);
    expect(summary?.provider).toBe("test-provider");
    expect(summary?.model).toBe("test-model");
    expect(db.run?.status).toBe("completed");
    expect(db.run?.attempts).toBe(1);
    // The provider saw the conversation as data, in a valid envelope.
    expect(AiSummaryInput.parse(provider.calls[0])).toStrictEqual(
      provider.calls[0],
    );
  });

  it("treats an empty period as valid input (mock empty-period result)", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider = new MockAiProvider();

    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("completed");
    const summary = db.summaries.get(run.id);
    expect(summary?.result.overview).toBe(
      "No messages were found in this period.",
    );
    expect(SummaryResult.parse(summary?.result)).toStrictEqual(summary?.result);
  });

  it("chunks oversized conversations and consolidates provider outputs", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    // 6 x 4000-char texts against the 20000-char budget -> chunks [5] + [1].
    // Texts stay under the 4096 AiMessage cap so the mapping boundary
    // (toAiMessages) does not truncate them.
    db.messages = makeStoredMessages(6, "x".repeat(4000));
    const provider = new FakeProvider((input, index) =>
      fakeOutput({
        overview: `chunk ${index} overview`,
        confirmedDecisions: [
          {
            text: `decision from chunk ${index}`,
            sourceRefs: input.messages.map((message) => ({
              messageId: message.id,
              sentAt: message.sentAt,
            })),
          },
        ],
      }),
    );

    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("completed");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.messages).toHaveLength(5);
    expect(provider.calls[1]?.messages).toHaveLength(1);

    const result = db.summaries.get(run.id)?.result;
    expect(result?.overview).toBe("chunk 0 overview\n\nchunk 1 overview");
    expect(result?.confirmedDecisions).toHaveLength(2);
    // Source references from both chunks survive consolidation.
    expect(result?.confirmedDecisions[0]?.sourceRefs.map((ref) => ref.messageId)).toEqual(
      db.messages.slice(0, 5).map((message) => message.id),
    );
    expect(result?.confirmedDecisions[1]?.sourceRefs.map((ref) => ref.messageId)).toEqual(
      [db.messages[5]?.id],
    );
  });

  it("classifies malformed provider output as retryable and keeps the run processing", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider = new FakeProvider(
      () => ({ overview: 42 }) as unknown as ProviderSummaryOutput,
    );

    const error = await processSummaryRun(makeDeps(db, provider), run.id).catch(
      (caught: unknown) => caught,
    );
    expect(isPermanentFailure(error)).toBe(false);
    expect((error as Error & { code?: string }).code).toBe(
      "provider_malformed_output",
    );
    // No terminal write: BullMQ will retry and the run stays processable.
    expect(db.failedWrites).toEqual([]);
    expect(db.run?.status).toBe("processing");
    expect(db.summaries.size).toBe(0);
  });

  it("classifies unknown provider errors as retryable with safe text", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider: AiProvider = {
      async generate(): Promise<ProviderSummaryOutput> {
        throw new Error('upstream said: "secret conversation text"');
      },
    };

    const error = await processSummaryRun(
      makeDeps(db, provider),
      run.id,
    ).catch((caught: unknown) => caught);
    expect(isPermanentFailure(error)).toBe(false);
    // The original (potentially leaking) error text is not surfaced in
    // run metadata; it only reaches operational logs in summarized form.
    expect(db.failedWrites).toEqual([]);
  });

  it("marks the run failed immediately on permanent provider errors", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    const provider: AiProvider = {
      async generate(): Promise<ProviderSummaryOutput> {
        throw new PermanentRunError("provider_config", "Missing credentials.");
      },
    };

    const error = await processSummaryRun(
      makeDeps(db, provider),
      run.id,
    ).catch((caught: unknown) => caught);
    expect(isPermanentFailure(error)).toBe(true);
    expect((error as Error).name).toBe("UnrecoverableError");
    expect(db.failedWrites).toEqual([
      { code: "provider_config", message: "Missing credentials." },
    ]);
    expect(db.run?.status).toBe("failed");
  });

  it("is idempotent: redelivery after completion never duplicates", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    db.messages = makeStoredMessages(2);
    const provider = new FakeProvider(() => fakeOutput());

    await processSummaryRun(makeDeps(db, provider), run.id);
    const summary = db.summaries.get(run.id);
    expect(summary).toBeDefined();

    // Simulated duplicate delivery (crash after commit, job redelivered).
    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("already-completed");
    expect(provider.calls).toHaveLength(1);
    expect(db.summaries.size).toBe(1);
    // Same summary identity and createdAt — never a second row.
    expect(db.summaries.get(run.id)?.id).toBe(summary?.id);
    expect(db.summaries.get(run.id)?.createdAt).toBe(summary?.createdAt);
  });
});

describe("error classification at the boundaries (review M1/m3)", () => {
  it("treats transient loadRun failures as retryable — no terminal write", async () => {
    // A pool/network/timeout error must NOT kill the run: retrying with
    // finite backoff is the documented policy (AGENTS.md).
    const run = makeRun();
    const db = new FakeDb(run);
    db.loadRun = async () => {
      throw new Error("Connection terminated unexpectedly");
    };
    const provider = new FakeProvider(() => fakeOutput());

    const error = await processSummaryRun(makeDeps(db, provider), run.id).catch(
      (caught: unknown) => caught,
    );
    expect(isPermanentFailure(error)).toBe(false);
    expect((error as Error & { code?: string }).code).toBe("db_unavailable");
    // No markRunFailed: the run must stay processable for the retry.
    expect(db.failedWriteCalls).toEqual([]);
    expect(db.failedWrites).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("classifies a run row that violates the contract as permanent invalid_run_data", async () => {
    const run = makeRun();
    const db = new FakeDb(run);
    db.loadRun = async () => {
      // Mirrors PostgresWorkerDb's toSummaryRun parsing a corrupt row.
      SummaryRun.parse({ id: "not-a-uuid" });
      return undefined;
    };
    const provider = new FakeProvider(() => fakeOutput());

    const error = await processSummaryRun(makeDeps(db, provider), run.id).catch(
      (caught: unknown) => caught,
    );
    expect(isPermanentFailure(error)).toBe(true);
    expect((error as Error).name).toBe("UnrecoverableError");
    expect(db.failedWrites).toEqual([
      {
        code: "invalid_run_data",
        message: expect.stringContaining("SummaryRun contract"),
      },
    ]);
  });

  it("classifies an AiSummaryInput contract failure as permanent invalid_run_data", async () => {
    // Previously a ZodError here surfaced as a retryable provider_error
    // and was retried five times against a defect retrying cannot fix.
    const run = makeRun();
    const db = new FakeDb(run);
    db.messages = [
      { id: run.id, sender: "Ana", sentAt: "not-a-timestamp", text: "hi" },
    ];
    const provider = new FakeProvider(() => fakeOutput());

    const error = await processSummaryRun(makeDeps(db, provider), run.id).catch(
      (caught: unknown) => caught,
    );
    expect(isPermanentFailure(error)).toBe(true);
    expect((error as Error).name).toBe("UnrecoverableError");
    expect(db.failedWrites).toEqual([
      {
        code: "invalid_run_data",
        message: expect.stringContaining("AiSummaryInput contract"),
      },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("truncates oversized messages at the mapping boundary instead of failing", async () => {
    // Audit M3: a long real message can never fail the run at
    // AiSummaryInput.parse — it is truncated to the AiMessage caps.
    const run = makeRun();
    const db = new FakeDb(run);
    db.messages = [
      { id: run.id, sender: "x".repeat(500), sentAt: "2026-10-28T09:00:00Z", text: "y".repeat(50_000) },
    ];
    const provider = new FakeProvider(() => fakeOutput());

    const outcome = await processSummaryRun(makeDeps(db, provider), run.id);
    expect(outcome).toBe("completed");
    const seen = provider.calls[0]?.messages[0];
    expect(seen?.sender).toHaveLength(200);
    expect(seen?.text).toHaveLength(4096);
  });
});

describe("assembleResult (audit L2: fixed-text malformed-output handling)", () => {
  it("returns a validated SummaryResult with aiGenerated for good outputs", () => {
    const result = assembleResult([fakeOutput({ overview: "Fine." })]);
    expect(result.aiGenerated).toBe(true);
    expect(result.overview).toBe("Fine.");
  });

  it("throws retryable provider_malformed_output with FIXED text on schema failure", () => {
    // Malformed content that passes per-chunk checks can only arrive
    // from a buggy adapter; the raw ZodError embeds received values and
    // must never reach BullMQ's failedReason (it is stored in Redis).
    const malformed = [
      fakeOutput({ tasks: [{ text: "", owner: null, dueDate: null, sourceRefs: [] }] }),
    ] as unknown as ProviderSummaryOutput[];

    let thrown: unknown;
    try {
      assembleResult(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RetryableRunError);
    expect((thrown as RetryableRunError).code).toBe("provider_malformed_output");
    expect((thrown as Error).message).toBe(
      "The assembled summary does not match the SummaryResult contract.",
    );
  });

  it("truncates overviews without splitting surrogate pairs (audit L4)", () => {
    // The join of these overviews crosses the 5000-char cap INSIDE an
    // emoji (a naive slice would leave a lone surrogate and break the
    // jsonb write).
    const consolidated = consolidate([
      fakeOutput({ overview: `a${"😀".repeat(2500)}` }),
      fakeOutput({ overview: "tail" }),
    ]);
    expect(consolidated.overview.length).toBeLessThanOrEqual(5000);
    const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(
      consolidated.overview,
    );
    expect(hasLoneSurrogate).toBe(false);
    // Round-trips cleanly (what the jsonb write needs).
    expect(JSON.parse(JSON.stringify(consolidated.overview))).toBe(
      consolidated.overview,
    );
  });
});
