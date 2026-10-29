import { z } from "zod";
import { Id, Interval, IsoDateTime } from "./common.js";

export const RunKind = z.enum(["manual", "scheduled"]);

export const RunStatus = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);

/**
 * Safe error metadata: category code and short message only.
 * Never store message content, credentials, or provider secrets here.
 */
export const RunError = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(500),
});

export const SummaryRun = z.object({
  id: Id,
  groupId: Id,
  kind: RunKind,
  status: RunStatus,
  interval: Interval,
  attempts: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  error: RunError.nullable(),
});

export const CreateRunRequest = z.object({
  groupId: Id,
  interval: Interval,
});

export const RunListResponse = z.object({
  items: z.array(SummaryRun),
  nextCursor: z.string().nullable(),
});

export type RunKind = z.infer<typeof RunKind>;
export type RunStatus = z.infer<typeof RunStatus>;
export type RunError = z.infer<typeof RunError>;
export type SummaryRun = z.infer<typeof SummaryRun>;
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
export type RunListResponse = z.infer<typeof RunListResponse>;
