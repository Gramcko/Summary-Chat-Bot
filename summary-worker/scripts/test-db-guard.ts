/**
 * Safety guard for destructive test setup (DEF-2, developer data safety).
 *
 * Copied from backend/scripts/test-db-guard.ts on purpose: the
 * summary-worker is an independent service and must not import from
 * @summarly/backend (architecture A4.4). Keep the two copies in sync.
 *
 * The summary-worker integration suite TRUNCATEs every application table
 * before each test. That is only ever safe against a throwaway database,
 * so destructive setup must refuse to run unless the connected database
 * is unmistakably a test database:
 *
 *   - its name ends in `_test`, or contains `_e2e_`, or
 *   - `SUMMARLY_TEST_DB_CONFIRM=yes` is set (explicit operator override).
 *
 * Anything else (a development or production database named e.g.
 * "summarly") is refused with an actionable error BEFORE any destructive
 * statement runs. Used by tests/worker-integration.test.ts (before the
 * first TRUNCATE) and by the `npm run test:integration` preflight.
 */
export const TEST_DB_CONFIRM_VAR = "SUMMARLY_TEST_DB_CONFIRM";

/** Throwaway test database names: `*_test` or anything containing `_e2e_`. */
export const TEST_DB_NAME_PATTERN = /_test$|_e2e_/i;

export function isTestDatabaseName(databaseName: string): boolean {
  return TEST_DB_NAME_PATTERN.test(databaseName);
}

/**
 * Throws unless `databaseName` looks like a throwaway test database (or
 * the override variable is exactly "yes").
 */
export function assertTestDatabaseName(
  databaseName: string,
  override: string | undefined = process.env[TEST_DB_CONFIRM_VAR],
): void {
  if (override === "yes") {
    // Loud, unconditional warning (F3): the override disables the safety
    // guard and destructive statements WILL run against this database.
    process.stderr.write(
      `[summarly] WARNING: ${TEST_DB_CONFIRM_VAR}=yes — the test-database guard is ` +
        `DISABLED. Destructive test setup (TRUNCATE of all application tables) will run ` +
        `against database "${databaseName}".\n`,
    );
    return;
  }
  if (!isTestDatabaseName(databaseName)) {
    throw new Error(
      `refusing destructive test setup against database "${databaseName}": its name does ` +
        `not look like a throwaway test database (expected a name ending in "_test" or ` +
        `containing "_e2e_"). The suite TRUNCATES every application table. Create a ` +
        `throwaway database (for example: createdb summarly_test) and point DATABASE_URL ` +
        `at it, or set ${TEST_DB_CONFIRM_VAR}=yes to override at your own risk.`,
    );
  }
}
