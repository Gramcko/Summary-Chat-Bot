import { createHash } from "node:crypto";

/**
 * Privacy helpers (AGENTS.md: never log phone numbers).
 *
 * Legacy WhatsApp group JIDs embed phone numbers, so raw chat JIDs must
 * never reach the logs. `safeChatRef` maps a JID to a short, stable,
 * non-reversible reference (truncated SHA-256) that still lets an
 * operator correlate log lines for the same chat across events.
 */
export function safeChatRef(chatJid: string): string {
  return createHash("sha256").update(chatJid).digest("hex").slice(0, 12);
}
