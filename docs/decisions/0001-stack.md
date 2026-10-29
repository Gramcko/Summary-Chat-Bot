# 0001 — Stack and repository structure

- **Status:** Decided (2026-10-29)

## Context

AGENTS.md and architecture §12.1 require deciding the workspace layout,
package manager, HTTP framework, database access library, migration tool,
and test runner before implementation work begins.

## Decision

- **Package manager / layout:** npm workspaces. Root `package.json` with
  `packages/contracts` and `backend`; `dashboard`, `bot-worker`, and
  `summary-worker` join the workspace as they are created. One
  `package-lock.json` at the root.
- **Language/runtime:** TypeScript (strict), NodeNext modules, Node >= 20.
- **API contract:** shared Zod schemas in `@summarly/contracts`. The same
  schemas provide runtime boundary validation and inferred static types for
  the backend and (later) the dashboard.
- **HTTP framework:** Fastify 5 with `@fastify/cookie`.
- **PostgreSQL access:** `pg` with a thin typed query layer. SQL stays
  explicit; queries live in repositories, not in route handlers.
- **Migrations:** node-pg-migrate (lands with the PostgreSQL persistence
  milestone).
- **Tests:** Vitest, using `fastify.inject` for HTTP tests. No test depends
  on a real WhatsApp account or paid AI requests.
- **Dev runner:** tsx.

## Consequences

- `packages/contracts` is the single source of truth for request/response
  shapes; contract changes must be reviewed before either side adapts.
- No ORM lock-in; switching the data layer stays possible.
- Alternatives considered and rejected: Drizzle/Prisma (ORM coupling not
  justified yet), Express (more assembly for the same result), pnpm/yarn
  (npm is sufficient and already installed).

## Follow-ups

- Wire node-pg-migrate and `pg` at the persistence milestone.
- ESLint configuration (lint is not set up yet; `npm run lint` does not exist).
- License selection for the open-source release.
