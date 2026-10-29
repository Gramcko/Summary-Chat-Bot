import type { FastifyInstance } from "fastify";
import { CreateAdminRequest, CreateAdminResponse, SetupStatus } from "@summarly/contracts";
import { apiError, HttpError } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../lib/recovery-codes.js";
import type { InMemoryStore } from "../lib/store.js";

export function registerSetupRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.get("/api/setup/status", async () =>
    SetupStatus.parse({ needsSetup: store.admin === null }),
  );

  app.post("/api/setup", async (request, reply) => {
    const body = CreateAdminRequest.parse(request.body);
    if (store.admin !== null) {
      throw new HttpError(409, "conflict", "Setup has already been completed.");
    }
    const recoveryCodes = generateRecoveryCodes();
    store.admin = {
      passwordHash: hashPassword(body.password),
      recoveryCodeHashes: new Set(recoveryCodes.map(hashRecoveryCode)),
    };
    // Recovery codes are returned exactly once; only hashes are stored.
    return reply
      .status(201)
      .send({ recoveryCodes } satisfies CreateAdminResponse);
  });
}
