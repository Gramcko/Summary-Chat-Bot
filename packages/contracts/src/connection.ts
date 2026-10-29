import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const ConnectionState = z.enum([
  "connected",
  "connecting",
  "disconnected",
  "unavailable",
]);

/** Non-secret connection status. Never includes authentication material. */
export const ConnectionStatus = z.object({
  state: ConnectionState,
  since: IsoDateTime,
  lastMessageAt: IsoDateTime.nullable(),
});

export type ConnectionState = z.infer<typeof ConnectionState>;
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
