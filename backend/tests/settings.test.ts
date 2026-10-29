import { describe, expect, it } from "vitest";
import { ApiError, ProviderConfigPublic } from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

async function authedApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  const session = await login(ctx.app);
  return { ...ctx, session };
}

describe("AI provider settings", () => {
  it("404s before anything is configured", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
  });

  it("never returns the saved api key, only hasApiKey", async () => {
    const { app, session } = await authedApp();
    const secret = "sk-must-never-appear-in-a-response";
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: {
        provider: "openai-compatible",
        model: "test-model",
        apiKey: secret,
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    const config = ProviderConfigPublic.parse(get.json());
    expect(config.hasApiKey).toBe(true);
    expect(get.body).not.toContain(secret);
    expect(get.body).not.toContain("apiKey");
  });

  it("keeps the saved key when an update omits apiKey", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: "sk-old" },
    });
    const update = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v2" },
    });
    expect(update.statusCode).toBe(200);
    const config = ProviderConfigPublic.parse(update.json());
    expect(config.model).toBe("v2");
    expect(config.hasApiKey).toBe(true);
  });

  it("clears a saved key with an explicit null", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: "sk-old" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "openai-compatible", model: "v1", apiKey: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(ProviderConfigPublic.parse(cleared.json()).hasApiKey).toBe(false);
  });

  it("reports hasApiKey false when configured without a key", async () => {
    const { app, session } = await authedApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "mock", model: "mock-1" },
    });
    const get = await app.inject({
      method: "GET",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
    });
    expect(ProviderConfigPublic.parse(get.json()).hasApiKey).toBe(false);
  });

  it("rejects an invalid configuration payload", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/ai-provider",
      headers: { cookie: session },
      payload: { provider: "", model: "test-model" },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
  });
});
