import makeWASocket, {
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type ConnectionState as BaileysConnectionState,
  type GroupMetadata,
  type SocketConfig,
  type WAVersion,
  type WAMessage,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { errorReason } from "../lib/errors.js";
import type { Logger } from "../lib/log.js";
import type {
  AdapterEvent,
  DiscoveredChat,
  RawContentKind,
  RawInboundMessage,
  WhatsAppAdapter,
} from "./adapter.js";

/**
 * The ONLY module that imports `@whiskeysockets/baileys` (architecture
 * §4.3, ADR 0004). It translates Baileys sockets/events/messages into
 * the internal adapter contract so the rest of the service is testable
 * without Baileys and without a WhatsApp account.
 *
 * Baileys is an UNOFFICIAL WhatsApp Web integration: upstream protocol
 * changes or account restrictions can break it at any time (ADR 0004).
 * The pinned version and the translation rules below were verified
 * against the installed package sources, not remembered behavior.
 *
 * Privacy posture (ADR 0004):
 * - the Baileys logger is silenced (its logs can carry chat metadata)
 * - `shouldIgnoreJid` drops every non-group JID before decryption
 * - history sync is disabled (no bulk backfill of old conversations)
 * - `markOnlineOnConnect` is off; own-message events are not emitted
 */

export interface BaileysAdapterOptions {
  /** Protected session-state directory (WA_SESSION_DIR). Never logged. */
  sessionDir: string;
  /** E.164 digits for pairing-code linking; null/undefined = QR linking. */
  phoneNumber?: string | null;
  /**
   * Opt-in egress (WA_CHECK_UPDATES=yes): fetch the latest WhatsApp Web
   * version manifest from the Baileys repository at connect time. Off by
   * default — the version bundled with the pinned Baileys release is
   * used instead (no third-party influence on the protocol version).
   */
  checkForUpdates?: boolean;
  log: Logger;
}

type BaileysLogger = SocketConfig["logger"];

/** Pino-compatible logger that drops everything (privacy, ADR 0004). */
function createSilentLogger(): BaileysLogger {
  const silent = (): void => {};
  const self: BaileysLogger = {
    level: "silent",
    child: () => self,
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
  };
  return self;
}

/** Error reason for logs: code or truncated message, never file paths. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Accepts protobufjs Long values and plain numbers (unix seconds). */
function toUnixSeconds(timestamp: unknown): number | null {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) && timestamp > 0
      ? Math.floor(timestamp)
      : null;
  }
  if (
    typeof timestamp === "object" &&
    timestamp !== null &&
    "toNumber" in timestamp &&
    typeof (timestamp as { toNumber: unknown }).toNumber === "function"
  ) {
    const value = (timestamp as { toNumber(): number }).toNumber();
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  return null;
}

/**
 * Protocol-level content keys that are internal noise. WhatsApp bundles
 * senderKeyDistributionMessage with ordinary text/media messages in the
 * same proto, so these may only be treated as the whole message when
 * they are the SOLE content (CR-M1).
 */
const NOISE_CONTENT_KEYS = [
  "senderKeyDistributionMessage",
  "messageHistoryNotice",
  "messageHistoryBundle",
] as const;

/** One level of the wrapper fields unwrapped before classification. */
const WRAPPER_FIELDS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

/**
 * True when protocolMessage / editedMessage content appears at ANY
 * unwrap depth (CR-m2): e.g. ephemeralMessage > editedMessage > text is
 * an edit and must never surface its replacement text as a new message.
 * Bounded to five levels like Baileys' own normalizeMessageContent.
 */
export function containsEditOrProtocol(
  content: proto.IMessage | null | undefined,
  depth = 0,
): boolean {
  if (content === null || content === undefined || depth > 5) return false;
  if (content.protocolMessage != null || content.editedMessage != null) {
    return true;
  }
  const asRecord = content as unknown as Record<
    string,
    { message?: proto.IMessage | null } | null | undefined
  >;
  for (const field of WRAPPER_FIELDS) {
    const inner = asRecord[field]?.message;
    if (inner !== null && inner !== undefined && containsEditOrProtocol(inner, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Strips the internal noise keys (CR-M1). Returns the content to
 * classify (the original object when there was no noise, the stripped
 * shallow copy otherwise) or `undefined` when the noise keys were the
 * sole content — in which case the message is a "system" notice.
 */
function stripSoleNoiseKeys(
  content: proto.IMessage,
): proto.IMessage | undefined {
  const record = content as unknown as Record<string, unknown>;
  const hasNoise = NOISE_CONTENT_KEYS.some((key) => record[key] != null);
  if (!hasNoise) return content;
  const stripped: Record<string, unknown> = { ...record };
  for (const key of NOISE_CONTENT_KEYS) delete stripped[key];
  const remaining = Object.keys(stripped).filter(
    (key) => stripped[key] != null,
  );
  return remaining.length > 0
    ? (stripped as unknown as proto.IMessage)
    : undefined;
}

/**
 * Maps one Baileys message to the internal raw shape (ADR 0004):
 * - group-event stubs -> "system"
 * - protocolMessage / editedMessage at ANY unwrap depth -> "protocol"
 *   (edits and deletions are never re-captured; the original is kept)
 * - senderKeyDistributionMessage / history-sync notices -> "system" ONLY
 *   when they are the sole content; when bundled with real content the
 *   real content is classified (CR-M1)
 * - conversation / extendedTextMessage -> "text" (or "link-preview" when
 *   the message carries a link preview)
 * - image/video/document (incl. captioned documents) -> "other" with the
 *   caption; audio/stickers -> "other" with no caption
 * - reactions -> "reaction"
 * - any other content type -> "other" with its caption when it has one
 * Returns null when the message has no usable identity (no chat JID).
 */
export function mapWAMessage(message: WAMessage): RawInboundMessage | null {
  const key = message.key;
  const chatJid = stringOrNull(key?.remoteJid);
  if (chatJid === null) return null;

  const base = {
    chatJid,
    messageId: stringOrNull(key?.id),
    senderJid: stringOrNull(key?.participant),
    timestampSec: toUnixSeconds(message.messageTimestamp),
    fromMe: key?.fromMe === true,
    text: null,
    caption: null,
    linkPreview: false,
  };

  // Group-event stubs (subject/participant changes etc.). StubType
  // UNKNOWN is 0 and means "not a stub".
  if (
    message.messageStubType !== null &&
    message.messageStubType !== undefined &&
    message.messageStubType !== 0
  ) {
    return { ...base, kind: "system" };
  }

  // Edits and deletions at ANY unwrap depth travel as
  // protocolMessage / editedMessage content and must never be
  // re-captured (ADR 0004) — unwrapping editedMessage would otherwise
  // surface the replacement text as a fresh message (CR-m2).
  if (containsEditOrProtocol(message.message)) {
    return { ...base, kind: "protocol" };
  }

  const rawContent =
    message.message !== null && message.message !== undefined
      ? stripSoleNoiseKeys(message.message)
      : undefined;
  if (rawContent === undefined) {
    // No content at all, or only internal noise (SKDM / history notices).
    return { ...base, kind: message.message != null ? "system" : "empty" };
  }

  const content = normalizeMessageContent(rawContent);
  if (content === undefined) {
    return { ...base, kind: "empty" };
  }
  const type = getContentType(content);
  if (type === undefined) {
    return { ...base, kind: "empty" };
  }

  switch (type) {
    case "conversation": {
      return {
        ...base,
        kind: "text",
        text: stringOrNull(content.conversation) ?? "",
      };
    }
    case "extendedTextMessage": {
      const extended = content.extendedTextMessage;
      // Link-preview detection: WhatsApp sets matchedText (the URL it
      // matched to build the preview) on previewed messages (ADR 0004).
      const linkPreview = stringOrNull(extended?.matchedText) !== null;
      return {
        ...base,
        kind: linkPreview ? "link-preview" : "text",
        text: stringOrNull(extended?.text) ?? "",
        linkPreview,
      };
    }
    case "imageMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.imageMessage?.caption),
      };
    case "videoMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.videoMessage?.caption),
      };
    case "documentMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(content.documentMessage?.caption),
      };
    case "documentWithCaptionMessage":
      return {
        ...base,
        kind: "other",
        caption: stringOrNull(
          content.documentWithCaptionMessage?.message?.documentMessage
            ?.caption,
        ),
      };
    case "audioMessage":
    case "stickerMessage":
      return { ...base, kind: "other", caption: null };
    case "reactionMessage":
      return { ...base, kind: "reaction" };
    // The cases below are unreachable today — edits/protocol content is
    // caught by containsEditOrProtocol() and the noise keys are stripped
    // or rejected before classification. They are kept as annotated
    // backstops so a future wrapper shape can never fall into the
    // capture path by accident.
    case "protocolMessage":
    case "editedMessage":
      // Edits and deletions: skipped, the original captured text is kept.
      return { ...base, kind: "protocol" };
    case "senderKeyDistributionMessage":
    case "messageHistoryNotice":
    case "messageHistoryBundle":
      // Internal distribution/notice noise: never persisted.
      return { ...base, kind: "system" };
    default: {
      // Any other content type is captured as "other" with the caption
      // when the payload has one, else an empty body (ADR 0004).
      const payload = (content as Record<string, unknown>)[type];
      const caption =
        typeof payload === "object" && payload !== null
          ? stringOrNull((payload as { caption?: unknown }).caption)
          : null;
      return { ...base, kind: "other", caption };
    }
  }
}

/**
 * Classifies a connection close. Terminal causes (session revoked,
 * replaced, corrupt, forbidden) must stop reconnection and require a
 * manual re-link (ADR 0004); everything else retries with backoff.
 */
export function classifyClose(statusCode: number | undefined): {
  retryable: boolean;
  reason: string;
} {
  switch (statusCode) {
    case 401: // DisconnectReason.loggedOut — session revoked
      return { retryable: false, reason: "logged_out" };
    case 419: // unauthorized (Baileys UNAUTHORIZED_CODES) — cause unknown
      return { retryable: false, reason: "session_unauthorized" };
    case 440: // DisconnectReason.connectionReplaced — another device took over
      return { retryable: false, reason: "session_replaced" };
    case 500: // DisconnectReason.badSession — corrupt session state
      return { retryable: false, reason: "session_invalid" };
    case 403: // DisconnectReason.forbidden — account restricted
      return { retryable: false, reason: "account_forbidden" };
    case 411: // DisconnectReason.multideviceMismatch
      return { retryable: false, reason: "multidevice_mismatch" };
    case 515: // DisconnectReason.restartRequired — retried with backoff
      return { retryable: true, reason: "restart_required" };
    default:
      // 428 connectionClosed, 408 connectionLost/timedOut, 503
      // unavailableService, and unknown codes: transient.
      return { retryable: true, reason: "connection_lost" };
  }
}

/** Best-effort status code from a Boom-wrapped disconnect error. */
function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const boom = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  if (typeof boom.output?.statusCode === "number") {
    return boom.output.statusCode;
  }
  if (typeof boom.statusCode === "number") return boom.statusCode;
  return undefined;
}

export class BaileysAdapter implements WhatsAppAdapter {
  private socket: WASocket | null = null;
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private stopping = false;
  private pairingRequested = false;
  private pairingCodeFailed = false;
  private saveCreds: (() => Promise<void>) | null = null;
  /**
   * Serializes auth-state writes (audit L3): concurrent writeFile calls
   * on creds.json can corrupt the session and force a re-link, so every
   * save runs after the previous one completes.
   */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: BaileysAdapterOptions) {}

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: AdapterEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  /** Enqueues one serialized auth-state save. */
  private queueSaveCreds(): void {
    this.saveChain = this.saveChain
      .then(async () => {
        await this.saveCreds?.();
      })
      .catch((error) => {
        this.options.log("error", "save_creds_failed", {
          reason: errorReason(error),
        });
      });
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.pairingRequested = false;
    this.pairingCodeFailed = false;
    const silentLogger = createSilentLogger();

    // The session directory is protected storage; fs failures are
    // re-thrown with codes only so the path can never reach the logs.
    let auth: Awaited<ReturnType<typeof useMultiFileAuthState>>;
    try {
      auth = await useMultiFileAuthState(this.options.sessionDir);
    } catch (error) {
      throw new Error(`session storage unavailable (${errorReason(error)})`);
    }
    // Race guard (CR): stop() may have run during the awaits above — do
    // not create a socket nobody will close.
    if (this.stopping) return;
    this.saveCreds = auth.saveCreds;

    const version = await this.resolveVersion();
    if (this.stopping) return;
    this.socket = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger),
      },
      logger: silentLogger,
      ...(version !== undefined ? { version } : {}),
      emitOwnEvents: false,
      markOnlineOnConnect: false,
      // Privacy-minimizing collection (ADR 0004): no history backfill,
      // no decryption of non-group chats (DMs, status broadcasts, ...).
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) => !jid.endsWith("@g.us"),
      generateHighQualityLinkPreview: false,
    });

    // Race guard (CR): stop() raced socket creation — close the socket
    // created late so no orphan connection survives shutdown.
    if (this.stopping) {
      const late = this.socket;
      this.socket = null;
      try {
        late.end(undefined);
      } catch {
        // Already closed; nothing to release.
      }
      return;
    }

    this.socket.ev.on("creds.update", () => {
      this.queueSaveCreds();
    });
    this.socket.ev.on("connection.update", (update) => {
      this.onConnectionUpdate(update);
    });
    this.socket.ev.on("messages.upsert", (upsert) => {
      this.onMessagesUpsert(upsert);
    });
    this.socket.ev.on("groups.upsert", (groups) => {
      for (const group of groups) this.onGroupUpdate(group);
    });
    this.socket.ev.on("groups.update", (updates) => {
      for (const update of updates) this.onGroupUpdate(update);
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.end(undefined);
      } catch {
        // Already closed; nothing to release.
      }
    }
    // Final serialized auth-state flush (creds.update already saves on
    // change; queued saves complete before this returns).
    this.queueSaveCreds();
    await this.saveChain;
  }

  async fetchChats(): Promise<DiscoveredChat[]> {
    const socket = this.socket;
    if (socket === null) throw new Error("not connected");
    const participating = await socket.groupFetchAllParticipating();
    const chats: DiscoveredChat[] = [];
    for (const [jid, metadata] of Object.entries(participating)) {
      if (!jid.endsWith("@g.us")) continue;
      const name = stringOrNull(metadata?.subject) ?? jid;
      chats.push({ chatJid: jid, name });
    }
    return chats;
  }

  // ------------------------------------------------------------------
  // Baileys event translation
  // ------------------------------------------------------------------

  private onConnectionUpdate(update: Partial<BaileysConnectionState>): void {
    if (this.stopping) return;
    if (typeof update.qr === "string" && update.qr !== "") {
      this.onQr(update.qr);
    }
    if (update.connection === "connecting") {
      this.emit({ type: "connecting" });
    } else if (update.connection === "open") {
      this.emit({ type: "open" });
    } else if (update.connection === "close") {
      const statusCode = disconnectStatusCode(update.lastDisconnect?.error);
      const { retryable, reason } = classifyClose(statusCode);
      this.emit({ type: "close", retryable, reason });
    }
  }

  private onQr(qr: string): void {
    const phoneNumber = this.options.phoneNumber;
    if (
      phoneNumber !== undefined &&
      phoneNumber !== null &&
      phoneNumber !== "" &&
      !this.pairingCodeFailed
    ) {
      // Pairing-code linking (stretch, ADR 0004): request the code once
      // and show it instead of the QR.
      if (this.pairingRequested) return;
      this.pairingRequested = true;
      void this.requestPairingCode(phoneNumber, qr);
      return;
    }
    this.emit({ type: "qr", qr });
  }

  private async requestPairingCode(
    phoneNumber: string,
    fallbackQr: string,
  ): Promise<void> {
    try {
      const code = await this.socket?.requestPairingCode(phoneNumber);
      if (typeof code !== "string" || code === "") {
        throw new Error("empty pairing code");
      }
      this.emit({ type: "pairing-code", code });
    } catch (error) {
      // Never leave the operator without a way to link: fall back to the
      // QR now, and let every FRESH QR through afterwards (a QR expires
      // within ~20s and must be replaced by a newer one — forwarding
      // only this stale fallback would leave the operator stuck).
      this.pairingCodeFailed = true;
      this.options.log("warn", "pairing_code_failed", {
        reason: errorReason(error),
      });
      this.emit({ type: "qr", qr: fallbackQr });
    }
  }

  private onMessagesUpsert(upsert: {
    messages: WAMessage[];
    type: string;
  }): void {
    // Both live ("notify") and replayed ("append") upserts flow through
    // the same idempotent capture path (ADR 0004): duplicates count as
    // already captured, and history sync is disabled anyway.
    const messages: RawInboundMessage[] = [];
    for (const message of upsert.messages) {
      const mapped = mapWAMessage(message);
      if (mapped !== null) messages.push(mapped);
    }
    if (messages.length > 0) {
      this.emit({ type: "messages", messages });
    }
  }

  private onGroupUpdate(group: Partial<GroupMetadata>): void {
    // Only meaningful subject updates: a missing subject must never
    // overwrite a registered group name with its JID (ADR 0004).
    const chatJid = stringOrNull(group.id);
    const name = stringOrNull(group.subject);
    if (chatJid === null || name === null || !chatJid.endsWith("@g.us")) {
      return;
    }
    this.emit({ type: "chat-updated", chat: { chatJid, name } });
  }

  private async resolveVersion(): Promise<WAVersion | undefined> {
    // Opt-in egress (audit L6): the version manifest fetch phones home on
    // every connect and lets a third party influence the protocol
    // version. By default the WhatsApp Web version bundled with the
    // pinned Baileys release is used (undefined = Baileys default).
    if (this.options.checkForUpdates !== true) return undefined;
    try {
      const { version } = await fetchLatestBaileysVersion();
      return version;
    } catch (error) {
      // Offline or GitHub unreachable: fall back to the bundled version.
      this.options.log("warn", "baileys_version_fetch_failed", {
        reason: errorReason(error),
      });
      return undefined;
    }
  }
}
