import type { FastifyInstance } from "fastify";
import { CreateAdminRequest, CreateAdminResponse, SetupStatus } from "@summarly/contracts";
import { HttpError } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../lib/recovery-codes.js";
import type { Store } from "../lib/store.js";

export function registerSetupRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/setup/status", async () =>
    SetupStatus.parse({ needsSetup: (await store.getAdmin()) === null }),
  );

  app.post("/api/setup", async (request, reply) => {
    const body = CreateAdminRequest.parse(request.body);
    if ((await store.getAdmin()) !== null) {
      throw new HttpError(409, "conflict", "Setup has already been completed.");
    }
    const recoveryCodes = generateRecoveryCodes();
    // Insert-only: when two setup requests race, exactly one wins and
    // the loser gets 409 instead of silently discarding its recovery codes.
    const created = await store.setAdmin({
      passwordHash: hashPassword(body.password),
      recoveryCodeHashes: new Set(recoveryCodes.map(hashRecoveryCode)),
    });
    if (!created) {
      throw new HttpError(409, "conflict", "Setup has already been completed.");
    }
    // Recovery codes are returned exactly once; only hashes are stored.
    return reply
      .status(201)
      .send({ recoveryCodes } satisfies CreateAdminResponse);
  });
}
