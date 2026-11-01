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

Login and recovery share one soft throttle (not a hard lock): 5 failed
attempts within a 60-second sliding window start a 60-second cooldown
(`429` with an accurate `Retry-After`); every attempt made while cooling
down doubles the cooldown, capped at 5 minutes. A successful login or
recovery clears the state. Behind the dashboard proxy all clients share
**one** throttle bucket — the proxy strips client-supplied forwarding
headers, so the bucket key cannot be chosen by clients — which means one
user's wrong-password spree can briefly deny login (and recovery) to
others. That availability trade-off is deliberate and bounded (at most
5 minutes after the last attempt); operator escape hatches are the
server-side CLI password reset (`npm run reset-password -w
@summarly/backend`) and restarting the backend, which clears the
in-memory throttle.

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
| POST | `/api/summary-runs` | `SummaryRun` (201/200) | Create-or-find (see conventions). Non-terminal runs are queued for the summary-worker (`generate-summary`, docs/decisions/0003); enqueue failures leave the run `pending` and are repaired by reconciliation. |
| GET | `/api/summary-runs` | `RunListResponse` | Newest first. `nextCursor` is `null` in the skeleton. |
| GET | `/api/summary-runs/:id` | `SummaryRun` | |
| POST | `/api/summary-runs/:id/retry` | `SummaryRun` | `failed → pending` **and re-enqueues the run**; no-op for `pending`/`processing`; `409` for `completed` (regeneration is an open decision). |
| GET | `/api/summaries/:id` | `Summary` | `404` until the summary-worker has completed the run. |
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

Runs progress **automatically**: a created run is enqueued into the
BullMQ `summaries` queue (payload = the run id only, docs/decisions/0003),
consumed by the summary-worker, and marked `completed` together with its
summary. `GET /api/summary-runs/:id/summary` then returns the `Summary`.
Reconciliation (backend, every 60 s by default) re-enqueues runs that
stay `pending`/`processing` too long, so a lost job or a queue outage
never strands a run.

**Empty periods are valid.** A run whose interval contains no messages
completes normally with a summary whose overview states the period was
empty and whose sections are all empty — `404` from the summary
endpoints only means "not finished yet" (or an unknown run), never
"nothing to summarize". (The exact overview wording is adapter
behavior, not part of this API contract.)

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend listen port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` inside containers. |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `REDIS_URL` | — (required) | Redis connection string for BullMQ queue state (summary runs; docs/decisions/0003) |
| `ENCRYPTION_KEY` | — (required) | Base64 for 32 random bytes; encrypts stored provider keys (AES-256-GCM) |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs/CIDRs whose `X-Forwarded-For` is trusted for client-IP derivation (rate limiting) |
| `RECONCILE_INTERVAL_MS` | `60000` | Cadence of the summary-run reconciliation pass (positive integer, milliseconds; the floor is 1000) |
| `SUMMARY_QUEUE_PREFIX` | `summarly` | BullMQ key-prefix namespace for the summary queue (backend + summary-worker must agree; tests use `summarly-test`, e2e `summarly-e2e`) |

## Security notes

- Passwords are hashed with scrypt (see `docs/decisions/0002`).
- Recovery codes are single-use **128-bit** codes, shown once, and stored as
  SHA-256 hashes.
- Login and recovery share the soft throttle above. Behind the dashboard
  proxy there is **one shared bucket** (the proxy strips client-supplied
  forwarding headers, so they cannot be trusted); direct connections are
  bucketed by socket peer, with `X-Forwarded-For` honored only from
  `TRUSTED_PROXIES` peers. Never add an untrusted address there: it would
  let clients choose their own bucket.
- Rate-limited responses carry an accurate `Retry-After` header (≤ 5
  minutes; see the soft-throttle semantics above).
- Password change and recovery invalidate all existing sessions.
- The backend binds to loopback by default; do not expose it to untrusted
  networks without HTTPS and a reviewed authentication model.

## Data retention

- Captured messages (`messages`) are **retained until deleted**. There is
  **no automatic expiry in the MVP**; the retention policy has not been
  productized yet (tracked for Phase E/F — see `docs/decisions/0004` §11).
- The explicit deletion path today is the operator CLI
  `npm run purge-messages -w @summarly/backend` (by group id, chat id,
  and/or a `--before <ISO date>` cutoff; destructive, with a typed
  confirmation or an explicit `--yes` flag; it reports counts only).
  There is no API or dashboard deletion endpoint yet.
- **Database backups are as sensitive as the WhatsApp session volume**:
  dumps contain full conversations and phone-number-bearing sender JIDs.
  Encrypt and rotate dumps, restrict their access — and remember that
  purging rows does not remove them from backups taken earlier.
