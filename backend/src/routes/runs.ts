import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateRunRequest,
  Id,
  RunListResponse,
  type SummaryRun,
} from "@summarly/contracts";
import { z } from "zod";
import type { SummaryEnqueuer } from "../lib/enqueue.js";
import { HttpError } from "../lib/errors.js";
import { nowIso, type Store } from "../lib/store.js";

const RunParams = z.object({ id: Id });

/**
 * Best-effort enqueue (architecture A6): the run row is durable BEFORE
 * this is called, so a failed enqueue is never fatal — the run stays
 * `pending`, the API still answers success, and the reconciliation pass
 * (lib/reconcile.ts) re-enqueues it later. Only safe metadata is
 * logged: error NAMES never carry request or message content, and
 * Redis/BullMQ error text can embed connection URLs (secrets).
 */
async function safeEnqueue(
  request: FastifyRequest,
  enqueue: SummaryEnqueuer,
  summaryRunId: string,
): Promise<void> {
  try {
    await enqueue.enqueueSummaryRun(summaryRunId);
  } catch (error) {
    request.log.error(
      {
        summaryRunId,
        reason: error instanceof Error ? error.name : "unknown",
      },
      "failed to enqueue summary run; left pending for reconciliation",
    );
  }
}

export function registerRunRoutes(
  app: FastifyInstance,
  store: Store,
  enqueue: SummaryEnqueuer,
): void {
  app.post("/api/summary-runs", async (request, reply) => {
    const body = CreateRunRequest.parse(request.body);
    if ((await store.getGroup(body.groupId)) === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // Create-or-find: identical requests return the existing run (200).
    const { run, created } = await store.createOrFindRun({
      groupId: body.groupId,
      interval: body.interval,
      // API-created runs are always manual; scheduled runs are owned by
      // the scheduler (architecture A5.3) and created internally.
      kind: "manual",
    });
    // Queue the work once the durable run exists (A6: durable-run-first;
    // the enqueue is recoverable). Non-terminal runs may legitimately be
    // requested again while queued/running — the job-id mechanism makes
    // the repeat a safe dedupe (at most one live job per run).
    // Terminal runs are deliberately NOT re-queued: `completed` must not
    // be regenerated and `failed` runs go through the explicit retry
    // endpoint below.
    if (run.status === "pending" || run.status === "processing") {
      await safeEnqueue(request, enqueue, run.id);
    }
    return reply.status(created ? 201 : 200).send(run);
  });

  app.get("/api/summary-runs", async () => {
    // The store returns newest first.
    const items = await store.listRuns();
    return RunListResponse.parse({ items, nextCursor: null });
  });

  app.get("/api/summary-runs/:id", async (request) => {
    const { id } = RunParams.parse(request.params);
    const run = await store.getRun(id);
    if (run === undefined) {
      throw new HttpError(404, "not_found", "Summary run not found.");
    }
    return run;
  });

  app.post("/api/summary-runs/:id/retry", async (request) => {
    const { id } = RunParams.parse(request.params);
    const run = await store.getRun(id);
    if (run === undefined) {
      throw new HttpError(404, "not_found", "Summary run not found.");
    }
    if (run.status === "completed") {
      throw new HttpError(
        409,
        "conflict",
        "Completed runs cannot be retried; regeneration is not supported yet.",
      );
    }
    // Idempotent: retrying a queued or running job is a no-op.
    if (run.status === "pending" || run.status === "processing") return run;
    const updated: SummaryRun = {
      ...run,
      status: "pending",
      error: null,
      updatedAt: nowIso(),
    };
    const saved = await store.updateRun(updated);
    // failed -> pending is THE re-enqueue path. The job-id mechanism
    // replaces the retained dead job (never a live/active one).
    await safeEnqueue(request, enqueue, id);
    return saved;
  });
}
