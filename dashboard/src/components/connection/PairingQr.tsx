"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";

interface PairingQrProps {
  /** Live pairing ticket from `ConnectionStatus.linking`. Never rendered as text. */
  qr: string;
}

/**
 * Renders the pairing ticket as a QR image. `qrcode` is imported lazily so the
 * encoder stays out of the initial bundle and never runs on the server. The
 * ticket itself is a live credential: it is only ever passed to the encoder, not
 * logged, linked, or shown as text.
 */
export function PairingQr({ qr }: PairingQrProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    setFailed(false);

    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const url = await toDataURL(qr, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 320,
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        if (active) setDataUrl(url);
      } catch {
        if (active) setFailed(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [qr]);

  return (
    <div className="flex h-64 w-64 items-center justify-center rounded-2xl border border-slate-200 bg-white p-2 shadow-card">
      {failed ? (
        <p className="px-4 text-center text-sm text-red-700">
          Could not render the QR code. Wait for the next code or refresh.
        </p>
      ) : dataUrl === null ? (
        <div className="h-full w-full p-2">
          <Skeleton className="h-full w-full" />
        </div>
      ) : (
        <img
          src={dataUrl}
          alt="WhatsApp pairing QR code"
          width={320}
          height={320}
          className="h-full w-full"
        />
      )}
    </div>
  );
}
