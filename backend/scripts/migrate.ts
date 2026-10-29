/**
 * Migration entry point (node-pg-migrate CLI) with the repository-root
 * `.env` loaded first (M2). npm scripts run with cwd=backend/ while
 * `.env` lives at the repository root; this wrapper makes
 *
 *   npm run migrate -w @summarly/backend up|down
 *
 * behave exactly like the plain CLI (`--migrations-dir migrations` is
 * applied here) with the documented env workflow. The CLI binary is
 * spawned as a child process so its own arg parsing and exit codes are
 * preserved verbatim.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { loadRepoEnv } from "../src/lib/load-env.js";

loadRepoEnv();

const require = createRequire(import.meta.url);
// The package's "./bin/*" export maps to "./bin/*.js", so the specifier
// is given WITHOUT the extension.
const bin = require.resolve("node-pg-migrate/bin/node-pg-migrate");

const child = spawn(
  process.execPath,
  [bin, "--migrations-dir", "migrations", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

child.on("error", (error) => {
  console.error(`Failed to start node-pg-migrate: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
