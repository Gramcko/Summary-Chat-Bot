#!/usr/bin/env node
/**
 * Reproducible smoke check for the Summarly dashboard.
 *
 * `npm run smoke -w @summarly/dashboard`
 *
 * What it does:
 *   1. starts an in-repo contract test double (`scripts/smoke-stub.mjs`) — no
 *      PostgreSQL, Redis, WhatsApp, or AI provider needed;
 *   2. builds the dashboard with `BACKEND_URL` pointing at that stub (Next bakes
 *      the rewrite destination at build time), unless SMOKE_SKIP_BUILD=1;
 *   3. starts the production server with `next start`;
 *   4. drives the real HTTP surface: the `/api` proxy, the session cookie,
 *      error-envelope passthrough, idempotent run creation, retry conflicts,
 *      provider key handling, and every page's response;
 *   5. asserts the proxy strips client-supplied forwarding headers (the stub
 *      records what the backend actually received), and that no backend origin
 *      or session cookie value leaks into the served HTML / client bundles;
 *   6. rebuilds `.next` for the caller's `BACKEND_URL` (or the built-in
 *      default) on both the success and failure paths, so a later `next start`
 *      never silently proxies to the stub.
 *
 * Environment:
 *   SMOKE_BACKEND_PORT  stub backend port           (default 3999)
 *   SMOKE_APP_PORT      dashboard port              (default 3100)
 *   SMOKE_SKIP_BUILD=1  reuse an existing `.next` build (must have been built
 *                       with BACKEND_URL=http://127.0.0.1:<SMOKE_BACKEND_PORT>)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_VALUE, startStubBackend } from "./smoke-stub.mjs";

const require = createRequire(import.meta.url);
const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const backendPort = Number(process.env.SMOKE_BACKEND_PORT ?? 3999);
const appPort = Number(process.env.SMOKE_APP_PORT ?? 3100);
const skipBuild = process.env.SMOKE_SKIP_BUILD === "1";

const appUrl = `http://127.0.0.1:${appPort}`;
const results = [];
let cookie = "";

/** The caller's BACKEND_URL, restored into `.next` after the run. */
const originalBackendUrl = process.env.BACKEND_URL;
/** Set before `next build` runs: the build output may be replaced from then on. */
let didBuild = false;
/** Resolved in `main`; needed by the teardown rebuild. */
let nextBinPath = null;

// --- helpers -------------------------------------------------------------

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
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

function runToCompletion(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, options);
    child.once("error", fail);
    child.once("exit", (code) => done(code ?? 1));
  });
}

async function request(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;

  const response = await fetch(`${appUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });

  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0];
    if (pair.trim().startsWith("summarly_session=")) cookie = pair.trim();
  }

  return { status: response.status, text: await response.text() };
}

/** Runs one check; a thrown error marks it failed and keeps the run going. */
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseList(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function report() {
  const width = Math.max(...results.map((entry) => entry.name.length), 4);
  for (const entry of results) {
    const status = entry.ok ? "PASS" : "FAIL";
    const detail = entry.ok ? "" : `  ${entry.detail.replace(/\s+/g, " ").slice(0, 300)}`;
    console.log(`${status}  ${entry.name.padEnd(width)}${detail}`);
  }
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(
    `\nTOTAL=${results.length} PASSED=${results.length - failed} FAILED=${failed}`,
  );
  return failed;
}

// --- orchestration -------------------------------------------------------

let appProcess = null;
let appLog = "";
let stub = null;

async function cleanup() {
  if (appProcess !== null) {
    const child = appProcess;
    appProcess = null;
    child.kill();
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      delay(3000),
    ]);
  }
  if (stub !== null) {
    const current = stub;
    stub = null;
    await current.close();
  }
}

async function waitForDashboard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcess !== null && appProcess.exitCode !== null) {
      throw new Error(
        `\`next start\` exited early (code ${appProcess.exitCode}).\n${appLog}`,
      );
    }
    try {
      const response = await fetch(`${appUrl}/login`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`The dashboard did not become ready at ${appUrl}.\n${appLog}`);
}

async function assertNoBackendOriginInClientBundles() {
  const staticDir = join(dashboardRoot, ".next", "static");
  const entries = await readdir(staticDir, { recursive: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const contents = await readFile(join(staticDir, entry), "utf8");
    if (contents.includes(`127.0.0.1:${backendPort}`)) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], "backend origin found in client bundles");
}

function expectedBackendBaseUrl() {
  return (originalBackendUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
}

/**
 * Rebuilds `.next` for the caller's BACKEND_URL (or the built-in default) so a
 * later `next start` cannot silently proxy to the smoke stub. Runs on both the
 * success and failure paths; verifies the rewrite destination afterwards.
 */
async function restoreDefaultBuild() {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  if (originalBackendUrl === undefined) delete env.BACKEND_URL;
  else env.BACKEND_URL = originalBackendUrl;

  const target = expectedBackendBaseUrl();
  console.log(`\n  build:  restoring the production build for ${target}`);
  const exit = await runToCompletion(
    process.execPath,
    [nextBinPath, "build"],
    { cwd: dashboardRoot, env, stdio: "inherit" },
  );
  if (exit !== 0) {
    throw new Error(`the restore build exited with code ${exit}`);
  }

  const manifest = JSON.parse(
    await readFile(join(dashboardRoot, ".next", "routes-manifest.json"), "utf8"),
  );
  const rewrite = (manifest.rewrites?.afterFiles ?? []).find(
    (entry) => entry.source === "/api/:path*",
  );
  const destination = rewrite?.destination ?? "(missing)";
  assert.ok(
    destination.startsWith(`${target}/api/`),
    `the restored build still proxies to ${destination}`,
  );
  return destination;
}

async function main() {
  nextBinPath = resolveNextBin();
  const nextBin = nextBinPath;

  console.log(`Summarly dashboard smoke check`);
  console.log(`  app:    ${appUrl}`);
  console.log(`  stub:   http://127.0.0.1:${backendPort}`);

  stub = await startStubBackend({ port: backendPort });
  const childEnv = {
    ...process.env,
    BACKEND_URL: stub.baseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  if (skipBuild) {
    console.log(
      "  build:  skipped (SMOKE_SKIP_BUILD=1; .next must target the stub URL)\n",
    );
  } else {
    console.log("  build:  next build\n");
    // From here on `.next` targets the stub. The teardown rebuilds it for the
    // caller's BACKEND_URL on success and on failure (see `restoreDefaultBuild`).
    didBuild = true;
    const buildExit = await runToCompletion(
      process.execPath,
      [nextBin, "build"],
      { cwd: dashboardRoot, env: childEnv, stdio: "inherit" },
    );
    if (buildExit !== 0) {
      throw new Error(`\`next build\` failed with exit code ${buildExit}.`);
    }
    console.log("");
  }

  appProcess = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(appPort)],
    { cwd: dashboardRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  appProcess.stdout?.on("data", (chunk) => {
    appLog += String(chunk);
  });
  appProcess.stderr?.on("data", (chunk) => {
    appLog += String(chunk);
  });

  await waitForDashboard(60_000);

  // --- checks ----------------------------------------------------------
  await check("dashboard reachable (GET /login)", async () => {
    const response = await request("/login");
    assert.equal(response.status, 200);
  });

  await check("proxy GET /api/setup/status", async () => {
    const response = await request("/api/setup/status");
    assert.equal(response.status, 200);
    assert.match(response.text, /"needsSetup":true/);
  });

  await check("setup rejects a short password with a details envelope", async () => {
    const response = await request("/api/setup", {
      method: "POST",
      body: { password: "short" },
    });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /"code":"validation_error"/);
    assert.match(response.text, /"path":"password"/);
  });

  await check("setup returns 10 recovery codes", async () => {
    const response = await request("/api/setup", {
      method: "POST",
      body: { password: "correct-horse-battery-123" },
    });
    assert.equal(response.status, 201, response.text);
    const payload = JSON.parse(response.text);
    assert.equal(payload.recoveryCodes.length, 10);
  });

  await check("setup status flips to false", async () => {
    const response = await request("/api/setup/status");
    assert.match(response.text, /"needsSetup":false/);
  });

  await check("protected route requires a session", async () => {
    cookie = "";
    const response = await request("/api/groups");
    assert.equal(response.status, 401);
    assert.match(response.text, /"code":"unauthorized"/);
  });

  await check("login rejects a wrong password", async () => {
    const response = await request("/api/auth/login", {
      method: "POST",
      body: { password: "wrong-password" },
    });
    assert.equal(response.status, 401, response.text);
  });

  await check("login sets the session cookie through the proxy", async () => {
    const response = await request("/api/auth/login", {
      method: "POST",
      body: { password: "correct-horse-battery-123" },
    });
    assert.equal(response.status, 200, response.text);
    assert.ok(
      cookie.startsWith("summarly_session="),
      "expected a summarly_session cookie",
    );
  });

  await check("authenticated GET /api/groups", async () => {
    const response = await request("/api/groups");
    assert.equal(response.status, 200, response.text);
    assert.equal(parseList(response.text).length, 2);
  });

  // --- proxy header sanitization ---------------------------------------
  // The stub records the exact headers the backend receives, so these are
  // echo captures of the real proxy path: a client must not be able to choose
  // the backend's rate-limit bucket or inject forwarding metadata.
  function stubRequestFor(path) {
    const matches = stub.getRequests().filter((entry) => entry.path === path);
    return matches.length === 0 ? null : matches[matches.length - 1];
  }

  const spoofedAddress = "203.0.113.7";
  const probePath = `/api/groups?probe=xff-${Date.now()}`;
  const spoofedHeaders = {
    "x-forwarded-for": spoofedAddress,
    "x-real-ip": "198.51.100.9",
    forwarded: `for=${spoofedAddress};proto=http`,
    "cf-connecting-ip": "203.0.113.8",
    "true-client-ip": "203.0.113.9",
    "x-client-ip": "203.0.113.10",
    // A client must not be able to fake the sanitizer's own marker.
    "x-summarly-proxy": "spoofed-by-client",
  };

  await check("spoofed x-forwarded-for never reaches the backend", async () => {
    const response = await request(probePath, { headers: spoofedHeaders });
    assert.equal(response.status, 200, response.text);
    const observed = stubRequestFor(probePath);
    assert.ok(observed !== null, "the backend never received the probe request");
    const forwarded = observed.headers["x-forwarded-for"];
    assert.ok(
      forwarded === undefined || !forwarded.includes(spoofedAddress),
      `the client-supplied x-forwarded-for reached the backend: ${forwarded}`,
    );
    // This dashboard uses the strip design (no trustworthy socket address is
    // available to Next application code), so nothing may be invented either.
    assert.equal(
      forwarded,
      undefined,
      `the strip design must forward no x-forwarded-for, got: ${forwarded}`,
    );
    assert.ok(
      !JSON.stringify(observed.headers).includes(spoofedAddress),
      "a spoofed address reached the backend in some other header",
    );
  });

  await check("spoofed x-real-ip and other client-address headers are stripped", async () => {
    const observed = stubRequestFor(probePath);
    assert.ok(observed !== null, "the backend never received the probe request");
    for (const name of [
      "x-real-ip",
      "forwarded",
      "cf-connecting-ip",
      "true-client-ip",
      "x-client-ip",
    ]) {
      assert.equal(
        observed.headers[name],
        undefined,
        `${name} reached the backend: ${observed.headers[name]}`,
      );
    }
  });

  await check("no x-forwarded-for is invented for clients that send none", async () => {
    const path = `/api/groups?probe=plain-${Date.now()}`;
    const response = await request(path);
    assert.equal(response.status, 200, response.text);
    const observed = stubRequestFor(path);
    assert.ok(observed !== null, "the backend never received the probe request");
    assert.equal(observed.headers["x-forwarded-for"], undefined);
    assert.equal(observed.headers["x-real-ip"], undefined);
  });

  await check("the sanitizer's marker reaches the backend (override applied)", async () => {
    const observed = stubRequestFor(probePath);
    assert.ok(observed !== null, "the backend never received the probe request");
    assert.equal(
      observed.headers["x-summarly-proxy"],
      "strip",
      `expected x-summarly-proxy: strip, got: ${observed.headers["x-summarly-proxy"]}`,
    );
  });

  await check("session cookie still reaches the backend after sanitization", async () => {
    const observed = stubRequestFor(probePath);
    assert.ok(observed !== null, "the backend never received the probe request");
    assert.match(String(observed.headers.cookie ?? ""), /summarly_session=/);
  });

  const groupId = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";

  await check("group PATCH surfaces validation details", async () => {
    const response = await request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { timezone: "Not/AZone" },
    });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /"path":"timezone"/);
  });

  await check("group PATCH clears the cutoff with summaryTime:null", async () => {
    const response = await request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { summaryTime: null },
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"summaryTime":null/);
  });

  const projectGroupId = "11111111-2222-4333-8444-555555555555";

  await check("history import on an unmonitored group is rejected with 409", async () => {
    const response = await request(`/api/groups/${projectGroupId}/history-import`, {
      method: "POST",
    });
    assert.equal(response.status, 409, response.text);
    assert.match(response.text, /"code":"conflict"/);
    assert.match(response.text, /must be monitored/i);
  });

  await check("history import request returns 202 with pending state", async () => {
    const response = await request(`/api/groups/${groupId}/history-import`, {
      method: "POST",
    });
    assert.equal(response.status, 202, response.text);
    const payload = JSON.parse(response.text);
    assert.equal(payload.historyImport.status, "pending");
    assert.equal(payload.historyImport.importedCount, 0);
    assert.equal(payload.historyImport.error, null);
  });

  await check("repeated history import returns 200 (idempotent)", async () => {
    const response = await request(`/api/groups/${groupId}/history-import`, {
      method: "POST",
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"status":"pending"/);
  });

  await check("PATCH never changes the system-managed history import", async () => {
    const response = await request(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: { monitored: true, timezone: "Europe/Madrid", summaryTime: "08:30" },
    });
    assert.equal(response.status, 200, response.text);
    const payload = JSON.parse(response.text);
    assert.equal(payload.historyImport.status, "pending");
  });

  await check("GET /api/groups/:id returns the group", async () => {
    const response = await request(`/api/groups/${groupId}`);
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"name":"Family Chat"/);
    assert.match(response.text, /"chatId":/);
  });

  await check("GET /api/groups/:id returns 404 for an unknown group", async () => {
    const response = await request(
      "/api/groups/00000000-0000-4000-8000-000000000000",
    );
    assert.equal(response.status, 404, response.text);
    assert.match(response.text, /"code":"not_found"/);
  });

  await check("GET /api/groups/:id/members returns the roster", async () => {
    const response = await request(`/api/groups/${groupId}/members`);
    assert.equal(response.status, 200, response.text);
    const members = parseList(response.text);
    assert.equal(members.length, 3);
    assert.equal(members[0].isAdmin, true);
    assert.ok(members.some((member) => member.active === false));
  });

  await check("member rosters require a monitored group (409)", async () => {
    const response = await request(`/api/groups/${projectGroupId}/members`);
    assert.equal(response.status, 409, response.text);
    assert.match(response.text, /"code":"conflict"/);
  });

  await check("GET messages returns the newest page with a cursor", async () => {
    const response = await request(
      `/api/groups/${groupId}/messages?limit=2`,
    );
    assert.equal(response.status, 200, response.text);
    const page = JSON.parse(response.text);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].id, "11111111-1111-4111-8111-111111111111");
    assert.equal(page.nextCursor, "cursor-2");
  });

  await check("following the message cursor loads older messages", async () => {
    const response = await request(
      `/api/groups/${groupId}/messages?limit=2&cursor=cursor-2`,
    );
    assert.equal(response.status, 200, response.text);
    const page = JSON.parse(response.text);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].id, "33333333-3333-4333-8333-333333333333");
    assert.equal(page.nextCursor, null);
  });

  await check("the message range filters on half-open instants", async () => {
    const response = await request(
      `/api/groups/${groupId}/messages?from=2026-11-04T00:00:00.000Z&to=2026-11-05T00:00:00.000Z`,
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(JSON.parse(response.text).items.length, 2);
  });

  await check("an invalid message range is rejected", async () => {
    const response = await request(
      `/api/groups/${groupId}/messages?from=2026-11-05T00:00:00.000Z&to=2026-11-04T00:00:00.000Z`,
    );
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /"code":"validation_error"/);
  });

  await check("an invalid message cursor is rejected", async () => {
    const response = await request(
      `/api/groups/${groupId}/messages?cursor=not-a-cursor`,
    );
    assert.equal(response.status, 400, response.text);
  });

  await check("GET /api/groups/:id/summaries returns past summaries", async () => {
    const response = await request(`/api/groups/${groupId}/summaries`);
    assert.equal(response.status, 200, response.text);
    const summaries = parseList(response.text);
    assert.equal(summaries.length, 1);
    assert.match(response.text, /"provider":"openai"/);
    assert.match(response.text, /"interval":/);
  });

  await check("run request surfaces interval errors", async () => {
    const response = await request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-29T00:00:00.000Z",
          end: "2026-10-28T00:00:00.000Z",
          timezone: "Europe/Madrid",
        },
      },
    });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /interval\.end/);
  });

  const interval = {
    start: "2026-10-20T00:00:00.000Z",
    end: "2026-10-21T00:00:00.000Z",
    timezone: "Europe/Madrid",
  };

  await check("run create returns 201", async () => {
    const response = await request("/api/summary-runs", {
      method: "POST",
      body: { groupId, interval },
    });
    assert.equal(response.status, 201, response.text);
  });

  await check("identical run returns 200 (already requested)", async () => {
    const response = await request("/api/summary-runs", {
      method: "POST",
      body: { groupId, interval },
    });
    assert.equal(response.status, 200, response.text);
  });

  await check("run create accepts custom instructions", async () => {
    const response = await request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-22T00:00:00.000Z",
          end: "2026-10-23T00:00:00.000Z",
          timezone: "Europe/Madrid",
        },
        instructions: "Focus on decisions and deadlines; ignore small talk.",
      },
    });
    assert.equal(response.status, 201, response.text);
    assert.match(response.text, /"instructions":"Focus on decisions/);
  });

  await check("run create rejects instructions over 2000 characters", async () => {
    const response = await request("/api/summary-runs", {
      method: "POST",
      body: {
        groupId,
        interval: {
          start: "2026-10-24T00:00:00.000Z",
          end: "2026-10-25T00:00:00.000Z",
          timezone: "Europe/Madrid",
        },
        instructions: "x".repeat(2001),
      },
    });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /"path":"instructions"/);
  });

  await check("run list returns items", async () => {
    const response = await request("/api/summary-runs");
    assert.equal(response.status, 200, response.text);
    const payload = JSON.parse(response.text);
    assert.ok(payload.items.length >= 3);
  });

  await check("completed run has a summary", async () => {
    const response = await request(
      "/api/summary-runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/summary",
    );
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"aiGenerated":true/);
  });

  await check("pending run summary is 404", async () => {
    const response = await request(
      "/api/summary-runs/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff/summary",
    );
    assert.equal(response.status, 404, response.text);
  });

  await check("retry of a completed run returns 409", async () => {
    const response = await request(
      "/api/summary-runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/retry",
      { method: "POST" },
    );
    assert.equal(response.status, 409, response.text);
    assert.match(response.text, /"code":"conflict"/);
  });

  await check("retry of a failed run returns pending", async () => {
    const response = await request(
      "/api/summary-runs/cccccccc-dddd-4eee-8fff-000000000000/retry",
      { method: "POST" },
    );
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"status":"pending"/);
  });

  await check("provider config is 404 when unset", async () => {
    const response = await request("/api/settings/ai-provider");
    assert.equal(response.status, 404, response.text);
  });

  await check("provider save reports hasApiKey without echoing the key", async () => {
    const secret = "sk-smoke-not-a-real-key";
    const response = await request("/api/settings/ai-provider", {
      method: "PUT",
      body: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: null,
        apiKey: secret,
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"hasApiKey":true/);
    assert.ok(!response.text.includes(secret), "response echoed the API key");
  });

  await check("provider key can be removed with apiKey:null", async () => {
    const response = await request("/api/settings/ai-provider", {
      method: "PUT",
      body: { provider: "openai", model: "gpt-4o-mini", baseUrl: null, apiKey: null },
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"hasApiKey":false/);
  });

  const pages = [
    ["/", 200],
    ["/groups", 200],
    ["/groups/4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e", 200],
    ["/connection", 200],
    ["/runs", 200],
    ["/runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 200],
    ["/settings", 200],
    ["/login", 200],
    ["/setup", 200],
    ["/recover", 200],
    ["/does-not-exist", 404],
  ];

  let homeHtml = "";

  for (const [page, expected] of pages) {
    await check(`page ${page} responds ${expected}`, async () => {
      const response = await request(page);
      assert.equal(response.status, expected, response.text.slice(0, 300));
      assert.match(response.text, /<html/i);
      if (page === "/") homeHtml = response.text;
    });
  }

  await check("app shell renders navigation", async () => {
    assert.match(homeHtml, /Summary runs/);
    assert.match(homeHtml, /Sign out/);
  });

  await check("setup screen renders its first-run copy", async () => {
    const response = await request("/setup");
    assert.match(
      response.text,
      /First-time setup|Checking this installation/,
    );
  });

  await check("login screen renders the sign-in form", async () => {
    const response = await request("/login");
    assert.match(response.text, /Sign in/);
  });

  await check("run detail screen renders", async () => {
    const response = await request(
      "/runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    assert.match(response.text, /Summary run/);
  });

  await check("session cookie value never appears in served HTML", async () => {
    assert.equal(cookie.length > 0, true, "no session cookie captured");
    assert.ok(
      !homeHtml.includes(SESSION_VALUE),
      "the session cookie value was rendered into HTML",
    );
  });

  await check("no backend origin in client bundles", async () => {
    await assertNoBackendOriginInClientBundles();
  });

  await check("GET /api/connection includes the linking field", async () => {
    const response = await request("/api/connection");
    assert.equal(response.status, 200, response.text);
    const payload = JSON.parse(response.text);
    assert.ok("linking" in payload, "linking is missing");
    assert.equal(payload.state, "connected");
    assert.equal(payload.linking, null);
  });

  await check("connection unlink returns 202 and is idempotent", async () => {
    const first = await request("/api/connection/logout", { method: "POST" });
    assert.equal(first.status, 202, first.text);
    const second = await request("/api/connection/logout", { method: "POST" });
    assert.equal(second.status, 202, second.text);
  });

  await check("the connection publishes a pairing ticket after unlink", async () => {
    const response = await request("/api/connection");
    assert.equal(response.status, 200, response.text);
    const payload = JSON.parse(response.text);
    assert.equal(payload.state, "connecting");
    assert.equal(typeof payload.linking.qr, "string");
    assert.equal(payload.linking.kind, "qr");
    assert.ok(payload.linking.qr.length > 0);
    assert.ok(!Number.isNaN(Date.parse(payload.linking.expiresAt)));
  });

  await check("logout succeeds", async () => {
    const response = await request("/api/auth/logout", { method: "POST" });
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /"ok":true/);
  });
}

main()
  .catch((error) => {
    results.push({
      name: "smoke run",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  })
  .finally(async () => {
    await cleanup();
    if (didBuild) {
      // Give the terminated server a moment to release `.next` on Windows.
      await delay(500);
      try {
        const destination = await restoreDefaultBuild();
        results.push({
          name: "production build restored for the caller's BACKEND_URL",
          ok: true,
          detail: destination,
        });
      } catch (error) {
        results.push({
          name: "production build restored for the caller's BACKEND_URL",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const failed = report();
    process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
  });
