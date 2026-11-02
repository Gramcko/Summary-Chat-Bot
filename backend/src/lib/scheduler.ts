import type { Group } from "@summarly/contracts";
import type { SummaryEnqueuer } from "./enqueue.js";
import type { Store } from "./store.js";

/**
 * Daily summary scheduler (architecture §5.3 — "initially hosted by
 * backend"; D5 semantics recorded in docs/decisions/0005 and specified
 * in docs/decisions/0006-scheduling-semantics.md):
 *
 * - A scheduled daily summary covers the PREVIOUS calendar day in the
 *   group's IANA time zone: the half-open local-day window
 *   `[00:00, 24:00)` of "yesterday", expressed as UTC instants.
 * - It becomes due when the group's cutoff (its `summary_time`, or the
 *   install default DEFAULT_SUMMARY_TIME) has been reached TODAY in
 *   the group's time zone.
 * - At most ONE scheduled run per (group, window) — enforced by the
 *   database's run-identity uniqueness (createOrFindRun), so repeated
 *   ticks, restarts, or concurrent replicas can never double-schedule.
 *   The scheduler never "overruns" a window: a run that already exists
 *   (any status) is never replaced. A missed day is summarized on a
 *   later pass only if no run exists for that window — bounded
 *   BACKFILL_DAYS look-back (default 3) so gaps do not silently expire
 *   at local midnight, while older gaps are deliberately skipped
 *   (each backfilled day costs at most MAX_CHUNKS_PER_RUN provider
 *   calls). Regeneration of completed runs stays an open decision.
 * - A lost enqueue is not fatal: the run row is durable first
 *   (create-or-find) and the reconciliation pass (lib/reconcile.ts)
 *   re-enqueues abandoned pending runs. The scheduler only enqueues
 *   runs it just created (`created: true`).
 *
 * MVP placement choice (documented): the "due" predicate is evaluated
 * in this process (`listGroups()` + in-memory per-group checks) while
 * run existence is checked with a dedicated identity query
 * (`findRunByIdentity`). Pushing the whole predicate into SQL would
 * need per-group time zone math in the database; at MVP scale (a
 * handful of monitored groups, one pass per minute) the in-memory
 * check is simple, testable, and cheap. Revisit if group counts grow.
 *
 * Time math (D5, no dependencies): local-day boundaries are computed
 * with `Intl.DateTimeFormat` offsets in a two-pass correction (the
 * same approach as dashboard/src/lib/time.ts), so DST days are handled
 * exactly: a local day may be 23h (spring forward) or 25h (fall back)
 * and the window is always [local midnight, next local midnight) as
 * instants. In zones that transition at midnight the boundary is the
 * LAST reading of 00:00 and the repeated hour belongs to the earlier
 * day's window (see ADR 0006).
 */

/** Install default cutoff when a group has no `summary_time` (HH:mm). */
export const DEFAULT_SUMMARY_TIME = "09:00";

export const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;
export const MIN_SCHEDULER_INTERVAL_MS = 1000;

/**
 * Bounded missed-day recovery (review M1): each pass also considers the
 * previous BACKFILL_DAYS local days, so a window that lost its run (or
 * whose day passed while the backend was down) is summarized on a
 * later pass instead of silently expiring at local midnight. The bound
 * is deliberate: every backfilled day costs at most
 * MAX_CHUNKS_PER_RUN provider calls (ADR 0006).
 */
export const DEFAULT_BACKFILL_DAYS = 3;
export const MIN_BACKFILL_DAYS = 1;
export const MAX_BACKFILL_DAYS = 31;

export type SchedulerLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

// ---- environment/config parsing (fail fast, like every other knob) ----

/**
 * Parses `DEFAULT_SUMMARY_TIME` (and per-group `summary_time` values)
 * into minutes since local midnight. `raw` unset/empty → `fallback`.
 */
export function parseSummaryTime(
  raw: string | undefined,
  fallback: string = DEFAULT_SUMMARY_TIME,
): number {
  const value = (raw ?? "").trim() === "" ? fallback : (raw ?? "").trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    throw new Error(
      `summary time must be HH:mm in 24-hour format, got "${raw ?? value}".`,
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Parses `SCHEDULER_ENABLED`. Unset/empty → enabled (the default).
 * Accepts true/false/yes/no/1/0 case-insensitively; anything else
 * fails fast instead of guessing.
 */
export function parseSchedulerEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  if (value === "yes" || value === "1") return true;
  throw new Error(
    `SCHEDULER_ENABLED must be true or false, got "${raw}".`,
  );
}

/**
 * Parses `SCHEDULER_INTERVAL_MS`. Unset/empty → 60s. Positive integer
 * with the same 1000ms floor as RECONCILE_INTERVAL_MS (a misconfigured
 * value must never spin the pass into a hot loop).
 */
export function parseSchedulerIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_SCHEDULER_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `SCHEDULER_INTERVAL_MS must be a positive integer (milliseconds), got "${raw}".`,
    );
  }
  return Math.max(parsed, MIN_SCHEDULER_INTERVAL_MS);
}

/**
 * Parses `BACKFILL_DAYS`. Unset/empty → 3. Must be an integer; clamped
 * to [1, 31] (floor 1 — recovery is never silently disabled; cap 31 —
 * bounded provider spend per pass).
 */
export function parseBackfillDays(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_BACKFILL_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`BACKFILL_DAYS must be an integer, got "${raw}".`);
  }
  return Math.min(Math.max(parsed, MIN_BACKFILL_DAYS), MAX_BACKFILL_DAYS);
}

// ---- time-zone aware day windows (D5, DST-safe, no dependencies) ----

const DAY_MS = 24 * 60 * 60 * 1000;

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  // hourCycle "h23" avoids the "24:00" midnight quirk of hour12:false.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const record: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") record[part.type] = part.value;
  }
  return {
    year: Number(record.year),
    month: Number(record.month),
    day: Number(record.day),
    hour: Number(record.hour),
    minute: Number(record.minute),
    second: Number(record.second),
  };
}

/** Zone offset at `instantMs` (zone time minus UTC), in milliseconds. */
function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // Second precision is enough: offsets are whole minutes.
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The local civil date of `instantMs` as a UTC-midnight timestamp. */
function localDateNumber(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/**
 * Smallest instant in (fromMs, fromMs + 24h] whose local civil date has
 * reached `requestedDateMs` — i.e. the first instant AFTER a midnight
 * DST gap. Local dates only move forward across a spring gap.
 */
function firstInstantOnLocalDate(
  requestedDateMs: number,
  fromMs: number,
  timeZone: string,
): number {
  let lo = fromMs;
  let hi = fromMs + DAY_MS;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDateNumber(mid, timeZone) >= requestedDateMs) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * UTC instant at which the local date `year-month-day` begins in
 * `timeZone` (local 00:00). Two-pass offset correction: the naive
 * "guess" is corrected with the offset at the guess, then re-checked at
 * the corrected instant — this is what makes DST boundaries exact
 * (a local day can start at a UTC hour that itself shifted).
 *
 * Midnight-transition zones (e.g. America/Santiago):
 * - where local 00:00 occurs TWICE (fall back), the two-pass converges
 *   to the LAST reading and the repeated hour belongs to the earlier
 *   day's window;
 * - where local 00:00 is SKIPPED (spring forward, review m1), the
 *   two-pass alone would land on an instant of the PREVIOUS local date
 *   (misattributing the final hour) — the result is verified against
 *   the local civil date and clamped forward to the first instant after
 *   the gap (the day starts when its date does).
 * Adjacency between consecutive windows always holds: no gap, no
 * overlap. Documented in ADR 0006.
 */
function zonedMidnightMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const requestedDate = Date.UTC(year, month - 1, day);
  const guess = requestedDate;
  const offset1 = timeZoneOffsetMs(guess, timeZone);
  let instant = guess - offset1;
  const offset2 = timeZoneOffsetMs(instant, timeZone);
  if (offset2 !== offset1) {
    instant = guess - offset2;
  }
  if (localDateNumber(instant, timeZone) < requestedDate) {
    // 00:00 never occurred (spring gap at midnight): the day begins at
    // the gap end, the first instant whose local date matches.
    instant = firstInstantOnLocalDate(requestedDate, instant, timeZone);
  }
  return instant;
}

/** Half-open local-day window as UTC instants. */
export interface DayWindow {
  /** Inclusive start: local 00:00 of the day. */
  start: string;
  /** Exclusive end: local 00:00 of the next day. */
  end: string;
  timezone: string;
}

/**
 * The previous calendar day of `now` in `timezone`, as the half-open
 * instant window [local midnight yesterday, local midnight today).
 * This is the D5 period of one scheduled daily summary.
 */
export function previousDayWindow(now: Date, timezone: string): DayWindow {
  return dayWindowAgo(now, timezone, 1);
}

/**
 * The local-day window `daysBack` days before `now` (1 = yesterday):
 * [local midnight of that day, local midnight of the next day).
 */
function dayWindowAgo(
  now: Date,
  timezone: string,
  daysBack: number,
): DayWindow {
  const local = zonedParts(now.getTime(), timezone);
  const todayCiv = Date.UTC(local.year, local.month - 1, local.day);
  const day = new Date(todayCiv - daysBack * DAY_MS);
  const nextDay = new Date(todayCiv - (daysBack - 1) * DAY_MS);
  const start = zonedMidnightMs(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    timezone,
  );
  const end = zonedMidnightMs(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    timezone,
  );
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timezone,
  };
}

/**
 * The `days` most recent local-day windows ending with yesterday,
 * newest first (review M1 — the bounded backfill scan).
 */
export function previousDayWindows(
  now: Date,
  timezone: string,
  days: number,
): DayWindow[] {
  const windows: DayWindow[] = [];
  for (let daysBack = 1; daysBack <= days; daysBack += 1) {
    windows.push(dayWindowAgo(now, timezone, daysBack));
  }
  return windows;
}

/**
 * True when the cutoff (minutes since LOCAL midnight) has already been
 * reached at `now` in `timezone`. Minute precision: 09:00 exactly is
 * reached at 09:00:00 local.
 */
export function isCutoffReached(
  now: Date,
  timezone: string,
  cutoffMinutes: number,
): boolean {
  const local = zonedParts(now.getTime(), timezone);
  return local.hour * 60 + local.minute >= cutoffMinutes;
}

// ---- the scheduler ----

export interface SchedulerOptions {
  store: Pick<Store, "listGroups" | "createOrFindRun" | "findRunByIdentity">;
  enqueue: SummaryEnqueuer;
  /** Install default cutoff in minutes since local midnight. */
  defaultCutoffMinutes?: number;
  /** Timer cadence (env SCHEDULER_INTERVAL_MS). */
  intervalMs?: number;
  /** Bounded missed-day recovery depth (env BACKFILL_DAYS). */
  backfillDays?: number;
  now?: () => number;
  log?: SchedulerLogger;
}

export interface ResolvedSchedulerOptions {
  store: SchedulerOptions["store"];
  enqueue: SummaryEnqueuer;
  defaultCutoffMinutes: number;
  intervalMs: number;
  backfillDays: number;
  now: () => number;
  log?: SchedulerLogger;
}

/**
 * Interval-driven scheduling pass. `start()` runs one pass immediately
 * (a restart must not miss the day's cutoff) and then on the interval;
 * the timer is `unref`'d and `stop()` awaits the in-flight pass — the
 * same lifecycle contract as the Reconciler (lib/reconcile.ts).
 */
export class Scheduler {
  private readonly options: ResolvedSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(options: SchedulerOptions) {
    this.options = {
      store: options.store,
      enqueue: options.enqueue,
      log: options.log,
      now: options.now ?? Date.now,
      defaultCutoffMinutes:
        options.defaultCutoffMinutes ?? parseSummaryTime(undefined),
      intervalMs: options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      backfillDays: options.backfillDays ?? DEFAULT_BACKFILL_DAYS,
    };
  }

  /**
   * One scheduling pass. Returns the ids of the runs CREATED by this
   * pass (an already-scheduled window is not an error — it is the
   * idempotency guarantee). Per-group failures are isolated: one
   * broken group never stops the pass.
   */
  async runOnce(): Promise<string[]> {
    const now = new Date(this.options.now());
    const groups = await this.options.store.listGroups();
    const created: string[] = [];
    for (const group of groups) {
      if (!group.monitored) continue;
      try {
        created.push(...(await this.scheduleGroup(group, now)));
      } catch (error) {
        // Per-group isolation (deliverable): log safe metadata and go
        // on; the next pass retries this group.
        this.options.log?.("schedule_group_failed", {
          groupId: group.id,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (created.length > 0) {
      this.options.log?.("schedule_pass_done", {
        groupsScanned: groups.length,
        runsCreated: created.length,
      });
    }
    return created;
  }

  /**
   * Schedules every due/missing window for one group. Returns the ids
   * of the runs created.
   */
  private async scheduleGroup(group: Group, now: Date): Promise<string[]> {
    const cutoffMinutes =
      group.summaryTime === null
        ? this.options.defaultCutoffMinutes
        : parseSummaryTime(group.summaryTime);
    const cutoffReached = isCutoffReached(now, group.timezone, cutoffMinutes);
    const windows = previousDayWindows(
      now,
      group.timezone,
      this.options.backfillDays,
    );
    const created: string[] = [];
    let backfilled = 0;

    for (const [index, window] of windows.entries()) {
      const isYesterday = index === 0;
      // The D5 cutoff gates the previous day's summary (the fast
      // path). Older windows are strictly past due — their cutoffs
      // were reached on earlier days — so bounded recovery does not
      // wait for today's cutoff (review M1: a missed day must not
      // silently expire at local midnight).
      if (isYesterday && !cutoffReached) continue;

      // "No run exists yet for the window" — checked by identity so a
      // scheduled window is never re-created or re-enqueued (no matter
      // the existing run's status: the scheduler never overruns).
      const existing = await this.options.store.findRunByIdentity({
        groupId: group.id,
        interval: window,
        kind: "scheduled",
      });
      if (existing !== undefined) continue;

      // Durable-run-first (architecture A6): create-or-find is the
      // atomic "claim" on the window — its UNIQUE(group, start, end,
      // kind) constraint makes concurrent ticks/replicas harmless.
      const { run, created: isNew } = await this.options.store.createOrFindRun(
        {
          groupId: group.id,
          interval: window,
          kind: "scheduled",
        },
      );
      if (!isNew) continue;

      try {
        const outcome = await this.options.enqueue.enqueueSummaryRun(run.id);
        this.options.log?.("scheduled_run_enqueued", {
          groupId: group.id,
          runId: run.id,
          outcome,
        });
      } catch (error) {
        // Same semantics as the routes' safeEnqueue: the run row is
        // durable and stays `pending`; the reconciliation pass
        // re-enqueues it later. Never fail the pass for a queue blip.
        this.options.log?.("scheduled_run_enqueue_failed", {
          groupId: group.id,
          runId: run.id,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      created.push(run.id);
      if (!isYesterday) backfilled += 1;
    }

    if (backfilled > 0) {
      this.options.log?.("scheduled_backfill_created", {
        groupId: group.id,
        count: backfilled,
      });
    }
    return created;
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
      // Overlap guard: a slow pass must not stack with the next tick.
      return this.inFlight;
    }
    this.running = true;
    this.inFlight = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.log?.("schedule_pass_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        this.running = false;
      });
    return this.inFlight;
  }
}
