import { describe, expect, it } from "vitest";
import { ConnectionLinking, ConnectionStatus } from "../src/index.js";

const BASE = {
  state: "connected",
  since: "2026-11-01T09:00:00Z",
  lastMessageAt: "2026-11-01T09:15:00Z",
};

describe("ConnectionStatus.linking (pairing ticket, ADR 0008)", () => {
  it("is null when no linking is in progress (e.g. connected)", () => {
    const parsed = ConnectionStatus.parse({ ...BASE, linking: null });
    expect(parsed.linking).toBeNull();
  });

  it("carries the QR payload and its expiry while linking", () => {
    const parsed = ConnectionStatus.parse({
      ...BASE,
      state: "connecting",
      linking: { qr: "2@abc123pairingpayload", expiresAt: "2026-11-01T09:05:00Z" },
    });
    expect(parsed.linking?.qr).toBe("2@abc123pairingpayload");
    expect(parsed.linking?.expiresAt).toBe("2026-11-01T09:05:00Z");
    // kind defaults to "qr" when not published explicitly.
    expect(parsed.linking?.kind).toBe("qr");
  });

  it("requires both fields when linking is present", () => {
    expect(
      ConnectionStatus.safeParse({
        ...BASE,
        linking: { qr: "", expiresAt: "2026-11-01T09:05:00Z" },
      }).success,
    ).toBe(false);
    expect(
      ConnectionStatus.safeParse({
        ...BASE,
        linking: { qr: "2@abc" },
      }).success,
    ).toBe(false);
    // The field itself is required-but-nullable (like every system
    // field in this API surface).
    expect(
      ConnectionStatus.safeParse({
        ...BASE,
      }).success,
    ).toBe(false);
  });
});

describe("ConnectionLinking.kind (pairing display, fix round A)", () => {
  it("accepts qr and pairing-code, and defaults to qr when absent", () => {
    expect(
      ConnectionLinking.parse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "pairing-code",
      }).kind,
    ).toBe("pairing-code");
    // Default behavior: QR payloads (pre-kind rows) are served as "qr".
    expect(
      ConnectionLinking.parse({
        qr: "2@abc123pairingpayload",
        expiresAt: "2026-11-01T09:05:00Z",
      }).kind,
    ).toBe("qr");
  });

  it("rejects any other kind spelling", () => {
    expect(
      ConnectionLinking.safeParse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "QR",
      }).success,
    ).toBe(false);
    expect(
      ConnectionLinking.safeParse({
        qr: "12345678",
        expiresAt: "2026-11-01T09:05:00Z",
        kind: "pairing",
      }).success,
    ).toBe(false);
  });
});
