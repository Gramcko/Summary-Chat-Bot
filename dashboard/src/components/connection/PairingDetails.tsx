"use client";

import type { ConnectionLinking } from "@summarly/contracts";
import { useState } from "react";
import { PairingQr } from "./PairingQr";
import { Button } from "@/components/ui/Button";
import { formatCountdown } from "@/lib/connection";

type CopyState = "idle" | "copied" | "failed";

interface PairingDetailsProps {
  linking: ConnectionLinking;
  /** Whole seconds until the payload expires (0 when expired). */
  remainingSeconds: number;
  expired: boolean;
}

/**
 * Renders the pairing payload in the shape the bot worker chose:
 * `qr` as a scannable QR image, `pairing-code` as text to type into
 * WhatsApp's "Link with phone number" flow. The payload is a live credential —
 * it is only shown here (never logged or put into a URL), and the copy action
 * is explicit.
 */
export function PairingDetails({
  linking,
  remainingSeconds,
  expired,
}: PairingDetailsProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const isPairingCode = linking.kind === "pairing-code";

  async function handleCopy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error("unavailable");
      await navigator.clipboard.writeText(linking.qr);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {isPairingCode ? (
        <div className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Pairing code
          </p>
          <p className="mt-2 select-all break-all font-mono text-2xl font-semibold tracking-[0.2em] text-slate-900">
            {linking.qr}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
              Copy code
            </Button>
            <span aria-live="polite" className="text-xs text-slate-600">
              {copyState === "copied"
                ? "Copied to clipboard."
                : copyState === "failed"
                  ? "Copy failed — select the code and copy it manually."
                  : ""}
            </span>
          </div>
        </div>
      ) : (
        <PairingQr qr={linking.qr} />
      )}

      <div className="text-center">
        {expired ? (
          <p role="status" className="text-sm font-medium text-amber-800">
            This {isPairingCode ? "pairing code" : "QR code"} expired — waiting for
            a new one…
          </p>
        ) : (
          <p className="text-sm text-slate-700">
            Expires in{" "}
            <span className="font-medium tabular-nums">
              {formatCountdown(remainingSeconds)}
            </span>
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          A new one is published automatically while linking.
        </p>
      </div>

      <ol className="w-full space-y-1 text-sm text-slate-600">
        <li>1. Open WhatsApp on your phone.</li>
        <li>
          2. Tap <strong>Linked devices</strong> →{" "}
          {isPairingCode ? (
            <>
              <strong>Link with phone number</strong>.
            </>
          ) : (
            <>
              <strong>Link a device</strong>.
            </>
          )}
        </li>
        <li>
          3.{" "}
          {isPairingCode
            ? "Enter the pairing code shown here."
            : "Scan the QR code shown here."}
        </li>
      </ol>

      {isPairingCode ? (
        <p className="text-center text-xs text-slate-500">
          WhatsApp shows this flow when the bot worker is configured with a phone
          number instead of the camera scanner.
        </p>
      ) : null}
    </div>
  );
}
