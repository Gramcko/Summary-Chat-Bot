# 0004 — WhatsApp integration (Baileys) for `bot-worker`

- **Status:** Accepted (2026-11-01) — records the user-approved D4
  decision and the Phase D implementation.

## Context

`bot-worker` must capture authorized WhatsApp group messages
(architecture §4.3/§5.1). WhatsApp has no official API for this; the
established option is **Baileys**, an *unofficial* WhatsApp Web client
library. WhatsApp integration rules require that all Baileys-specific
code stays behind a dedicated adapter, that session state lives in
protected storage (never the database, never Git), and that the
unofficial nature and its limits are documented honestly.

Decisions to make here (architecture §12, topic 2):

1. How to pin the Baileys dependency so installation is reproducible.
2. Where session state lives and how it is protected (the D4 decision).
3. Which events are captured, which are skipped, and how duplicates and
   reconnects behave.
4. How the account is linked (QR) and re-linked after a session loss.

## Decision

### 1. Dependency pinning (exact versions, no ranges)

- **`@whiskeysockets/baileys` pinned to exactly `6.7.24`** (no `^`, no
  `~`). That is the newest release of the stable 6.x line
  (`legacy` dist-tag, still receiving fixes; published 2026-07-29).
  The `latest` dist-tag is `7.0.0-rc14`, a release candidate with a new
  native Rust bridge (`whatsapp-rust-bridge`) that would complicate the
  self-hosted Docker target (prebuilds, ARM hosts); the MVP takes the
  stable line instead. Verified before pinning: `npm view` dist-tags and
  publish dates, and an import smoke test under the target runtime
  (**Node 26.8.1**) confirming `makeWASocket`,
  `useMultiFileAuthState`, `makeCacheableSignalKeyStore`,
  `getContentType`, `fetchLatestBaileysVersion`, and
  `groupFetchAllParticipating` all load and resolve. The
  `bot-worker/tests/baileys-mapping.test.ts` suite re-verifies the
  Baileys import on every test run.
- **`qrcode-terminal` pinned to exactly `0.12.0`** for terminal QR
  rendering. Rationale: zero dependencies, tiny, the de-facto standard
  for CLI QR display, and it prints straight to stdout (no canvas or
  image stack). Alternatives (`qrcode`) are heavier with native-ish
  transitive dependencies. TypeScript types come from
  `@types/qrcode-terminal` (dev-only).
- **`libsignal` override:** Baileys 6.x declares its `libsignal`
  dependency as a *git URL*
  (`git+https://github.com/whiskeysockets/libsignal-node.git`), which
  npm ≥ 12 refuses to fetch by default (`allow-git = "none"`), breaking
  `npm install` out of the box. The root `package.json` therefore
  contains `"overrides": { "libsignal": "6.0.0" }`. The substituted
  package is the same WhiskeySockets fork published to the registry
  (its `repository` field is `WhiskeySockets/libsignal-node`).
  **Provenance honesty:** the git `master` the original spec resolves to
  *floats*, so no claim of byte-identity with it is durable. What is
  durable is the registry release: version 6.0.0, pinned in
  `package-lock.json` by its integrity digest
  `sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==`
  (npm verifies it on every install; the registry tarball additionally
  carries npm attestations/SLSA provenance). The resolution is visible
  in `npm ls libsignal` as `libsignal@6.0.0 overridden`.
- **Install scripts:** Baileys ships a `preinstall` engine check and
  `protobufjs` a `postinstall` notice. npm ≥ 12 blocks install scripts
  by default (`allow-scripts`) and both were blocked during
  verification without any effect — the runtime does not depend on
  them. Do not blanket-allow install scripts for this tree without
  reviewing each one.
- Versions are recorded in `package-lock.json`; upgrades are deliberate
  and re-tested, not automatic.

### 2. Session storage (D4): protected directory → named Docker volume

- WhatsApp session state is stored with Baileys'
  `useMultiFileAuthState` in a **dedicated directory**
  (`WA_SESSION_DIR`, default `./wa-session`). Relative values resolve
  against the **repository root** (never against `process.cwd()`, which
  is a package directory under npm scripts), so the documented
  `./wa-session` always means `<repo root>/wa-session`.
- It is **never** stored in PostgreSQL, never in Git (`.gitignore`
  covers `wa-session/`, `auth/`, and `*.creds.json`), never exposed by
  any API or static asset, and **never written to logs — not even the
  directory path** (fs errors are reduced to their error code before
  logging; `bot-worker/src/lib/errors.ts`).
- Deployment stores it in the **named Docker volume
  `summarly-wa-session`** (declared in `docker-compose.dev.yml`; Phase F
  mounts it on `bot-worker` and points `WA_SESSION_DIR` at it). Named
  volume — not a bind mount to the repo, not a database blob.
- **Containment (fail fast):** a session directory that resolves inside
  the repository working tree is refused at startup — that is where it
  could be committed, served as static content, or swept into a
  source-tree backup. The documented dev default *is* inside the tree,
  so local development sets `WA_SESSION_ALLOW_INSECURE=yes` (shipped,
  loudly commented, in `.env.example`) to acknowledge that explicitly;
  deployments point `WA_SESSION_DIR` at the volume and drop the flag.
  Error messages never include the path.
- **File-permission expectations (POSIX deployments):** the directory is
  created with mode `0700` and the post-condition is **verified** on
  startup (`mode & 0o077 === 0`) — failure is a startup error, not a
  warning, because this is credential storage. The `0700` **directory**
  is the actual protection: Baileys writes its auth files with the
  process umask (NOT owner-only by itself), so file modes must not be
  relied upon — the containing directory does the work. Run the
  bot-worker as a **non-root user** that owns the mount point (Phase F
  must `chown` the volume, or startup fails the permission check).
- **Windows (dev) hosts:** NTFS ACLs cannot be verified from Node, so
  `ensureSessionStorage` **refuses to start** unless
  `WA_SESSION_ALLOW_INSECURE=yes` acknowledges that protecting the
  directory is the operator's job. Use a POSIX container for real
  protections.
- **Backups:** treat this volume as **credentials** (it can link the
  account): encrypt backups of it or exclude them, and never commit or
  sync them to public storage.

### 3. Adapter isolation (architecture §4.3)

- All Baileys code lives in `bot-worker/src/whatsapp/baileys-adapter.ts`;
  the rest of the service depends only on the internal
  `WhatsAppAdapter` contract (`src/whatsapp/adapter.ts`): `connect`,
  `disconnect`, `fetchChats`, and typed events (`connecting`, `qr`,
  `pairing-code`, `open`, `close`, `messages`, `chat-updated`).
- No test imports a live connection: unit tests use `FakeAdapter`, the
  integration suite uses `FakeAdapter` against real PostgreSQL. No test
  needs a WhatsApp account (AGENTS.md).
- The Baileys logger is **silenced** (its log lines can carry chat
  metadata); `markOnlineOnConnect` is off; `emitOwnEvents` is off.

### 4. Connection lifecycle and state mapping

Persisted in `whatsapp_connections` (single linked session per
installation), matching the `ConnectionStatus` contract and the
migration CHECK constraint:

| Internal status       | DB `state`     | Meaning |
|---|---|---|
| `connecting`          | `connecting`   | Socket being established (also while waiting for the QR scan). |
| `connected`           | `connected`    | WhatsApp connection open. |
| `disconnected`        | `disconnected` | Transient close; capped exponential backoff reconnect (base 1 s, doubling, cap 60 s; the counter resets on a successful open). |
| `lost-logged-out`     | `unavailable`  | Terminal: session revoked, replaced, corrupt, or forbidden. |

- Terminal disconnect causes (**stop retrying**, log a safe
  "re-link required" instruction): code **401** (logged out) and **419**
  (unauthorized, cause unknown — reported as `session_unauthorized`, not
  assumed to be a logout), **440** (connection replaced by another
  device), **500** (badSession: corrupt session state), **403**
  (forbidden — an account restriction: re-linking may not help), **411**
  (multidevice mismatch). Everything else — 428 closed, 408 lost/timed
  out, 503 unavailable, 515 restart required (retried **with backoff**),
  unknown codes — retries with backoff.
- On a terminal close the session files are **NOT deleted
  automatically** (deleting user data without approval is prohibited);
  the operator removes them manually before re-linking if the state is
  corrupt (see Re-linking below).
- Graceful shutdown (SIGINT/SIGTERM): stop timers → close the socket
  (auth state saved) → let in-flight message batches commit → close the
  database pool. A lost session stays `unavailable` on shutdown (it is
  never downgraded to `disconnected`).

### 5. Linking UX (MVP)

- **Terminal QR (MVP):** on start without a saved session, the QR code
  is rendered with `qrcode-terminal` plus step-by-step instructions
  ("WhatsApp → Settings → Linked devices → Link a device"). The QR is
  linkable credential material: it is shown on the terminal only and
  **never logged**. When a fresh QR replaces an expired one, the
  presenter says so explicitly — only the latest QR is valid.
- **Pairing code (stretch, implemented):** set `WA_PHONE_NUMBER` and
  the adapter requests a pairing code (`requestPairingCode`) instead of
  printing the QR; the code is printed with instructions
  ("Link with phone number"). Falls back to the QR when the code cannot
  be requested, and forwards every fresh QR afterwards (a QR expires
  within ~20s; a retained fallback would strand the operator).
- **Log-sink safety (audit M3/L5):** in Docker, stdout **is** the log
  stream, and a retained QR code is a live pairing ticket. Rendering is
  therefore gated on `process.stdout.isTTY` and can be disabled with
  `WA_LINKING_DISPLAY=none`; when suppressed, a single safe warning
  explains how to link from a terminal. **Linking output must never be
  piped into log aggregation** (documented in `.env.example` too).
- **Follow-up:** a dashboard QR/pairing-code display (over the
  authenticated API, with the same never-logged rules) is deferred.

### 6. Group discovery (privacy-first opt-in)

On every `open` (and on `groups.upsert` / `groups.update` subject
changes) the bot-worker lists the `@g.us` groups the account
participates in and upserts them into `groups` keyed by `chat_id`:

- **New** groups are inserted with `monitored = false` (the admin opts
  in via the dashboard — data minimization), `timezone` =
  `DEFAULT_GROUP_TIMEZONE`, `summary_time = NULL`, and a generated uuid
  (`groups.id` has no database default).
- **Existing** groups (`chat_id` conflict): **only `name` is updated**.
  `monitored`, `timezone`, `summary_time`, and `id` are never clobbered
  by re-discovery or subject updates (regression-tested at unit and
  integration level). Subject-less updates are ignored so a name is
  never overwritten by a JID.
- The `chat_id` join path (`groups.chat_id = messages.chat_id`) is the
  one documented in the migration comment.

### 7. Message capture and normalization

Only **group** messages (`@g.us`) for groups present in `groups` with
`monitored = true` are persisted; the toggle takes effect on the next
message (the filter queries PostgreSQL per batch). Normalized into the
`messages` columns:

| WhatsApp content | `message_type` | `body` |
|---|---|---|
| `conversation`, `extendedTextMessage` (non-empty body) | `text`, or `link` when the message carries a link preview (`matchedText` set) or the body is only whitespace-separated `http(s)` URLs | the text |
| empty or whitespace-only text bodies | — skipped (`empty-body`) | — |
| image/video/document (+ `documentWithCaptionMessage`) | `other` | the caption, or `""` |
| audio, stickers, contacts, locations, polls, templates, interactive/button/list responses, ... | `other` | caption when the payload has one, else `""` |
| reactions | — skipped (`reaction`) | — |
| `protocolMessage` / `editedMessage`, at **any** unwrap depth (e.g. `ephemeralMessage > editedMessage`) | — skipped (`protocol`) | the original text is kept; edits are never applied |
| `senderKeyDistributionMessage` / history-sync notices **as the sole content** | — skipped (`system`) | — |
| the same noise keys **bundled with real content** (WhatsApp delivers SKDM alongside text/media) | classified from the real content | the real text/caption (CR-M1: the message is never dropped) |
| group-event stubs | — skipped (`system`) | — |
| own messages (`fromMe`) | — skipped (`own-message`) | — |
| status broadcasts | — skipped (`status-broadcast`) | — |
| non-group chats (DMs, newsletters) | — skipped (`not-group`) | — |
| no usable content / no message id / no timestamp | — skipped (`unsupported-type`, `missing-id`, `missing-timestamp`) | — |

- Skips are counted per reason in a debug log line; they are never
  persisted. Media itself is **never downloaded** — captions only.
- **Idempotency:** `INSERT ... ON CONFLICT (connection_id, chat_id,
  whatsapp_message_id) DO NOTHING`; duplicate deliveries count as
  already captured (architecture §5.1). `last_message_at` on the
  connection row tracks the newest captured message.
- **Privacy boundary inside the write (audit M4):** the INSERT only
  accepts rows whose chat is currently monitored (`EXISTS` against
  `groups`, enforced in the statement itself), so a group unmonitored
  *between* the service's filter and the write is never persisted. The
  `groups.monitored` default is `false` (migration 0002) and discovery
  inserts explicit `monitored = false` — opt-in is the default posture.
- **Batching and back-pressure (CR-M2 / audit L4):** messages arriving
  in a burst are coalesced into one multi-row insert (chunked at 200
  rows per statement) inside a transaction. The in-memory queue is
  capped (`MESSAGE_QUEUE_CAP`, 5000): on overflow the **newest**
  messages are dropped with a counted warn log. A batch whose insert
  fails is retried up to 3 attempts with small backoff (safe: the
  insert is idempotent) and only then dropped **whole**, with counted
  logs (`message_drain_failed` reports `captured: 0, lost: N`).
- **History sync is disabled** (`syncFullHistory: false`,
  `shouldSyncHistoryMessage: () => false`) and non-group JIDs are
  dropped before decryption (`shouldIgnoreJid`): the MVP captures live
  traffic only and does not backfill old conversations — data
  minimization over completeness. Messages sent while the bot-worker is
  offline are therefore **not** captured; do not promise otherwise.
  Replays that WhatsApp may still deliver (`append` upserts) flow
  through the same idempotent path and can never duplicate rows.

### 8. Logging rules (strict)

Structured JSON logs with counts, hashed chat references, message ids,
states, and durations only. **Never** message bodies, group/subject
names, phone numbers, QR values, pairing codes, credentials, or the
session directory path. Per-batch capture summaries ("captured N
messages from chat `<hash>`") are `debug` level (`LOG_LEVEL=debug` to
see them).

- **Chat references are hashed (audit L1):** legacy WhatsApp group JIDs
  embed phone numbers, so logs carry a truncated SHA-256 of the JID
  (`safeChatRef`) — stable enough to correlate events per chat, useless
  as a phone number.
- **`sender_id` stores the participant JID by design (audit L9):** that
  is pseudonymous contact identity, and summaries attribute messages to
  senders. It is stored in PostgreSQL (protected like the rest of the
  message data) and is never written to logs. Note that legacy JIDs and
  `@s.whatsapp.net` JIDs embed phone numbers — the `messages` table is
  therefore as sensitive as the conversation itself.

### 9. Limitations (honest, AGENTS.md requirement)

- **Baileys is an unofficial WhatsApp Web integration.** It is not an
  official API; WhatsApp can change the protocol, restrict accounts, or
  block linked devices at any time, and upstream releases can break
  compatibility. Keep it isolated behind the adapter (done), pin the
  version (done), and expect to update the pin after breakage. Account
  restrictions (e.g. temporary blocks) are outside our control.
- **No delivery guarantees.** Baileys event delivery is not a durable
  queue: messages exchanged while the bot-worker is disconnected are
  lost for capture purposes (history sync is off). Duplicate deliveries
  *are* handled.
- **Bounded loss window during outages (CR-M2):** a message is durable
  only after its batch INSERT commits. Between reception and commit the
  message exists only in the in-memory queue: a process crash loses the
  in-flight batch, queue overflow (flood beyond 5000 queued messages)
  drops the newest with counted logs, and a batch failing 3 insert
  attempts is dropped whole with counted logs (`captured: 0, lost: N`).
  There is no replay source to recover from — this window is inherent
  to the design (architecture §5.1) and must not be hidden.
- **Startup egress is opt-in (audit L6):** the WhatsApp Web version is
  the one bundled with the pinned Baileys release by default — no
  network call, no third-party influence on the protocol version, and
  air-gapped operation works. `WA_CHECK_UPDATES=yes` opts in to
  Baileys' version-manifest fetch (one HTTPS request to the Baileys
  repository per connect).
- **Single linked session** per installation (the schema and the
  `shouldIgnoreJid`/discovery design assume one account).
- **Unverifiable without a live account:** pairing-code linking and
  end-to-end decryption were not exercised against real WhatsApp in the
  test suite (no account in CI, by policy). The translation layer is
  covered by unit tests against recorded shapes; treat the first real
  link as a validation step.
- **Windows dev hosts:** the permission checks cannot pass on NTFS and
  startup requires `WA_SESSION_ALLOW_INSECURE=yes`; the `0700`
  directory hardening is POSIX-only. Use a POSIX deployment.

### 10. Re-linking procedure (operator runbook)

1. Stop the bot-worker (`docker compose stop bot-worker` / Ctrl+C).
2. If the log reported `session_lost_relink_required` with
   `session_invalid`, delete the contents of the session directory
   (the `summarly-wa-session` volume / `WA_SESSION_DIR`). For
   `logged_out`/`session_replaced` the files are stale — deleting them
   before re-linking avoids a confusing state. **Never delete them
   automatically.** Note: `account_forbidden` means WhatsApp restricts
   the **account** itself — re-linking may not help while the
   restriction stands.
3. Start the bot-worker and scan the printed QR (or use a pairing code
   with `WA_PHONE_NUMBER`).
4. Confirm `connection_status` shows `connected` and re-check which
   groups are monitored. Existing group rows **keep their preferences**
   across re-discovery (never-clobber); only groups seen for the first
   time are registered with `monitored = false`.

### 11. Data retention (audit M6)

Captured conversations accumulate in `messages` and are **retained
until deleted** — there is no automatic expiry in the MVP. Until the
retention policy is productized (Phase E/F):

- The explicit deletion path is the operator CLI
  `npm run purge-messages -w @summarly/backend` (by `--group-id` /
  `--chat-id` / `--before <ISO>`; destructive, requires a typed `DELETE`
  confirmation or the explicit `--yes` flag; reports counts, never
  content). There is no API/UI deletion path yet.
- **Database backups are as sensitive as the session volume**: dumps of
  `messages` contain full conversations and phone-number-bearing sender
  JIDs. Protect dumps accordingly (encryption, access control, rotation)
  — and note that purging rows does NOT remove them from earlier
  backups.

## Alternatives considered

- **Baileys 7.0.0-rc14 (`latest` tag):** registry-only dependencies
  (no git override needed) but an RC with a native Rust bridge; deferred
  until stable. Migration cost is contained by the adapter boundary.
- **`allow-git` npm opt-in instead of the `libsignal` override:** keeps
  upstream's git spec but makes every fresh install (and CI) require a
  policy change; the override is reproducible and provenance-identical.
- **Session state in PostgreSQL:** rejected (D4): credentials in the
  application database widen the blast radius of any SQL injection or
  dump and contradict the "protected persistent storage" rule.
- **QR display in the dashboard (MVP):** deferred; terminal QR keeps the
  MVP's exposure surface small.

## Follow-ups

- Phase F: mount `summarly-wa-session` on the `bot-worker` Compose
  service (non-root user, restrictive permissions; `chown` the volume or
  the permission post-condition fails), readiness checks.
- Dashboard QR/pairing-code linking over the authenticated API.
- Productize retention (automatic expiry / per-group deletion API) and a
  purge UX; today only the CLI exists (ADR §11).
- Revisit history sync (bounded backfill) if offline gaps become a real
  product requirement.
- When upgrading Baileys: re-run the import smoke (mapping suite),
  re-read the changelog/advisories (e.g. the message-spoofing advisory
  GHSA-qvv5-jq5g-4cgg — 6.7.24 is unaffected), **re-verify the
  `libsignal` override pin** (version + `package-lock.json` integrity
  digest) against the fork's current state, and re-test linking. When CI
  exists, add `npm audit signatures` / provenance verification to the
  pipeline.
