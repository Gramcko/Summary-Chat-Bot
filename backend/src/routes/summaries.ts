import type { FastifyInstance } from "fastify";
import { Id, Summary } from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import type { InMemoryStore } from "../lib/store.js";

const SummaryParams = z.object({ id: Id });

export function registerSummaryRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.get("/api/summaries/:id", async (request) => {
    const { id } = SummaryParams.parse(request.params);
    const summary = store.summaries.get(id);
    if (summary === undefined) {
      throw new HttpError(404, "not_found", "Summary not found.");
    }
    return Summary.parse(summary);
  });
}
