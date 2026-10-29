import type { FastifyInstance } from "fastify";
import {
  CreateRunRequest,
  Id,
  RunListResponse,
  type SummaryRun,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { nowIso, type Store } from "../lib/store.js";

const RunParams = z.object({ id: Id });

export function registerRunRoutes(
  app: FastifyInstance,
  store: Store,
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
      // the scheduler (architecture §5.3) and created internally.
      kind: "manual",
    });
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
    return store.updateRun(updated);
  });
}
