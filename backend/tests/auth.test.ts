import { describe, expect, it } from "vitest";
import { ApiError, OkResponse } from "@summarly/contracts";
import {
  ADMIN_PASSWORD,
  login,
  makeApp,
  NEW_PASSWORD,
  setupAdmin,
} from "./helpers.js";

describe("login", () => {
  it("rejects a wrong password with the standard error envelope", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong-password-123" },
    });
    expect(res.statusCode).toBe(401);
    expect(ApiError.parse(res.json()).error.code).toBe("unauthorized");
  });

  it("sets a strict httpOnly session cookie on success", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(OkResponse.parse(res.json())).toEqual({ ok: true });
    const cookieHeader = String(res.headers["set-cookie"]);
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
  });

  it("rejects a login attempt before setup without revealing setup state", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "any-password-at-all-123" },
    });
    expect(res.statusCode).toBe(401);
    expect(ApiError.parse(res.json()).error.code).toBe("unauthorized");
  });

  it("rate-limits repeated failures and sends Retry-After", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "wrong-password-123" },
      });
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
    expect(ApiError.parse(locked.json()).error.code).toBe("rate_limited");
    const retryAfter = Number(locked.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});

describe("protected routes", () => {
  it("rejects requests without a session", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/groups" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts requests with a valid session and logout invalidates it", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const ok = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(ok.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: session },
    });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("recovery codes (option A)", () => {
  it("resets the password with a valid code and consumes it", async () => {
    const { app } = await makeApp();
    const codes = await setupAdmin(app);
    const code = codes[0];
    if (code === undefined) throw new Error("no recovery code generated");

    const recover = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { recoveryCode: code, newPassword: NEW_PASSWORD },
    });
    expect(recover.statusCode).toBe(200);

    // Old password no longer works; the new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: NEW_PASSWORD },
    });
    expect(newLogin.statusCode).toBe(200);

    // The code is single-use.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { recoveryCode: code, newPassword: ADMIN_PASSWORD },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("returns 404 when no admin exists yet", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: {
        recoveryCode: "0000-0000-0000-0000-0000-0000-0000-0000",
        newPassword: NEW_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("invalidates all existing sessions", async () => {
    const { app } = await makeApp();
    const codes = await setupAdmin(app);
    const session = await login(app);
    const code = codes[1];
    if (code === undefined) throw new Error("no recovery code generated");

    const recover = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { recoveryCode: code, newPassword: NEW_PASSWORD },
    });
    expect(recover.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(after.statusCode).toBe(401);
  });

  it("rejects an unknown recovery code", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { recoveryCode: "0000-0000-0000", newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("change password", () => {
  it("requires the current password and invalidates existing sessions", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: session },
      payload: { currentPassword: "wrong-password-123", newPassword: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: session },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    // Sessions were dropped on password change.
    const after = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(after.statusCode).toBe(401);
  });
});
