import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Loads the repository-root `.env` (see `.env.example`) into the process
 * environment without overriding variables that are already set. This is
 * what makes the documented "copy .env.example to .env" workflow real.
 *
 * Copied from backend/src/lib/load-env.ts on purpose: the worker is an
 * independent service and must not import from @summarly/backend
 * (architecture §4.4 — the worker has its own PostgreSQL access layer).
 *
 * npm scripts run with cwd=summary-worker/ while `.env` lives at the
 * repository root, so the file is found by walking up from the working
 * directory (the first `.env` found wins). Zero dependencies: Node's
 * built-in `process.loadEnvFile` (Node >= 20.12).
 */
export function loadRepoEnv(): void {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(
      "Loading .env files requires Node.js >= 20.12 (process.loadEnvFile). " +
        "Upgrade Node.js or export the variables yourself.",
    );
  }
  let dir = resolve(process.cwd());
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return; // No .env anywhere up the tree: rely on the real environment.
    dir = parent;
  }
}
