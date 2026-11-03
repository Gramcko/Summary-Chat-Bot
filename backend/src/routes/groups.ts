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
    // SA-M1 (consent): un-monitoring revokes a PENDING history import —
    // the old request must never fire later just because the group is
    // monitored again. Cancel BEFORE the update so the response carries
    // the cleared state. `running` imports are not touched (the
    // bot-worker aborts those itself).
    const unmonitoring = group.monitored && body.monitored === false;
    if (unmonitoring) {
      await store.cancelPendingHistoryImport(id);
    }
    // summaryTime distinguishes "absent" (keep) from explicit null (clear).
    // chatId is read-only metadata; PATCH never changes it. historyImport
    // is system-managed (ADR 0007) and is carried over untouched — the
    // store preserves it even if a caller tampers with this literal.
    const updated: Group = {
      id: group.id,
      chatId: group.chatId,
      name: group.name,
      monitored: body.monitored ?? group.monitored,
      timezone: body.timezone ?? group.timezone,
      summaryTime:
        body.summaryTime !== undefined ? body.summaryTime : group.summaryTime,
      historyImport: group.historyImport,
    };
    const stored = await store.updateGroup(updated);
    if (stored === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    return stored;
  });

  /**
   * Requests a WhatsApp history import for the group (ADR 0007). The
   * dashboard asks the admin this question when a group is switched to
   * monitored; the actual import is performed later by the bot-worker,
   * which polls the system-managed historyImport state.
   *
   * - 404 unknown group;
   * - 409 when the group is NOT monitored (imports are only ever done
   *   for monitored groups — the privacy boundary of ADR 0004);
   * - 200 with the current Group when an import is already
   *   pending/running (idempotent);
   * - 202 with the updated Group when a new request is accepted
   *   (including re-requests after done/failed).
   */
  app.post("/api/groups/:id/history-import", async (request, reply) => {
    const { id } = GroupParams.parse(request.params);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    if (!group.monitored) {
      throw new HttpError(
        409,
        "conflict",
        "Group must be monitored before importing history.",
      );
    }
    const result = await store.requestHistoryImport(id);
    if (result === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // The response code is derived from the WRITE (`changed`), not from
    // a pre-write read: concurrent requests cannot both answer 202
    // (review CR-m1). 202 = this call performed the transition; 200 =
    // an import was already in flight.
    return reply.status(result.changed ? 202 : 200).send(result.group);
  });
}
