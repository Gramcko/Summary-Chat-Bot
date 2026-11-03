import { describe, expect, it } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  classifyClose,
  classifyHistoryCorrelation,
  isIgnoredIncomingJid,
  mapHistorySet,
  mapWAMessage,
} from "../src/whatsapp/baileys-adapter.js";

/**
 * Baileys translation rules (ADR 0004). Importing the adapter also
 * serves as the Baileys-under-Node-26 import smoke test — if the pinned
 * @whiskeysockets/baileys release stops loading, this suite fails
 * before anything else does. No WhatsApp account is ever involved.
 */

function wa(partial: Record<string, unknown>): WAMessage {
  return partial as unknown as WAMessage;
}

const KEY = {
  remoteJid: "111111111111-22222222@g.us",
  fromMe: false,
  id: "MSG-ID-1",
  participant: "sender@s.whatsapp.net",
};

describe("classifyClose (reconnect policy per disconnect cause)", () => {
  it("treats logged-out and unauthorized codes as terminal", () => {
    expect(classifyClose(401)).toEqual({
      retryable: false,
      reason: "logged_out",
    });
    // 419 is an unauthorized code of unknown cause: terminal, but not
    // labeled as a definite logout (CR).
    expect(classifyClose(419)).toEqual({
      retryable: false,
      reason: "session_unauthorized",
    });
  });

  it("treats a replaced, corrupt, or forbidden session as terminal", () => {
    expect(classifyClose(440).retryable).toBe(false);
    expect(classifyClose(500).retryable).toBe(false);
    expect(classifyClose(403).retryable).toBe(false);
    expect(classifyClose(411).retryable).toBe(false);
  });

  it("retries transient closes and restarts", () => {
    expect(classifyClose(428).retryable).toBe(true);
    expect(classifyClose(408).retryable).toBe(true);
    expect(classifyClose(503).retryable).toBe(true);
    expect(classifyClose(undefined).retryable).toBe(true);
    expect(classifyClose(515)).toEqual({
      retryable: true,
      reason: "restart_required",
    });
  });
});

describe("mapWAMessage (content classification)", () => {
  it("maps a plain conversation message to kind text", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1_772_000_000,
        message: { conversation: "hello" },
      }),
    );
    expect(mapped).toEqual({
      chatJid: KEY.remoteJid,
      messageId: "MSG-ID-1",
      senderJid: "sender@s.whatsapp.net",
      timestampSec: 1_772_000_000,
      fromMe: false,
      kind: "text",
      text: "hello",
      caption: null,
      linkPreview: false,
    });
  });

  it("maps extendedTextMessage without preview to kind text", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { extendedTextMessage: { text: "hi there" } },
      }),
    );
    expect(mapped?.kind).toBe("text");
    expect(mapped?.text).toBe("hi there");
    expect(mapped?.linkPreview).toBe(false);
  });

  it("maps extendedTextMessage with a link preview to kind link-preview", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          extendedTextMessage: {
            text: "see this",
            matchedText: "https://example.com/a",
          },
        },
      }),
    );
    expect(mapped?.kind).toBe("link-preview");
    expect(mapped?.linkPreview).toBe(true);
  });

  it("extracts captions from image, video, and document messages", () => {
    for (const message of [
      { imageMessage: { caption: "pic" } },
      { videoMessage: { caption: "vid" } },
      { documentMessage: { caption: "doc" } },
    ]) {
      const mapped = mapWAMessage(
        wa({ key: KEY, messageTimestamp: 1, message }),
      );
      expect(mapped?.kind).toBe("other");
      expect(mapped?.caption).not.toBeNull();
    }
  });

  it("extracts the caption from documentWithCaptionMessage", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          documentWithCaptionMessage: {
            message: { documentMessage: { caption: "wrapped" } },
          },
        },
      }),
    );
    expect(mapped?.kind).toBe("other");
    expect(mapped?.caption).toBe("wrapped");
  });

  it("maps captionless media to kind other with no caption", () => {
    for (const message of [
      { audioMessage: {} },
      { stickerMessage: {} },
      { locationMessage: { degreesLatitude: 1 } },
    ]) {
      const mapped = mapWAMessage(
        wa({ key: KEY, messageTimestamp: 1, message }),
      );
      expect(mapped?.kind).toBe("other");
      expect(mapped?.caption).toBeNull();
    }
  });

  it("unwraps ephemeral wrappers before classifying", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          ephemeralMessage: { message: { conversation: "wrapped text" } },
        },
      }),
    );
    expect(mapped?.kind).toBe("text");
    expect(mapped?.text).toBe("wrapped text");
  });

  it("maps reactions to kind reaction (skipped later)", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { reactionMessage: { text: "👍" } },
      }),
    );
    expect(mapped?.kind).toBe("reaction");
  });

  it("maps protocol messages and edited-message wrappers to kind protocol", () => {
    const protocol = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { protocolMessage: { type: 1 } },
      }),
    );
    expect(protocol?.kind).toBe("protocol");
    const edited = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          editedMessage: { message: { conversation: "new text" } },
        },
      }),
    );
    expect(edited?.kind).toBe("protocol");
  });

  it("maps group-event stubs to kind system even when content exists", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        messageStubType: 2,
        message: { conversation: "irrelevant" },
      }),
    );
    expect(mapped?.kind).toBe("system");
  });

  it("maps history-sync notices to kind system", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { messageHistoryNotice: {} },
      }),
    );
    expect(mapped?.kind).toBe("system");
  });

  it("captures text bundled with senderKeyDistributionMessage (CR-M1)", () => {
    // WhatsApp delivers SKDM alongside real content in the same proto:
    // the real message must never be dropped as "system" noise.
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          senderKeyDistributionMessage: { distribution: "bytes" },
          conversation: "hi",
        },
      }),
    );
    expect(mapped?.kind).toBe("text");
    expect(mapped?.text).toBe("hi");
  });

  it("captures media bundled with senderKeyDistributionMessage (CR-M1)", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          senderKeyDistributionMessage: { distribution: "bytes" },
          imageMessage: { caption: "pic" },
        },
      }),
    );
    expect(mapped?.kind).toBe("other");
    expect(mapped?.caption).toBe("pic");
  });

  it("still treats sole noise content as kind system", () => {
    const skdm = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { senderKeyDistributionMessage: { distribution: "bytes" } },
      }),
    );
    expect(skdm?.kind).toBe("system");
    const notice = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { messageHistoryBundle: {} },
      }),
    );
    expect(notice?.kind).toBe("system");
  });

  it("skips nested edited-message wrappers at any unwrap depth (CR-m2)", () => {
    // ephemeralMessage > editedMessage > conversation is an edit: the
    // replacement text must never surface as a fresh message.
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          ephemeralMessage: {
            message: {
              editedMessage: { message: { conversation: "replacement" } },
            },
          },
        },
      }),
    );
    expect(mapped?.kind).toBe("protocol");
  });

  it("skips nested protocol messages at any unwrap depth (CR-m2)", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          viewOnceMessage: {
            message: { protocolMessage: { type: 0 } },
          },
        },
      }),
    );
    expect(mapped?.kind).toBe("protocol");
  });

  it("still captures ordinary content nested in wrappers", () => {
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: {
          ephemeralMessage: {
            message: {
              senderKeyDistributionMessage: { distribution: "bytes" },
              conversation: "kept",
            },
          },
        },
      }),
    );
    expect(mapped?.kind).toBe("text");
    expect(mapped?.text).toBe("kept");
  });

  it("maps content-less messages to kind empty (skipped later)", () => {
    expect(mapWAMessage(wa({ key: KEY, messageTimestamp: 1 }))?.kind).toBe(
      "empty",
    );
    expect(
      mapWAMessage(wa({ key: KEY, messageTimestamp: 1, message: {} }))?.kind,
    ).toBe("empty");
  });

  it("maps any other content type to kind other with its caption when present", () => {
    const withCaption = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: 1,
        message: { templateMessage: { caption: "tpl" } },
      }),
    );
    expect(withCaption?.kind).toBe("other");
    expect(withCaption?.caption).toBe("tpl");
  });

  it("accepts Long-like timestamps and reports missing ones as null", () => {
    const longLike = {
      toNumber: () => 1_772_000_000,
    };
    const mapped = mapWAMessage(
      wa({
        key: KEY,
        messageTimestamp: longLike,
        message: { conversation: "x" },
      }),
    );
    expect(mapped?.timestampSec).toBe(1_772_000_000);

    const missing = mapWAMessage(
      wa({ key: KEY, message: { conversation: "x" } }),
    );
    expect(missing?.timestampSec).toBeNull();
  });

  it("reports missing identity fields as null without crashing", () => {
    const mapped = mapWAMessage(
      wa({
        key: { remoteJid: KEY.remoteJid, fromMe: true },
        messageTimestamp: 1,
        message: { conversation: "x" },
      }),
    );
    expect(mapped?.messageId).toBeNull();
    expect(mapped?.senderJid).toBeNull();
    expect(mapped?.fromMe).toBe(true);
  });

  it("returns null when the message has no chat JID at all", () => {
    expect(mapWAMessage(wa({ key: {}, messageTimestamp: 1 }))).toBeNull();
  });
});

describe("mapHistorySet (messaging-history.set translation, ADR 0007)", () => {
  const A = "111111111111-22222222@g.us";
  const B = "333333333333-44444444@g.us";

  const historyMessage = (chatJid: string, id: string): WAMessage =>
    wa({
      key: { remoteJid: chatJid, fromMe: false, id, participant: "u@s.whatsapp.net" },
      messageTimestamp: 1000,
      message: { conversation: `text-${id}` },
    });

  it("emits one history event per requested chat, mapped via mapWAMessage", () => {
    const events = mapHistorySet(
      {
        messages: [historyMessage(A, "M1"), historyMessage(A, "M2")],
        progress: 0.5,
        peerDataRequestSessionId: "req-1",
      },
      new Set([A]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("history");
    expect(events[0]?.chatJid).toBe(A);
    expect(events[0]?.messages.map((m) => m.messageId)).toEqual(["M1", "M2"]);
    expect(events[0]?.messages[0]?.kind).toBe("text");
    expect(events[0]?.progress).toBe(0.5);
    expect(events[0]?.requestId).toBe("req-1");
  });

  it("drops other chats' history BEFORE normalization (privacy)", () => {
    const events = mapHistorySet(
      { messages: [historyMessage(B, "OTHER"), historyMessage(A, "M1")] },
      new Set([A]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.chatJid).toBe(A);
    expect(events[0]?.messages.map((m) => m.messageId)).toEqual(["M1"]);
  });

  it("emits nothing when no chat was requested (bulk sync)", () => {
    const events = mapHistorySet(
      { messages: [historyMessage(A, "M1")] },
      new Set(),
    );
    expect(events).toEqual([]);
  });

  it("splits a multi-chat batch into per-chat events", () => {
    const events = mapHistorySet(
      { messages: [historyMessage(A, "M1"), historyMessage(B, "M2")] },
      new Set([A, B]),
    );
    expect(events.map((e) => e.chatJid).sort()).toEqual([A, B].sort());
    expect(events.find((e) => e.chatJid === A)?.messages).toHaveLength(1);
  });
});

describe("isIgnoredIncomingJid (SA-L2 self-JID predicate)", () => {
  const selfUsers = new Set(["1234567890", "987654321"]); // own PN + LID users

  it("allows group chats", () => {
    expect(isIgnoredIncomingJid("111111111111-22222222@g.us", selfUsers)).toBe(
      false,
    );
  });

  it("allows the account's own PN and LID JIDs, with or without device suffix", () => {
    expect(isIgnoredIncomingJid("1234567890@s.whatsapp.net", selfUsers)).toBe(false);
    expect(isIgnoredIncomingJid("1234567890:12@s.whatsapp.net", selfUsers)).toBe(false);
    expect(isIgnoredIncomingJid("987654321:34@lid", selfUsers)).toBe(false);
    expect(isIgnoredIncomingJid("987654321@lid", selfUsers)).toBe(false);
  });

  it("ignores DMs, status broadcasts, newsletters, and bare broadcasts", () => {
    expect(isIgnoredIncomingJid("555000111@s.whatsapp.net", selfUsers)).toBe(true);
    expect(isIgnoredIncomingJid("status@broadcast", selfUsers)).toBe(true);
    expect(isIgnoredIncomingJid("123456789@newsletter", selfUsers)).toBe(true);
    expect(isIgnoredIncomingJid("status@broadcast", new Set())).toBe(true);
    expect(isIgnoredIncomingJid("555:1@s.whatsapp.net", new Set())).toBe(true);
  });
});

describe("classifyHistoryCorrelation (SA-M3, log-only)", () => {
  const known = new Set(["req-1", "req-2"]);

  it("matches an outstanding request id", () => {
    expect(classifyHistoryCorrelation("req-1", known)).toBe("match");
  });

  it("flags an absent session id", () => {
    expect(classifyHistoryCorrelation(null, known)).toBe("missing-session-id");
  });

  it("flags a foreign session id", () => {
    expect(classifyHistoryCorrelation("req-9", known)).toBe("unknown-session-id");
    expect(classifyHistoryCorrelation("req-1", new Set())).toBe(
      "unknown-session-id",
    );
  });
});
