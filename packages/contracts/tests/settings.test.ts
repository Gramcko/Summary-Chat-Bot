import { describe, expect, it } from "vitest";
import { ProviderConfigPublic, ProviderConfigUpdate } from "../src/index.js";

describe("ProviderConfigPublic (masked by construction)", () => {
  it("strips a supplied apiKey from the output entirely", () => {
    const parsed = ProviderConfigPublic.parse({
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: null,
      hasApiKey: true,
      apiKey: "sk-must-never-appear",
    });
    expect(parsed).not.toHaveProperty("apiKey");
    expect("apiKey" in parsed).toBe(false);
  });

  it("reports key presence as a boolean instead of the key", () => {
    const parsed = ProviderConfigPublic.parse({
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      hasApiKey: true,
    });
    expect(parsed.hasApiKey).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("sk-");
  });
});

describe("ProviderConfigUpdate", () => {
  it("accepts an update that omits apiKey (keep existing key)", () => {
    const parsed = ProviderConfigUpdate.parse({
      provider: "openai-compatible",
      model: "another-model",
    });
    expect(parsed.apiKey).toBeUndefined();
  });

  it("accepts an update that supplies a new apiKey", () => {
    const parsed = ProviderConfigUpdate.parse({
      provider: "openai-compatible",
      model: "another-model",
      apiKey: "sk-new",
    });
    expect(parsed.apiKey).toBe("sk-new");
  });

  it("rejects an empty model", () => {
    expect(
      ProviderConfigUpdate.safeParse({ provider: "p", model: "" }).success,
    ).toBe(false);
  });
});
