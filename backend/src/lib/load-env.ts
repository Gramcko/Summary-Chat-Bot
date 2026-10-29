import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Loads the repository-root `.env` (see `.env.example`) into the process
 * environment without overriding variables that are already set. This is
 * what makes the documented "copy .env.example to .env" workflow real:
 * every backend entry point (server, migrate, reset-password) calls this
 * before reading configuration.
 *
 * npm scripts run with cwd=backend/ while `.env` lives at the repository
 * root, so the file is found by walking up from the working directory
 * (the first `.env` found wins). Zero dependencies: Node's built-in
 * `process.loadEnvFile` (Node >= 20.12).
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
