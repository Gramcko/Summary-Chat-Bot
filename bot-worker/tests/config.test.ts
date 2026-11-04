import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ensureSessionStorage,
  findRepoRoot,
  isInsideRoot,
  loadConfig,
} from "../src/config.js";

/**
 * Session-storage safety (audit M1/M2, CR-m3):
 * - relative WA_SESSION_DIR values resolve against the REPOSITORY ROOT
 * - session directories inside the repository working tree are refused
 *   unless WA_SESSION_ALLOW_INSECURE=yes (explicit escape hatch)
 * - permission hardening is verified, not silently best-effort: win32
 *   refuses unless acknowledged; POSIX enforces owner-only mode
 * - error messages never contain the path
 */

const REPO_ROOT = findRepoRoot();
if (REPO_ROOT === null) {
  throw new Error("tests must run inside the repository");
}
const SECRET_DIR_NAME = "super-secret-session-dir-name";
const OUTSIDE = mkdtempSync(join(tmpdir(), "summarly-wa-"));
const BASE_ENV = { DATABASE_URL: "postgres://localhost/test" };

describe("loadConfig: session directory resolution and containment", () => {
  it("resolves explicit relative values against the repository root", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_DIR: "custom-wa-session",
      WA_SESSION_ALLOW_INSECURE: "yes",
    });
    expect(config.sessionDir).toBe(resolve(REPO_ROOT, "custom-wa-session"));
  });

  it("defaults to <repo root>/wa-session", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
    });
    expect(config.sessionDir).toBe(resolve(REPO_ROOT, "wa-session"));
  });

  it("refuses session directories inside the repository working tree", () => {
    const inside = join(REPO_ROOT, SECRET_DIR_NAME);
    let error: unknown;
    try {
      loadConfig({ ...BASE_ENV, WA_SESSION_DIR: inside });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("WA_SESSION_ALLOW_INSECURE");
    // The path itself must never appear in the error (ADR 0004).
    expect(message).not.toContain(SECRET_DIR_NAME);
  });

  it("refuses the in-tree default without the explicit escape hatch", () => {
    expect(() => loadConfig({ ...BASE_ENV })).toThrow(ConfigError);
  });

  it("allows in-tree storage with WA_SESSION_ALLOW_INSECURE=yes", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_DIR: join(REPO_ROOT, SECRET_DIR_NAME),
      WA_SESSION_ALLOW_INSECURE: "yes",
    });
    expect(config.allowInsecureSessionStorage).toBe(true);
  });

  it("accepts out-of-tree paths without the hatch", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_DIR: join(OUTSIDE, "wa-session"),
    });
    expect(config.sessionDir).toBe(join(OUTSIDE, "wa-session"));
  });

  it("validates the remaining values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        DEFAULT_GROUP_TIMEZONE: "Not/AZone",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...BASE_ENV, WA_SESSION_ALLOW_INSECURE: "yes", WA_LINKING_DISPLAY: "sometimes" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...BASE_ENV, WA_SESSION_ALLOW_INSECURE: "yes", LOG_LEVEL: "loud" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...BASE_ENV, WA_SESSION_ALLOW_INSECURE: "yes", WA_PHONE_NUMBER: "abc" }),
    ).toThrow(ConfigError);
  });
});

describe("loadConfig: history-import budgets (ADR 0007)", () => {
  it("uses the documented defaults", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
    });
    expect(config.historyImport).toEqual({
      pollMs: 5000,
      batchCount: 100,
      maxRounds: 20,
      maxMessages: 2000,
      timeBudgetMs: 120000,
    });
  });

  it("parses overrides and floors the poll interval at 1000ms", () => {
    const config = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
      HISTORY_IMPORT_POLL_MS: "500",
      HISTORY_IMPORT_BATCH_COUNT: "25",
      HISTORY_IMPORT_MAX_ROUNDS: "5",
      HISTORY_IMPORT_MAX_MESSAGES: "600",
      HISTORY_IMPORT_TIME_BUDGET_MS: "30000",
    });
    expect(config.historyImport).toEqual({
      pollMs: 1000,
      batchCount: 25,
      maxRounds: 5,
      maxMessages: 600,
      timeBudgetMs: 30000,
    });
  });

  it("rejects invalid budget values", () => {
    const withEnv = (name: string, value: string) => () =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        [name]: value,
      });
    expect(withEnv("HISTORY_IMPORT_MAX_ROUNDS", "many")).toThrow(ConfigError);
    expect(withEnv("HISTORY_IMPORT_BATCH_COUNT", "0")).toThrow(ConfigError);
    expect(withEnv("HISTORY_IMPORT_TIME_BUDGET_MS", "-5")).toThrow(ConfigError);
  });

  it("enforces the effort bounds (SA-L1)", () => {
    const withEnv = (name: string, value: string) => () =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        [name]: value,
      });
    expect(withEnv("HISTORY_IMPORT_BATCH_COUNT", "501")).toThrow(/between 1 and 500/);
    expect(withEnv("HISTORY_IMPORT_MAX_ROUNDS", "101")).toThrow(/between 1 and 100/);
    expect(withEnv("HISTORY_IMPORT_MAX_MESSAGES", "20001")).toThrow(
      /between 1 and 20000/,
    );
  });

  it("enforces the staleness invariant (SA-L1)", () => {
    // timeBudget (580000) + roundTimeout (30000) would reach the stale
    // threshold (600000): fail fast with a clear message.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        HISTORY_IMPORT_TIME_BUDGET_MS: "580000",
      }),
    ).toThrow(/staleness invariant/);
    // 500000 + 30000 < 600000: fine.
    const ok = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
      HISTORY_IMPORT_TIME_BUDGET_MS: "500000",
    });
    expect(ok.historyImport.timeBudgetMs).toBe(500000);
  });
});

describe("loadConfig: session-control poll (ADR 0008)", () => {
  it("defaults to 3000ms and floors at 1000ms", () => {
    const defaults = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
    });
    expect(defaults.sessionControlPollMs).toBe(3000);

    const floored = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
      SESSION_CONTROL_POLL_MS: "500",
    });
    expect(floored.sessionControlPollMs).toBe(1000);

    const custom = loadConfig({
      ...BASE_ENV,
      WA_SESSION_ALLOW_INSECURE: "yes",
      SESSION_CONTROL_POLL_MS: "7000",
    });
    expect(custom.sessionControlPollMs).toBe(7000);
  });

  it("rejects invalid values", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        SESSION_CONTROL_POLL_MS: "often",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        WA_SESSION_ALLOW_INSECURE: "yes",
        SESSION_CONTROL_POLL_MS: "0",
      }),
    ).toThrow(ConfigError);
  });
});

describe("isInsideRoot", () => {
  it("detects the root itself and nested paths", () => {
    expect(isInsideRoot(REPO_ROOT, REPO_ROOT)).toBe(true);
    expect(isInsideRoot(join(REPO_ROOT, "a", "b"), REPO_ROOT)).toBe(true);
    expect(isInsideRoot(join(REPO_ROOT, "..", "outside"), REPO_ROOT)).toBe(false);
    expect(isInsideRoot(OUTSIDE, REPO_ROOT)).toBe(false);
  });
});

describe("ensureSessionStorage: permission post-conditions", () => {
  it("refuses win32 unless explicitly acknowledged (NTFS ACLs unverifiable)", () => {
    const dir = join(OUTSIDE, "win32-session");
    let error: unknown;
    try {
      ensureSessionStorage(dir, { allowInsecure: false, platform: "win32" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("WA_SESSION_ALLOW_INSECURE");
    expect((error as Error).message).not.toContain(dir);

    // Explicit acknowledgment passes (the operator owns NTFS ACLs).
    expect(() =>
      ensureSessionStorage(dir, { allowInsecure: true, platform: "win32" }),
    ).not.toThrow();
  });

  it("creates the directory and verifies owner-only mode on POSIX", () => {
    const dir = join(OUTSIDE, "posix-session");
    // Note: the mode post-condition itself needs real POSIX permissions
    // and cannot be simulated on a Windows dev host — the win32 refusal
    // and the error paths above cover the guard logic here.
    if (process.platform === "win32") return;
    expect(() =>
      ensureSessionStorage(dir, { allowInsecure: false, platform: "linux" }),
    ).not.toThrow();
  });

  it("reports fs failures without leaking the path", () => {
    // A parent that is a plain file makes mkdir fail with an fs error.
    const filePath = join(OUTSIDE, "not-a-directory");
    writeFileSync(filePath, "x");
    const dir = join(filePath, "wa-session");
    let error: unknown;
    try {
      ensureSessionStorage(dir, { allowInsecure: true, platform: "linux" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("WA_SESSION_DIR");
    expect((error as Error).message).not.toContain(OUTSIDE);
  });
});
