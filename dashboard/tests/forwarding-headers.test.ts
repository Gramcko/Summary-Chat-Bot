import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_ADDRESS_HEADERS,
  PROXY_MARKER_HEADER,
  PROXY_MARKER_VALUE,
  sanitizeForwardingHeaders,
} from "../src/lib/forwarding-headers.ts";

/**
 * Unit tests for the proxy's header sanitization. The end-to-end wiring (that
 * these headers really are gone when the backend receives the request) is
 * asserted by `scripts/smoke.mjs` against the contract test double.
 */

test("strips every listed client-address header", () => {
  const incoming = new Headers({
    "x-forwarded-for": "203.0.113.7",
    "x-real-ip": "198.51.100.9",
    forwarded: "for=203.0.113.7;proto=http",
    "x-client-ip": "203.0.113.8",
    "x-original-forwarded-for": "203.0.113.9",
    "x-original-ip": "203.0.113.10",
    "cf-connecting-ip": "203.0.113.11",
    "true-client-ip": "203.0.113.12",
    "fastly-client-ip": "203.0.113.13",
    "x-cluster-client-ip": "203.0.113.14",
  });

  const sanitized = sanitizeForwardingHeaders(incoming);

  for (const name of CLIENT_ADDRESS_HEADERS) {
    assert.equal(sanitized.get(name), null, `${name} was forwarded`);
  }
});

test("the contract headers are covered", () => {
  assert.ok(CLIENT_ADDRESS_HEADERS.includes("x-forwarded-for"));
  assert.ok(CLIENT_ADDRESS_HEADERS.includes("x-real-ip"));
  assert.ok(CLIENT_ADDRESS_HEADERS.includes("forwarded"));
});

test("strips header names case-insensitively", () => {
  const incoming = new Headers();
  incoming.set("X-Forwarded-For", "203.0.113.7");
  incoming.set("X-Real-IP", "198.51.100.9");

  const sanitized = sanitizeForwardingHeaders(incoming);

  assert.equal(sanitized.get("x-forwarded-for"), null);
  assert.equal(sanitized.get("x-real-ip"), null);
});

test("strips spoofed chains, not just single addresses", () => {
  const incoming = new Headers({
    "x-forwarded-for": "203.0.113.7, 10.0.0.1, 127.0.0.1",
  });

  const sanitized = sanitizeForwardingHeaders(incoming);

  assert.equal(sanitized.get("x-forwarded-for"), null);
});

test("keeps the session, content, and unrelated headers", () => {
  const incoming = new Headers({
    cookie: "summarly_session=abc123",
    accept: "application/json",
    "content-type": "application/json",
    "x-custom-client": "keep-me",
    authorization: "Bearer dashboard-forwarded",
    "x-forwarded-for": "203.0.113.7",
  });

  const sanitized = sanitizeForwardingHeaders(incoming);

  assert.equal(sanitized.get("cookie"), "summarly_session=abc123");
  assert.equal(sanitized.get("accept"), "application/json");
  assert.equal(sanitized.get("content-type"), "application/json");
  assert.equal(sanitized.get("x-custom-client"), "keep-me");
  assert.equal(sanitized.get("authorization"), "Bearer dashboard-forwarded");
  assert.equal(sanitized.get("x-forwarded-for"), null);
});

test("does not mutate the original request headers", () => {
  const incoming = new Headers({ "x-forwarded-for": "203.0.113.7" });

  sanitizeForwardingHeaders(incoming);

  assert.equal(incoming.get("x-forwarded-for"), "203.0.113.7");
});

test("always sets the proxy marker, even for header-less requests", () => {
  const sanitized = sanitizeForwardingHeaders(new Headers());

  // Fail-open guard: an empty override is ignored by Next, so the marker must
  // make the sanitized header set non-empty unconditionally.
  assert.equal(sanitized.get(PROXY_MARKER_HEADER), PROXY_MARKER_VALUE);
  assert.deepEqual([...sanitized.keys()], [PROXY_MARKER_HEADER]);
  assert.equal(sanitized.get("x-forwarded-for"), null);
});

test("overwrites a client-supplied proxy marker", () => {
  const incoming = new Headers({ [PROXY_MARKER_HEADER]: "spoofed-by-client" });

  const sanitized = sanitizeForwardingHeaders(incoming);

  assert.equal(sanitized.get(PROXY_MARKER_HEADER), PROXY_MARKER_VALUE);
  assert.equal(incoming.get(PROXY_MARKER_HEADER), "spoofed-by-client");
});

test("keeps the marker alongside the headers it forwards", () => {
  const incoming = new Headers({
    cookie: "summarly_session=abc123",
    "x-forwarded-for": "203.0.113.7",
  });

  const sanitized = sanitizeForwardingHeaders(incoming);

  assert.equal(sanitized.get(PROXY_MARKER_HEADER), PROXY_MARKER_VALUE);
  assert.equal(sanitized.get("cookie"), "summarly_session=abc123");
  assert.deepEqual([...sanitized.keys()].sort(), ["cookie", PROXY_MARKER_HEADER]);
});
