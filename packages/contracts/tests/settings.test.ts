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

describe("ProviderBaseUrl validation (audit E-2: credential-bearing endpoint)", () => {
  const withBaseUrl = (baseUrl: string | null) => ({
    provider: "google-gemini",
    model: "gemini-3.8-flash",
    baseUrl,
    apiKey: "sk-must-never-appear",
  });

  it("requires https, always", () => {
    expect(
      ProviderConfigUpdate.safeParse(withBaseUrl("http://proxy.example/v1"))
        .success,
    ).toBe(false);
    expect(
      ProviderConfigUpdate.safeParse(
        withBaseUrl("http://generativelanguage.googleapis.com/v1beta"),
      ).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdate.safeParse(withBaseUrl("https://proxy.example/v1"))
        .success,
    ).toBe(true);
  });

  it("rejects obvious internal targets at the schema layer", () => {
    for (const baseUrl of [
      "https://localhost/v1",
      "https://127.0.0.1:8080/v1",
      "https://10.1.2.3/v1",
      "https://172.16.0.1/v1",
      "https://172.31.0.1/v1",
      "https://192.168.0.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.internal/v1",
      "https://files.local/v1",
      "https://[::1]/v1",
    ]) {
      expect(
        ProviderConfigUpdate.safeParse(withBaseUrl(baseUrl)).success,
        baseUrl,
      ).toBe(false);
    }
  });

  it("accepts the Google host and ordinary public hosts", () => {
    for (const baseUrl of [
      "https://generativelanguage.googleapis.com/v1beta",
      "https://europe-west4-aiplatform.googleapis.com/v1",
      "https://proxy.example/v1",
    ]) {
      expect(
        ProviderConfigUpdate.safeParse(withBaseUrl(baseUrl)).success,
        baseUrl,
      ).toBe(true);
    }
  });

  it("does not confuse public and internal addresses (172.32 is public)", () => {
    expect(
      ProviderConfigUpdate.safeParse(withBaseUrl("https://172.32.0.1/v1"))
        .success,
    ).toBe(true);
  });
});