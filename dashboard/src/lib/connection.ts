import type { ConnectionLinking, ConnectionStatus } from "@summarly/contracts";

/**
 * Pure helpers for the WhatsApp connection screen.
 *
 * `linking.qr` is a LIVE pairing ticket served only on the authenticated API.
 * It must never be logged, copied into a URL, or rendered as text; only the
 * rendered QR image is shown to the admin.
 */

/** How often the connection screen polls while the session is not linked. */
export const CONNECTION_POLL_MS = 2_500;

/**
 * Poll until the session is connected. A missing status means the first load
 * has not resolved yet, so polling should start.
 */
export function shouldPollConnection(
  status: ConnectionStatus | null | undefined,
): boolean {
  if (status === undefined || status === null) return true;
  return status.state !== "connected";
}

/** Whole seconds until `iso`, floored at zero. Invalid input counts as expired. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

export function isLinkingExpired(
  linking: ConnectionLinking | null,
  now: number = Date.now(),
): boolean {
  if (linking === null) return false;
  return secondsUntil(linking.expiresAt, now) === 0;
}

/** `mm:ss` countdown label (e.g. `1:05`). */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
