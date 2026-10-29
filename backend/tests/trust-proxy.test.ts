import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/lib/store.js";
import { ADMIN_PASSWORD, setupAdmin } from "./helpers.js";

/**
 * Per-IP rate limiting behind reverse proxies (M3). request.ip must
 * honor X-Forwarded-For ONLY from trusted peers; otherwise a client
 * could pick its own lockout bucket by spoofing the header (or a shared
 * proxy bucket could lock every admin out at once).
 */

async function appWith(trustProxy?: string[]) {
  const store = new InMemoryStore();
  const app = await buildApp({ store, cookieSecure: false, logger: false, trustProxy });
  await setupAdmin(app);
  return app;
}

function failedLogin(
  app: Awaited<ReturnType<typeof buildApp>>,
  forwardedFor: string,
  remoteAddress: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-forwarded-for": forwardedFor },
    remoteAddress,
    payload: { password: "wrong-password-123" },
  });
}

describe("rate limiting and reverse proxies", () => {
  it("ignores X-Forwarded-For on direct connections (single bucket)", async () => {
    const app = await appWith();
    // Five failures from "different" spoofed clients still share the
    // socket's bucket when no proxy is trusted.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await failedLogin(app, `203.0.113.${attempt}`, "127.0.0.1");
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "203.0.113.99" },
      remoteAddress: "127.0.0.1",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
  });

  it("buckets by forwarded client IP when the peer is a trusted proxy", async () => {
    const app = await appWith(["127.0.0.1"]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await failedLogin(app, "203.0.113.1", "127.0.0.1");
      expect(res.statusCode).toBe(401);
    }
    // The first client is locked out...
    const locked = await failedLogin(app, "203.0.113.1", "127.0.0.1");
    expect(locked.statusCode).toBe(429);
    // ...but another client behind the same proxy has its own bucket.
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "203.0.113.2" },
      remoteAddress: "127.0.0.1",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(other.statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For from untrusted peers", async () => {
    const app = await appWith(["10.0.0.1"]);
    // The immediate peer is not a trusted proxy: spoofed headers are
    // ignored and every request lands in the socket's bucket.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await failedLogin(app, `203.0.113.${attempt}`, "203.0.113.9");
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "203.0.113.50" },
      remoteAddress: "203.0.113.9",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
  });
});
