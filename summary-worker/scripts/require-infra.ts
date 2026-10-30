/**
 * Preflight for `npm run test:integration` (summary-worker): the
 * integration suite needs BOTH PostgreSQL and Redis. This fails fast
 * with instructions when DATABASE_URL/REDIS_URL are missing, the
 * database is unreachable, does not look like a throwaway test database
 * (DEF-2), has no schema yet, or Redis is unreachable — instead of
 * silently skipping (mirror of backend/scripts/require-test-db.ts).
 *
 * Running `vitest run` directly without DATABASE_URL/REDIS_URL skips the
 * integration suite with a loud warning; this preflight is what turns
 * "integration requested" into "integration guaranteed or failed".
 */
import { Redis } from "ioredis";
import { Client } from "pg";
import {
  assertTestDatabaseName,
  TEST_DB_CONFIRM_VAR,
} from "./test-db-guard.js";

const INSTRUCTIONS = [
  "summary-worker integration tests need PostgreSQL AND Redis (the suite TRUNCATEs every application table):",
  "  1. docker compose -f docker-compose.dev.yml up -d        (PostgreSQL + Redis)",
  "  2. createdb summarly_test        (or: psql -c 'CREATE DATABASE summarly_test')",
  "  3. npm run migrate -w @summarly/backend up   (with DATABASE_URL pointing at it)",
  "  4. DATABASE_URL=postgres://summarly:summarly_dev_password@127.0.0.1:5432/summarly_test \\",
  "     REDIS_URL=redis://127.0.0.1:6379 npm run test:integration -w @summarly/summary-worker",
  `The suite refuses database names that do not end in "_test" or contain "_e2e_" (override: ${TEST_DB_CONFIRM_VAR}=yes).`,
].join("\n");

function fail(message: string): never {
  console.error(`[test:integration] ${message}`);
  console.error(INSTRUCTIONS);
  process.exit(1);
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    fail("DATABASE_URL is not set.");
  }
  const redisUrl = process.env["REDIS_URL"]?.trim();
  if (redisUrl === undefined || redisUrl === "") {
    fail("REDIS_URL is not set.");
  }

  // ---- PostgreSQL: reachable, throwaway name, schema present ----
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const result = await client.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const name = result.rows[0]?.name ?? "";
    const overrideActive = process.env[TEST_DB_CONFIRM_VAR] === "yes";
    // assertTestDatabaseName emits its own loud warning when overridden.
    assertTestDatabaseName(name);
    const schema = await client.query<{ regclass: string | null }>(
      "SELECT to_regclass('public.summary_runs') AS regclass",
    );
    if (schema.rows[0]?.regclass == null) {
      fail(
        `database "${name}" has no summary_runs table — run the migrations first ` +
          `(npm run migrate -w @summarly/backend up with DATABASE_URL pointing at it).`,
      );
    }
    console.log(
      overrideActive
        ? `[test:integration] guard overridden by ${TEST_DB_CONFIRM_VAR} — running against "${name}".`
        : `[test:integration] database "${name}" looks like a test database — schema present.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("refusing destructive test setup")) {
      fail(message);
    }
    fail(`cannot use DATABASE_URL: ${message}`);
  } finally {
    await client.end().catch(() => {});
  }

  // ---- Redis: reachable ----
  const redis = new Redis(redisUrl, {
    connectTimeout: 5000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    await redis.ping();
    console.log("[test:integration] Redis is reachable — running the suite.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot use REDIS_URL: ${message}`);
  } finally {
    redis.disconnect();
  }
}

await main();
