import type { FastifyInstance } from "fastify";
import { Id, Summary } from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import type { Store } from "../lib/store.js";

const SummaryParams = z.object({ id: Id });

export function registerSummaryRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/summaries/:id", async (request) => {
    const { id } = SummaryParams.parse(request.params);
    const summary = await store.getSummary(id);
    if (summary === undefined) {
      throw new HttpError(404, "not_found", "Summary not found.");
    }
    return Summary.parse(summary);
  });

  /**
   * Summary for a run (the dashboard's primary lookup). Unknown runs and
   * runs without a summary yet both answer with the standard 404 envelope.
   */
  app.get("/api/summary-runs/:id/summary", async (request) => {
    const { id } = SummaryParams.parse(request.params);
    const run = await store.getRun(id);
    if (run === undefined) {
      throw new HttpError(404, "not_found", "Summary run not found.");
    }
    const summary = await store.getSummaryByRunId(id);
    if (summary === undefined) {
      throw new HttpError(404, "not_found", "Summary not found.");
    }
    return Summary.parse(summary);
  });
}
