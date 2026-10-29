#!/usr/bin/env node
/**
 * Reproducible end-to-end check for Summarly Chat Bot — the REAL system, not a
 * test double:
 *
 *   PostgreSQL 16 (docker compose) → migrations (node-pg-migrate) →
 *   Fastify backend (real DATABASE_URL + ENCRYPTION_KEY + TRUSTED_PROXIES) →
 *   Next.js dashboard (`next start`, /api/* rewritten to the backend)
 *
 * Every scenario drives the dashboard origin over HTTP with a real cookie jar,
 * so the Next.js proxy, the httpOnly session cookie, the standard error
 * envelope, and the rate limiter are all exercised together — the combination
 * that unit tests and the isolated dashboard smoke check cannot cover.
 *
 * Isolation: a throwaway database `summarly_e2e_<timestamp>_<rand>` is created
 * for the run, migrated, and dropped during teardown. The development database
 * is never touched (backend/tests/postgres-store.test.ts TRUNCATEs whatever
 * database it is pointed at — do not point it at data you care about).
 *
 * Usage:
 *   npm run test:e2e
 *
 * Environment:
 *   E2E_POSTGRES_URL     base PostgreSQL URL without a database name
 *                        (default: postgres://summarly:summarly_dev_password@127.0.0.1:5432)
 *   E2E_BACKEND_PORT     backend port (default 3000 — the dashboard build must
 *                        point at it; the script rebuilds if it does not)
 *   E2E_DASHBOARD_PORT   dashboard port (default 3100)
 *   E2E_SKIP_BUILD=1     never rebuild the dashboard (fails if the baked
 *                        BACKEND_URL does not match E2E_BACKEND_PORT)
 *   E2E_KEEP_DATABASE=1  keep the throwaway database for inspection
 *
 * Behaviour notes (deliberate, documented in the run output):
 *   - The login rate limiter is in-memory per backend process, so the
 *     rate-limit scenarios run last and restart the backend first to get a
 *     clean bucket. The restart also proves sessions survive a restart
 *     (registered state lives in PostgreSQL).
 *   - X-Forwarded-For through the dashboard proxy is observed, not "fixed":
 *     the observed result is reported as INFO, and the security implication is
 *     written to the summary for the reviewer.
 *   - Windows has no POSIX signals, so `child.kill()` terminates the servers
 *     instead of exercising the backend's graceful SIGTERM shutdown path.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = join(repoRoot, "dashboard");

// ---- configuration ------------------------------------------------------

const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 3000);
const dashboardPort = Number(process.env.E2E_DASHBOARD_PORT ?? 3100);
// A second backend instance used only to prove that X-Forwarded-For is ignored
// when the socket peer is NOT a trusted proxy (the primary instance must trust
// loopback, because the dashboard proxy connects from there).
const untrustedPeerBackendPort = backendPort + 901;
const postgresBaseUrl =
  process.env.E2E_POSTGRES_URL ??
  "postgres://summarly:summarly_dev_password@127.0.0.1:5432";
const skipBuild = process.env.E2E_SKIP_BUILD === "1";
const keepDatabase = process.env.E2E_KEEP_DATABASE === "1";

const databaseName = `summarly_e2e_${Date.now()}_${randomBytes(3).toString("hex")}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const untrustedPeerBackendUrl = `http://127.0.0.1:${untrustedPeerBackendPort}`;

// Fresh secrets per run. Test-only values, never real credentials.
const setupPassword = "correct-horse-battery-123";
const recoveredPassword = "recovered-battery-staple-91";
const rotatedPassword = "rotated-battery-staple-203";
const providerApiKey = `sk-e2e-${randomBytes(12).toString("hex")}`;
const encryptionKey = randomBytes(32).toString("base64");

const groupId = "0d3f6c2a-9b41-4c58-8f7e-2a6d5b8c1e42";
const unknownRunId = "1b9e4d7c-3a52-4e61-9c08-7f2d1a3b5c64";

const interval = {
  start: "2026-10-20T00:00:00.000Z",
  end: "2026-10-21T00:00:00.000Z",
  timezone: "Europe/Madrid",
};

// ---- reporting ----------------------------------------------------------

/** @type {{name: string, status: "PASS" | "FAIL" | "INFO", detail: string}[]} */
const results = [];

function progress(message) {
  console.log(message);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail: detail ?? "" });
  } catch (error) {
    results.push({
      name,
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function observe(name, detail) {
  results.push({ name, status: "INFO", detail });
}

function report() {
  console.log("");
  const width = Math.max(...results.map((entry) => entry.name.length), 4);
  for (const entry of results) {
    const detail =
      entry.detail === "" ? "" : `  ${entry.detail.replace(/\s+/g, " ").slice(0, 400)}`;
    console.log(`${entry.status}  ${entry.name.padEnd(width)}${detail}`);
  }
  const failed = results.filter((entry) => entry.status === "FAIL").length;
  const info = results.filter((entry) => entry.status === "INFO").length;
  console.log(
    `\nTOTAL=${results.length} PASSED=${results.length - failed - info} FAILED=${failed} INFO=${info}`,
  );
  return failed;
}

// ---- small utilities ----------------------------------------------------

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function truncate(text, max = 300) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const adminDatabaseUrl = withDatabase(postgresBaseUrl, "postgres");
const e2eDatabaseUrl = withDatabase(postgresBaseUrl, databaseName);

function expectStatus(response, expected, label) {
  assert.equal(
    response.status,
    expected,
    `${label}: expected ${expected}, got ${response.status} — ${truncate(response.text)}`,
  );
}

/** Asserts the documented error envelope and returns `body.error`. */
function expectEnvelope(response, status, code, label) {
  expectStatus(response, status, label);
  const body = jsonOrNull(response.text);
  assert.ok(
    body !== null && typeof body === "object" && body.error !== undefined,
    `${label}: expected the standard error envelope, got ${truncate(response.text)}`,
  );
  assert.equal(
    body.error.code,
    code,
    `${label}: expected code ${code}, got ${String(body.error.code)} — ${truncate(response.text)}`,
  );
  assert.equal(
    typeof body.error.message,
    "string",
    `${label}: the error envelope must carry a message`,
  );
  return body.error;
}

// ---- HTTP clients (real cookie jars) ------------------------------------

/** Every response body seen during the run (used for the "no key material" gate). */
const responses = [];

function createClient(origin, label) {
  let cookie = "";
  let lastSetCookie = "";

  return {
    label,
    get cookie() {
      return cookie;
    },
    get lastSetCookie() {
      return lastSetCookie;
    },
    clearCookie() {
      cookie = "";
    },
    async request(path, options = {}) {
      const headers = { accept: "application/json", ...(options.headers ?? {}) };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.sendCookie !== false && cookie !== "") headers.cookie = cookie;

      const response = await fetch(`${origin}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0]?.trim() ?? "";
        if (!pair.startsWith("summarly_session=")) continue;
        lastSetCookie = raw;
        cookie = pair === "summarly_session=" ? "" : pair;
      }

      const text = await response.text();
      responses.push({
        client: label,
        method: options.method ?? "GET",
        path,
        status: response.status,
        text,
      });
      return {
        status: response.status,
        text,
        json: jsonOrNull(text),
        headers: response.headers,
        setCookie: response.headers.getSetCookie(),
      };
    },
  };
}

/** Primary client: dashboard origin, keeps the real session cookie jar. */
const api = createClient(dashboardUrl, "dashboard");
/** No-jar client: rate-limit scenarios must not depend on session state. */
const anon = createClient(dashboardUrl, "dashboard-anon");
/** Direct backend access (health, and the untrusted-peer trust test). */
const direct = createClient(backendUrl, "backend-direct");

// ---- PostgreSQL helpers -------------------------------------------------

let databaseClient = null;

async function db() {
  if (databaseClient === null) {
    databaseClient = new Client({ connectionString: e2eDatabaseUrl });
    await databaseClient.connect();
  }
  return databaseClient;
}

async function sql(text, params) {
  const client = await db();
  return client.query(text, params);
}

async function closeDatabaseClient() {
  if (databaseClient === null) return;
  const client = databaseClient;
  databaseClient = null;
  await client.end().catch(() => {});
}

// ---- process helpers ---------------------------------------------------

function runToCompletion(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (chunk) => {
      output += String(chunk);
      if (output.length > 40_000) output = output.slice(-20_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", fail);
    child.once("exit", (code) => done({ code: code ?? 1, output }));
  });
}

/**
 * Runs the documented npm command for this repository (npm workspaces).
 * Prefers the npm CLI script shipped with Node (no shell, so arguments are
 * never concatenated into a command line).
 */
async function runNpm(args, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = candidates.find(
    (candidate) => candidate !== undefined && candidate.endsWith(".js") && existsSync(candidate),
  );
  if (npmCli !== undefined) {
    return runToCompletion(process.execPath, [npmCli, ...args], { cwd: repoRoot, env });
  }
  return runToCompletion("npm", args, {
    cwd: repoRoot,
    env,
    shell: process.platform === "win32",
  });
}

function startProcess(label, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const state = {
    label,
    child,
    output: "",
    exited: false,
  };
  const capture = (chunk) => {
    state.output += String(chunk);
    if (state.output.length > 40_000) state.output = state.output.slice(-20_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", () => {
    state.exited = true;
  });
  return state;
}

async function stopProcess(state) {
  if (state === null || state === undefined || state.exited) return;
  const child = state.child;
  child.kill();
  await Promise.race([new Promise((done) => child.once("exit", done)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(3000)]);
  }
}

async function waitForHttp(url, timeoutMs, started, accepted = (response) => response.status === 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (started !== null && started !== undefined && started.exited) {
      throw new Error(
        `${started.label} exited before becoming ready.\n${truncate(started.output, 2000)}`,
      );
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await response.text();
      if (accepted(response)) return;
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const tail = started === null || started === undefined ? "" : `\n${truncate(started.output, 2000)}`;
  throw new Error(
    `Timed out waiting for ${url} (${lastError instanceof Error ? lastError.message : String(lastError)}).${tail}`,
  );
}

function portIsFree(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (free) => {
      socket.destroy();
      done(free);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(true));
  });
}

async function requireFreePorts(ports) {
  const busy = [];
  for (const port of ports) {
    if (!(await portIsFree(port))) busy.push(port);
  }
  assert.deepEqual(
    busy,
    [],
    `port(s) ${busy.join(", ")} already in use — stop the other process or set E2E_BACKEND_PORT/E2E_DASHBOARD_PORT`,
  );
}

// ---- orchestration state ------------------------------------------------

let postgresStartedHere = false;
const servers = {
  backend: null,
  untrustedPeerBackend: null,
  dashboard: null,
};

function backendEnv(port, trustedProxies) {
  return {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    COOKIE_SECURE: "false",
    DATABASE_URL: e2eDatabaseUrl,
    ENCRYPTION_KEY: encryptionKey,
    TRUSTED_PROXIES: trustedProxies,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function startBackend(port, trustedProxies) {
  const state = startProcess(
    `backend:${port}`,
    process.execPath,
    ["--import", "tsx", join(repoRoot, "backend", "src", "index.ts")],
    {
      cwd: repoRoot,
      env: { ...backendEnv(port, trustedProxies), NODE_ENV: "production" },
    },
  );
  await waitForHttp(`http://127.0.0.1:${port}/health`, 60_000, state);
  return state;
}

async function restartBackend() {
  await stopProcess(servers.backend);
  servers.backend = null;
  servers.backend = await startBackend(backendPort, "127.0.0.1,::1");
  await waitForHttp(`${dashboardUrl}/login`, 60_000, servers.dashboard);
}

function resolveNextBin() {
  const candidates = [
    "next/dist/bin/next",
    join(dirname(require.resolve("next/package.json")), "dist", "bin", "next"),
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Cannot locate the Next.js CLI. Run `npm install` first.");
}

/** The rewrite destination Next baked into `.next` at build time. */
async function bakedBackendOrigin() {
  try {
    const manifest = JSON.parse(
      await readFile(join(dashboardRoot, ".next", "routes-manifest.json"), "utf8"),
    );
    const rewrite = (manifest.rewrites?.afterFiles ?? []).find(
      (entry) => entry.source === "/api/:path*",
    );
    const match = /^https?:\/\/[^/]+/.exec(rewrite?.destination ?? "");
    return match === null ? null : match[0];
  } catch {
    return null;
  }
}

// ---- scenarios ----------------------------------------------------------

let recoveryCodes = [];

async function scenarioSetupAndAuth() {
  await check("setup status reports needsSetup=true on a fresh database", async () => {
    const response = await api.request("/api/setup/status");
    expectStatus(response, 200, "GET /api/setup/status");
    assert.equal(response.json?.needsSetup, true, response.text);
  });

  await check("setup rejects a password shorter than 12 characters", async () => {
    const response = await api.request("/api/setup", {
      method: "POST",
      body: { password: "elevenchars" },
    });
    const error = expectEnvelope(response, 400, "validation_error", "POST /api/setup");
    assert.ok(
      (error.details ?? []).some((detail) => detail.path === "password"),
      `expected a "password" detail, got ${truncate(response.text)}`,
    );
  });

  await check("setup creates the administrator and returns exactly 10 recovery codes", async () => {
    const response = await api.request("/api/setup", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectStatus(response, 201, "POST /api/setup");
    const codes = response.json?.recoveryCodes;
    assert.ok(Array.isArray(codes), `expected recoveryCodes, got ${truncate(response.text)}`);
    assert.equal(codes.length, 10, `expected 10 recovery codes, got ${codes.length}`);
    assert.equal(new Set(codes).size, 10, "recovery codes must be unique");
    for (const code of codes) {
      assert.match(
        code,
        /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/,
        `recovery code ${code} is not 128 bits of grouped hex`,
      );
    }
    recoveryCodes = codes;
  });

  await check("only code hashes are stored for recovery codes", async () => {
    const result = await sql("SELECT recovery_code_hashes FROM admin_credentials");
    const hashes = result.rows[0]?.recovery_code_hashes ?? [];
    assert.equal(hashes.length, 10, `expected 10 stored hashes, got ${hashes.length}`);
    const plaintext = recoveryCodes.map((code) =>
      code.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    for (const hash of hashes) {
      assert.match(hash, /^[0-9a-f]{64}$/, `unexpected stored value ${hash}`);
      assert.ok(!plaintext.includes(hash), "a recovery code was stored in plaintext");
    }
  });

  await check("setup status reports needsSetup=false afterwards", async () => {
    const response = await api.request("/api/setup/status");
    expectStatus(response, 200, "GET /api/setup/status");
    assert.equal(response.json?.needsSetup, false, response.text);
  });

  await check("a second setup attempt returns 409 and no recovery codes", async () => {
    const response = await api.request("/api/setup", {
      method: "POST",
      body: { password: "another-long-password-1" },
    });
    expectEnvelope(response, 409, "conflict", "second POST /api/setup");
    assert.equal(
      response.json?.recoveryCodes,
      undefined,
      "a rejected setup must not hand out recovery codes",
    );
  });
}

async function scenarioSession() {
  await check("a protected route without a session returns 401", async () => {
    const response = await anon.request("/api/connection");
    expectEnvelope(response, 401, "unauthorized", "GET /api/connection (anonymous)");
  });

  await check("correct login through the dashboard proxy sets an httpOnly SameSite cookie", async () => {
    const response = await api.request("/api/auth/login", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectStatus(response, 200, "POST /api/auth/login");
    assert.deepEqual(response.json, { ok: true });
    assert.match(api.lastSetCookie, /^summarly_session=[0-9a-f]{64};/, api.lastSetCookie);
    assert.match(api.lastSetCookie, /HttpOnly/i, `cookie is not httpOnly: ${api.lastSetCookie}`);
    assert.match(
      api.lastSetCookie,
      /SameSite=Strict/i,
      `cookie is not SameSite=Strict: ${api.lastSetCookie}`,
    );
    assert.doesNotMatch(
      api.lastSetCookie,
      /;\s*Secure/i,
      `cookie must not be Secure while COOKIE_SECURE=false: ${api.lastSetCookie}`,
    );
    assert.doesNotMatch(
      api.lastSetCookie,
      /Max-Age|Expires/i,
      "the session cookie should be a session cookie (no expiry)",
    );
  });

  await check("authenticated GET /api/connection returns the connection state", async () => {
    const response = await api.request("/api/connection");
    expectStatus(response, 200, "GET /api/connection");
    assert.ok(
      ["connected", "connecting", "disconnected", "unavailable"].includes(response.json?.state),
      `unexpected state: ${truncate(response.text)}`,
    );
    assert.equal(typeof response.json?.since, "string", response.text);
  });

  await check("wrong password is rejected with 401 and does not create a session", async () => {
    const response = await anon.request("/api/auth/login", {
      method: "POST",
      body: { password: "definitely-not-the-password" },
    });
    expectEnvelope(response, 401, "unauthorized", "POST /api/auth/login (wrong password)");
    assert.equal(anon.cookie, "", "a failed login must not set a session cookie");
  });

  await check("logout deletes the session server-side", async () => {
    const response = await api.request("/api/auth/logout", { method: "POST" });
    expectStatus(response, 200, "POST /api/auth/logout");
    assert.deepEqual(response.json, { ok: true });
    assert.equal(api.cookie, "", "logout must clear the session cookie");
    const after = await api.request("/api/connection");
    expectEnvelope(after, 401, "unauthorized", "GET /api/connection after logout");
    const sessions = await sql("SELECT count(*)::int AS count FROM admin_sessions");
    assert.equal(sessions.rows[0].count, 0, "the session row should be deleted");
  });

  // The remaining scenarios need an authenticated session: sign in again and
  // keep the cookie jar for the rest of the run.
  await check("signing in again after logout yields a working session", async () => {
    const response = await api.request("/api/auth/login", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectStatus(response, 200, "POST /api/auth/login (after logout)");
    assert.notEqual(api.cookie, "", "no session cookie was issued");
    expectStatus(await api.request("/api/connection"), 200, "GET /api/connection (re-login)");
  });
}

async function scenarioGroups() {
  await check("a group inserted directly in PostgreSQL is returned by GET /api/groups", async () => {
    await sql(
      `INSERT INTO groups (id, chat_id, name, monitored, timezone, summary_time)
       VALUES ($1, $2, $3, true, 'Europe/Madrid', NULL)`,
      [groupId, "120363000000000001@g.us", "E2E Test Group"],
    );
    const response = await api.request("/api/groups");
    expectStatus(response, 200, "GET /api/groups");
    assert.ok(Array.isArray(response.json), response.text);
    const found = response.json.find((group) => group.id === groupId);
    assert.ok(found, `the inserted group is missing: ${truncate(response.text)}`);
    assert.equal(found.name, "E2E Test Group");
    assert.equal(found.chatId, "120363000000000001@g.us");
    assert.equal(found.monitored, true);
    assert.equal(found.summaryTime, null);
  });

  await check("PATCH updates the timezone and the daily cutoff (HH:mm)", async () => {
    const response = await api.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { timezone: "America/New_York", summaryTime: "07:30" },
    });
    expectStatus(response, 200, "PATCH /api/groups/:id");
    assert.equal(response.json?.timezone, "America/New_York", response.text);
    assert.equal(response.json?.summaryTime, "07:30", response.text);
    const row = await sql("SELECT timezone, summary_time FROM groups WHERE id = $1", [groupId]);
    assert.equal(row.rows[0]?.timezone, "America/New_York", "timezone was not persisted");
    assert.equal(row.rows[0]?.summary_time, "07:30", "summary_time was not persisted");
  });

  await check("PATCH summaryTime:null clears the daily cutoff", async () => {
    const response = await api.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { summaryTime: null },
    });
    expectStatus(response, 200, "PATCH /api/groups/:id (clear cutoff)");
    assert.equal(response.json?.summaryTime, null, response.text);
    // The timezone must be untouched by an omitted field.
    assert.equal(response.json?.timezone, "America/New_York", response.text);
    const row = await sql("SELECT summary_time FROM groups WHERE id = $1", [groupId]);
    assert.equal(row.rows[0]?.summary_time, null, "summary_time was not cleared");
  });

  await check("PATCH with an invalid IANA time zone returns a 400 envelope", async () => {
    const response = await api.request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { timezone: "Not/AZone" },
    });
    const error = expectEnvelope(response, 400, "validation_error", "PATCH invalid timezone");
    assert.ok(
      (error.details ?? []).some((detail) => detail.path === "timezone"),
      `expected a "timezone" detail, got ${truncate(response.text)}`,
    );
    const row = await sql("SELECT timezone FROM groups WHERE id = $1", [groupId]);
    assert.equal(row.rows[0]?.timezone, "America/New_York", "a rejected PATCH changed the group");
  });

  await check("PATCH on an unknown group returns 404", async () => {
    const response = await api.request(`/api/groups/${unknownRunId}`, {
      method: "PATCH",
      body: { monitored: false },
    });
    expectEnvelope(response, 404, "not_found", "PATCH unknown group");
  });
}

async function scenarioRuns() {
  let runId = null;
  let secondRunId = null;

  await check("POST /api/summary-runs creates a pending manual run (201)", async () => {
    const response = await api.request("/api/summary-runs", {
      method: "POST",
      body: { groupId, interval },
    });
    expectStatus(response, 201, "POST /api/summary-runs");
    assert.equal(response.json?.status, "pending", response.text);
    assert.equal(response.json?.kind, "manual", response.text);
    assert.equal(response.json?.attempts, 0, response.text);
    assert.equal(response.json?.error, null, response.text);
    assert.match(response.json?.id ?? "", /^[0-9a-f-]{36}$/, response.text);
    assert.equal(Date.parse(response.json.interval.start), Date.parse(interval.start));
    assert.equal(Date.parse(response.json.interval.end), Date.parse(interval.end));
    runId = response.json.id;
  });

  await check("an identical run request returns 200 with the same id", async () => {
    const response = await api.request("/api/summary-runs", {
      method: "POST",
      body: { groupId, interval },
    });
    expectStatus(response, 200, "POST /api/summary-runs (identical)");
    assert.equal(response.json?.id, runId, response.text);
    const count = await sql("SELECT count(*)::int AS count FROM summary_runs");
    assert.equal(count.rows[0].count, 1, "the duplicate request created a second row");
  });

  await check("the same instants in a +02:00 spelling return 200 with the same id", async () => {
    const response = await api.request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-20T02:00:00+02:00",
          end: "2026-10-21T02:00:00+02:00",
          // A different label must not change run identity ...
          timezone: "Asia/Tokyo",
        },
      },
    });
    expectStatus(response, 200, "POST /api/summary-runs (+02:00 spelling)");
    assert.equal(response.json?.id, runId, response.text);
    // ... and the first request's label is kept.
    assert.equal(
      response.json?.interval?.timezone,
      interval.timezone,
      `expected the first label to be kept: ${truncate(response.text)}`,
    );
    assert.equal(Date.parse(response.json.interval.start), Date.parse(interval.start));
  });

  await check("an inverted interval is rejected with 400", async () => {
    const response = await api.request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-21T00:00:00.000Z",
          end: "2026-10-20T00:00:00.000Z",
          timezone: "Europe/Madrid",
        },
      },
    });
    const error = expectEnvelope(response, 400, "validation_error", "inverted interval");
    assert.ok(
      (error.details ?? []).some((detail) => detail.path.startsWith("interval")),
      `expected an interval detail, got ${truncate(response.text)}`,
    );
    const count = await sql("SELECT count(*)::int AS count FROM summary_runs");
    assert.equal(count.rows[0].count, 1, "an invalid request created a run");
  });

  await check("a run for an unknown group returns 404", async () => {
    const response = await api.request("/api/summary-runs", {
      method: "POST",
      body: { groupId: unknownRunId, interval },
    });
    expectEnvelope(response, 404, "not_found", "POST run for unknown group");
  });

  await check("GET /api/summary-runs lists runs newest first", async () => {
    const created = await api.request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-22T00:00:00.000Z",
          end: "2026-10-23T00:00:00.000Z",
          timezone: "Europe/Madrid",
        },
      },
    });
    expectStatus(created, 201, "POST second run");
    secondRunId = created.json.id;

    const response = await api.request("/api/summary-runs");
    expectStatus(response, 200, "GET /api/summary-runs");
    assert.ok(Array.isArray(response.json?.items), response.text);
    const ids = response.json.items.map((item) => item.id);
    assert.ok(ids.includes(runId) && ids.includes(secondRunId), `missing runs: ${truncate(response.text)}`);
    assert.equal(ids[0], secondRunId, "the newest run should be first");
    assert.equal(response.json.nextCursor, null, response.text);
    const stamps = response.json.items.map((item) => Date.parse(item.createdAt));
    for (let index = 1; index < stamps.length; index += 1) {
      assert.ok(
        stamps[index - 1] >= stamps[index],
        "the list is not ordered by createdAt descending",
      );
    }
  });

  await check("GET /api/summary-runs/:id returns the run and 404 for an unknown id", async () => {
    const response = await api.request(`/api/summary-runs/${runId}`);
    expectStatus(response, 200, "GET /api/summary-runs/:id");
    assert.equal(response.json?.id, runId, response.text);
    const missing = await api.request(`/api/summary-runs/${unknownRunId}`);
    expectEnvelope(missing, 404, "not_found", "GET unknown run");
  });

  await check("retry moves a failed run back to pending", async () => {
    await sql(
      `UPDATE summary_runs
         SET status = 'failed', error_code = 'provider_error', error_message = 'simulated failure'
       WHERE id = $1`,
      [runId],
    );
    const failed = await api.request(`/api/summary-runs/${runId}`);
    assert.equal(failed.json?.status, "failed", failed.text);
    assert.equal(failed.json?.error?.code, "provider_error", failed.text);

    const response = await api.request(`/api/summary-runs/${runId}/retry`, { method: "POST" });
    expectStatus(response, 200, "POST retry (failed run)");
    assert.equal(response.json?.status, "pending", response.text);
    assert.equal(response.json?.error, null, response.text);
    const row = await sql("SELECT status, error_code FROM summary_runs WHERE id = $1", [runId]);
    assert.equal(row.rows[0]?.status, "pending", "retry was not persisted");
    assert.equal(row.rows[0]?.error_code, null, "the error was not cleared");
  });

  await check("retry of a completed run returns 409 conflict", async () => {
    await sql("UPDATE summary_runs SET status = 'completed' WHERE id = $1", [runId]);
    const response = await api.request(`/api/summary-runs/${runId}/retry`, { method: "POST" });
    expectEnvelope(response, 409, "conflict", "POST retry (completed run)");
    const row = await sql("SELECT status FROM summary_runs WHERE id = $1", [runId]);
    assert.equal(row.rows[0]?.status, "completed", "a rejected retry changed the run");
  });

  await check("retry of a pending run is a no-op (200, still pending)", async () => {
    const response = await api.request(`/api/summary-runs/${secondRunId}/retry`, {
      method: "POST",
    });
    expectStatus(response, 200, "POST retry (pending run)");
    assert.equal(response.json?.status, "pending", response.text);
  });

  return { runId, secondRunId };
}

async function scenarioSummaries(runId) {
  await check("a run without a generated summary answers 404", async () => {
    const response = await api.request(`/api/summary-runs/${runId}/summary`);
    const error = expectEnvelope(response, 404, "not_found", "GET run summary");
    assert.match(error.message.toLowerCase(), /summary/, `unexpected message: ${error.message}`);
  });

  await check("the summary route answers 404 for an unknown run", async () => {
    const response = await api.request(`/api/summary-runs/${unknownRunId}/summary`);
    expectEnvelope(response, 404, "not_found", "GET unknown run summary");
  });
}

async function scenarioSettings() {
  await check("provider config is 404 before it is configured", async () => {
    const response = await api.request("/api/settings/ai-provider");
    expectEnvelope(response, 404, "not_found", "GET provider config (unset)");
  });

  await check("PUT stores the API key and reports hasApiKey without echoing it", async () => {
    const response = await api.request("/api/settings/ai-provider", {
      method: "PUT",
      body: { provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: providerApiKey },
    });
    expectStatus(response, 200, "PUT provider config");
    assert.equal(response.json?.hasApiKey, true, response.text);
    assert.equal(response.json?.provider, "openai", response.text);
    assert.equal(response.json?.model, "gpt-4o-mini", response.text);
    assert.equal(response.json?.baseUrl, null, response.text);
    assert.ok(
      !response.text.includes(providerApiKey),
      "the PUT response echoed the API key",
    );
  });

  await check("GET returns hasApiKey:true and no key material", async () => {
    const response = await api.request("/api/settings/ai-provider");
    expectStatus(response, 200, "GET provider config");
    assert.equal(response.json?.hasApiKey, true, response.text);
    assert.ok(!response.text.includes(providerApiKey), "the GET response echoed the API key");
    assert.deepEqual(
      Object.keys(response.json ?? {}).sort(),
      ["baseUrl", "hasApiKey", "model", "provider"],
      `unexpected fields: ${truncate(response.text)}`,
    );
  });

  await check("the API key is encrypted at rest (AES-256-GCM envelope)", async () => {
    const result = await sql("SELECT api_key_encrypted FROM ai_provider_configs");
    const stored = result.rows[0]?.api_key_encrypted;
    assert.equal(typeof stored, "string", "no encrypted key was stored");
    assert.match(stored, /^enc:v1:/, `unexpected envelope: ${truncate(stored, 40)}`);
    assert.ok(!stored.includes(providerApiKey), "the stored value contains the plaintext key");
  });

  await check("PUT omitting apiKey keeps the saved key", async () => {
    const response = await api.request("/api/settings/ai-provider", {
      method: "PUT",
      body: { provider: "openai", model: "gpt-4o-mini" },
    });
    expectStatus(response, 200, "PUT provider config (keep key)");
    assert.equal(response.json?.hasApiKey, true, response.text);
    const read = await api.request("/api/settings/ai-provider");
    assert.equal(read.json?.hasApiKey, true, read.text);
    assert.ok(!read.text.includes(providerApiKey), "the GET response echoed the API key");
  });

  await check("PUT apiKey:null clears the saved key", async () => {
    const response = await api.request("/api/settings/ai-provider", {
      method: "PUT",
      body: { provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: null },
    });
    expectStatus(response, 200, "PUT provider config (clear key)");
    assert.equal(response.json?.hasApiKey, false, response.text);
    const read = await api.request("/api/settings/ai-provider");
    assert.equal(read.json?.hasApiKey, false, read.text);
    const result = await sql("SELECT api_key_encrypted FROM ai_provider_configs");
    assert.equal(result.rows[0]?.api_key_encrypted, null, "the stored key was not cleared");
  });
}

async function scenarioRecovery() {
  await check("recovery consumes a one-time code, invalidates sessions, and rotates the password", async () => {
    // A live session that recovery must destroy.
    const login = await api.request("/api/auth/login", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectStatus(login, 200, "POST /api/auth/login (before recovery)");
    const staleCookie = api.cookie;
    assert.notEqual(staleCookie, "", "no session cookie was issued");
    expectStatus(await api.request("/api/connection"), 200, "GET /api/connection (before recovery)");

    const recover = await api.request("/api/auth/recover", {
      method: "POST",
      body: { recoveryCode: recoveryCodes[0], newPassword: recoveredPassword },
    });
    expectStatus(recover, 200, "POST /api/auth/recover");
    assert.deepEqual(recover.json, { ok: true });

    const stale = await api.request("/api/connection");
    expectEnvelope(stale, 401, "unauthorized", "GET /api/connection with the pre-recovery session");

    const oldPassword = await anon.request("/api/auth/login", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectEnvelope(oldPassword, 401, "unauthorized", "POST /api/auth/login (old password)");

    const newPassword = await api.request("/api/auth/login", {
      method: "POST",
      body: { password: recoveredPassword },
    });
    expectStatus(newPassword, 200, "POST /api/auth/login (recovered password)");
    expectStatus(await api.request("/api/connection"), 200, "GET /api/connection (after recovery)");

    const reused = await anon.request("/api/auth/recover", {
      method: "POST",
      body: { recoveryCode: recoveryCodes[0], newPassword: "another-recovered-password-1" },
    });
    expectEnvelope(reused, 401, "unauthorized", "POST /api/auth/recover (reused code)");

    const stillOld = await anon.request("/api/auth/login", {
      method: "POST",
      body: { password: setupPassword },
    });
    expectEnvelope(stillOld, 401, "unauthorized", "POST /api/auth/login (old password after reuse)");
  });

  await check("changing the password requires the current one and drops every session", async () => {
    const wrongCurrent = await api.request("/api/auth/password", {
      method: "POST",
      body: { currentPassword: "not-the-current-password", newPassword: rotatedPassword },
    });
    expectEnvelope(wrongCurrent, 401, "unauthorized", "POST /api/auth/password (wrong current)");
    // The session must survive a rejected change (only success evicts).
    expectStatus(await api.request("/api/connection"), 200, "GET /api/connection (after rejection)");

    const changed = await api.request("/api/auth/password", {
      method: "POST",
      body: { currentPassword: recoveredPassword, newPassword: rotatedPassword },
    });
    expectStatus(changed, 200, "POST /api/auth/password");
    assert.deepEqual(changed.json, { ok: true });

    const dropped = await api.request("/api/connection");
    expectEnvelope(dropped, 401, "unauthorized", "GET /api/connection after a password change");
    const sessions = await sql("SELECT count(*)::int AS count FROM admin_sessions");
    assert.equal(sessions.rows[0].count, 0, "sessions were not evicted");

    const relogin = await api.request("/api/auth/login", {
      method: "POST",
      body: { password: rotatedPassword },
    });
    expectStatus(relogin, 200, "POST /api/auth/login (rotated password)");
  });
}

async function scenarioRateLimiting() {
  // Fresh backend process = fresh in-memory limiter (see the file header).
  await check("sessions survive a backend restart (state is in PostgreSQL)", async () => {
    const before = api.cookie;
    assert.notEqual(before, "", "no session cookie to test with");
    await restartBackend();
    const response = await api.request("/api/connection");
    expectStatus(response, 200, "GET /api/connection after restart");
    assert.equal(api.cookie, before, "the cookie changed on restart");
  });

  await check("5 failed logins from one client are rate limited with Retry-After", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await anon.request("/api/auth/login", {
        method: "POST",
        body: { password: `wrong-password-${attempt}` },
      });
      expectStatus(response, 401, `failed login ${attempt}`);
    }
    const limited = await anon.request("/api/auth/login", {
      method: "POST",
      body: { password: rotatedPassword },
    });
    expectEnvelope(limited, 429, "rate_limited", "6th login attempt (locked)");
    const retryAfter = limited.headers.get("retry-after");
    assert.ok(retryAfter !== null, "the 429 response is missing Retry-After");
    assert.match(retryAfter, /^\d+$/, `Retry-After is not a number of seconds: ${retryAfter}`);
    const seconds = Number(retryAfter);
    assert.ok(seconds > 0 && seconds <= 15 * 60, `Retry-After out of range: ${seconds}`);
  });

  // X-Forwarded-For through the real Next proxy: observation only (a defect
  // here is reported, not "fixed" by this script).
  await restartBackend();
  const spoofNote = [];
  let separateBuckets = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const spoofed = `203.0.113.${100 + attempt}`;
    const response = await anon.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": spoofed },
      body: { password: `wrong-password-${attempt}` },
    });
    expectStatus(response, 401, `spoofed failed login ${attempt} (X-Forwarded-For: ${spoofed})`);
  }
  {
    const probe = await anon.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.199" },
      body: { password: rotatedPassword },
    });
    separateBuckets = probe.status === 200;
    if (separateBuckets) {
      spoofNote.push(
        "separate buckets: after 5 failures under X-Forwarded-For 203.0.113.101..105, a correct login " +
          "with X-Forwarded-For 203.0.113.199 returned 200 — the client-supplied header selects the bucket",
      );
    } else {
      spoofNote.push(
        `shared bucket: after 5 failures under different X-Forwarded-For values, a correct login with a fresh ` +
          `value returned ${probe.status} — the header did not change the bucket`,
      );
    }
  }
  {
    // Second probe: can a client lock out an address it does not own?
    const victim = "192.0.2.77";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await anon.request("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": victim },
        body: { password: `wrong-password-${attempt}` },
      });
    }
    const victimLocked = await anon.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": victim },
      body: { password: rotatedPassword },
    });
    spoofNote.push(
      victimLocked.status === 429
        ? "third-party lockout: 5 failures with X-Forwarded-For: 192.0.2.77 made a correct login carrying that same header answer 429"
        : `third-party lockout not observed (status ${victimLocked.status} for the spoofed victim bucket)`,
    );
  }
  observe(
    "X-Forwarded-For through the Next proxy (observation)",
    `${spoofNote.join("; ")} ⇒ ${
      separateBuckets
        ? "a client that can set X-Forwarded-For escapes the login limit and can lock out arbitrary IPs (defect: the rewrite forwards the client header verbatim and the backend trusts loopback as a proxy)"
        : "clients cannot choose their own lockout bucket through the proxy"
    }`,
  );

  // Untrusted socket peer: the header must be ignored. The primary backend
  // must trust loopback (the dashboard proxy), so this uses a second instance
  // whose TRUSTED_PROXIES does not contain 127.0.0.1.
  await check("X-Forwarded-For from an untrusted peer is ignored (single bucket)", async () => {
    servers.untrustedPeerBackend = await startBackend(untrustedPeerBackendPort, "192.0.2.10");
    const client = createClient(untrustedPeerBackendUrl, "backend-untrusted-peer");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const spoofed = `198.51.100.${10 + attempt}`;
      const response = await client.request("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": spoofed },
        body: { password: `wrong-password-${attempt}` },
      });
      expectStatus(response, 401, `untrusted-peer failed login ${attempt}`);
    }
    const limited = await client.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.99" },
      body: { password: rotatedPassword },
    });
    expectEnvelope(limited, 429, "rate_limited", "untrusted peer, fresh spoofed XFF");
    assert.ok(limited.headers.get("retry-after") !== null, "missing Retry-After");
  });
}

async function scenarioHealth() {
  await check("GET /health on the backend returns ok", async () => {
    const response = await direct.request("/health");
    expectStatus(response, 200, "GET /health (direct)");
    assert.deepEqual(response.json, { status: "ok" });
  });
}

async function scenarioNoKeyMaterialAnywhere() {
  await check("the provider API key never appears in any response body", async () => {
    const offenders = responses
      .filter((entry) => entry.text.includes(providerApiKey))
      .map((entry) => `${entry.method} ${entry.path} (${entry.status})`);
    assert.deepEqual(offenders, [], `key material leaked by: ${offenders.join(", ")}`);
    assert.ok(responses.length > 40, `suspiciously few responses recorded: ${responses.length}`);
  });
}

// ---- teardown -----------------------------------------------------------

async function teardown() {
  progress("\nTeardown:");
  for (const key of ["dashboard", "untrustedPeerBackend", "backend"]) {
    const state = servers[key];
    if (state === null) continue;
    await stopProcess(state);
    servers[key] = null;
    progress(`  stopped ${state.label}`);
  }

  await closeDatabaseClient();

  if (keepDatabase) {
    progress(`  database kept: ${databaseName} (E2E_KEEP_DATABASE=1)`);
  } else {
    let dropped = false;
    for (let attempt = 1; attempt <= 3 && !dropped; attempt += 1) {
      const client = new Client({ connectionString: adminDatabaseUrl });
      try {
        await client.connect();
        await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        dropped = true;
        progress(`  dropped database ${databaseName}`);
      } catch (error) {
        progress(
          `  drop attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(500);
      } finally {
        await client.end().catch(() => {});
      }
    }
    if (!dropped) {
      progress(`  WARNING: could not drop ${databaseName}; remove it manually`);
    }
  }

  // Report the PostgreSQL state honestly: this script never stops PostgreSQL.
  let reachable = false;
  const probe = new Client({ connectionString: adminDatabaseUrl });
  try {
    await probe.connect();
    const version = await probe.query("SHOW server_version");
    reachable = true;
    progress(
      `  PostgreSQL: left RUNNING (127.0.0.1:5432, server ${version.rows[0]?.server_version}) — ${
        postgresStartedHere ? "started by this run" : "reused, already healthy"
      }`,
    );
  } catch {
    progress("  PostgreSQL: not reachable at teardown (it was not stopped by this script)");
  } finally {
    await probe.end().catch(() => {});
  }
  if (!reachable) progress("  PostgreSQL: not running");
}

// ---- main ---------------------------------------------------------------

async function ensurePostgres() {
  const probe = new Client({ connectionString: adminDatabaseUrl, connectionTimeoutMillis: 4000 });
  try {
    await probe.connect();
    await probe.end();
    progress("PostgreSQL: reusing the healthy instance on 127.0.0.1:5432");
    return;
  } catch {
    await probe.end().catch(() => {});
  }

  progress("PostgreSQL: not reachable — starting docker-compose.dev.yml");
  const up = await runToCompletion(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", "up", "-d"],
    { cwd: repoRoot, env: process.env },
  );
  if (up.code !== 0) {
    throw new Error(`docker compose up failed (exit ${up.code}).\n${truncate(up.output, 2000)}`);
  }
  postgresStartedHere = true;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const client = new Client({ connectionString: adminDatabaseUrl, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.end();
      progress("PostgreSQL: ready");
      return;
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        throw new Error(
          `PostgreSQL did not become ready: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await delay(1000);
    }
  }
}

async function createDatabase() {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseName}"`);
    progress(`Database: created throwaway database ${databaseName}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMigrations() {
  progress("Migrations: npm run migrate -w @summarly/backend up");
  const result = await runNpm(["run", "migrate", "-w", "@summarly/backend", "up"], {
    DATABASE_URL: e2eDatabaseUrl,
  });
  if (result.code !== 0) {
    throw new Error(`migrations failed (exit ${result.code}).\n${truncate(result.output, 3000)}`);
  }
  const applied = await sql("SELECT name FROM pgmigrations ORDER BY id");
  assert.ok(
    applied.rows.length >= 1,
    "node-pg-migrate recorded no applied migration",
  );
  const tables = await sql(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  progress(
    `Migrations: applied ${applied.rows.map((row) => row.name).join(", ")} (${tables.rows[0].count} public tables)`,
  );
}

async function ensureDashboardBuild() {
  const contractsDist = join(repoRoot, "packages", "contracts", "dist", "index.js");
  if (!existsSync(contractsDist)) {
    progress("Dashboard: building @summarly/contracts first");
    const built = await runNpm(["run", "build", "-w", "@summarly/contracts"]);
    if (built.code !== 0) {
      throw new Error(`contracts build failed.\n${truncate(built.output, 2000)}`);
    }
  }

  const baked = await bakedBackendOrigin();
  if (baked === backendUrl) {
    progress(`Dashboard: reusing the existing .next build (baked BACKEND_URL=${baked})`);
    return;
  }
  if (skipBuild) {
    throw new Error(
      `.next is baked for ${baked ?? "no backend"} but this run serves ${backendUrl}; ` +
        "unset E2E_SKIP_BUILD or rebuild with BACKEND_URL=" +
        backendUrl,
    );
  }
  progress(
    `Dashboard: .next baked for ${baked ?? "nothing"} — rebuilding with BACKEND_URL=${backendUrl}`,
  );
  const build = await runToCompletion(
    process.execPath,
    [resolveNextBin(), "build"],
    {
      cwd: dashboardRoot,
      env: {
        ...process.env,
        BACKEND_URL: backendUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  if (build.code !== 0) {
    throw new Error(`next build failed (exit ${build.code}).\n${truncate(build.output, 4000)}`);
  }
  const rebuilt = await bakedBackendOrigin();
  assert.equal(rebuilt, backendUrl, "the rebuilt dashboard still does not target this backend");
  progress(`Dashboard: build complete (baked BACKEND_URL=${rebuilt})`);
}

async function startDashboard() {
  const state = startProcess(
    "dashboard",
    process.execPath,
    [resolveNextBin(), "start", "-p", String(dashboardPort)],
    {
      cwd: dashboardRoot,
      env: {
        ...process.env,
        BACKEND_URL: backendUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  await waitForHttp(`${dashboardUrl}/login`, 90_000, state);
  return state;
}

async function main() {
  progress("Summarly end-to-end check (real PostgreSQL + backend + dashboard)");
  progress(`  backend:   ${backendUrl}`);
  progress(`  dashboard: ${dashboardUrl}`);
  progress(`  database:  ${databaseName} (throwaway)`);
  progress("");

  await requireFreePorts([backendPort, dashboardPort, untrustedPeerBackendPort]);
  await ensurePostgres();
  await createDatabase();
  await runMigrations();

  progress("Backend: starting Fastify on " + backendUrl);
  servers.backend = await startBackend(backendPort, "127.0.0.1,::1");
  progress("Backend: ready (TRUSTED_PROXIES=127.0.0.1,::1)");

  await ensureDashboardBuild();
  progress("Dashboard: starting next start");
  servers.dashboard = await startDashboard();
  progress("Dashboard: ready\n");

  await scenarioSetupAndAuth();
  await scenarioSession();
  await scenarioGroups();
  const runs = await scenarioRuns();
  await scenarioSummaries(runs.runId);
  await scenarioSettings();
  await scenarioRecovery();
  await scenarioHealth();
  await scenarioRateLimiting();
  await scenarioNoKeyMaterialAnywhere();
}

let shuttingDown = false;

main()
  .catch((error) => {
    results.push({
      name: "e2e orchestration",
      status: "FAIL",
      detail: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  })
  .finally(async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await teardown();
    const failed = report();
    process.exitCode = failed === 0 && results.some((entry) => entry.status === "PASS") ? 0 : 1;
  });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    progress(`\nReceived ${signal}; shutting down.`);
    void teardown().finally(() => process.exit(130));
  });
}
