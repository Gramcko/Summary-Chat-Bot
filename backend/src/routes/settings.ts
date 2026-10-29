import type { FastifyInstance } from "fastify";
import {
  ProviderConfigPublic,
  ProviderConfigUpdate,
} from "@summarly/contracts";
import { HttpError } from "../lib/errors.js";
import type { InMemoryStore } from "../lib/store.js";

export function registerSettingsRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.get("/api/settings/ai-provider", async () => {
    if (store.provider === null) {
      throw new HttpError(404, "not_found", "AI provider is not configured.");
    }
    // Parse masks by construction: no key material can leave this handler.
    return ProviderConfigPublic.parse({
      provider: store.provider.provider,
      model: store.provider.model,
      baseUrl: store.provider.baseUrl,
      hasApiKey: store.provider.apiKey !== null,
    });
  });

  app.put("/api/settings/ai-provider", async (request) => {
    const body = ProviderConfigUpdate.parse(request.body);
    const previous = store.provider;
    // Omitting apiKey keeps the currently saved key.
    const apiKey =
      body.apiKey !== undefined
        ? body.apiKey
        : (previous?.apiKey ?? null);
    store.provider = {
      provider: body.provider,
      model: body.model,
      baseUrl:
        body.baseUrl !== undefined ? body.baseUrl : (previous?.baseUrl ?? null),
      apiKey,
    };
    return ProviderConfigPublic.parse({
      provider: store.provider.provider,
      model: store.provider.model,
      baseUrl: store.provider.baseUrl,
      hasApiKey: apiKey !== null,
    });
  });
}
