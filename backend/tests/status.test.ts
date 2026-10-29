import { describe, expect, it } from "vitest";
import { ConnectionStatus } from "@summarly/contracts";
import { login, makeApp, setupAdmin } from "./helpers.js";

describe("health and read-only status routes", () => {
  it("answers the health probe without authentication", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports the connection status", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    expect(ConnectionStatus.parse(res.json()).state).toBe("unavailable");
  });

  it("returns 404 for a summary that does not exist yet", async () => {
    const { app } = await makeApp();
    await setupAdmin(app);
    const session = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/summaries/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(404);
  });
});
