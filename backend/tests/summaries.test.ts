import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  Summary,
  type SummaryResult,
} from "@summarly/contracts";
import {
  GROUP_ID,
  login,
  makeApp,
  seedGroup,
  setupAdmin,
} from "./helpers.js";
import { nowIso } from "../src/lib/store.js";

const INTERVAL = {
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
  timezone: "Europe/Madrid",
};

const RESULT: SummaryResult = {
  overview: "A quiet day focused on release planning.",
  keyDiscussions: ["Release planning for v1"],
  confirmedDecisions: [
    { text: "Ship on Friday", sourceRefs: [] },
  ],
  proposals: [
    { text: "Move the daily cutoff to 06:00", sourceRefs: [] },
  ],
  unresolvedQuestions: [
    { text: "Who presents the release notes?", sourceRefs: [] },
  ],
  tasks: [
    {
      text: "Draft the release checklist",
      owner: null,
      dueDate: null,
      sourceRefs: [],
    },
  ],
  links: [{ url: "https://example.com/spec", description: "The spec" }],
  aiGenerated: true,
};

async function authedAppWithRun() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  await seedGroup(ctx.store);
  const session = await login(ctx.app);
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/summary-runs",
    headers: { cookie: session },
    payload: { groupId: GROUP_ID, interval: INTERVAL },
  });
  const run = (created.json() as { id: string });
  return { ...ctx, session, runId: run.id };
}

describe("GET /api/summary-runs/:id/summary", () => {
  it("404s for an unknown run with the standard error envelope", async () => {
    const { app, session } = await authedAppWithRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/summary-runs/${randomUUID()}/summary`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe("not_found");
  });

  it("404s when the run has no summary yet", async () => {
    const { app, session, runId } = await authedAppWithRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/summary-runs/${runId}/summary`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe("not_found");
  });

  it("returns the summary for the run", async () => {
    const { app, store, session, runId } = await authedAppWithRun();
    await store.saveSummary({
      id: randomUUID(),
      runId,
      provider: "mock",
      model: "mock-1",
      result: RESULT,
      createdAt: nowIso(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/summary-runs/${runId}/summary`,
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const summary = Summary.parse(res.json());
    expect(summary.runId).toBe(runId);
    expect(summary.provider).toBe("mock");
    expect(summary.model).toBe("mock-1");
    expect(summary.result).toEqual(RESULT);
  });

  it("is reachable through both lookups (by run id and by summary id)", async () => {
    const { app, store, session, runId } = await authedAppWithRun();
    const saved = await store.saveSummary({
      id: randomUUID(),
      runId,
      provider: "mock",
      model: "mock-1",
      result: RESULT,
      createdAt: nowIso(),
    });

    const bySummaryId = await app.inject({
      method: "GET",
      url: `/api/summaries/${saved.id}`,
      headers: { cookie: session },
    });
    expect(bySummaryId.statusCode).toBe(200);
    expect(Summary.parse(bySummaryId.json()).id).toBe(saved.id);

    const byRunId = await app.inject({
      method: "GET",
      url: `/api/summary-runs/${runId}/summary`,
      headers: { cookie: session },
    });
    expect(byRunId.statusCode).toBe(200);
    expect(Summary.parse(byRunId.json()).id).toBe(saved.id);
  });
});
