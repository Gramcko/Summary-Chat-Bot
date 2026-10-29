import { describe, expect, it } from "vitest";
import { ApiError, SetupStatus } from "@summarly/contracts";
import {
  ADMIN_PASSWORD,
  makeApp,
  NEW_PASSWORD,
  setupAdmin,
} from "./helpers.js";

describe("first-run setup", () => {
  it("reports that setup is needed before an admin exists", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(SetupStatus.parse(res.json())).toEqual({ needsSetup: true });
  });

  it("rejects a password below the policy minimum", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe("validation_error");
  });

  it("creates the admin and returns ten unique recovery codes once", async () => {
    const { app } = await makeApp();
    const codes = await setupAdmin(app);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const status = await app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(SetupStatus.parse(status.json()).needsSetup).toBe(false);
  });

  it("refuses to run setup twice", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(ApiError.parse(res.json()).error.code).toBe("conflict");
  });

  it("lets exactly one of two concurrent setup requests win", async () => {
    const { app } = await makeApp();
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { password: ADMIN_PASSWORD },
      }),
      app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { password: NEW_PASSWORD },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);

    // The loser's credentials must not have overwritten the winner's.
    const winner = a.statusCode === 201 ? ADMIN_PASSWORD : NEW_PASSWORD;
    const loser = winner === ADMIN_PASSWORD ? NEW_PASSWORD : ADMIN_PASSWORD;
    const winnerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: winner },
    });
    expect(winnerLogin.statusCode).toBe(200);
    const loserLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: loser },
    });
    expect(loserLogin.statusCode).toBe(401);
  });
});
