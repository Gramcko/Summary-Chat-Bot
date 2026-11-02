import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Group, SummaryRun } from "@summarly/contracts";
import type { CreateRunInput } from "../src/lib/store.js";
import {
  DEFAULT_BACKFILL_DAYS,
  DEFAULT_SUMMARY_TIME,
  isCutoffReached,
  parseBackfillDays,
  parseSchedulerEnabled,
  parseSchedulerIntervalMs,
  parseSummaryTime,
  previousDayWindow,
  previousDayWindows,
  Scheduler,
  type SchedulerOptions,
} from "../src/lib/scheduler.js";
import { RecordingEnqueuer } from "./helpers.js";

/**
 * D5 scheduling semantics (docs/decisions/0006): a scheduled summary
 * covers the PREVIOUS calendar day in the group's time zone as the
 * half-open instant window [local midnight, next local midnight) —
 * DST-spring (23h) and DST-fall (25h) exact. The expected instants
 * below were verified against live Intl data (the zone database is the
 * authority; these are the correct 2026/2027 transition instants).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function windowHours(window: { start: string; end: string }): number {
  return (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
}

function makeGroup(overrides?: Partial<Group>): Group {
  return {
    id: "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
    chatId: "120363000000000001@g.us",
    name: "Test Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: "09:00",
    ...overrides,
  };
}

describe("previousDayWindow (D5 period, DST-exact)", () => {
  it("covers a plain 24h previous day", () => {
    // Europe/Madrid on 2026-11-02 is CET (+01:00).
    const window = previousDayWindow(
      new Date("2026-11-02T10:00:00Z"),
      "Europe/Madrid",
    );
    expect(window).toEqual({
      start: "2026-10-31T23:00:00.000Z",
      end: "2026-11-01T23:00:00.000Z",
      timezone: "Europe/Madrid",
    });
    expect(windowHours(window)).toBe(24);
  });

  it("Europe/Berlin spring forward: the local day is exactly 23h", () => {
    // DST starts 2027-03-28 (02:00 -> 03:00 local).
    const window = previousDayWindow(
      new Date("2027-03-29T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(window).toEqual({
      start: "2027-03-27T23:00:00.000Z",
      end: "2027-03-28T22:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    expect(windowHours(window)).toBe(23);
  });

  it("Europe/Berlin fall back: the local day is exactly 25h", () => {
    // DST ends 2027-10-31 (03:00 -> 02:00 local).
    const window = previousDayWindow(
      new Date("2027-11-01T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(window).toEqual({
      start: "2027-10-30T22:00:00.000Z",
      end: "2027-10-31T23:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    expect(windowHours(window)).toBe(25);
  });

  it("America/New_York: both transitions are exact", () => {
    const spring = previousDayWindow(
      new Date("2027-03-15T12:00:00Z"),
      "America/New_York",
    );
    expect(spring).toEqual({
      start: "2027-03-14T05:00:00.000Z",
      end: "2027-03-15T04:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(windowHours(spring)).toBe(23);

    const fall = previousDayWindow(
      new Date("2027-11-08T12:00:00Z"),
      "America/New_York",
    );
    expect(fall).toEqual({
      start: "2027-11-07T04:00:00.000Z",
      end: "2027-11-08T05:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(windowHours(fall)).toBe(25);
  });

  it("Australia/Sydney (southern hemisphere): both transitions are exact", () => {
    // DST ends first Sunday of April (25h day) and starts first Sunday
    // of October (23h day) — inverted relative to Europe/America.
    const fall = previousDayWindow(
      new Date("2027-04-05T12:00:00Z"),
      "Australia/Sydney",
    );
    expect(fall).toEqual({
      start: "2027-04-03T13:00:00.000Z",
      end: "2027-04-04T14:00:00.000Z",
      timezone: "Australia/Sydney",
    });
    expect(windowHours(fall)).toBe(25);

    const spring = previousDayWindow(
      new Date("2027-10-04T12:00:00Z"),
      "Australia/Sydney",
    );
    expect(spring).toEqual({
      start: "2027-10-02T14:00:00.000Z",
      end: "2027-10-03T13:00:00.000Z",
      timezone: "Australia/Sydney",
    });
    expect(windowHours(spring)).toBe(23);
  });

  it("midnight-transition zones: boundaries stay adjacent (America/Santiago)", () => {
    // Chile falls back at midnight (2027-04-04): local 00:00 occurs
    // twice. The window boundary is the LAST reading of 00:00 and the
    // repeated hour belongs to the earlier day (ADR 0006): Apr 3 is a
    // 25h day, Apr 4 a normal 24h day, and the windows are adjacent.
    const repeatedDay = previousDayWindow(
      new Date("2027-04-04T12:00:00Z"),
      "America/Santiago",
    );
    expect(repeatedDay).toEqual({
      start: "2027-04-03T03:00:00.000Z",
      end: "2027-04-04T04:00:00.000Z",
      timezone: "America/Santiago",
    });
    expect(windowHours(repeatedDay)).toBe(25);

    const nextDay = previousDayWindow(
      new Date("2027-04-05T12:00:00Z"),
      "America/Santiago",
    );
    expect(nextDay).toEqual({
      start: "2027-04-04T04:00:00.000Z",
      end: "2027-04-05T04:00:00.000Z",
      timezone: "America/Santiago",
    });
    expect(windowHours(nextDay)).toBe(24);
    // Adjacency: no gap and no overlap between consecutive windows.
    expect(repeatedDay.end).toBe(nextDay.start);
  });

  it("midnight GAP zones: the day starts after the gap (America/Santiago spring)", () => {
    // Chile springs forward at midnight (2026-09-06): local 00:00 is
    // SKIPPED (23:59:59 Sep 5 -> 01:00:00 Sep 6). Review m1: the naive
    // two-pass lands on an instant of the PREVIOUS local date and
    // misattributes the final hour; the fix clamps to the first instant
    // after the gap. Verified against live Intl: the gap end is
    // 2026-09-06T04:00:00Z.
    const gapDay = previousDayWindow(
      new Date("2026-09-07T12:00:00Z"),
      "America/Santiago",
    );
    expect(gapDay).toEqual({
      start: "2026-09-06T04:00:00.000Z",
      end: "2026-09-07T03:00:00.000Z",
      timezone: "America/Santiago",
    });
    expect(windowHours(gapDay)).toBe(23); // spring: 23h local day

    // The day BEFORE the gap keeps its final hour (23:00-24:00 Sep 5 =
    // 03:00-04:00Z) — the exact hour that used to be misattributed.
    const dayBefore = previousDayWindow(
      new Date("2026-09-06T12:00:00Z"),
      "America/Santiago",
    );
    expect(dayBefore).toEqual({
      start: "2026-09-05T04:00:00.000Z",
      end: "2026-09-06T04:00:00.000Z",
      timezone: "America/Santiago",
    });
    expect(windowHours(dayBefore)).toBe(24);
    expect(dayBefore.end).toBe(gapDay.start); // still adjacent
  });

  it("is always adjacent to the next day's window (no gap, no overlap)", () => {
    for (const [timezone, now] of [
      ["Europe/Berlin", "2027-03-29T12:00:00Z"],
      ["Europe/Berlin", "2027-11-01T12:00:00Z"],
      ["America/New_York", "2027-03-15T12:00:00Z"],
      ["Australia/Sydney", "2027-04-05T12:00:00Z"],
    ] as const) {
      const today = previousDayWindow(new Date(now), timezone);
      const tomorrow = previousDayWindow(
        new Date(Date.parse(now) + DAY_MS),
        timezone,
      );
      expect(today.end, timezone).toBe(tomorrow.start);
    }
  });

  it("formats both boundaries at local 00:00 of the expected dates", () => {
    // Independent check of the wall-clock semantics (the window really
    // is the local calendar day, whatever the offset).
    const window = previousDayWindow(
      new Date("2027-03-29T12:00:00Z"),
      "Europe/Berlin",
    );
    const localStart = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    }).format(new Date(window.start));
    expect(localStart).toBe("2027-03-28, 00:00");
  });

  it("stays stable across the whole local day (the window only rolls at local midnight)", () => {
    // 08:00Z = 10:00 local, 20:00Z = 22:00 local (CEST) — both on
    // 2027-03-29 local.
    const morning = previousDayWindow(
      new Date("2027-03-29T08:00:00Z"),
      "Europe/Berlin",
    );
    const evening = previousDayWindow(
      new Date("2027-03-29T20:00:00Z"),
      "Europe/Berlin",
    );
    expect(morning).toEqual(evening);
  });
});

describe("isCutoffReached (group-local cutoff)", () => {
  it("is reached exactly at HH:mm local, not a minute before", () => {
    // 2026-11-02T08:59:00Z = 09:59 CET; 07:59:00Z = 08:59 CET.
    expect(isCutoffReached(new Date("2026-11-02T07:59:00Z"), "Europe/Madrid", 540)).toBe(false);
    expect(isCutoffReached(new Date("2026-11-02T08:00:00Z"), "Europe/Madrid", 540)).toBe(true);
  });

  it("depends on the group time zone, not the host", () => {
    const now = new Date("2026-11-02T08:30:00Z");
    // 09:30 in Madrid (reached 09:00), 03:30 in New York (not reached).
    expect(isCutoffReached(now, "Europe/Madrid", 540)).toBe(true);
    expect(isCutoffReached(now, "America/New_York", 540)).toBe(false);
  });
});

describe("config parsing", () => {
  it("parses summary times as minutes with a validated fallback", () => {
    expect(parseSummaryTime(undefined)).toBe(parseSummaryTime(DEFAULT_SUMMARY_TIME));
    expect(parseSummaryTime("")).toBe(9 * 60);
    expect(parseSummaryTime("00:00")).toBe(0);
    expect(parseSummaryTime("23:59")).toBe(23 * 60 + 59);
    for (const raw of ["9:00", "24:00", "12:60", "noon", "0900"]) {
      expect(() => parseSummaryTime(raw), raw).toThrow(/HH:mm/);
    }
  });

  it("parses SCHEDULER_ENABLED (default on)", () => {
    expect(parseSchedulerEnabled(undefined)).toBe(true);
    expect(parseSchedulerEnabled("")).toBe(true);
    expect(parseSchedulerEnabled("false")).toBe(false);
    expect(parseSchedulerEnabled(" FALSE ")).toBe(false);
    expect(parseSchedulerEnabled("0")).toBe(false);
    expect(parseSchedulerEnabled("no")).toBe(false);
    expect(parseSchedulerEnabled("true")).toBe(true);
    expect(parseSchedulerEnabled("yes")).toBe(true);
    expect(parseSchedulerEnabled("1")).toBe(true);
    expect(() => parseSchedulerEnabled("maybe")).toThrow(/SCHEDULER_ENABLED/);
  });

  it("parses SCHEDULER_INTERVAL_MS with a 1000ms floor", () => {
    expect(parseSchedulerIntervalMs(undefined)).toBe(60_000);
    expect(parseSchedulerIntervalMs("5000")).toBe(5000);
    expect(parseSchedulerIntervalMs("500")).toBe(1000);
    for (const raw of ["0", "-1", "abc", "1.5"]) {
      expect(() => parseSchedulerIntervalMs(raw), raw).toThrow(
        /SCHEDULER_INTERVAL_MS/,
      );
    }
  });

  it("parses BACKFILL_DAYS with a floor of 1 and a cap of 31 (review M1)", () => {
    expect(parseBackfillDays(undefined)).toBe(DEFAULT_BACKFILL_DAYS);
    expect(DEFAULT_BACKFILL_DAYS).toBe(3);
    expect(parseBackfillDays("5")).toBe(5);
    expect(parseBackfillDays("0")).toBe(1); // recovery is never disabled
    expect(parseBackfillDays("-4")).toBe(1);
    expect(parseBackfillDays("100")).toBe(31); // bounded provider spend
    for (const raw of ["abc", "1.5"]) {
      expect(() => parseBackfillDays(raw), raw).toThrow(/BACKFILL_DAYS/);
    }
  });
});

// ---- scheduler behavior (fake store + fake queue, injected clock) ----

class FakeSchedulerStore {
  groups: Group[] = [];
  runs = new Map<string, SummaryRun>();
  createCalls: CreateRunInput[] = [];
  failListFor: Error | undefined;

  async listGroups(): Promise<Group[]> {
    if (this.failListFor !== undefined) throw this.failListFor;
    return this.groups;
  }

  async findRunByIdentity(
    input: CreateRunInput,
  ): Promise<SummaryRun | undefined> {
    for (const run of this.runs.values()) {
      if (
        run.groupId === input.groupId &&
        run.kind === input.kind &&
        Date.parse(run.interval.start) === Date.parse(input.interval.start) &&
        Date.parse(run.interval.end) === Date.parse(input.interval.end)
      ) {
        return run;
      }
    }
    return undefined;
  }

  async createOrFindRun(
    input: CreateRunInput,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    const existing = await this.findRunByIdentity(input);
    if (existing !== undefined) return { run: existing, created: false };
    this.createCalls.push(input);
    const now = new Date().toISOString();
    const run: SummaryRun = {
      // Distinct ids per run (like the real store) — several windows of
      // the same group must coexist.
      id: randomUUID(),
      groupId: input.groupId,
      kind: input.kind,
      status: "pending",
      interval: input.interval,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.runs.set(run.id, run);
    return { run, created: true };
  }
}

const NOW = new Date("2026-11-02T10:00:00Z"); // 11:00 in Europe/Madrid

function makeScheduler(overrides?: Partial<SchedulerOptions>) {
  const store = new FakeSchedulerStore();
  const enqueue = new RecordingEnqueuer();
  const logs: string[] = [];
  const scheduler = new Scheduler({
    store,
    enqueue,
    now: () => NOW.getTime(),
    // Fast-path tests use backfill depth 1 (previous day only); the
    // backfill describes opt into deeper windows explicitly.
    backfillDays: 1,
    log: (event) => logs.push(event),
    ...overrides,
  });
  return { scheduler, store, enqueue, logs };
}

describe("Scheduler (due groups, idempotency, isolation)", () => {
  it("creates one scheduled run for a due group with the previous-day window", async () => {
    const { scheduler, store, enqueue } = makeScheduler();
    store.groups = [makeGroup()];

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(1);
    expect(store.createCalls).toHaveLength(1);
    expect(store.createCalls[0]).toEqual({
      groupId: makeGroup().id,
      kind: "scheduled",
      interval: {
        start: "2026-10-31T23:00:00.000Z",
        end: "2026-11-01T23:00:00.000Z",
        timezone: "Europe/Madrid",
      },
    });
    expect(enqueue.enqueued).toEqual(created);
  });

  it("does nothing before the group's cutoff is reached", async () => {
    const { scheduler, store } = makeScheduler();
    // summaryTime 12:00 local; now is 11:00 local.
    store.groups = [makeGroup({ summaryTime: "12:00" })];
    expect(await scheduler.runOnce()).toEqual([]);
    expect(store.createCalls).toHaveLength(0);
  });

  it("never schedules an unmonitored group", async () => {
    const { scheduler, store } = makeScheduler();
    store.groups = [makeGroup({ monitored: false })];
    expect(await scheduler.runOnce()).toEqual([]);
    expect(store.createCalls).toHaveLength(0);
  });

  it("never overruns: an existing run for the window (any status) is skipped", async () => {
    const { scheduler, store } = makeScheduler();
    store.groups = [makeGroup()];
    await scheduler.runOnce();
    // Later passes (and passes after the run completed) must not
    // create or enqueue anything new.
    const completed = [...store.runs.values()][0] as SummaryRun;
    store.runs.set(completed.id, { ...completed, status: "completed" });
    expect(await scheduler.runOnce()).toEqual([]);
    expect(store.createCalls).toHaveLength(1);
  });

  it("uses the install default cutoff when summaryTime is null", async () => {
    const { scheduler, store } = makeScheduler();
    store.groups = [makeGroup({ summaryTime: null })];
    // Default 09:00; now is 11:00 local -> due.
    expect(await scheduler.runOnce()).toHaveLength(1);
  });

  it("isolates per-group failures and keeps scheduling the rest", async () => {
    const { scheduler, store, logs } = makeScheduler();
    const broken = makeGroup({
      id: "00000000-0000-4000-8000-000000000001",
      timezone: "Not/AZone", // Intl throws -> isolated, logged
    });
    const healthy = makeGroup({
      id: "00000000-0000-4000-8000-000000000002",
    });
    store.groups = [broken, healthy];

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(1);
    expect(store.createCalls[0]?.groupId).toBe(healthy.id);
    expect(logs).toContain("schedule_group_failed");
  });

  it("leaves the run pending on enqueue failure (reconciliation recovers it)", async () => {
    const { scheduler, store, enqueue, logs } = makeScheduler();
    store.groups = [makeGroup()];
    enqueue.failWith = new Error("connect ECONNREFUSED");

    const created = await scheduler.runOnce();
    // The run was still created durably; only the enqueue failed.
    expect(created).toHaveLength(1);
    expect(store.createCalls).toHaveLength(1);
    expect(enqueue.enqueued).toEqual([]);
    expect(logs).toContain("scheduled_run_enqueue_failed");
  });

  it("start(): immediate pass, then interval ticks; stop() halts them", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeSchedulerStore();
      store.groups = [makeGroup()];
      const enqueue = new RecordingEnqueuer();
      const scheduler = new Scheduler({
        store,
        enqueue,
        intervalMs: 1000,
        now: () => NOW.getTime(),
        backfillDays: 1,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0); // startup pass
      expect(store.createCalls).toHaveLength(1);

      // The run now exists, so later ticks are no-ops — but they must
      // RUN (and must never double-create for the same window).
      await vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTime(2000);
      expect(store.createCalls).toHaveLength(1);
      expect(enqueue.enqueued).toHaveLength(1);

      await scheduler.stop();
      await vi.advanceTimersByTime(5000);
      expect(store.createCalls).toHaveLength(1); // timer fully stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips ticks while a pass is still running (no overlap)", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeSchedulerStore();
      store.groups = [makeGroup()];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let listGroupsCalls = 0;
      const slowStore = {
        async listGroups() {
          listGroupsCalls += 1;
          await gate;
          return store.groups;
        },
        findRunByIdentity: store.findRunByIdentity.bind(store),
        createOrFindRun: store.createOrFindRun.bind(store),
      };
      const scheduler = new Scheduler({
        store: slowStore,
        enqueue: new RecordingEnqueuer(),
        intervalMs: 1000,
        now: () => NOW.getTime(),
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(listGroupsCalls).toBe(1); // startup pass in flight (blocked)
      await vi.advanceTimersByTime(3000);
      expect(listGroupsCalls).toBe(1); // three ticks skipped while busy
      release();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(listGroupsCalls).toBe(2); // ticks resume afterwards
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent and stop() is safe twice", async () => {
    const { scheduler } = makeScheduler();
    scheduler.start();
    scheduler.start();
    await scheduler.stop();
    await scheduler.stop();
  });
});

describe("Scheduler bounded backfill (review M1: missed days never expire)", () => {
  it("schedules one run per missing window in the backfill depth", async () => {
    const { scheduler, store, enqueue, logs } = makeScheduler({
      backfillDays: 3,
    });
    store.groups = [makeGroup()];

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(3);
    // Fast path first, then the older windows — exactly the previous 3
    // local days, each with its own window.
    const windows = previousDayWindows(NOW, "Europe/Madrid", 3);
    expect(store.createCalls.map((call) => call.interval)).toEqual(
      windows.map((window) => ({
        start: window.start,
        end: window.end,
        timezone: "Europe/Madrid",
      })),
    );
    expect(enqueue.enqueued).toHaveLength(3);
    // Backfill creations are logged as counts (safe metadata only).
    expect(logs).toContain("scheduled_backfill_created");
    // Idempotent: later passes never re-create.
    expect(await scheduler.runOnce()).toEqual([]);
    expect(store.createCalls).toHaveLength(3);
  });

  it("recovers the day that expired while the backend was down", async () => {
    const { scheduler, store, logs } = makeScheduler({ backfillDays: 3 });
    store.groups = [makeGroup()];
    const windows = previousDayWindows(NOW, "Europe/Madrid", 3);

    // Yesterday and the day before already have runs (they did not
    // expire); the OLDEST window of the depth is the missed one.
    for (const window of windows.slice(0, 2)) {
      await store.createOrFindRun({
        groupId: makeGroup().id,
        interval: { ...window },
        kind: "scheduled",
      });
    }
    store.createCalls.length = 0;

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(1);
    expect(store.createCalls[0]?.interval.start).toBe(
      windows[2]?.start,
    );
    expect(
      logs.some(
        (event) =>
          event === "scheduled_backfill_created",
      ),
    ).toBe(true);
  });

  it("is bounded: gaps older than BACKFILL_DAYS are skipped deliberately", async () => {
    const { scheduler, store } = makeScheduler({ backfillDays: 2 });
    store.groups = [makeGroup()];

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(2); // yesterday + one backfill day only
    const windows = previousDayWindows(NOW, "Europe/Madrid", 3);
    const starts = store.createCalls.map((call) => call.interval.start);
    expect(starts).not.toContain(windows[2]?.start);
  });

  it("gates only the previous-day window on the cutoff; older windows are past due", async () => {
    const { scheduler, store } = makeScheduler({ backfillDays: 3 });
    // Cutoff 23:00 local has NOT been reached at 11:00 local.
    store.groups = [makeGroup({ summaryTime: "23:00" })];

    const created = await scheduler.runOnce();
    expect(created).toHaveLength(2);
    const windows = previousDayWindows(NOW, "Europe/Madrid", 3);
    const starts = store.createCalls.map((call) => call.interval.start);
    // Yesterday's window waits for its cutoff ...
    expect(starts).not.toContain(windows[0]?.start);
    // ... the older windows do not (their cutoffs passed on earlier days).
    expect(starts).toEqual([windows[1]?.start, windows[2]?.start]);
  });

  it("changing a group's timezone re-frames windows (documented follow-up, review m2)", async () => {
    const { scheduler, store } = makeScheduler();
    // 04:00 cutoff is reached at 11:00 Madrid AND at 05:00 New York
    // (NOW = 2026-11-02T10:00Z) — both passes must see the group due.
    store.groups = [makeGroup({ summaryTime: "04:00" })];

    expect(await scheduler.runOnce()).toHaveLength(1);
    const madridWindow = store.createCalls[0]?.interval;

    // Same group, different timezone: "yesterday" becomes a DIFFERENT
    // instant window, and run identity is instant-based — so a second
    // scheduled run for an overlapping range is created. ADR 0006
    // documents this; overlap detection is a tracked follow-up.
    store.groups[0] = {
      ...makeGroup({ summaryTime: "04:00" }),
      timezone: "America/New_York",
    };
    expect(await scheduler.runOnce()).toHaveLength(1);
    const newYorkWindow = store.createCalls[1]?.interval;
    expect(newYorkWindow).toBeDefined();
    expect(newYorkWindow?.start).not.toBe(madridWindow?.start);
    // Both windows were claimed (two distinct identities).
    expect(store.createCalls).toHaveLength(2);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
