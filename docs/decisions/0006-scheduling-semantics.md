# 0006 — Scheduling semantics for daily summaries (D5)

- **Status:** Accepted (2026-11-02) — specifies the D5 decision recorded
  in ADR 0005 and the Phase E round 2 scheduler implementation
  (`backend/src/lib/scheduler.ts`, architecture §5.3 "initially hosted
  by backend").

## Context

The dashboard lets the admin monitor groups with a per-group IANA time
zone and an optional daily cutoff (`summary_time`). D5 decided WHAT a
scheduled daily summary covers; this ADR fixes the exact semantics so
the scheduler, the API docs, and future schedulers cannot drift:

- Which period does one scheduled summary cover?
- When does a group become due, and what is the default cutoff?
- How do DST transitions interact with "a calendar day"?
- How are duplicates prevented across ticks, restarts, and replicas?
- What happens when an enqueue or a day is missed?

## Decision

### Period: the previous calendar day, as instants

A scheduled run covers the **previous calendar day** in the group's
time zone: the half-open window `[00:00, 24:00)` of "yesterday" local,
stored as UTC instants (`start_at` inclusive, `end_at` exclusive — the
same instant-based identity as manual runs, architecture §5.3). The
window's `timezone` label is the group's zone; it is presentation
metadata, not part of run identity.

### Cutoff: `summary_time ?? DEFAULT_SUMMARY_TIME`

A group becomes due **today** when its cutoff has been reached in the
group's own time zone (minute precision: 09:00 is reached at 09:00:00
local):

- `groups.summary_time` (HH:mm, per group, set in the dashboard) when
  present;
- otherwise the install default **`DEFAULT_SUMMARY_TIME`** (env, default
  `"09:00"`).

What the admin configures: per group — `monitored`, `timezone`,
`summary_time`; per install — `DEFAULT_SUMMARY_TIME`,
`SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`.

### DST handling (why the math is two-pass Intl)

A local day is not always 24 hours: it is **23h** when clocks spring
forward and **25h** when they fall back. The window is always
`[local midnight, next local midnight)` as instants — never "now minus
24h". The implementation converts local midnights to UTC instants with
an `Intl.DateTimeFormat` offset lookup and a two-pass correction (the
same approach as `dashboard/src/lib/time.ts`), with **no date library**.

Verified transition examples (unit-tested with exact instants):

| zone | local day | window length |
| --- | --- | --- |
| Europe/Berlin | 2027-03-28 (spring) | 23h |
| Europe/Berlin | 2027-10-31 (fall) | 25h |
| America/New_York | 2027-03-14 / 2027-11-07 | 23h / 25h |
| Australia/Sydney | 2027-04-04 / 2027-10-03 (southern) | 25h / 23h |

Midnight-transition zones (e.g. America/Santiago, where the clock jumps
at 24:00):

- **Fall back** (local 00:00 occurs twice): the window boundary is the
  **last** reading of 00:00 and the repeated hour belongs to the
  **earlier** day's window (a 25h day followed by a normal 24h day).
- **Spring forward** (local 00:00 is skipped): the window boundary is
  the **first instant after the gap** — the day begins when its date
  does (e.g. 01:00 local). The two-pass conversion alone used to land
  on an instant of the *previous* local date here, misattributing the
  day's first hour to the day before (review m1); the boundary is now
  verified against the local civil date and clamped forward. The
  affected day is 23h and the day before keeps its full 24h.

Consecutive windows always share a boundary exactly — no gap, no
overlap, and no message can fall between two windows or count twice.
Verified transition examples (unit-tested with exact instants, checked
against the live Intl time-zone database): Europe/Berlin 2027-03-28
(23h) and 2027-10-31 (25h), America/New_York 2027-03-14 / 2027-11-07,
Australia/Sydney 2027-04-04 / 2027-10-03, America/Santiago 2026-09-06
(spring gap) and 2027-04-04 (fall double-midnight).

### Idempotency: create-or-find on the run identity

At most ONE scheduled run exists per (group, window, kind="scheduled").
This is enforced by the database's run-identity uniqueness through the
same `createOrFindRun` used for manual runs — so repeated scheduler
ticks, process restarts, and even concurrent replicas cannot
double-schedule (architecture §5.3's duplicate-avoidance requirement).
The scheduler additionally skips windows that already have a run
(read-only `findRunByIdentity`) to avoid pointless writes.

**The scheduler never overruns.** A window with an existing run — any
status, including `completed` or `failed` — is never re-created and
never re-enqueued. **Missed-day recovery is bounded**: each pass also
scans the previous `BACKFILL_DAYS` local days (default 3, floor 1,
cap 31) and create-or-finds runs for any missing window, so a missed
day within the backfill window is summarized on the next pass instead
of silently expiring at local midnight. Older gaps are skipped
**deliberately** — each backfilled day costs at most
`MAX_CHUNKS_PER_RUN` provider calls, so the look-back is capped to
bound spend. A newly monitored group likewise gets its recent
`BACKFILL_DAYS` days summarized on its first due pass (expected catch-up
behavior). The previous-day window keeps its cutoff gate; backfilled
windows are strictly past due and do not wait for today's cutoff.
**Regeneration of completed runs remains an open decision** (the API's
retry endpoint answers 409 for completed runs; nothing here changes
that).

### Changing a group's time zone after runs exist

Run identity is instant-based, but "yesterday" is computed from the
group's CURRENT time zone. If the admin changes a group's `timezone`
after scheduled runs exist, the next pass computes a DIFFERENT instant
window (e.g. `Europe/Madrid` → `America/New_York` shifts the boundary
by hours) and claims it as a new identity — so a second scheduled run
covering an overlapping range can coexist with the old one (covered
twice for some messages, by design of instant identity). This is
accepted behavior for the MVP (a deliberate change of grouping
semantics), with **overlap detection as a tracked follow-up** (review
m2). `summary_time` changes are harmless: they only move the cutoff,
not the window.

### Interplay with reconciliation

The scheduler and the reconciler (`lib/reconcile.ts`) are separate
timers with separate jobs:

- the scheduler **creates** runs for due windows (durable run first,
  then enqueue — the same safe semantics as the API routes);
- if the enqueue fails (Redis blip), the run stays `pending` and the
  **reconciler** re-enqueues abandoned runs on its own cadence. A lost
  enqueue is therefore recovered without scheduler involvement.

### Placement and scale

The "due" predicate runs in the backend process (`listGroups()` +
in-memory per-group checks; run existence via a dedicated identity
query). Pushing it into SQL would require per-group time zone math in
the database; at MVP scale (a handful of monitored groups, one pass per
minute) the in-memory check is simple and cheap. Revisit if group
counts grow. Per-group failures are isolated (one broken group never
stops a pass) and logs carry only group ids and counts.

## Consequences

- `kind: "scheduled"` runs are indistinguishable from manual runs for
  the summary-worker (same pipeline, same validation) — only their
  `kind` and interval differ.
- Disabling the scheduler (`SCHEDULER_ENABLED=false`) stops new
  scheduling without touching existing runs; the reconciler keeps
  recovering them.
- The e2e suite runs the baseline with the scheduler disabled for
  determinism and covers the D5 flow in a dedicated scenario (one
  scheduled run per window, no duplicates, completed by the worker).
