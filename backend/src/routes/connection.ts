import type { FastifyInstance } from "fastify";
import { ConnectionStatus } from "@summarly/contracts";
import type { Store } from "../lib/store.js";

export function registerConnectionRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/connection", async () =>
    ConnectionStatus.parse(await store.getConnectionStatus()),
  );
}
