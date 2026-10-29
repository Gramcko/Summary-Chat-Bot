import type { FastifyInstance } from "fastify";
import {
  Group,
  Id,
  UpdateGroupRequest,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import type { InMemoryStore } from "../lib/store.js";

const GroupParams = z.object({ id: Id });

export function registerGroupRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.get("/api/groups", async () => [...store.groups.values()]);

  app.patch("/api/groups/:id", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const body = UpdateGroupRequest.parse(request.body);
    const group = store.groups.get(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // summaryTime distinguishes "absent" (keep) from explicit null (clear).
    const updated: Group = {
      id: group.id,
      name: group.name,
      monitored: body.monitored ?? group.monitored,
      timezone: body.timezone ?? group.timezone,
      summaryTime:
        body.summaryTime !== undefined ? body.summaryTime : group.summaryTime,
    };
    store.groups.set(id, updated);
    return updated;
  });
}
