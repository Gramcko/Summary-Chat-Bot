import { describe, expect, it } from "vitest";
import { ApiError, SetupStatus } from "@summarly/contracts";
import { ADMIN_PASSWORD, makeApp, setupAdmin } from "./helpers.js";

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
});
