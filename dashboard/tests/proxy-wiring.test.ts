import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PROXY_MATCHER } from "../src/lib/proxy-matcher.ts";

/**
 * Wiring tests for `src/proxy.ts`.
 *
 * `next/server` cannot be imported outside a Next build, so these tests read
 * the proxy source and assert the things that silently break the sanitization:
 * the file still exists at the path Next expects, it still exports the handler
 * and config, it still calls the sanitizer, and its (static, required) matcher
 * literal still equals the canonical pattern and covers the sensitive API paths.
 * The runtime behaviour is asserted end to end by `scripts/smoke.mjs`.
 */

const PROXY_SOURCE_URL = new URL("../src/proxy.ts", import.meta.url);

/**
 * Documented subset of Next.js matcher semantics (path-to-regexp) covering the
 * patterns this app uses: literal segments plus `:name`, `:name*`, `:name+`,
 * and `:name?` parameters. Not a general path-to-regexp implementation.
 */
function compileMatcher(pattern: string): RegExp {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let source = "";
  for (const segment of segments) {
    if (!segment.startsWith(":")) {
      source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
      continue;
    }
    const modifier = segment.slice(-1);
    if (modifier === "*") source += "(?:/.*)?";
    else if (modifier === "+") source += "/.+";
    else if (modifier === "?") source += "(?:/[^/]+)?";
    else source += "/[^/]+";
  }
  return new RegExp(`^${source}/?$`);
}

function coveredBy(matcher: readonly string[], pathname: string): boolean {
  return matcher.some((pattern) => compileMatcher(pattern).test(pathname));
}

function readMatcherLiteral(source: string): string[] {
  const match = /matcher\s*:\s*\[([^\]]*)\]/.exec(source);
  assert.ok(
    match !== null,
    "src/proxy.ts must declare `matcher: [...]` as a static array literal",
  );
  const captured = match[1];
  assert.ok(captured !== undefined, "could not read the matcher literal");
  const values = [...captured.matchAll(/"([^"]+)"/g)]
    .map((entry) => entry[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(values.length > 0, "the matcher literal has no entries");
  return values;
}

test("src/proxy.ts still exports the handler and config", async () => {
  const source = await readFile(PROXY_SOURCE_URL, "utf8");

  assert.match(source, /export\s+function\s+proxy\s*\(\s*request/, "proxy() is missing");
  assert.match(source, /export\s+const\s+config\s*=/, "config export is missing");
  assert.match(
    source,
    /sanitizeForwardingHeaders\s*\(\s*request\.headers\s*\)/,
    "the handler no longer sanitizes the request headers",
  );
});

test("the matcher literal matches the canonical pattern", async () => {
  const source = await readFile(PROXY_SOURCE_URL, "utf8");

  assert.deepEqual(
    readMatcherLiteral(source),
    PROXY_MATCHER,
    "config.matcher drifted from src/lib/proxy-matcher.ts",
  );
});

test("the matcher covers every sensitive backend path", async () => {
  const matcher = readMatcherLiteral(await readFile(PROXY_SOURCE_URL, "utf8"));

  for (const pathname of [
    "/api",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/password",
    "/api/auth/recover",
    "/api/setup",
    "/api/setup/status",
    "/api/connection",
    "/api/groups",
    "/api/groups/4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e",
    "/api/summary-runs",
    "/api/summary-runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "/api/summary-runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/retry",
    "/api/summary-runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/summary",
    "/api/settings/ai-provider",
  ]) {
    assert.equal(coveredBy(matcher, pathname), true, `${pathname} is not proxied`);
  }
});

test("the matcher does not shadow page routes", async () => {
  const matcher = readMatcherLiteral(await readFile(PROXY_SOURCE_URL, "utf8"));

  for (const pathname of [
    "/",
    "/login",
    "/recover",
    "/setup",
    "/groups",
    "/runs",
    "/runs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "/settings",
    "/apiary",
    "/api-docs",
  ]) {
    assert.equal(coveredBy(matcher, pathname), false, `${pathname} is proxied`);
  }
});

test("the matcher model behaves like Next's path-to-regexp subset", () => {
  assert.equal(compileMatcher("/api/:path*").test("/api"), true);
  assert.equal(compileMatcher("/api/:path*").test("/api/"), true);
  assert.equal(compileMatcher("/api/:path*").test("/api/a/b"), true);
  assert.equal(compileMatcher("/api/:path*").test("/apix"), false);
  assert.equal(compileMatcher("/api/:path+").test("/api"), false);
  assert.equal(compileMatcher("/api/:path+").test("/api/a"), true);
  assert.equal(compileMatcher("/api/:path?").test("/api"), true);
  assert.equal(compileMatcher("/api/:path?").test("/api/a/b"), false);
  assert.equal(compileMatcher("/a.b").test("/a.b"), true);
  assert.equal(compileMatcher("/a.b").test("/axb"), false);
});
