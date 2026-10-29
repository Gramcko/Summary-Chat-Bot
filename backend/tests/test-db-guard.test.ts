import { describe, expect, it, vi } from "vitest";
import {
  assertTestDatabaseName,
  isTestDatabaseName,
  TEST_DB_CONFIRM_VAR,
} from "../scripts/test-db-guard.js";

/**
 * DEF-2: destructive test setup must refuse databases that do not look
 * like throwaway test databases. These tests run everywhere (no DB).
 */
describe("test database guard", () => {
  it("refuses database names that are not unmistakably test databases", () => {
    for (const name of [
      "summarly",
      "summarly_dev",
      "summarly-development",
      "production",
      "postgres",
      "my_testing_ground", // ends in "_ground", not "_test"
    ]) {
      expect(isTestDatabaseName(name), name).toBe(false);
      expect(() => assertTestDatabaseName(name, undefined), name).toThrow(
        /refusing destructive test setup/,
      );
    }
  });

  it("names the refused database and gives actionable instructions", () => {
    expect(() => assertTestDatabaseName("summarly", undefined)).toThrow(
      /"summarly"/,
    );
    expect(() => assertTestDatabaseName("summarly", undefined)).toThrow(
      /createdb|_test|_e2e_/,
    );
  });

  it("accepts throwaway test database names", () => {
    for (const name of [
      "summarly_test",
      "summarly_backend_test",
      "summarly_e2e_1761700000000_abc123",
      "app_E2E_1",
    ]) {
      expect(isTestDatabaseName(name), name).toBe(true);
      expect(() => assertTestDatabaseName(name, undefined), name).not.toThrow();
    }
  });

  it("only the explicit override allows a non-test database, and it warns loudly", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(() => assertTestDatabaseName("summarly", "yes")).not.toThrow();
      expect(stderr).toHaveBeenCalledTimes(1);
      const warning = String(stderr.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("SUMMARLY_TEST_DB_CONFIRM=yes");
      expect(warning).toContain("WARNING");
      expect(warning).toContain('"summarly"');
      stderr.mockClear();

      // Anything other than exactly "yes" is not an override (and warns nothing).
      expect(() => assertTestDatabaseName("summarly", "YES")).toThrow();
      expect(() => assertTestDatabaseName("summarly", "true")).toThrow();
      expect(() => assertTestDatabaseName("summarly", "")).toThrow();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(TEST_DB_CONFIRM_VAR).toBe("SUMMARLY_TEST_DB_CONFIRM");
  });
});
