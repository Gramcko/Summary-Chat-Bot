import type { SummaryRun } from "@summarly/contracts";
import type { Store } from "./store.js";
import type { EnqueueOutcome, SummaryEnqueuer } from "./enqueue.js";

/**
 * Summary-run reconciliation (architecture A4.6/A6, docs/decisions/
 * 0003-queue-strategy.md): PostgreSQL and Redis cannot be updated in
 * one atomic transaction, so a durable run can outlive its queue job
 * (enqueue failed, Redis restarted, job evicted). This pass runs with
 * the backend and re-enqueues runs that look abandoned:
 *
 * - `pending` runs whose last activity is older than
 *   {@link DEFAULT_PENDING_STALE_MS} (5 minutes) — they have no live
 *   job doing work for them;
 * - `processing` runs whose last activity is older than
 *   {@link DEFAULT_PROCESSING_STUCK_MS} (30 minutes) — the worker
 *   crashed or its job was lost mid-run.
 *
 * Terminal states (`completed`, `failed`) are NEVER touched: completed
 * runs must not be regenerated, and failed runs have an explicit retry
 * path (POST /api/summary-runs/:id/retry). "Last activity" is the run
 * row's `updated_at`, which every state transition refreshes.
 *
 * Re-enqueueing is safe to repeat at any cadence: the queue producer's
 * job-id mechanism dedupes runs with a live job and only replaces dead
 * jobs (see enqueue.ts), and the summary-worker pipeline itself is
 * idempotent per run (architecture A6).
 */

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
export const MIN_RECONCILE_INTERVAL_MS = 1000;
export const DEFAULT_PENDING_STALE_MS = 5 * 60_000;
export const DEFAULT_PROCESSING_STUCK_MS = 30 * 60_000;

export type ReconcileLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

/**
 * Parses `RECONCILE_INTERVAL_MS`. Unset/empty → default (60s). Must be
 * a positive integer number of milliseconds; the floor is CLAMPED to
 * 1000 ms (audit L10/n1) so a misconfigured value can never spin the
 * pass into a hot loop.
 */
export function parseReconcileIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_RECONCILE_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `RECONCILE_INTERVAL_MS must be a positive integer (milliseconds), got "${raw}".`,
    );
  }
  return Math.max(parsed, MIN_RECONCILE_INTERVAL_MS);
}

export interface StaleThresholds {
  /** `pending` runs idle at least this long are stale. */
  pendingStaleMs: number;
  /** `processing` runs idle at least this long are stuck. */
  processingStuckMs: number;
  /** Evaluation time (epoch ms). */
  nowMs: number;
}

/**
 * Pure selection of runs that reconciliation should re-enqueue. Idle
 * time is measured from `updatedAt` (last activity). Terminal runs are
 * never selected.
 */
export function selectStaleRuns(
  runs: SummaryRun[],
  thresholds: StaleThresholds,
): SummaryRun[] {
  return runs.filter((run) => {
    const idleMs = thresholds.nowMs - Date.parse(run.updatedAt);
    switch (run.status) {
      case "pending":
        return idleMs >= thresholds.pendingStaleMs;
      case "processing":
        return idleMs >= thresholds.processingStuckMs;
      // completed/failed are terminal: regeneration is unsupported and
      // failed runs have the explicit retry endpoint.
      default:
        return false;
    }
  });
}

export interface ReconcilerOptions {
  store: Pick<Store, "listRuns">;
  enqueue: SummaryEnqueuer;
  /** Timer cadence (env RECONCILE_INTERVAL_MS). */
  intervalMs?: number;
  pendingStaleMs?: number;
  processingStuckMs?: number;
  now?: () => number;
  log?: ReconcileLogger;
}

/** ReconcilerOptions with every default resolved to a concrete value. */
export interface ResolvedReconcilerOptions {
  store: Pick<Store, "listRuns">;
  enqueue: SummaryEnqueuer;
  /** Timer cadence (env RECONCILE_INTERVAL_MS). */
  intervalMs: number;
  pendingStaleMs: number;
  processingStuckMs: number;
  now?: () => number;
  log?: ReconcileLogger;
}

/**
 * Interval-driven reconciliation pass. `start()` also runs one pass
 * immediately (a restart must repair the backlog right away). The
 * timer is `unref`'d so it never keeps the process alive, and `stop()`
 * clears it and awaits the in-flight pass (graceful shutdown).
 */
export class Reconciler {
  private readonly options: ResolvedReconcilerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(options: ReconcilerOptions) {
    // Defaults first are overridden only by PRESENT values (a plain
    // trailing spread would let `undefined` erase them).
    this.options = {
      store: options.store,
      enqueue: options.enqueue,
      now: options.now,
      log: options.log,
      intervalMs: options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      pendingStaleMs: options.pendingStaleMs ?? DEFAULT_PENDING_STALE_MS,
      processingStuckMs:
        options.processingStuckMs ?? DEFAULT_PROCESSING_STUCK_MS,
    };
  }

  /**
   * One reconciliation pass. Returns the ids of runs that were handed
   * to the enqueuer (whether or not a new job was needed — a live job
   * already covering the run is a successful outcome too). A failing
   * enqueue never aborts the pass: the next tick retries it.
   */
  async runOnce(): Promise<string[]> {
    const nowMs = (this.options.now ?? Date.now)();
    const runs = await this.options.store.listRuns();
    const stale = selectStaleRuns(runs, {
      pendingStaleMs: this.options.pendingStaleMs,
      processingStuckMs: this.options.processingStuckMs,
      nowMs,
    });
    const requeued: string[] = [];
    for (const run of stale) {
      try {
        const outcome: EnqueueOutcome =
          await this.options.enqueue.enqueueSummaryRun(run.id);
        requeued.push(run.id);
        this.options.log?.("run_requeued", {
          summaryRunId: run.id,
          runStatus: run.status,
          outcome,
        });
      } catch (error) {
        // Safe reason only (error names never carry run or message
        // content); the run stays in place for the next pass.
        this.options.log?.("run_requeue_failed", {
          summaryRunId: run.id,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    return requeued;
  }

  /** Starts the interval and runs one pass immediately. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    // The timer must never hold the process open (graceful shutdown).
    this.timer.unref();
  }

  /** Clears the interval and awaits the in-flight pass. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private tick(): Promise<void> {
    if (this.running) {
      // Overlap guard (review n3): a slow pass must not stack with the
      // next interval tick — the skipped pass would add nothing anyway.
      return this.inFlight;
    }
    this.running = true;
    this.inFlight = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.log?.("reconcile_pass_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        this.running = false;
      });
    return this.inFlight;
  }
}
