import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_GOOGLE_GEMINI,
  DEFAULT_GEMINI_MODEL,
} from "@summarly/contracts";
import {
  classifyProviderBaseUrl,
  createProviderResolver,
  isMockProviderName,
  providerNeedsApiKey,
  startupProviderStatus,
  type ProviderResolverOptions,
} from "../src/ai/resolve-provider.js";
import { GeminiProvider } from "../src/ai/gemini-provider.js";
import {
  MockAiProvider,
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
} from "../src/ai/mock-provider.js";
import {
  CryptoError,
  encryptSecret,
} from "../src/lib/crypto.js";
import { isPermanentFailure, PermanentRunError, RetryableRunError } from "../src/errors.js";
import { PROVIDER_ERROR_MESSAGES } from "../src/ai/provider-errors.js";
import type { StoredProviderConfig } from "../src/db.js";

/**
 * Provider selection from the saved ai_provider_configs row (ADR 0005,
 * deliverable 5): mock by default, google-gemini with a decrypted key,
 * permanent provider_config for anything unreadable or unknown.
 */

const MASTER_KEY = randomBytes(32);
const API_KEY = "AIza-FAKE-KEY-for-tests";

function config(
  overrides?: Partial<StoredProviderConfig>,
): StoredProviderConfig {
  return {
    provider: AI_PROVIDER_GOOGLE_GEMINI,
    model: "gemini-3.8-flash",
    baseUrl: null,
    apiKeyEncrypted: encryptSecret(MASTER_KEY, API_KEY),
    ...overrides,
  };
}

function makeResolver(
  saved: StoredProviderConfig | undefined,
  overrides?: Partial<Omit<ProviderResolverOptions, "db">>,
) {
  const logs: Array<{ level: string; event: string; fields: unknown }> = [];
  let loadCalls = 0;
  const resolver = createProviderResolver({
    db: {
      loadProviderConfig: async () => {
        loadCalls += 1;
        return saved;
      },
    },
    getEncryptionKey: () => MASTER_KEY,
    // Logger signature: (level, event, fields).
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...overrides,
  });
  return { resolver, logs, loadCalls: () => loadCalls };
}

describe("provider-name helpers", () => {
  it("treats empty and `mock` as the mock adapter", () => {
    expect(isMockProviderName("")).toBe(true);
    expect(isMockProviderName("mock")).toBe(true);
    expect(isMockProviderName(" MOCK ")).toBe(true);
    expect(isMockProviderName("google-gemini")).toBe(false);
  });

  it("only google-gemini needs an API key", () => {
    expect(providerNeedsApiKey("google-gemini")).toBe(true);
    expect(providerNeedsApiKey("mock")).toBe(false);
  });
});

describe("createProviderResolver (adapter selection)", () => {
  it("returns the mock adapter when no config is saved", async () => {
    const { resolver, logs } = makeResolver(undefined);
    const resolved = await resolver();
    expect(resolved.provider).toBeInstanceOf(MockAiProvider);
    expect(resolved.providerName).toBe(MOCK_PROVIDER_NAME);
    expect(resolved.modelName).toBe(MOCK_MODEL_NAME);
    // The loud mock warning is preserved (deliverable 5).
    expect(logs.some((entry) => entry.event === "mock_provider_active")).toBe(
      true,
    );
  });

  it("returns the mock adapter for provider `mock`", async () => {
    const { resolver } = makeResolver(config({ provider: "mock" }));
    const resolved = await resolver();
    expect(resolved.provider).toBeInstanceOf(MockAiProvider);
  });

  it("never touches the encryption key on the mock path", async () => {
    const { resolver } = makeResolver(undefined, {
      getEncryptionKey: () => {
        throw new CryptoError("ENCRYPTION_KEY must not be read for mock runs");
      },
    });
    const resolved = await resolver();
    expect(resolved.provider).toBeInstanceOf(MockAiProvider);
  });

  it("builds the Gemini adapter with the DECRYPTED key and saved model", async () => {
    const { resolver } = makeResolver(config());
    const resolved = await resolver();
    expect(resolved.provider).toBeInstanceOf(GeminiProvider);
    expect(resolved.providerName).toBe(AI_PROVIDER_GOOGLE_GEMINI);
    expect(resolved.modelName).toBe("gemini-3.8-flash");
    // The decrypted key actually reaches the adapter: prove it round-trips
    // through a stubbed call's auth header.
    const headersSeen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string>);
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const withFetch = makeResolver(config(), { fetchImpl });
    await (await withFetch.resolver()).provider.generate({
      groupName: "g",
      period: {
        start: "2026-10-28T00:00:00Z",
        end: "2026-10-29T00:00:00Z",
        timezone: "Europe/Madrid",
      },
      messages: [],
    }).catch(() => undefined);
    expect(headersSeen[0]?.["x-goog-api-key"]).toBe(API_KEY);
  });

  it("falls back to the verified default model when the config is empty", async () => {
    const { resolver } = makeResolver(config({ model: "  " }));
    const resolved = await resolver();
    expect(resolved.modelName).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("fails the run permanently when the saved key cannot be decrypted", async () => {
    // Wrong master key -> CryptoError internally -> FIXED provider_config.
    const { resolver, logs } = makeResolver(config(), {
      getEncryptionKey: () => Buffer.alloc(32, 7),
    });
    const error = await resolver().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(PermanentRunError);
    expect(error?.code).toBe("provider_config");
    expect(error?.message).toBe(PROVIDER_ERROR_MESSAGES.provider_config);
    // The CryptoError text never leaks; the safe log names the cause.
    expect(error?.message).not.toContain("authentication");
    expect(
      logs.some(
        (entry) =>
          entry.event === "provider_config_rejected" &&
          JSON.stringify(entry.fields).includes("credentials_unreadable"),
      ),
    ).toBe(true);
  });

  it("fails the run permanently when no key is saved for a real provider", async () => {
    const { resolver } = makeResolver(config({ apiKeyEncrypted: null }));
    const error = await resolver().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(PermanentRunError);
    expect(error?.code).toBe("provider_config");
    expect(error?.message).toBe(PROVIDER_ERROR_MESSAGES.provider_config);
  });

  it("fails the run permanently for an unknown provider name", async () => {
    const { resolver, logs } = makeResolver(config({ provider: "acme-ai" }));
    const error = await resolver().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(PermanentRunError);
    expect(error?.code).toBe("provider_config");
    expect(
      logs.some((entry) => JSON.stringify(entry.fields).includes("unknown_provider")),
    ).toBe(true);
  });

  it("classifies a config row that violates the contract as permanent", async () => {
    // Simulate the row-level contract failure (ZodError) via a stub db.
    const { ZodError } = await import("zod");
    const broken = createProviderResolver({
      db: {
        loadProviderConfig: async () => {
          throw new ZodError([]);
        },
      },
      getEncryptionKey: () => MASTER_KEY,
    });
    const error = await broken().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(PermanentRunError);
    expect(error?.code).toBe("provider_config");
  });

  it("treats a transient config-read failure as retryable", async () => {
    const broken = createProviderResolver({
      db: {
        loadProviderConfig: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
      },
      getEncryptionKey: () => MASTER_KEY,
    });
    const error = await broken().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(RetryableRunError);
    expect(isPermanentFailure(error)).toBe(false);
    expect(error?.code).toBe("db_unavailable");
  });
});

describe("base-URL policy (audit E-2: credential-bearing endpoint)", () => {
  function resolveWithBaseUrl(
    baseUrl: string | null,
    allowCustomBaseUrl: boolean,
  ) {
    return makeResolver(config({ baseUrl }), {
      allowCustomBaseUrl,
      fetchImpl: (async (url: string | URL | Request) => {
        return new Response("{}", { status: 500, headers: {} });
        void url;
      }) as typeof fetch,
    }).resolver();
  }

  it("allows the Google host without any opt-in", async () => {
    const resolved = await resolveWithBaseUrl(
      "https://generativelanguage.googleapis.com/v1beta",
      false,
    );
    expect(resolved.providerName).toBe(AI_PROVIDER_GOOGLE_GEMINI);
    expect(classifyProviderBaseUrl("https://x.googleapis.com/v1", false)).toBe(
      "google",
    );
  });

  it("rejects http even for Google hosts (https-only, always)", async () => {
    const error = await resolveWithBaseUrl(
      "http://generativelanguage.googleapis.com/v1beta",
      false,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error?.code).toBe("provider_config");
    expect(isPermanentFailure(error)).toBe(true);
  });

  it("rejects a custom host without the privileged opt-in", async () => {
    const { resolver, logs } = makeResolver(
      config({ baseUrl: "https://proxy.example/v1beta" }),
    );
    const error = await resolver().then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error?.code).toBe("provider_config");
    expect(
      logs.some((entry) => JSON.stringify(entry.fields).includes("base_url_not_allowed")),
    ).toBe(true);
  });

  it("honors a custom host WITH the privileged opt-in", async () => {
    const seen: string[] = [];
    const resolved = makeResolver(config({ baseUrl: "https://proxy.example/v1beta" }), {
      allowCustomBaseUrl: true,
      fetchImpl: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    }).resolver().then((r) => r);
    const resolution = await resolved;
    expect(resolution.providerName).toBe(AI_PROVIDER_GOOGLE_GEMINI);
    await resolution.provider.generate({
      groupName: "g",
      period: {
        start: "2026-10-28T00:00:00Z",
        end: "2026-10-29T00:00:00Z",
        timezone: "Europe/Madrid",
      },
      messages: [],
    }).catch(() => undefined);
    expect(seen[0]).toContain("https://proxy.example/v1beta/models/");
  });

  it("rejects internal targets EVEN with the privileged opt-in", async () => {
    for (const baseUrl of [
      "https://localhost/v1beta",
      "https://127.0.0.1/v1beta",
      "https://10.0.0.5/v1beta",
      "https://172.16.0.1/v1beta",
      "https://172.31.255.255/v1beta",
      "https://192.168.1.10/v1beta",
      "https://169.254.1.1/v1beta",
      "https://app.internal/v1beta",
      "https://db.local/v1beta",
      "https://[::1]/v1beta",
    ]) {
      expect(() => classifyProviderBaseUrl(baseUrl, true), baseUrl).toThrow(
        /provider configuration/i,
      );
    }
    // And the resolver enforces the same rule end to end.
    const error = await resolveWithBaseUrl(
      "https://127.0.0.1:8080/v1beta",
      true,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error?.code).toBe("provider_config");
  });
});

describe("startupProviderStatus (review m4)", () => {
  it("rejects a saved-but-UNKNOWN provider name loudly (name only)", () => {
    expect(startupProviderStatus(config({ provider: "acme-ai" }))).toEqual({
      kind: "rejected",
      provider: "acme-ai",
    });
  });

  it("classifies mock and google-gemini", () => {
    expect(startupProviderStatus(undefined)).toEqual({ kind: "mock" });
    expect(startupProviderStatus(config({ provider: "mock" }))).toEqual({
      kind: "mock",
    });
    expect(startupProviderStatus(config())).toEqual({
      kind: "configured",
      provider: AI_PROVIDER_GOOGLE_GEMINI,
      model: "gemini-3.8-flash",
    });
    // Empty model falls back to the verified default id.
    expect(
      startupProviderStatus(config({ model: " " })),
    ).toEqual({
      kind: "configured",
      provider: AI_PROVIDER_GOOGLE_GEMINI,
      model: DEFAULT_GEMINI_MODEL,
    });
  });
});