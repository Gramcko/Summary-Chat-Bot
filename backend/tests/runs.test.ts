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
  seedGroup(ctx.store);
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
    const existing = store.runs.get(runId);
    if (existing === undefined) throw new Error("run missing from store");
    store.runs.set(runId, {
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
    store.runs.set(runId, { ...retriedRun, status: "completed" });
    const completed = await app.inject({
      method: "POST",
      url: `/api/summary-runs/${runId}/retry`,
      headers: { cookie: session },
    });
    expect(completed.statusCode).toBe(409);
  });
});
