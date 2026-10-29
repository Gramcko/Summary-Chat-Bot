# Summarly dashboard

Next.js (App Router) + React + TypeScript + Tailwind CSS v4 frontend for
Summarly Chat Bot.

## Backend access

The browser only talks to this app; the dashboard proxies `/api/:path*` to the
backend (architecture §4.1) so the httpOnly `summarly_session` cookie stays
same-origin and no CORS setup is needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_URL` | `http://127.0.0.1:3000` | Backend base URL used by the rewrite (server-side only) |

Copy `.env.example` to `.env.local` for local development. Never expose the
backend directly to an untrusted network, and never put API keys or session
tokens in environment variables prefixed with `NEXT_PUBLIC_`.

`BACKEND_URL` is read when the Next.js config loads. Rewrite destinations are
written into `.next/routes-manifest.json` at build time, so set the variable for
`next build` (and for `next dev`); changing it after a production build has no
effect until the app is rebuilt.

## Commands (workspace-scoped)

```bash
npm run dev -w @summarly/dashboard        # http://localhost:3000? see note below
npm run typecheck -w @summarly/dashboard  # tsc --noEmit
npm run build -w @summarly/dashboard      # production build
npm run start -w @summarly/dashboard      # serve the production build
npm test -w @summarly/dashboard           # unit tests (node:test): api layer + helpers
npm run smoke -w @summarly/dashboard      # end-to-end smoke check, see below
```

The backend defaults to port 3000, so run the dashboard on another port for
local development, e.g. `npx next dev -p 3001` from this directory (or set
`PORT=3001`). The proxy target is controlled by `BACKEND_URL`.

## Smoke check

`npm run smoke -w @summarly/dashboard` is self-contained and reproducible: it
starts the contract test double in `scripts/smoke-stub.mjs` (no PostgreSQL,
Redis, WhatsApp, or AI provider required), rebuilds the app with `BACKEND_URL`
pointing at that stub — Next bakes the rewrite destination at build time — runs
`next start` on port 3100, drives the real HTTP surface, and tears everything
down. It exits non-zero if any check fails.

It covers the `/api` proxy for GET/POST/PATCH/PUT, the httpOnly session cookie
round-trip, error-envelope passthrough with `details[].path`, `401` handling,
`createRun`'s 201-vs-200 behaviour, retry conflicts, provider key
write-only behaviour, every page, and that neither the backend origin nor the
session cookie value leaks into the served HTML or client bundles.

Environment overrides: `SMOKE_BACKEND_PORT` (default `3999`), `SMOKE_APP_PORT`
(default `3100`), `SMOKE_SKIP_BUILD=1` to reuse an existing `.next` build (it
must then have been built with the same `BACKEND_URL`). Note that a smoke run
leaves `.next` built for the stub, so rebuild before serving the real backend.

## Screens

- `/setup` — one-time administrator password + recovery codes (shown once).
- `/login`, `/recover` — session sign-in and single-use recovery code flow.
- `/` — connection status and the most recent summary runs.
- `/groups` — monitored flag, IANA time zone, and daily cutoff per group.
- `/runs` — request a manual summary and browse run history.
- `/runs/[id]` — run status, retry, and the generated summary.
- `/settings` — AI provider configuration (the API key is write-only).

## Notes

- Responses are typed with `@summarly/contracts`. Only types are imported, so
  the shared Zod schemas never ship to the browser bundle.
- Every API call goes through `src/lib/api.ts`, which always sends
  `credentials: "include"`, parses the standard error envelope, and redirects to
  `/login` on `401` (except on the auth screens).
- Validation mirrors the contract rules (`HH:mm`, password ≥ 12, IANA time
  zone). Server-side `error.details[].path` entries are mapped back onto the
  matching form fields.
- `src/lib/api.ts` exposes `setBrowserLocationForTests`, a narrow test seam that
  lets `tests/api.test.ts` cover the `401 → /login` rule without a DOM. It is
  only used by tests; passing `null` restores the real `window.location`.
