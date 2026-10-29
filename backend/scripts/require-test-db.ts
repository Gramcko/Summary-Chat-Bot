/**
 * Preflight for `npm run test:integration` (DEF-3): runs the backend suite
 * with DATABASE_URL REQUIRED — when it is missing, unreachable, or points
 * at a database that does not look like a throwaway test database
 * (DEF-2), this fails fast with instructions instead of silently
 * skipping the PostgreSQL integration tests.
 */
import { Client } from "pg";
import { assertTestDatabaseName, TEST_DB_CONFIRM_VAR } from "./test-db-guard.js";

const INSTRUCTIONS = [
  "PostgreSQL integration tests need a throwaway database (the suite TRUNCATES every application table):",
  "  1. docker compose -f docker-compose.dev.yml up -d",
  "  2. createdb summarly_test        (or: psql -c 'CREATE DATABASE summarly_test')",
  "  3. npm run migrate -w @summarly/backend up   (with DATABASE_URL pointing at it)",
  "  4. DATABASE_URL=postgres://summarly:summarly_dev_password@127.0.0.1:5432/summarly_test npm run test:integration",
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
    console.log(
      overrideActive
        ? `[test:integration] guard overridden by ${TEST_DB_CONFIRM_VAR} — running against "${name}".`
        : `[test:integration] database "${name}" looks like a test database — running the suite.`,
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
