# Summarly Chat Bot — API contract

- **Status:** Skeleton milestone. The authoritative contract is `packages/contracts`
  (Zod schemas); this document explains it for humans.
- **Base URL:** the backend service (default `http://127.0.0.1:3000`).
- **Authentication:** session cookie `summarly_session` (httpOnly, SameSite=Strict;
  `Secure` when `COOKIE_SECURE=true`).

## Conventions

- Every request and response body is validated against the schemas in
  `@summarly/contracts`. The dashboard imports the same package for types.
- Errors always use one envelope:

  ```json
  { "error": { "code": "validation_error", "message": "...", "details": [{ "path": "...", "message": "..." }] } }
  ```

  Codes: `validation_error`, `unauthorized`, `forbidden`, `not_found`,
  `conflict`, `rate_limited`, `internal`.
- Intervals are **half-open**: `start` inclusive, `end` exclusive, with an
  explicit IANA `timezone`. The server compares instants, not wall times.
- `POST /api/summary-runs` is **create-or-find**: an identical request — same
  group, same `[start, end)` instants (timestamp formats are normalized to
  instants, so `...Z` and `+02:00` spellings of the same moment are the same
  request), same kind — returns the existing run with `200`; a new run is
  created with `201`. The first request's timezone label is kept on the run
  (the label does not change which messages the interval covers).
  Safe to retry. API-created runs are always `kind: "manual"`; scheduled runs
  are created by the scheduler (architecture §5.3).
- Saved provider API keys are **write-only**: responses only report
  `hasApiKey: true|false`. No response shape contains key material. In
  `PUT /api/settings/ai-provider`, omit `apiKey` to keep the saved key or send
  `null` to clear it.

## Endpoints

### Public

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/health` | `{ "status": "ok" }` | readiness probe |
| GET | `/api/setup/status` | `SetupStatus` | `{ "needsSetup": bool }` |
| POST | `/api/setup` | `CreateAdminResponse` (201) | One-time first-run setup. Returns 10 recovery codes **exactly once**. `409` if already completed. |
| POST | `/api/auth/login` | `OkResponse` | Sets the session cookie. |
| POST | `/api/auth/recover` | `OkResponse` | Single-use recovery code + new password. Invalidates all sessions. |

Login and recovery share a per-IP guessing limit: 5 failed attempts →
15-minute lock (`429`).

### Session (authentication required)

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/logout` | `OkResponse` | Deletes the session and cookie. |
| POST | `/api/auth/password` | `OkResponse` | Requires the current password. Invalidates all sessions. |

### Application (authentication required)

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/api/connection` | `ConnectionStatus` | Non-secret WhatsApp connection state. |
| GET | `/api/groups` | `Group[]` | Monitored groups. |
| PATCH | `/api/groups/:id` | `Group` | Partial update. `summaryTime: null` clears the daily cutoff. |
| POST | `/api/summary-runs` | `SummaryRun` (201/200) | Create-or-find (see conventions). |
| GET | `/api/summary-runs` | `RunListResponse` | Newest first. `nextCursor` is `null` in the skeleton. |
| GET | `/api/summary-runs/:id` | `SummaryRun` | |
| POST | `/api/summary-runs/:id/retry` | `SummaryRun` | `failed → pending`; no-op for `pending`/`processing`; `409` for `completed` (regeneration is an open decision). |
| GET | `/api/summaries/:id` | `Summary` | `404` until the summary-worker exists. |
| GET | `/api/summary-runs/:id/summary` | `Summary` | `404` for an unknown run or a run without a summary yet. |
| GET | `/api/settings/ai-provider` | `ProviderConfigPublic` | `404` when unconfigured. Never returns key material. |
| PUT | `/api/settings/ai-provider` | `ProviderConfigPublic` | Upsert. `apiKey`: omit = keep, string = replace, `null` = clear. |

Note: `GET /api/summary-runs/:id/summary` is the primary result lookup for
a run — it returns the `Summary` schema and answers `404` (standard error
envelope) both when the run is unknown and when it has no summary yet.
With PostgreSQL persistence the backend now also requires `DATABASE_URL`
and `ENCRYPTION_KEY` (see `.env.example`); saved provider keys are stored
encrypted (AES-256-GCM) and never returned.

## Run state machine

```
pending → processing → completed
                     ↘ failed → (retry) → pending
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend listen port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` inside containers. |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `ENCRYPTION_KEY` | — (required) | Base64 for 32 random bytes; encrypts stored provider keys (AES-256-GCM) |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs/CIDRs whose `X-Forwarded-For` is trusted for client-IP derivation (rate limiting) |

## Security notes

- Passwords are hashed with scrypt (see `docs/decisions/0002`).
- Recovery codes are single-use **128-bit** codes, shown once, and stored as
  SHA-256 hashes.
- Login and recovery share the per-IP guessing limit above.
- The client IP used for that limit honors `X-Forwarded-For` **only** when the
  immediate peer is listed in `TRUSTED_PROXIES` (default: loopback, which
  covers a local dashboard proxy). Never add an untrusted address: it would
  let clients choose their own lockout bucket. With no trusted peer, the
  header is ignored and all clients share the direct-connection bucket.
  Rate-limited responses carry a `Retry-After` header.
- Password change and recovery invalidate all existing sessions.
- The backend binds to loopback by default; do not expose it to untrusted
  networks without HTTPS and a reviewed authentication model.
