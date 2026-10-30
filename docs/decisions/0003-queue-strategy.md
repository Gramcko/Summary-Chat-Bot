# 0003 — Queue strategy for summary runs

- **Status:** Accepted (2026-10-30)

## Context

Architecture §4.6/§6 fixes the shape: BullMQ on Redis carries
`generate-summary` work, PostgreSQL stays the source of truth, and the
two cannot be updated in one atomic transaction. Phase C must therefore
decide the concrete queue contract: job identity, payloads, retries,
retention, and how lost or duplicated work is repaired. The decisions
below were verified against the installed **bullmq 6.5.2** sources
(`dist/cjs/scripts/addStandardJob-9.js`, `removeJob-2.js`,
`classes/job.js`) — not against remembered behavior.

## Decision

### Queue, job, payload

- Queue: `summaries` (`SUMMARY_QUEUE`). Job: `generate-summary`
  (`SUMMARY_JOB`). Both names live in `@summarly/contracts`.
- Payload: **identifiers only** — `{ summaryRunId: uuid }`
  (`SummaryRunJob`). Never message content, API keys, or WhatsApp
  session secrets (AGENTS.md). Validation strips unknown keys, so
  accidental extra data can never become part of the job contract.

### Retry policy and backoff

- `attempts: 5` (`SUMMARY_JOB_ATTEMPTS`) with exponential backoff from
  base `SUMMARY_RETRY_BASE_MS` (default 30 s; overridable for tests).
  Permanent failures (unknown run, invalid run data, provider
  configuration) throw BullMQ's `UnrecoverableError` and are never
  retried; the run is marked `failed` immediately with safe metadata.
  Retryable failures (timeouts, rate limits, malformed provider output)
  retry with backoff; when attempts are exhausted the worker's
  `failed` handler marks the run `failed`
  ("Retry attempts were exhausted without producing a summary.").
- **One policy, one home:** `summaryJobOptions()` in
  `@summarly/contracts/queue.ts` (pure data, structurally compatible
  with BullMQ's `JobsOptions`, no bullmq import in contracts). BullMQ
  stores `attempts`/`backoff` on the job at **enqueue time** — there
  are no worker-level retry defaults — so every producer (backend
  routes, reconciliation, tests) MUST add jobs with these options.

### Retention

- Finished jobs are kept per state, bounded to the most recent 1000
  (`SUMMARY_FINISHED_JOBS_KEPT`, `removeOnComplete`/`removeOnFail`) —
  set both on the job options and (as a safety net) at the worker.
  Completed business history lives in PostgreSQL; Redis queue state
  must not grow without bound.

### Job identity, dedupe, and re-enqueue

- `jobId = summaryRunId` (a UUID, so it can never collide across runs).
- BullMQ's add script hard-deduplicates custom ids: if the job key
  exists, the new job is **silently dropped** (`duplicated` event).
  That gives "at most one live job per run" for free — concurrent
  double-enqueues (double-click, route racing reconciliation) collapse
  into one job.
- The same mechanism is a trap: a **finished** job is retained
  (bounded retention keeps its key), so a plain re-add after
  completion/failure would be silently dropped and the re-enqueue
  would be lost. `RedisSummaryEnqueuer.enqueueSummaryRun` therefore:
  1. looks up the job by id;
  2. if it is **live** (waiting/active/delayed/prioritized/
     waiting-children) — done, dedupe succeeded;
  3. if it is **dead** (completed/failed) — removes it, then adds the
     new job with the same id;
  4. removal is safe by construction: BullMQ's remove script refuses
     locked (active) jobs (code 0, nothing removed), so an in-flight
     job can never be yanked even if its state changed between the
     check and the remove. Code 0 means "leave it", and the add is
     skipped.
- Initial enqueues and re-enqueues (retry route, reconciliation) share
  this one code path; a fresh run simply has no existing job.

### Namespace isolation (shared Redis)

- All queue keys are namespaced with a BullMQ `prefix` derived from
  `SUMMARY_QUEUE_PREFIX` (default `summarly`). Test suites run under
  `summarly-test` and the e2e under `summarly-e2e`, so a shared Redis
  can host a dev instance and test/e2e runs at the same time without a
  test worker stealing (and terminally failing) live jobs.

### Reconciliation (lost-work recovery)

- Hosted by the backend (`lib/reconcile.ts`). One pass at startup and
  then every `RECONCILE_INTERVAL_MS` (default 60 s; timer `unref`'d,
  stopped on graceful shutdown).
- Re-enqueues `pending` runs idle ≥ 5 minutes and `processing` runs
  idle ≥ 30 minutes (measured from `updated_at`, which every state
  transition refreshes). Terminal runs are never touched: `completed`
  must not be regenerated, `failed` has the explicit retry endpoint.
- Route-level enqueue failures are swallowed with a safe operational
  log: the durable run already exists (durable-run-first), so the API
  still answers success and the next pass repairs the queue.

### Why no transactional outbox yet

Architecture §6 permits the simpler durable-run-plus-reconciliation
design for the MVP. The worst case (a run waiting for the next
reconciliation pass) is bounded at one interval and already covered by
tests; a transactional outbox adds a second persistence mechanism and
worker without a demonstrated need. Revisit only if measurements show
the reconciliation window is operationally painful.

## Consequences

- The dashboard's "run requested" flow is now end-to-end: request →
  durable run → queue job → summary-worker → validated summary → API.
- Redis outages degrade gracefully: runs stay `pending` and are
  reconciled when Redis returns; nothing durable is lost.
- Known narrow inconsistency: after a stalled-job redelivery race, a
  validated summary may exist for a run that a concurrent execution
  marked `failed`. `POST /api/summary-runs/:id/retry` replaces the
  stale summary; gating summary reads on run status is the full fix and
  is tracked for later.
- Redis is a trusted LOCAL component in this design. Production /
  self-hosted deployments must add authentication (requirepass) and a
  `maxmemory` policy before exposing it — tracked for the deployment
  phase (Phase F).
- Regeneration of completed runs stays unsupported (API answers 409 on
  retry); the mock provider is the only AI adapter in this milestone
  (real providers are Phase E).
