import { Pool } from "pg";
import { buildApp } from "./app.js";
import { parseEncryptionKey } from "./lib/crypto.js";
import { loadRepoEnv } from "./lib/load-env.js";
import { PostgresStore } from "./lib/postgres-store.js";

// Load the repository-root .env (see .env.example) before any
// configuration is read. Shell-exported variables win over the file.
loadRepoEnv();

const port = Number(process.env["PORT"] ?? 3000);
// Safe default: bind to loopback only. Containers set HOST=0.0.0.0.
const host = process.env["HOST"] ?? "127.0.0.1";

/**
 * Reverse proxies whose X-Forwarded-For header is trusted for client-IP
 * derivation (rate limiting). Default: loopback only, which covers the
 * dashboard's local Next.js proxy. Never add an untrusted address here —
 * it would let clients pick their own lockout bucket.
 */
function parseTrustedProxies(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (value === undefined || value === "") return ["127.0.0.1", "::1"];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Fail fast at startup with an actionable message (never echoing secrets). */
function fail(message: string): never {
  console.error(`[summarly-backend] ${message}`);
  process.exit(1);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    return fail(
      "DATABASE_URL is required. Copy .env.example to .env at the repository " +
        "root (it is loaded automatically) or export it in the environment " +
        "(docker-compose.dev.yml provides a local PostgreSQL).",
    );
  }
  return databaseUrl;
}

function requireEncryptionKey(): Buffer {
  try {
    return parseEncryptionKey(process.env["ENCRYPTION_KEY"]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid ENCRYPTION_KEY.");
  }
}

const pool = new Pool({ connectionString: requireDatabaseUrl() });
// Log only the driver message; never query parameters or credentials.
pool.on("error", (error) => {
  console.error(`[summarly-backend] database pool error: ${error.message}`);
});

const app = await buildApp({
  store: new PostgresStore(pool, requireEncryptionKey()),
  cookieSecure: process.env["COOKIE_SECURE"] === "true",
  logger: process.env["NODE_ENV"] !== "test",
  trustProxy: parseTrustedProxies(process.env["TRUSTED_PROXIES"]),
});

await app.listen({ port, host });

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await app.close();
        await pool.end();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();
  });
}
