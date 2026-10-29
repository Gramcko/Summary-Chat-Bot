import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ChangePasswordRequest,
  LoginRequest,
  OkResponse,
  RecoverRequest,
} from "@summarly/contracts";
import { HttpError } from "../lib/errors.js";
import { LoginRateLimiter } from "../lib/login-rate-limit.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { hashRecoveryCode } from "../lib/recovery-codes.js";
import type { Store } from "../lib/store.js";

export const SESSION_COOKIE = "summarly_session";

/**
 * A fixed valid scrypt hash used to equalize the work done by /login
 * when no administrator exists yet (N1): "setup not done" must not be
 * distinguishable from "wrong password" through response timing.
 */
const DUMMY_PASSWORD_HASH = hashPassword("timing-equalizer-not-a-real-secret");

/** onRequest hook: rejects requests without a valid session cookie. */
export function requireAuth(store: Store) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || !(await store.validateSession(token))) {
      throw new HttpError(401, "unauthorized", "Authentication required.");
    }
  };
}

export interface AuthOptions {
  cookieSecure: boolean;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: Store,
  options: AuthOptions,
): void {
  // Per-IP guessing limit shared by login and recovery. In-memory by
  // design: an operational guard, not business data. request.ip honors
  // X-Forwarded-For only from TRUSTED_PROXIES (see app.ts).
  const rateLimiter = new LoginRateLimiter();

  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginRequest.parse(request.body);
    rateLimiter.assertNotRateLimited(request.ip);

    const admin = await store.getAdmin();
    // Always run the scrypt verification (against a dummy hash when no
    // admin exists) so the response time does not reveal setup state.
    const valid = verifyPassword(body.password, admin?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (admin === null || !valid) {
      rateLimiter.recordFailedAttempt(request.ip);
      throw new HttpError(401, "unauthorized", "Invalid password.");
    }

    rateLimiter.reset(request.ip);
    const token = randomBytes(32).toString("hex");
    await store.createSession(token);
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
    rateLimiter.assertNotRateLimited(request.ip);
    const admin = await store.getAdmin();
    if (admin === null) {
      throw new HttpError(404, "not_found", "No administrator account exists.");
    }
    const codeHash = hashRecoveryCode(body.recoveryCode);
    if (!admin.recoveryCodeHashes.has(codeHash)) {
      rateLimiter.recordFailedAttempt(request.ip);
      throw new HttpError(401, "unauthorized", "Invalid recovery code.");
    }
    // Single use: consuming the code, resetting the password, and
    // evicting every session happen in one atomic store operation.
    const consumed = await store.consumeRecoveryCode(
      codeHash,
      hashPassword(body.newPassword),
    );
    if (!consumed) {
      rateLimiter.recordFailedAttempt(request.ip);
      throw new HttpError(401, "unauthorized", "Invalid recovery code.");
    }
    rateLimiter.reset(request.ip);
    return OkResponse.parse({ ok: true });
  });
}

/** Session-scoped auth routes. Register behind requireAuth. */
export function registerSessionRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) await store.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return OkResponse.parse({ ok: true });
  });

  app.post("/api/auth/password", async (request) => {
    const body = ChangePasswordRequest.parse(request.body);
    const admin = await store.getAdmin();
    if (
      admin === null ||
      !verifyPassword(body.currentPassword, admin.passwordHash)
    ) {
      throw new HttpError(401, "unauthorized", "Current password is incorrect.");
    }
    // Password change and session eviction commit together (M9).
    await store.updateAdminPassword({
      passwordHash: hashPassword(body.newPassword),
    });
    return OkResponse.parse({ ok: true });
  });
}
