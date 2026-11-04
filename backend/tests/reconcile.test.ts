import { afterEach, describe, expect, it, vi } from "vitest";
import type { SummaryRun } from "@summarly/contracts";
import type { EnqueueOutcome, SummaryEnqueuer } from "../src/lib/enqueue.js";
import {
  DEFAULT_PENDING_STALE_MS,
  DEFAULT_PROCESSING_STUCK_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  MIN_RECONCILE_INTERVAL_MS,
  parseReconcileIntervalMs,
  Reconciler,
  selectStaleRuns,
} from "../src/lib/reconcile.js";
import type { Store } from "../src/lib/store.js";

/**
 * Reconciliation (architecture A4.6/A6): stale `pending` and stuck
 * `processing` runs are re-enqueued; terminal runs are never touched.
 * Unit tests run with a fake store and a fake queue (no infrastructure).
 */

const NOW = Date.parse("2026-10-30T12:00:00Z");

function makeRun(
  status: SummaryRun["status"],
  updatedAtMs: number,
  id = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
): SummaryRun {
  return {
    id,
    groupId: "9a2b7c60-2f44-4a63-9c31-7b1f0d8e5a21",
    kind: "manual",
    status,
    interval: {
      start: "2026-10-28T00:00:00Z",
      end: "2026-10-29T00:00:00Z",
      timezone: "Europe/Madrid",
    },
    attempts: 1,
    instructions: null,
    createdAt: new Date(updatedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    error: null,
  };
}

class FakeEnqueuer implements SummaryEnqueuer {
  readonly calls: string[] = [];
  failFor = new Set<string>();

  async enqueueSummaryRun(runId: string): Promise<EnqueueOutcome> {
    if (this.failFor.has(runId)) throw new Error("Connection is closed.");
    this.calls.push(runId);
    return "enqueued";
  }
}

function makeStore(runs: SummaryRun[]): Pick<Store, "listRuns"> {
  return { listRuns: async () => runs };
}

describe("parseReconcileIntervalMs", () => {
  it("defaults to 60s and accepts explicit overrides", () => {
    expect(parseReconcileIntervalMs(undefined)).toBe(
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    expect(parseReconcileIntervalMs("")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(parseReconcileIntervalMs("15000")).toBe(15000);
    expect(DEFAULT_RECONCILE_INTERVAL_MS).toBe(60_000);
  });

  it("clamps the floor to 1000 ms (audit L10/n1)", () => {
    expect(parseReconcileIntervalMs("500")).toBe(MIN_RECONCILE_INTERVAL_MS);
    expect(parseReconcileIntervalMs("999")).toBe(1000);
    expect(parseReconcileIntervalMs("1000")).toBe(1000);
  });

  it("fails fast on invalid values", () => {
    for (const raw of ["0", "-1", "abc", "1.5"]) {
      expect(() => parseReconcileIntervalMs(raw), raw).toThrow(
        /RECONCILE_INTERVAL_MS/,
      );
    }
  });
});

describe("selectStaleRuns", () => {
  const thresholds = {
    pendingStaleMs: DEFAULT_PENDING_STALE_MS,
    processingStuckMs: DEFAULT_PROCESSING_STUCK_MS,
    nowMs: NOW,
  };

  it("selects pending runs idle beyond the staleness window", () => {
    const stale = makeRun("pending", NOW - DEFAULT_PENDING_STALE_MS, "11111111-1111-4111-8111-111111111111");
    const fresh = makeRun("pending", NOW - 1000, "22222222-2222-4222-8222-222222222222");
    expect(selectStaleRuns([stale, fresh], thresholds)).toEqual([stale]);
  });

  it("selects processing runs idle beyond the stuck window", () => {
    const stuck = makeRun("processing", NOW - DEFAULT_PROCESSING_STUCK_MS, "33333333-3333-4333-8333-333333333333");
    const running = makeRun(
      "processing",
      NOW - DEFAULT_PENDING_STALE_MS,
      "44444444-4444-4444-8444-444444444444",
    );
    // Stale as "pending" would be, but processing gets the longer
    // stuck window: a busy worker is NOT re-queued after 5 minutes.
    expect(selectStaleRuns([stuck, running], thresholds)).toEqual([stuck]);
  });

  it("never touches terminal runs, no matter how old", () => {
    const completed = makeRun("completed", NOW - 86_400_000, "55555555-5555-4555-8555-555555555555");
    const failed = makeRun("failed", NOW - 86_400_000, "66666666-6666-4666-8666-666666666666");
    expect(selectStaleRuns([completed, failed], thresholds)).toEqual([]);
  });

  it("uses updatedAt as the last-activity clock (boundary inclusive)", () => {
    const atBoundary = makeRun("pending", NOW - DEFAULT_PENDING_STALE_MS, "77777777-7777-4777-8777-777777777777");
    const justInside = makeRun("pending", NOW - DEFAULT_PENDING_STALE_MS + 1, "88888888-8888-4888-8888-888888888888");
    const selected = selectStaleRuns([atBoundary, justInside], thresholds);
    expect(selected).toEqual([atBoundary]);
  });
});

describe("Reconciler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-enqueues stale runs only and survives per-run enqueue failures", async () => {
    const staleA = makeRun("pending", NOW - 600_000, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    const staleB = makeRun("processing", NOW - 3_600_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2");
    const fresh = makeRun("pending", NOW - 1000, "cccccccc-cccc-4ccc-8ccc-ccccccccccc3");
    const done = makeRun("completed", NOW - 3_600_000, "dddddddd-dddd-4ddd-8ddd-ddddddddddd4");
    const enqueue = new FakeEnqueuer();
    enqueue.failFor.add(staleA.id);
    const log: string[] = [];
    const reconciler = new Reconciler({
      store: makeStore([staleA, staleB, fresh, done]),
      enqueue,
      now: () => NOW,
      log: (event) => log.push(event),
    });

    const requeued = await reconciler.runOnce();
    // The failing run does not abort the pass; the other stale run goes.
    expect(requeued).toEqual([staleB.id]);
    expect(enqueue.calls).toEqual([staleB.id]);
    expect(log).toContain("run_requeue_failed");
    expect(log).toContain("run_requeued");
  });

  it("runs one pass at startup and then on the interval; stop() halts it", async () => {
    vi.useFakeTimers();
    const enqueue = new FakeEnqueuer();
    const stale = makeRun("pending", NOW - 600_000, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5");
    const reconciler = new Reconciler({
      store: makeStore([stale]),
      enqueue,
      intervalMs: 1000,
      now: () => NOW,
    });

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0); // startup pass
    expect(enqueue.calls).toHaveLength(1);

    await vi.advanceTimersByTime(1000);
    expect(enqueue.calls).toHaveLength(2);

    await reconciler.stop();
    await vi.advanceTimersByTime(5000);
    expect(enqueue.calls).toHaveLength(2); // timer fully stopped

    // Idempotent start/stop.
    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue.calls).toHaveLength(3);
    await reconciler.stop();
  });

  it("does not double-start two timers", async () => {
    vi.useFakeTimers();
    const enqueue = new FakeEnqueuer();
    const stale = makeRun("pending", NOW - 600_000, "ffffffff-ffff-4fff-8fff-fffffffffff6");
    const reconciler = new Reconciler({
      store: makeStore([stale]),
      enqueue,
      intervalMs: 1000,
      now: () => NOW,
    });
    reconciler.start();
    reconciler.start();
    await vi.advanceTimersByTimeAsync(1000);
    // One startup pass + one interval pass — a second start() must not
    // schedule a second timer (which would double every interval).
    expect(enqueue.calls).toHaveLength(2);
    await reconciler.stop();
  });

  it("skips interval ticks while a pass is still running (review n3)", async () => {
    vi.useFakeTimers();
    const enqueue = new FakeEnqueuer();
    const stale = makeRun("pending", NOW - 600_000, "12121212-1212-4212-8212-121212121212");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listRunsCalls = 0;
    const reconciler = new Reconciler({
      store: {
        listRuns: async () => {
          listRunsCalls += 1;
          await gate;
          return [stale];
        },
      },
      enqueue,
      intervalMs: 1000,
      now: () => NOW,
    });

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listRunsCalls).toBe(1); // startup pass in flight (blocked)

    // Three interval ticks fire while the pass is still running: none
    // of them may start a second pass.
    await vi.advanceTimersByTime(3000);
    expect(listRunsCalls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0); // let the pass finish
    await vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listRunsCalls).toBe(2); // ticks run again afterwards
    await reconciler.stop();
  });
});
