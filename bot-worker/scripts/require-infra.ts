/**
 * Preflight for `npm run test:integration` (bot-worker): the integration
 * suite needs a reachable PostgreSQL with the application schema. This
 * fails fast with instructions when DATABASE_URL is missing, the
 * database is unreachable, does not look like a throwaway test database
 * (DEF-2), or has no schema yet — instead of silently skipping (mirror
 * of summary-worker/scripts/require-infra.ts, minus Redis: bot-worker
 * writes directly to PostgreSQL and never touches the queue).
 *
 * Running `vitest run` directly without DATABASE_URL skips the
 * integration suite with a loud warning; this preflight is what turns
 * "integration requested" into "integration guaranteed or failed".
 */
import { Client } from "pg";
import {
  assertTestDatabaseName,
  TEST_DB_CONFIRM_VAR,
} from "./test-db-guard.js";

const INSTRUCTIONS = [
  "bot-worker integration tests need PostgreSQL (the suite TRUNCATEs every application table):",
  "  1. docker compose -f docker-compose.dev.yml up -d        (PostgreSQL)",
  "  2. createdb summarly_bot_test        (or: psql -c 'CREATE DATABASE summarly_bot_test')",
  "  3. npm run migrate -w @summarly/backend up   (with DATABASE_URL pointing at it)",
  "  4. DATABASE_URL=postgres://summarly:summarly_dev_password@127.0.0.1:5432/summarly_bot_test \\",
  "     npm run test:integration -w @summarly/bot-worker",
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
      "SELECT to_regclass('public.messages') AS regclass",
    );
    if (schema.rows[0]?.regclass == null) {
      fail(
        `database "${name}" has no messages table — run the migrations first ` +
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
}

await main();
