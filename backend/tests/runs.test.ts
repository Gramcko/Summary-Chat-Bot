import { describe, expect, it } from "vitest";
import { ApiError, SummaryRun } from "@summarly/contracts";
import { GROUP_ID, login, makeApp, setupAdmin, seedGroup } from "./helpers.js";

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

async function authedApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  await seedGroup(ctx.store);
  const session = await login(ctx.app);
  return { ...ctx, session };
}

describe("summary runs", () => {
  it("creates a pending run for a valid request", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    expect(res.statusCode).toBe(201);
    const run = SummaryRun.parse(res.json());
    expect(run.status).toBe("pending");
    expect(run.attempts).toBe(0);
    expect(run.groupId).toBe(GROUP_ID);
  });

  it("is create-or-find: identical requests return the same run", async () => {
    const { app, session } = await authedApp();
    const payload = { groupId: GROUP_ID, interval: INTERVAL };
    const first = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(SummaryRun.parse(second.json()).id).toBe(
      SummaryRun.parse(first.json()).id,
    );
  });

  it("treats a different interval as a different run", async () => {
    const { app, session } = await authedApp();
    const payload = { groupId: GROUP_ID, interval: INTERVAL };
    const other = {
      groupId: GROUP_ID,
      interval: { ...INTERVAL, start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z" },
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: other,
    });
    expect(second.statusCode).toBe(201);
    expect(SummaryRun.parse(second.json()).id).not.toBe(
      SummaryRun.parse(first.json()).id,
    );
  });

  it("deduplicates requests whose timestamps denote the same instants", async () => {
    const { app, session } = await authedApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    // Same instants as INTERVAL, expressed with a +02:00 offset.
    const equivalent = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: {
        groupId: GROUP_ID,
        interval: {
          start: "2026-10-28T02:00:00+02:00",
          end: "2026-10-29T02:00:00+02:00",
          timezone: "Europe/Madrid",
        },
      },
    });
    expect(equivalent.statusCode).toBe(200);
    expect(SummaryRun.parse(equivalent.json()).id).toBe(
      SummaryRun.parse(first.json()).id,
    );
  });

  it("validates the interval and time zone", async () => {
    const { app, session } = await authedApp();
    const inverted = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: {
        groupId: GROUP_ID,
        interval: { ...INTERVAL, start: INTERVAL.end, end: INTERVAL.start },
      },
    });
    expect(inverted.statusCode).toBe(400);
    expect(ApiError.parse(inverted.json()).error.code).toBe("validation_error");

    const badZone = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: {
        groupId: GROUP_ID,
        interval: { ...INTERVAL, timezone: "Not/AZone" },
      },
    });
    expect(badZone.statusCode).toBe(400);
  });

  it("404s for an unknown group and an unknown run", async () => {
    const { app, session } = await authedApp();
    const unknownGroup = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: {
        groupId: "00000000-0000-4000-8000-000000000000",
        interval: INTERVAL,
      },
    });
    expect(unknownGroup.statusCode).toBe(404);

    const unknownRun = await app.inject({
      method: "GET",
      url: "/api/summary-runs/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
    });
    expect(unknownRun.statusCode).toBe(404);
  });

  it("lists runs deterministically with a null cursor", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/summary-runs",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("retries failed runs, is idempotent for queued runs, and rejects completed runs", async () => {
    const { app, store, session } = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    const runId = SummaryRun.parse(created.json()).id;

    // Idempotent while pending.
    const whilePending = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${runId}/retry`,
      headers: { cookie: session },
    });
    expect(whilePending.statusCode).toBe(200);
    expect(SummaryRun.parse(whilePending.json()).status).toBe("pending");

    // Failed -> pending.
    const existing = await store.getRun(runId);
    if (existing === undefined) throw new Error("run missing from store");
    await store.updateRun({
      ...existing,
      status: "failed",
      error: { code: "provider_rate_limit", message: "Rate limited" },
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${runId}/retry`,
      headers: { cookie: session },
    });
    expect(retried.statusCode).toBe(200);
    const retriedRun = SummaryRun.parse(retried.json());
    expect(retriedRun.status).toBe("pending");
    expect(retriedRun.error).toBeNull();

    // Completed -> conflict.
    await store.updateRun({ ...retriedRun, status: "completed" });
    const completed = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${runId}/retry`,
      headers: { cookie: session },
    });
    expect(completed.statusCode).toBe(409);
  });
});

describe("summary run enqueue wiring (queue contract, architecture A6)", () => {
  it("enqueues the new run after the durable row exists", async () => {
    const { app, enqueue, session } = await authedApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    expect(res.statusCode).toBe(201);
    const run = SummaryRun.parse(res.json());
    // Identifier-only payload is asserted in contracts; the route hands
    // the QUEUE only the run id (RecordingEnqueuer records it).
    expect(enqueue.enqueued).toEqual([run.id]);
  });

  it("re-requests of a non-terminal run enqueue again (safe: job-id dedupe)", async () => {
    const { app, enqueue, session } = await authedApp();
    const payload = { groupId: GROUP_ID, interval: INTERVAL };
    const first = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    const runId = SummaryRun.parse(first.json()).id;
    const second = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    expect(second.statusCode).toBe(200);
    // The route asks again; at-most-one-live-job is guaranteed at the
    // queue level by jobId = summaryRunId (see lib/enqueue.ts).
    expect(enqueue.enqueued).toEqual([runId, runId]);
  });

  it("never re-enqueues terminal runs on create-or-find", async () => {
    const { app, store, enqueue, session } = await authedApp();
    const payload = { groupId: GROUP_ID, interval: INTERVAL };
    const first = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    const run = SummaryRun.parse(first.json());
    await store.updateRun({ ...run, status: "completed" });
    enqueue.enqueued.length = 0;

    const repeat = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload,
    });
    expect(repeat.statusCode).toBe(200);
    expect(SummaryRun.parse(repeat.json()).status).toBe("completed");
    // Regeneration is unsupported; failed runs use the retry endpoint.
    expect(enqueue.enqueued).toEqual([]);
  });

  it("a failed enqueue leaves the run pending and still answers success", async () => {
    const { app, store, enqueue, session } = await authedApp();
    enqueue.failWith = new Error("connect ECONNREFUSED 127.0.0.1:6379");
    const res = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    // Architecture A6: the durable run is recoverable (reconciliation
    // re-enqueues it), so the API does not fail the request.
    expect(res.statusCode).toBe(201);
    const run = SummaryRun.parse(res.json());
    expect(run.status).toBe("pending");
    expect(run.error).toBeNull();
    expect(enqueue.enqueued).toEqual([]);
    expect((await store.getRun(run.id))?.status).toBe("pending");
  });

  it("re-enqueues only on the failed -> pending retry transition", async () => {
    const { app, store, enqueue, session } = await authedApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/summary-runs",
      headers: { cookie: session },
      payload: { groupId: GROUP_ID, interval: INTERVAL },
    });
    const run = SummaryRun.parse(created.json());
    expect(enqueue.enqueued).toEqual([run.id]);

    // Retry while pending: no-op, no additional enqueue.
    await app.inject({
      method: "POST",
      url: `/api/summary-runs/${run.id}/retry`,
      headers: { cookie: session },
    });
    expect(enqueue.enqueued).toEqual([run.id]);

    // failed -> pending: this is THE re-enqueue path.
    const existing = await store.getRun(run.id);
    if (existing === undefined) throw new Error("run missing from store");
    await store.updateRun({
      ...existing,
      status: "failed",
      error: { code: "provider_error", message: "boom" },
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${run.id}/retry`,
      headers: { cookie: session },
    });
    expect(retried.statusCode).toBe(200);
    expect(enqueue.enqueued).toEqual([run.id, run.id]);

    // A failed enqueue on retry must not break the response either.
    await store.updateRun({
      ...(await store.getRun(run.id))!,
      status: "failed",
      error: { code: "provider_error", message: "boom" },
    });
    enqueue.failWith = new Error("Connection is closed.");
    const retriedAgain = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${run.id}/retry`,
      headers: { cookie: session },
    });
    expect(retriedAgain.statusCode).toBe(200);
    expect(SummaryRun.parse(retriedAgain.json()).status).toBe("pending");
  });
});
