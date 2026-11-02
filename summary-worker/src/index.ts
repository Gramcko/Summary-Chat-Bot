import { Redis } from "ioredis";
import { Pool } from "pg";
import {
  SUMMARY_JOB,
  SUMMARY_QUEUE,
  parseQueuePrefix,
} from "@summarly/contracts";
import {
  createProviderResolver,
  startupProviderStatus,
} from "./ai/resolve-provider.js";
import {
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
  MockAiProvider,
} from "./ai/mock-provider.js";
import { PostgresWorkerDb } from "./db.js";
import { CryptoError, parseEncryptionKey } from "./lib/crypto.js";
import { loadRepoEnv } from "./lib/load-env.js";
import { createLogger } from "./lib/log.js";
import {
  DEFAULT_MAX_CHUNKS_PER_RUN,
  DEFAULT_MAX_MESSAGES_PER_RUN,
  parsePositiveEnvInt,
  type RunLimits,
} from "./pipeline.js";
import { DEFAULT_GEMINI_TIMEOUT_MS } from "./ai/gemini-provider.js";
import {
  createSummaryWorker,
  parseConcurrency,
} from "./worker.js";

/**
 * summary-worker entry point (architecture A4.4): consumes
 * `generate-summary` jobs from the BullMQ `summaries` queue, generates
 * validated summaries from PostgreSQL-backed messages, and records run
 * outcomes. Operational logs carry run/job identifiers only — never
 * message content, credentials, or session secrets (AGENTS.md).
 */

// Load the repository-root .env (see .env.example) before any
// configuration is read. Shell-exported variables win over the file.
loadRepoEnv();

const log = createLogger("summary-worker");

/** Fail fast at startup with an actionable message (never echoing secrets). */
function fail(message: string): never {
  log("error", "startup_failed", { message });
  process.exit(1);
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return fail(`${name} is required. ${hint}`);
  }
  return value;
}

const databaseUrl = requireEnv(
  "DATABASE_URL",
  "Copy .env.example to .env at the repository root (it is loaded " +
    "automatically) or export it in the environment (docker-compose.dev.yml " +
    "provides a local PostgreSQL).",
);
const redisUrl = requireEnv(
  "REDIS_URL",
  "Copy .env.example to .env at the repository root (it is loaded " +
    "automatically) or export it in the environment (docker-compose.dev.yml " +
    "provides a local Redis for BullMQ queue state).",
);

let concurrency: number;
let queuePrefix: string;
let limits: RunLimits;
let requestTimeoutMs: number;
try {
  concurrency = parseConcurrency(process.env["SUMMARY_CONCURRENCY"]);
  queuePrefix = parseQueuePrefix(process.env["SUMMARY_QUEUE_PREFIX"]);
  limits = {
    maxMessagesPerRun: parsePositiveEnvInt(
      "MAX_MESSAGES_PER_RUN",
      process.env["MAX_MESSAGES_PER_RUN"],
      DEFAULT_MAX_MESSAGES_PER_RUN,
    ),
    maxChunksPerRun: parsePositiveEnvInt(
      "MAX_CHUNKS_PER_RUN",
      process.env["MAX_CHUNKS_PER_RUN"],
      DEFAULT_MAX_CHUNKS_PER_RUN,
    ),
  };
  requestTimeoutMs = parsePositiveEnvInt(
    "AI_REQUEST_TIMEOUT_MS",
    process.env["AI_REQUEST_TIMEOUT_MS"],
    DEFAULT_GEMINI_TIMEOUT_MS,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : "Invalid configuration.");
}

const pool = new Pool({ connectionString: databaseUrl });
// Log only the driver message; never connection URLs or query parameters.
pool.on("error", (error) => {
  log("error", "database_pool_error", { reason: error.message.slice(0, 200) });
});

// maxRetriesPerRequest: null is required for BullMQ worker connections.
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on("error", (error) => {
  log("error", "redis_error", { reason: error.message.slice(0, 200) });
});

const db = new PostgresWorkerDb(pool);

// ENCRYPTION_KEY is required ONLY when a real AI provider is
// configured: its saved API key is stored AES-256-GCM encrypted
// (ADR 0005). Mock-only installs run without it. The key is parsed
// lazily, cached, and never logged (AGENTS.md).
let cachedEncryptionKey: Buffer | undefined;
const getEncryptionKey = (): Buffer => {
  if (cachedEncryptionKey === undefined) {
    cachedEncryptionKey = parseEncryptionKey(process.env["ENCRYPTION_KEY"]);
  }
  return cachedEncryptionKey;
};

// Adapter selection happens per run from ai_provider_configs (saved
// through the dashboard's settings screen), so config changes apply
// without a worker restart.
const resolveProvider = createProviderResolver({
  db,
  getEncryptionKey,
  requestTimeoutMs,
  // Privileged (audit E-2): only "yes" enables a custom base URL — the
  // saved API key is sent to that host. Internal targets stay rejected.
  allowCustomBaseUrl:
    process.env["AI_ALLOW_CUSTOM_BASE_URL"]?.trim().toLowerCase() === "yes",
  log,
});

// Startup configuration check: fail fast when a real provider is
// configured but its credentials cannot be read on this host. An
// unknown saved provider name is rejected LOUDLY here (review m4).
try {
  const config = await db.loadProviderConfig();
  const status = startupProviderStatus(config);
  if (status.kind === "mock") {
    log("warn", "mock_provider_active", {
      provider: MOCK_PROVIDER_NAME,
      model: MOCK_MODEL_NAME,
      note:
        "No real AI provider is configured: summaries are produced by the " +
        "deterministic mock adapter (ADR 0005).",
    });
  } else if (status.kind === "configured") {
    getEncryptionKey(); // throws when ENCRYPTION_KEY is missing/malformed
    log("info", "provider_configured", {
      provider: status.provider,
      model: status.model,
    });
  } else {
    // Saved-but-UNKNOWN provider name: surface it loudly (review m4)
    // instead of a silent "configured". Runs fail with the fixed
    // provider_config error; only the name is logged.
    log("warn", "provider_config_rejected", {
      reason: "unknown_provider",
      provider: status.provider,
    });
  }
} catch (error) {
  if (error instanceof CryptoError) {
    fail(
      "A real AI provider is configured but its saved credentials cannot " +
        `be decrypted: ${error.message}`,
    );
  }
  // The config row could not be read right now: keep starting — runs
  // resolve per job and surface provider_config/db_unavailable safely.
  log("warn", "provider_config_check_failed", {
    reason: error instanceof Error ? error.name : "unknown",
  });
}

const worker = createSummaryWorker({
  connection: redis,
  db,
  // Static fallback identity required by PipelineDeps; resolveProvider
  // overrides it on every run.
  provider: new MockAiProvider(),
  providerName: MOCK_PROVIDER_NAME,
  modelName: MOCK_MODEL_NAME,
  resolveProvider,
  limits,
  concurrency,
  prefix: queuePrefix,
  log,
});

log("info", "worker_started", {
  queue: SUMMARY_QUEUE,
  job: SUMMARY_JOB,
  queuePrefix,
  concurrency,
  maxMessagesPerRun: limits.maxMessagesPerRun,
  maxChunksPerRun: limits.maxChunksPerRun,
  // Truthful about where the retry policy lives (it is producer-side):
  // SUMMARY_RETRY_BASE_MS is read by the backend's queue producer, not
  // here — BullMQ stores attempts/backoff on the job at enqueue time.
  note:
    "Job retry/backoff policy is producer-side (summaryJobOptions in " +
    "@summarly/contracts, SUMMARY_RETRY_BASE_MS at enqueue time).",
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_started", { signal });
  let failed = false;
  // Order matters: stop consuming first (let in-flight jobs finish),
  // then the database pool, then Redis (architecture A6).
  try {
    await worker.close();
  } catch {
    failed = true;
  }
  try {
    await pool.end();
  } catch {
    failed = true;
  }
  try {
    await redis.quit();
  } catch {
    failed = true;
    try {
      redis.disconnect();
    } catch {
      // Already gone; nothing else to release.
    }
  }
  log(failed ? "error" : "info", "shutdown_complete", { signal, failed });
  process.exit(failed ? 1 : 0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
