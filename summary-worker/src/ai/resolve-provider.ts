import {
  AI_PROVIDER_GOOGLE_GEMINI,
  AI_PROVIDER_MOCK,
  DEFAULT_GEMINI_MODEL,
} from "@summarly/contracts";
import { ZodError } from "zod";
import type { AiProvider } from "@summarly/contracts";
import type { StoredProviderConfig, WorkerDb } from "../db.js";
import { RetryableRunError } from "../errors.js";
import { decryptSecret } from "../lib/crypto.js";
import type { Logger } from "../lib/log.js";
import { GeminiProvider } from "./gemini-provider.js";
import { providerError } from "./provider-errors.js";
import {
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
  MockAiProvider,
} from "./mock-provider.js";

/**
 * Adapter selection from the saved `ai_provider_configs` row (ADR 0005,
 * deliverable 5):
 *
 * - no config, or provider `mock`/empty -> deterministic mock adapter
 *   (the default; tests and unconfigured installs keep working with no
 *   ENCRYPTION_KEY);
 * - provider `google-gemini` -> the Gemini REST adapter with the saved
 *   model (default `gemini-3.8-flash`) and the DECRYPTED API key;
 * - anything else -> the run fails permanently with `provider_config`
 *   (fixed message): an unknown provider must never be guessed at.
 *
 * Error classification at this boundary:
 * - unreadable stored key (CryptoError), unknown provider, missing key
 *   -> permanent `provider_config` (retrying cannot fix config);
 * - a transient failure READING the config row -> retryable
 *   `db_unavailable` (a database blip must not fail the run forever).
 * All messages are FIXED (audit L1) — CryptoError text never leaves
 * this module.
 */

/** What the pipeline needs to run: adapter plus persisted identity. */
export interface ProviderResolution {
  provider: AiProvider;
  providerName: string;
  modelName: string;
}

export interface ProviderResolverOptions {
  db: Pick<WorkerDb, "loadProviderConfig">;
  /**
   * Lazily provides the parsed ENCRYPTION_KEY. Throws CryptoError when
   * the variable is missing or malformed. Lazy so mock-only installs
   * never need the key (the deliverable's env rule).
   */
  getEncryptionKey: () => Buffer;
  /** Injectable fetch for the Gemini adapter (tests). */
  fetchImpl?: typeof fetch;
  /** Bounded provider request timeout (ms). */
  requestTimeoutMs?: number;
  /**
   * Privileged opt-in (env AI_ALLOW_CUSTOM_BASE_URL=yes): allows a
   * saved base URL on a NON-Google host. The API key is sent there —
   * treat enabling this as granting that host your credentials (ADR
   * 0005). Internal targets stay rejected regardless.
   */
  allowCustomBaseUrl?: boolean;
  log?: Logger;
}

/** True when this provider name selects the deterministic mock. */
export function isMockProviderName(provider: string): boolean {
  const name = provider.trim().toLowerCase();
  return name === "" || name === AI_PROVIDER_MOCK;
}

/** True when this provider name needs a decrypted API key. */
export function providerNeedsApiKey(provider: string): boolean {
  return provider.trim().toLowerCase() === AI_PROVIDER_GOOGLE_GEMINI;
}

/** Hosts that may be used WITHOUT the AI_ALLOW_CUSTOM_BASE_URL opt-in. */
const GOOGLE_API_HOST_RE = /(^|\.)googleapis\.com$/i;

/** Same best-effort internal-target list as contracts/settings.ts (E-2). */
const INTERNAL_HOST_RE =
  /^(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|\[::1\]|.*\.(internal|local))$/i;

/**
 * Base-URL policy (audit E-2) at the credential-usage boundary. The
 * saved API key is sent as a header to this URL, so:
 *
 * - https is ALWAYS required;
 * - obvious internal targets (loopback, RFC1918, link-local,
 *   *.internal, *.local) are rejected even with the privileged flag —
 *   best-effort exfiltration/SSRF guard, not a security boundary;
 * - a custom (non-Google) host is honored only when the operator set
 *   AI_ALLOW_CUSTOM_BASE_URL=yes (privileged: the key leaves Google).
 *
 * Throws providerError("provider_config") (permanent, FIXED message)
 * for every violation. Returns "google" or "custom" for logging.
 */
export function classifyProviderBaseUrl(
  baseUrl: string,
  allowCustomBaseUrl: boolean,
): "google" | "custom" {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw providerError("provider_config");
  }
  if (url.protocol !== "https:") {
    throw providerError("provider_config");
  }
  if (INTERNAL_HOST_RE.test(url.hostname)) {
    // Rejected even with the privileged flag.
    throw providerError("provider_config");
  }
  if (GOOGLE_API_HOST_RE.test(url.hostname)) return "google";
  if (!allowCustomBaseUrl) {
    throw providerError("provider_config");
  }
  return "custom";
}

/**
 * Startup classification (review m4): what the entry point should log
 * for a saved config. A saved-but-UNKNOWN provider name is REJECTED
 * loudly (`provider_config_rejected`, name only) — never silently
 * "configured" (runs would fail later with the same fixed code).
 */
export function startupProviderStatus(
  config: StoredProviderConfig | undefined,
):
  | { kind: "mock" }
  | { kind: "configured"; provider: string; model: string }
  | { kind: "rejected"; provider: string } {
  if (config === undefined || isMockProviderName(config.provider)) {
    return { kind: "mock" };
  }
  const provider = config.provider.trim().toLowerCase();
  const model =
    config.model.trim() === "" ? DEFAULT_GEMINI_MODEL : config.model.trim();
  if (providerNeedsApiKey(config.provider)) {
    return { kind: "configured", provider, model };
  }
  return { kind: "rejected", provider };
}

/**
 * Builds the per-run provider resolver used by the pipeline. Called at
 * most once per run, after the run is marked `processing`, so config
 * changes take effect without a worker restart.
 */
export function createProviderResolver(
  options: ProviderResolverOptions,
): () => Promise<ProviderResolution> {
  let mockLogged = false;
  return async function resolveProvider(): Promise<ProviderResolution> {
    let config: StoredProviderConfig | undefined;
    try {
      config = await options.db.loadProviderConfig();
    } catch (error) {
      if (error instanceof ZodError) {
        // The stored row violates the contract: config defect.
        throw providerError("provider_config");
      }
      // Database blip: transient (AGENTS.md — retry with backoff).
      throw new RetryableRunError(
        "db_unavailable",
        "The AI provider configuration could not be read; the run will be retried.",
      );
    }

    if (config === undefined || isMockProviderName(config.provider)) {
      if (!mockLogged) {
        mockLogged = true;
        options.log?.("warn", "mock_provider_active", {
          provider: MOCK_PROVIDER_NAME,
          model: MOCK_MODEL_NAME,
          note:
            "No real AI provider is configured: summaries are produced by " +
            "the deterministic mock adapter (ADR 0005).",
        });
      }
      return {
        provider: new MockAiProvider(),
        providerName: MOCK_PROVIDER_NAME,
        modelName: MOCK_MODEL_NAME,
      };
    }

    const providerName = config.provider.trim().toLowerCase();
    if (providerNeedsApiKey(providerName)) {
      const encrypted = config.apiKeyEncrypted;
      if (encrypted === null || encrypted.trim() === "") {
        // Specific cause goes to the (content-free) ops log; the run
        // error carries the fixed per-code message (audit L1).
        options.log?.("warn", "provider_config_rejected", {
          reason: "missing_api_key",
          provider: providerName,
        });
        throw providerError("provider_config");
      }
      let apiKey: string;
      try {
        apiKey = decryptSecret(options.getEncryptionKey(), encrypted);
      } catch {
        // CryptoError (missing/invalid ENCRYPTION_KEY, corrupt or
        // tampered envelope): permanent config failure with a FIXED
        // message — the CryptoError text never propagates (audit L1).
        options.log?.("warn", "provider_config_rejected", {
          reason: "credentials_unreadable",
          provider: providerName,
        });
        throw providerError("provider_config");
      }
      // Base-URL policy (audit E-2): https only, Google hosts unless
      // the privileged AI_ALLOW_CUSTOM_BASE_URL opt-in is set, and no
      // obvious internal targets ever.
      let baseUrlKind: "google" | "custom" = "google";
      if (config.baseUrl !== null && config.baseUrl.trim() !== "") {
        try {
          baseUrlKind = classifyProviderBaseUrl(
            config.baseUrl,
            options.allowCustomBaseUrl === true,
          );
        } catch (error) {
          options.log?.("warn", "provider_config_rejected", {
            reason: "base_url_not_allowed",
            provider: providerName,
          });
          throw error;
        }
        if (baseUrlKind === "custom") {
          options.log?.("info", "provider_custom_base_url", {
            provider: providerName,
            note: "privileged AI_ALLOW_CUSTOM_BASE_URL is active; the API key is sent to a non-Google host",
          });
        }
      }
      return {
        provider: new GeminiProvider({
          apiKey,
          model: config.model.trim() === "" ? DEFAULT_GEMINI_MODEL : config.model,
          baseUrl: config.baseUrl ?? undefined,
          timeoutMs: options.requestTimeoutMs,
          fetchImpl: options.fetchImpl,
          log: options.log,
        }),
        providerName: AI_PROVIDER_GOOGLE_GEMINI,
        modelName:
          config.model.trim() === "" ? DEFAULT_GEMINI_MODEL : config.model.trim(),
      };
    }

    options.log?.("warn", "provider_config_rejected", {
      reason: "unknown_provider",
      provider: providerName,
    });
    throw providerError("provider_config");
  };
}
