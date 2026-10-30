import { Redis } from "ioredis";
import { Pool } from "pg";
import {
  MOCK_MODEL_NAME,
  MOCK_PROVIDER_NAME,
  MockAiProvider,
} from "./ai/mock-provider.js";
import { PostgresWorkerDb } from "./db.js";
import { loadRepoEnv } from "./lib/load-env.js";
import { createLogger } from "./lib/log.js";
import {
  createSummaryWorker,
  parseConcurrency,
} from "./worker.js";
import {
  parseQueuePrefix,
  SUMMARY_JOB,
  SUMMARY_QUEUE,
} from "@summarly/contracts";

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
try {
  concurrency = parseConcurrency(process.env["SUMMARY_CONCURRENCY"]);
  queuePrefix = parseQueuePrefix(process.env["SUMMARY_QUEUE_PREFIX"]);
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
// The deterministic mock adapter is the only provider shipped in this
// milestone (architecture A7: mock for tests first). Real provider
// adapters plug into the same AiProvider interface later.
const provider = new MockAiProvider();

const worker = createSummaryWorker({
  connection: redis,
  db,
  provider,
  providerName: MOCK_PROVIDER_NAME,
  modelName: MOCK_MODEL_NAME,
  concurrency,
  prefix: queuePrefix,
  log,
});

log("warn", "mock_provider_active", {
  provider: MOCK_PROVIDER_NAME,
  model: MOCK_MODEL_NAME,
  note:
    "No real AI provider is configured yet: summaries are produced by the " +
    "deterministic mock adapter.",
});
log("info", "worker_started", {
  queue: SUMMARY_QUEUE,
  job: SUMMARY_JOB,
  queuePrefix,
  concurrency,
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
