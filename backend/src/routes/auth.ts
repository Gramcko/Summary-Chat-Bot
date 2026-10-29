import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ChangePasswordRequest,
  LoginRequest,
  OkResponse,
  RecoverRequest,
} from "@summarly/contracts";
import { HttpError } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { hashRecoveryCode } from "../lib/recovery-codes.js";
import { nowIso, type InMemoryStore } from "../lib/store.js";

export const SESSION_COOKIE = "summarly_session";

const MAX_FAILED_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

/**
 * Shared per-IP lockout for credential guessing (login passwords and
 * recovery codes alike).
 */
function assertNotRateLimited(store: InMemoryStore, ip: string): void {
  const attempts = store.loginAttempts.get(ip);
  if (attempts !== undefined && attempts.lockedUntil > Date.now()) {
    throw new HttpError(
      429,
      "rate_limited",
      "Too many failed attempts. Try again later.",
    );
  }
}

function recordFailedAttempt(store: InMemoryStore, ip: string): void {
  const attempts = store.loginAttempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  attempts.count += 1;
  if (attempts.count >= MAX_FAILED_ATTEMPTS) {
    attempts.count = 0;
    attempts.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
  store.loginAttempts.set(ip, attempts);
}

/** onRequest hook: rejects requests without a valid session cookie. */
export function requireAuth(store: InMemoryStore) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || !store.sessions.has(token)) {
      throw new HttpError(401, "unauthorized", "Authentication required.");
    }
  };
}

export interface AuthOptions {
  cookieSecure: boolean;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
  options: AuthOptions,
): void {
  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginRequest.parse(request.body);
    assertNotRateLimited(store, request.ip);

    const valid =
      store.admin !== null &&
      verifyPassword(body.password, store.admin.passwordHash);
    if (!valid) {
      recordFailedAttempt(store, request.ip);
      throw new HttpError(401, "unauthorized", "Invalid password.");
    }

    store.loginAttempts.delete(request.ip);
    const token = randomBytes(32).toString("hex");
    store.sessions.set(token, { createdAt: nowIso() });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: options.cookieSecure,
      path: "/",
    });
    return OkResponse.parse({ ok: true });
  });

  app.post("/api/auth/recover", async (request) => {
    const body = RecoverRequest.parse(request.body);
    assertNotRateLimited(store, request.ip);
    if (store.admin === null) {
      throw new HttpError(404, "not_found", "No administrator account exists.");
    }
    const codeHash = hashRecoveryCode(body.recoveryCode);
    if (!store.admin.recoveryCodeHashes.has(codeHash)) {
      recordFailedAttempt(store, request.ip);
      throw new HttpError(401, "unauthorized", "Invalid recovery code.");
    }
    // Single use: consume the code, reset the password, drop all sessions.
    store.loginAttempts.delete(request.ip);
    store.admin.recoveryCodeHashes.delete(codeHash);
    store.admin.passwordHash = hashPassword(body.newPassword);
    store.sessions.clear();
    return OkResponse.parse({ ok: true });
  });
}

/** Session-scoped auth routes. Register behind requireAuth. */
export function registerSessionRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
): void {
  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) store.sessions.delete(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return OkResponse.parse({ ok: true });
  });

  app.post("/api/auth/password", async (request) => {
    const body = ChangePasswordRequest.parse(request.body);
    const admin = store.admin;
    if (
      admin === null ||
      !verifyPassword(body.currentPassword, admin.passwordHash)
    ) {
      throw new HttpError(401, "unauthorized", "Current password is incorrect.");
    }
    admin.passwordHash = hashPassword(body.newPassword);
    store.sessions.clear();
    return OkResponse.parse({ ok: true });
  });
}
