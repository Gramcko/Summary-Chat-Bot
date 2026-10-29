import { CreateAdminResponse } from "@summarly/contracts";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/lib/store.js";
import { SESSION_COOKIE } from "../src/routes/auth.js";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

export const ADMIN_PASSWORD = "correct-horse-battery-123";
export const NEW_PASSWORD = "new-secret-password-456";
export const GROUP_ID = "4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e";

export async function makeApp(): Promise<{ app: TestApp; store: InMemoryStore }> {
  const store = new InMemoryStore();
  const app = await buildApp({ store, cookieSecure: false, logger: false });
  return { app, store };
}

export async function setupAdmin(app: TestApp): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { password: ADMIN_PASSWORD },
  });
  return CreateAdminResponse.parse(res.json()).recoveryCodes;
}

export async function login(app: TestApp): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: ADMIN_PASSWORD },
  });
  const session = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
  if (session === undefined) {
    throw new Error("login did not set a session cookie");
  }
  return `${SESSION_COOKIE}=${session.value}`;
}

export async function seedGroup(store: InMemoryStore): Promise<void> {
  await store.upsertGroup({
    id: GROUP_ID,
    chatId: null,
    name: "Test Group",
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
  });
}
