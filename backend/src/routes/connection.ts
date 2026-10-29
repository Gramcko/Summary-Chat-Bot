import type { FastifyInstance } from "fastify";
import { ConnectionStatus } from "@summarly/contracts";
import type { InMemoryStore } from "../lib/store.js";

export function registerConnectionRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.get("/api/connection", async () =>
    ConnectionStatus.parse(store.connection),
  );
}
