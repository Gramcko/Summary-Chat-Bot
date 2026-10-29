import { describe, expect, it } from "vitest";
import { ApiError, Group } from "@summarly/contracts";
import { GROUP_ID, login, makeApp, seedGroup, setupAdmin } from "./helpers.js";

async function authedApp() {
  const ctx = await makeApp();
  await setupAdmin(ctx.app);
  await seedGroup(ctx.store);
  const session = await login(ctx.app);
  return { ...ctx, session };
}

describe("groups", () => {
  it("lists seeded groups", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/groups",
      headers: { cookie: session },
    });
    expect(res.statusCode).toBe(200);
    const groups = res.json() as unknown[];
    expect(groups).toHaveLength(1);
    expect(Group.parse(groups[0]).id).toBe(GROUP_ID);
  });

  it("updates monitoring and time zone preferences", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { monitored: false, timezone: "America/Bogota", summaryTime: "06:30" },
    });
    expect(res.statusCode).toBe(200);
    const group = Group.parse(res.json());
    expect(group.monitored).toBe(false);
    expect(group.timezone).toBe("America/Bogota");
    expect(group.summaryTime).toBe("06:30");
  });

  it("clears summaryTime with an explicit null", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { summaryTime: null },
    });
    expect(Group.parse(res.json()).summaryTime).toBeNull();
  });

  it("rejects invalid time zones and cutoff times", async () => {
    const { app, session } = await authedApp();
    const badZone = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { timezone: "Not/AZone" },
    });
    expect(badZone.statusCode).toBe(400);
    expect(ApiError.parse(badZone.json()).error.code).toBe("validation_error");

    const badTime = await app.inject({
      method: "PATCH",
      url: `/api/groups/${GROUP_ID}`,
      headers: { cookie: session },
      payload: { summaryTime: "25:99" },
    });
    expect(badTime.statusCode).toBe(400);
  });

  it("404s for an unknown group id", async () => {
    const { app, session } = await authedApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/groups/00000000-0000-4000-8000-000000000000",
      headers: { cookie: session },
      payload: { monitored: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
