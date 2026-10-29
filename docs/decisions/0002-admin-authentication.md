# 0002 — Administrator authentication and recovery

- **Status:** Decided (2026-10-29)

## Context

AGENTS.md requires deciding and documenting the initial
authentication/authorization model before remote access is supported;
architecture §12.5 lists it as an open decision. The MVP is a self-hosted
single-administrator installation.

## Decision

- **First-run setup wizard, no default credentials.** The first visit creates
  the administrator password (minimum 12 characters) via `POST /api/setup`,
  which is accepted exactly once (`409` afterwards).
- **Sessions:** opaque random tokens in an httpOnly, SameSite=Strict cookie
  (`Secure` when `COOKIE_SECURE=true`). Server-side session records.
- **Password storage:** scrypt with a per-password random salt (Node built-in
  `node:crypto`). Upgrade path to argon2id once native build dependencies
  are acceptable; see Follow-ups.
- **Recovery (options A + B, chosen 2026-10-29):**
  - **A — recovery codes:** ten single-use **128-bit** codes generated at
    setup, shown exactly once, stored as SHA-256 hashes (a fast hash is
    appropriate for a 128-bit secret). Consuming a code resets the password
    and invalidates all sessions.
  - **B — server-side CLI reset:** the last-resort recovery path for a
    self-hosted install. The reset helper lands with the PostgreSQL
    persistence milestone; a CLI cannot reset the skeleton's in-memory
    store, so no placeholder script ships yet.
- **Security questions were considered and rejected.** Answers are guessable
  or easily forgotten, and knowledge-based recovery is deprecated by NIST
  and OWASP guidance. If product requirements bring them back, treat them
  as an additional factor, never the only one.
- **Hardening (revised 2026-10-29 after the security review):** login and
  recovery share one soft throttle instead of a hard lock. 5 failed
  attempts within a 60-second sliding window start a 60-second cooldown
  (`429` with an accurate `Retry-After`); every attempt made while cooling
  down doubles the cooldown, capped at 5 minutes; a successful login or
  recovery clears the state. Password change and recovery invalidate all
  existing sessions.
  Behind the dashboard proxy all clients share **one** throttle bucket:
  the proxy strips client-supplied forwarding headers (the implemented
  design), so the key cannot be chosen by clients. The availability
  trade-off is explicit: one user's wrong-password spree can briefly deny
  login to others, bounded to at most 5 minutes after the last attempt —
  chosen over the earlier fixed 5-failures → 15-minute deny, which was a
  trivial availability attack once the bucket was shared. Operator escape
  hatches: the server-side CLI password reset (recovery option B) and
  restarting the backend (the throttle is in memory by design).

## Consequences

- The dashboard needs setup, login, and recovery screens (frontend
  milestone) against the endpoints in `docs/api.md`.
- Remote access still requires HTTPS and a reviewed model before it is
  supported; the backend binds loopback by default.

## Follow-ups

- CLI reset entry point at the persistence milestone.
- argon2id migration; async scrypt in request handlers (avoid blocking the
  event loop) and encoding hash parameters in the stored string.
- Session TTL / absolute expiry for stolen-cookie hardening.
- CSRF hardening review for cookie-authenticated endpoints; encryption
  master key handling for stored provider keys (architecture §7).
