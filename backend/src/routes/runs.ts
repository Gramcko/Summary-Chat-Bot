import type { FastifyInstance } from "fastify";
import {
  CreateRunRequest,
  Id,
  RunListResponse,
  type SummaryRun,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { nowIso, type InMemoryStore } from "../lib/store.js";

const RunParams = z.object({ id: Id });

export function registerRunRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.post("/api/summary-runs", async (request, reply) => {
    const body = CreateRunRequest.parse(request.body);
    if (!store.groups.has(body.groupId)) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // Create-or-find: identical requests return the existing run (200).
    const { run, created } = store.createOrFindRun({
      groupId: body.groupId,
      interval: body.interval,
      // API-created runs are always manual; scheduled runs are owned by
      // the scheduler (architecture §5.3) and created internally.
      kind: "manual",
    });
    return reply.status(created ? 201 : 200).send(run);
  });

  app.get("/api/summary-runs", async () => {
    const items = [...store.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return RunListResponse.parse({ items, nextCursor: null });
  });

  app.get("/api/summary-runs/:id", async (request) => {
    const { id } = RunParams.parse(request.params);
    const run = store.runs.get(id);
    if (run === undefined) {
      throw new HttpError(404, "not_found", "Summary run not found.");
    }
    return run;
  });

  app.post("/api/summary-runs/:id/retry", async (request) => {
    const { id } = RunParams.parse(request.params);
    const run = store.runs.get(id);
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
    store.runs.set(id, updated);
    return updated;
  });
}
