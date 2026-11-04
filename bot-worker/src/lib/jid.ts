/**
 * Pure WhatsApp JID helpers (no Baileys import — safe for any layer).
 * Legacy group JIDs and participant JIDs are PII, so these helpers are
 * only used for matching/normalization and never for logging.
 */

/**
 * Normalizes a WhatsApp JID to its `user@server` alias, dropping any
 * device suffix (`123:4@s.whatsapp.net` -> `123@s.whatsapp.net`).
 * Returns null for empty/malformed values. Contacts and roster rows are
 * keyed by this alias so LID and PN forms of the same person can be
 * resolved independently.
 */
export function normalizeJidAlias(jid: unknown): string | null {
  if (typeof jid !== "string" || jid === "") return null;
  const at = jid.indexOf("@");
  const userPart = at === -1 ? jid : jid.slice(0, at);
  const server = at === -1 ? "" : jid.slice(at);
  const user = userPart.split(":")[0] ?? userPart;
  return user === "" ? null : `${user}${server}`;
}

/** True when a JID is a phone-number (PN) JID (`…@s.whatsapp.net`). */
export function isPhoneJid(jid: unknown): boolean {
  return typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
}
