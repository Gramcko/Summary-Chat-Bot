import { reconnectDelayMs } from "./backoff.js";
import type { BackoffPolicy } from "./config.js";
import type { BotDb, ConnectionState } from "./db.js";
import { errorReason } from "./lib/errors.js";
import type { LogFields, Logger } from "./lib/log.js";
import { safeChatRef } from "./lib/privacy.js";
import {
  normalizeMessage,
  SKIP_REASONS,
  type NewMessage,
  type SkipReason,
} from "./normalize.js";
import type {
  AdapterEvent,
  RawInboundMessage,
  WhatsAppAdapter,
} from "./whatsapp/adapter.js";

/**
 * Capture orchestration (architecture §4.3/§5.1, ADR 0004): maps
 * adapter connection events to `whatsapp_connections` rows, runs
 * privacy-first group discovery, and persists incoming group messages
 * idempotently. Everything here is testable with a fake adapter and a
 * fake (or real) database — no WhatsApp account is ever required.
 *
 * Connection state machine:
 *
 *   connecting  — a socket is being established (also during linking)
 *   connected   — the WhatsApp connection is open
 *   disconnected — transiently closed; a capped exponential backoff
 *                  reconnect is scheduled
 *   lost-logged-out — terminal: session revoked/replaced/invalid; no
 *                  more reconnects, a re-link is required (persisted as
 *                  state "unavailable")
 */

export type SessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "lost-logged-out";

export const STATUS_TO_DB: Record<SessionStatus, ConnectionState> = {
  connecting: "connecting",
  connected: "connected",
  disconnected: "disconnected",
  "lost-logged-out": "unavailable",
};

/** Linking material handed to the presenter (terminal). Never logged. */
export type LinkingInfo =
  | { kind: "qr"; qr: string }
  | { kind: "pairing-code"; code: string };

export interface CaptureServiceOptions {
  adapter: WhatsAppAdapter;
  db: BotDb;
  log: Logger;
  /** IANA time zone for newly discovered groups (DEFAULT_GROUP_TIMEZONE). */
  defaultTimezone: string;
  backoff: BackoffPolicy;
  /** Back-pressure limits; defaults to DEFAULT_CAPTURE_LIMITS. */
  limits?: Partial<CaptureLimits>;
  /** Linking UX callback (prints QR / pairing code); never a logger. */
  onLinking?: (linking: LinkingInfo) => void;
}

/** Safe error summary for logs: truncated driver text, nothing else. */
export const safeReason = errorReason;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture back-pressure limits (CR-M2 / audit L4). The in-memory queue
 * is bounded and failed batches are retried a bounded number of times —
 * re-inserts are idempotent via ON CONFLICT, so retrying is always safe.
 */
export interface CaptureLimits {
  /** Maximum queued raw messages; overflow drops the NEWEST (counted). */
  queueCap: number;
  /** Attempts per batch (1 initial + retries) before it is dropped. */
  maxBatchAttempts: number;
  /** Linear backoff base between batch retries. */
  batchRetryBaseMs: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  queueCap: 5000,
  maxBatchAttempts: 3,
  batchRetryBaseMs: 50,
};

export class CaptureService {
  private readonly adapter: WhatsAppAdapter;
  private readonly db: BotDb;
  private readonly log: Logger;
  private readonly defaultTimezone: string;
  private readonly backoff: BackoffPolicy;
  private readonly limits: CaptureLimits;
  private readonly onLinking: ((linking: LinkingInfo) => void) | undefined;
  private readonly unsubscribe: () => void;

  private status: SessionStatus = "disconnected";
  private connectionId: string | null = null;
  private attempt = 0;
  private stopped = true;
  private sessionLost = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serializes async event processing (ordering: open before close...). */
  private chain: Promise<void> = Promise.resolve();
  /** Pending messages; bursts coalesce into one batched insert. */
  private messageQueue: RawInboundMessage[] = [];
  private drainPromise: Promise<void> | null = null;

  constructor(options: CaptureServiceOptions) {
    this.adapter = options.adapter;
    this.db = options.db;
    this.log = options.log;
    this.defaultTimezone = options.defaultTimezone;
    this.backoff = options.backoff;
    this.limits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
    this.onLinking = options.onLinking;
    this.unsubscribe = options.adapter.subscribe((event) => this.onEvent(event));
  }

  /** Current status (for tests and status reporting). */
  get sessionStatus(): SessionStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.sessionLost = false;
    this.attempt = 0;
    this.connectionId = await this.db.ensureConnection();
    this.log("info", "connection_registered", {
      connectionId: this.connectionId,
    });
    await this.doConnect();
  }

  /**
   * Graceful shutdown: stop reconnecting, close the socket (the adapter
   * saves its auth state), let in-flight batches persist, then mark the
   * connection disconnected. A lost session stays "unavailable".
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.unsubscribe();
    try {
      await this.adapter.disconnect();
    } catch (error) {
      this.log("error", "disconnect_failed", { reason: safeReason(error) });
    }
    await this.idle();
    if (this.status !== "lost-logged-out") {
      await this.setStatus("disconnected");
    }
    this.log("info", "capture_stopped", {});
  }

  /** Resolves when all queued events and batches are fully processed. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      const drain = this.drainPromise;
      await chain;
      if (drain !== null) await drain;
      if (this.chain === chain && this.drainPromise === drain) return;
    }
  }

  // ------------------------------------------------------------------
  // Event routing
  // ------------------------------------------------------------------

  private onEvent(event: AdapterEvent): void {
    if (event.type === "messages") {
      // Bounded queue (audit L4): on overflow the NEWEST messages are
      // dropped (already-queued work is older and closer to being
      // persisted); every drop is counted.
      const room = this.limits.queueCap - this.messageQueue.length;
      if (event.messages.length > room) {
        const dropped = event.messages.length - Math.max(room, 0);
        this.log("warn", "messages_dropped_overflow", {
          count: dropped,
          queued: this.messageQueue.length,
          queueCap: this.limits.queueCap,
        });
        if (room > 0) {
          this.messageQueue.push(...event.messages.slice(0, room));
        }
      } else {
        this.messageQueue.push(...event.messages);
      }
      this.scheduleDrain();
      return;
    }
    this.enqueue(() => this.processEvent(event));
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error) => {
      this.log("error", "event_handler_failed", { reason: safeReason(error) });
    });
  }

  private async processEvent(event: AdapterEvent): Promise<void> {
    switch (event.type) {
      case "connecting":
        await this.setStatus("connecting");
        break;
      case "open":
        this.attempt = 0;
        await this.setStatus("connected");
        await this.runDiscovery();
        break;
      case "qr":
        // The QR / pairing code is linkable authentication material: it
        // is shown by the presenter, never passed to the logger.
        this.log("info", "linking_qr_pending", {});
        this.onLinking?.({ kind: "qr", qr: event.qr });
        break;
      case "pairing-code":
        this.log("info", "linking_pairing_code_pending", {});
        this.onLinking?.({ kind: "pairing-code", code: event.code });
        break;
      case "close":
        await this.handleClose(event);
        break;
      case "chat-updated":
        await this.db.upsertDiscoveredChats([event.chat], {
          timezone: this.defaultTimezone,
        });
        break;
      case "messages":
        break; // routed through the message queue; never reaches here
    }
  }

  private async handleClose(event: {
    retryable: boolean;
    reason: string;
  }): Promise<void> {
    if (this.stopped || this.sessionLost) return;
    if (!event.retryable) {
      // Session revoked, replaced, corrupt, or the account restricted
      // (ADR 0004): stop retrying, mark the connection "unavailable",
      // and require a manual re-link. Session files are NEVER deleted
      // automatically.
      this.sessionLost = true;
      await this.setStatus("lost-logged-out");
      this.log("error", "session_lost_relink_required", {
        reason: event.reason,
        note:
          "The WhatsApp session is no longer valid (logged out, replaced, or " +
          "corrupt). Stop the bot-worker and link the account again (scan the " +
          "QR code or use a pairing code). Session files are not deleted " +
          "automatically — remove them manually before re-linking (ADR 0004). " +
          "Note: account_forbidden means WhatsApp restricts the ACCOUNT itself " +
          "— re-linking may not help while the restriction stands.",
      });
      return;
    }
    await this.setStatus("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.sessionLost) return;
    if (this.reconnectTimer !== null) return;
    this.attempt += 1;
    const delayMs = reconnectDelayMs(this.attempt, this.backoff);
    this.log("info", "reconnect_scheduled", {
      attempt: this.attempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.enqueue(() => this.doConnect());
    }, delayMs);
  }

  private async doConnect(): Promise<void> {
    if (this.stopped || this.sessionLost) return;
    await this.setStatus("connecting");
    // Race guard (CR): stop() may have completed while the status write
    // was in flight — do not open a connection after shutdown.
    if (this.stopped || this.sessionLost) return;
    try {
      await this.adapter.connect();
    } catch (error) {
      this.log("error", "connect_failed", { reason: safeReason(error) });
      await this.setStatus("disconnected");
      this.scheduleReconnect();
      return;
    }
    // Race guard (CR): stop() raced connect() — close whatever the
    // adapter created late so no orphan socket survives shutdown.
    if (this.stopped) {
      try {
        await this.adapter.disconnect();
      } catch {
        // Already closed; nothing to release.
      }
    }
  }

  private async setStatus(status: SessionStatus): Promise<void> {
    if (this.status === status) return;
    this.status = status;
    this.log("info", "connection_status", {
      status,
      dbState: STATUS_TO_DB[status],
    });
    if (this.connectionId !== null) {
      try {
        await this.db.setConnectionState(
          this.connectionId,
          STATUS_TO_DB[status],
        );
      } catch (error) {
        // A failed status write must never break reconnection handling.
        this.log("error", "status_persist_failed", {
          reason: safeReason(error),
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Discovery (privacy-first opt-in; ADR 0004)
  // ------------------------------------------------------------------

  private async runDiscovery(): Promise<void> {
    try {
      const chats = await this.adapter.fetchChats();
      const result = await this.db.upsertDiscoveredChats(chats, {
        timezone: this.defaultTimezone,
      });
      this.log("info", "discovery_complete", {
        chats: chats.length,
        inserted: result.inserted,
        updated: result.updated,
      });
    } catch (error) {
      this.log("error", "discovery_failed", { reason: safeReason(error) });
    }
  }

  // ------------------------------------------------------------------
  // Message capture (architecture §5.1)
  // ------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.drainPromise !== null) return;
    // Deferred one microtask so a burst of synchronous event deliveries
    // coalesces into a single batched insert (architecture §5.1).
    this.drainPromise = Promise.resolve()
      .then(() => this.drainLoop())
      .catch((error) => {
        this.log("error", "message_drain_failed", {
          reason: safeReason(error),
        });
      })
      .finally(() => {
        this.drainPromise = null;
        // Lost-wakeup guard: messages that arrived between the final
        // empty check and the flag reset start a new drain.
        if (this.messageQueue.length > 0) this.scheduleDrain();
      });
  }

  private async drainLoop(): Promise<void> {
    while (this.messageQueue.length > 0) {
      // Everything queued while the previous batch was persisting is
      // coalesced into this batch (bursts → one insert).
      const batch = this.messageQueue.splice(0, this.messageQueue.length);
      await this.processBatchWithRetry(batch);
    }
  }

  /**
   * Bounded-loss write path (CR-M2 / audit L4): a failed batch is
   * re-queued a bounded number of times with small backoff — the
   * idempotent ON CONFLICT insert makes re-delivery safe — and only
   * dropped (whole, with counts in the log) when retries are exhausted
   * or shutdown is in progress.
   */
  private async processBatchWithRetry(batch: RawInboundMessage[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.processBatch(batch);
        return;
      } catch (error) {
        if (attempt >= this.limits.maxBatchAttempts) {
          this.log("error", "message_drain_failed", {
            reason: safeReason(error),
            attempts: attempt,
            // The whole batch is lost: nothing from it was committed.
            captured: 0,
            lost: batch.length,
          });
          return;
        }
        this.log("warn", "message_batch_retry", {
          attempt,
          count: batch.length,
          reason: safeReason(error),
        });
        await sleep(this.limits.batchRetryBaseMs * attempt);
      }
    }
  }

  private async processBatch(batch: RawInboundMessage[]): Promise<void> {
    const rows: NewMessage[] = [];
    const skipped = new Map<SkipReason, number>();
    for (const raw of batch) {
      const result = normalizeMessage(raw);
      if (result.action === "capture") {
        rows.push(result.row);
      } else {
        skipped.set(result.reason, (skipped.get(result.reason) ?? 0) + 1);
      }
    }
    if (skipped.size > 0) {
      // Counts and reasons only — never content (AGENTS.md).
      const fields: LogFields = { total: batch.length };
      for (const reason of SKIP_REASONS) {
        const count = skipped.get(reason);
        if (count !== undefined) fields[reason] = count;
      }
      this.log("debug", "messages_skipped", fields);
    }
    if (rows.length === 0) return;
    if (this.connectionId === null) {
      this.log("error", "messages_dropped_no_connection", {
        count: rows.length,
      });
      return;
    }

    const chatJids = [...new Set(rows.map((row) => row.chatJid))];
    const monitored = await this.db.filterMonitoredChatIds(chatJids);
    const kept = rows.filter((row) => monitored.has(row.chatJid));
    const droppedUnmonitored = rows.length - kept.length;
    if (droppedUnmonitored > 0) {
      this.log("debug", "messages_dropped_unmonitored", {
        count: droppedUnmonitored,
      });
    }
    if (kept.length === 0) return;

    const result = await this.db.insertMessages(this.connectionId, kept);
    const perChat = new Map<string, number>();
    for (const row of kept) {
      perChat.set(row.chatJid, (perChat.get(row.chatJid) ?? 0) + 1);
    }
    for (const [chatJid, count] of perChat) {
      // Hashed chat reference (audit L1): legacy group JIDs embed phone
      // numbers and must never reach the logs.
      this.log("debug", "messages_captured", {
        chatRef: safeChatRef(chatJid),
        captured: count,
      });
    }
    this.log("debug", "messages_persisted", {
      captured: kept.length,
      inserted: result.inserted,
      duplicates: result.duplicates,
      droppedUnmonitored: result.droppedUnmonitored,
    });
  }
}
