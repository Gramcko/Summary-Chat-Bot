import type { FastifyInstance } from "fastify";
import {
  Group,
  Id,
  UpdateGroupRequest,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import type { Store } from "../lib/store.js";

const GroupParams = z.object({ id: Id });

export function registerGroupRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/groups", async () => store.listGroups());

  app.patch("/api/groups/:id", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const body = UpdateGroupRequest.parse(request.body);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // summaryTime distinguishes "absent" (keep) from explicit null (clear).
    // chatId is read-only metadata; PATCH never changes it.
    const updated: Group = {
      id: group.id,
      chatId: group.chatId,
      name: group.name,
      monitored: body.monitored ?? group.monitored,
      timezone: body.timezone ?? group.timezone,
      summaryTime:
        body.summaryTime !== undefined ? body.summaryTime : group.summaryTime,
    };
    const stored = await store.updateGroup(updated);
    if (stored === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    return stored;
  });
}
