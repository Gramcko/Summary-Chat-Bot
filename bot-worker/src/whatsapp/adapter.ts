/**
 * Internal WhatsApp adapter contract (architecture §4.3, ADR 0004).
 *
 * ALL Baileys-specific code lives in `baileys-adapter.ts`; nothing else
 * in the service may import `@whiskeysockets/baileys`. The rest of the
 * service is unit-testable against `FakeAdapter` with no WhatsApp
 * account and no network (AGENTS.md).
 *
 * The raw-message shape below is deliberately Baileys-free: it carries
 * only identifiers, timestamps, and extracted text/caption fragments.
 * Policy (skip rules, classification) lives in `normalize.ts`.
 */

/** Content classification performed inside the adapter (ADR 0004). */
export type RawContentKind =
  /** Plain text (conversation / extendedTextMessage without a link preview). */
  | "text"
  /** Text carrying a link preview (extendedTextMessage with canonical url). */
  | "link-preview"
  /** Any other content type (media, contacts, polls, ...). */
  | "other"
  /** Reaction to a message — never persisted. */
  | "reaction"
  /** Protocol message (edits, deletions, key exchanges) — never persisted. */
  | "protocol"
  /** System/stub notice (group events, history-sync notices) — never persisted. */
  | "system"
  /** No usable content at all. */
  | "empty";

/** A single incoming WhatsApp message, adapter-normalized (untrusted data). */
export interface RawInboundMessage {
  /** Chat JID. Group chats end in `@g.us`. */
  chatJid: string;
  /** Stable WhatsApp message id (Baileys key.id); null when absent. */
  messageId: string | null;
  /** Sender participant JID; null when WhatsApp did not provide one. */
  senderJid: string | null;
  /** Unix seconds (WhatsApp messageTimestamp); null when absent/invalid. */
  timestampSec: number | null;
  /** True for messages sent by the linked account itself. */
  fromMe: boolean;
  kind: RawContentKind;
  /** Text content for kinds "text" and "link-preview". */
  text: string | null;
  /** Caption for kind "other" when the content type carries one. */
  caption: string | null;
  /** True when the message carries a link preview. */
  linkPreview: boolean;
}

/** A group chat the linked account participates in. */
export interface DiscoveredChat {
  chatJid: string;
  /** Group subject (name). May fall back to the JID when unset. */
  name: string;
}

export type AdapterEvent =
  /** The socket is being (re)established. */
  | { type: "connecting" }
  /** A linkable QR code (linking UX; presentation happens outside). */
  | { type: "qr"; qr: string }
  /** A phone-number pairing code (linking UX). */
  | { type: "pairing-code"; code: string }
  /** The WhatsApp connection is open. */
  | { type: "open" }
  /**
   * The connection closed. `retryable` is false for terminal causes
   * (logged out / replaced / invalid session): the service must stop
   * reconnecting and require a re-link (ADR 0004).
   */
  | { type: "close"; retryable: boolean; reason: string }
  /** Incoming messages (already adapter-filtered to what we handle). */
  | { type: "messages"; messages: RawInboundMessage[] }
  /** A group's metadata changed (e.g. subject renamed). */
  | { type: "chat-updated"; chat: DiscoveredChat };

/**
 * The WhatsApp integration as the rest of the service sees it.
 * Implementations must be safe to `connect()` repeatedly (a reconnect
 * after a transient close creates a fresh socket) and `disconnect()`
 * must close the socket and persist any pending auth state.
 */
export interface WhatsAppAdapter {
  connect(): Promise<void>;
  /** Graceful shutdown: close the socket and save auth state. */
  disconnect(): Promise<void>;
  /** Lists group chats (`@g.us`) the account participates in. */
  fetchChats(): Promise<DiscoveredChat[]>;
  /** Subscribes to adapter events; returns an unsubscribe function. */
  subscribe(handler: (event: AdapterEvent) => void): () => void;
}
