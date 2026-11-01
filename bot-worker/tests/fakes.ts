import { randomUUID } from "node:crypto";
import type { BotDb, ConnectionState, ChatDefaults, InsertMessagesResult, UpsertChatsResult } from "../src/db.js";
import type { LogFields, LogLevel, Logger } from "../src/lib/log.js";
import type { NewMessage } from "../src/normalize.js";
import type {
  AdapterEvent,
  DiscoveredChat,
  RawInboundMessage,
  WhatsAppAdapter,
} from "../src/whatsapp/adapter.js";

/**
 * Test doubles for the bot-worker suite. No file here is collected by
 * vitest: only `*.test.ts` files run. NOTHING in this suite ever needs a
 * real WhatsApp account or network access (AGENTS.md).
 */

// ---------------------------------------------------------------------------
// FakeAdapter — the Baileys boundary replaced by a scripted event source.
// ---------------------------------------------------------------------------

export class FakeAdapter implements WhatsAppAdapter {
  connectCalls = 0;
  disconnectCalls = 0;
  /** Simulates a connect() that throws (e.g. unreachable network). */
  connectError: Error | null = null;
  /** Makes connect() slow (race-guard tests). */
  connectDelayMs = 0;
  /** Groups returned by fetchChats(); may be mutated between calls. */
  fetchChatsResults: DiscoveredChat[] = [];
  fetchChatsError: Error | null = null;

  private readonly handlers = new Set<(event: AdapterEvent) => void>();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    if (this.connectError !== null) throw this.connectError;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async fetchChats(): Promise<DiscoveredChat[]> {
    if (this.fetchChatsError !== null) throw this.fetchChatsError;
    return [...this.fetchChatsResults];
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Scripted event injection (what Baileys would have emitted). */
  emit(event: AdapterEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  emitMessages(...messages: RawInboundMessage[]): void {
    this.emit({ type: "messages", messages });
  }
}

// ---------------------------------------------------------------------------
// FakeDb — implements the documented SQL semantics in memory, most
// importantly the NEVER-clobber discovery rule (insert monitored=false;
// conflict updates only the name).
// ---------------------------------------------------------------------------

export interface FakeStoredGroup {
  id: string;
  name: string;
  monitored: boolean;
  timezone: string;
  summaryTime: string | null;
}

export class FakeDb implements BotDb {
  readonly connectionId = randomUUID();
  readonly stateHistory: ConnectionState[] = [];
  readonly groups = new Map<string, FakeStoredGroup>();
  readonly messages: NewMessage[] = [];
  readonly insertCalls: NewMessage[][] = [];
  /**
   * Per-call insert failures (CR-M2 tests): each insertMessages() call
   * shifts one error and throws it when present.
   */
  readonly insertFailures: Error[] = [];

  private readonly seen = new Set<string>();

  async ensureConnection(): Promise<string> {
    return this.connectionId;
  }

  async setConnectionState(
    _connectionId: string,
    state: ConnectionState,
  ): Promise<void> {
    this.stateHistory.push(state);
  }

  async filterMonitoredChatIds(chatJids: string[]): Promise<Set<string>> {
    return new Set(
      chatJids.filter((chatJid) => this.groups.get(chatJid)?.monitored === true),
    );
  }

  async insertMessages(
    _connectionId: string,
    rows: NewMessage[],
  ): Promise<InsertMessagesResult> {
    this.insertCalls.push([...rows]);
    const failure = this.insertFailures.shift();
    if (failure !== undefined) throw failure;
    let inserted = 0;
    let duplicates = 0;
    let droppedUnmonitored = 0;
    for (const row of rows) {
      // Mirrors the SQL EXISTS clause (audit M4): the write itself
      // refuses rows whose chat is not monitored at INSERT time.
      if (this.groups.get(row.chatJid)?.monitored !== true) {
        droppedUnmonitored += 1;
        continue;
      }
      const key = `${row.chatJid}\u0000${row.whatsappMessageId}`;
      if (this.seen.has(key)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(key);
      this.messages.push(row);
      inserted += 1;
    }
    return { inserted, duplicates, droppedUnmonitored };
  }

  async upsertDiscoveredChats(
    chats: DiscoveredChat[],
    defaults: ChatDefaults,
  ): Promise<UpsertChatsResult> {
    // Mirror the SQL: one row per chat, LAST occurrence wins.
    const byJid = new Map<string, string>();
    for (const chat of chats) byJid.set(chat.chatJid, chat.name);
    let inserted = 0;
    let updated = 0;
    for (const [chatJid, name] of byJid) {
      const existing = this.groups.get(chatJid);
      if (existing !== undefined) {
        // NEVER-clobber rule (mirrors the SQL): only the name changes.
        existing.name = name;
        updated += 1;
      } else {
        this.groups.set(chatJid, {
          id: randomUUID(),
          name,
          monitored: false,
          timezone: defaults.timezone,
          summaryTime: null,
        });
        inserted += 1;
      }
    }
    return { inserted, updated };
  }

  /** Simulates the admin changing preferences in the dashboard. */
  adminConfigure(
    chatJid: string,
    prefs: {
      monitored?: boolean;
      timezone?: string;
      summaryTime?: string | null;
    },
  ): void {
    const group = this.groups.get(chatJid);
    if (group === undefined) throw new Error(`unknown chat ${chatJid}`);
    if (prefs.monitored !== undefined) group.monitored = prefs.monitored;
    if (prefs.timezone !== undefined) group.timezone = prefs.timezone;
    if (prefs.summaryTime !== undefined) group.summaryTime = prefs.summaryTime;
  }
}

// ---------------------------------------------------------------------------
// Recording logger + small async helpers
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export function recordingLogger(sink: LogEntry[]): Logger {
  return (level, event, fields) => {
    sink.push({ level, event, fields: fields ?? {} });
  };
}

export function findEvents(sink: LogEntry[], event: string): LogEntry[] {
  return sink.filter((entry) => entry.event === event);
}

/** True when any captured log line contains `secret` (privacy asserts). */
export function logsContain(sink: LogEntry[], secret: string): boolean {
  return sink.some((entry) => JSON.stringify(entry).includes(secret));
}

/** A normalized raw message with sensible defaults (group text). */
export function rawMessage(
  overrides: Partial<RawInboundMessage> = {},
): RawInboundMessage {
  return {
    chatJid: "111111111111-22222222@g.us",
    messageId: "MSG-1",
    senderJid: "sender@s.whatsapp.net",
    timestampSec: 1_772_000_000,
    fromMe: false,
    kind: "text",
    text: "hello",
    caption: null,
    linkPreview: false,
    ...overrides,
  };
}

/** Polls until `fn` returns a defined value; fails loudly on timeout. */
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
