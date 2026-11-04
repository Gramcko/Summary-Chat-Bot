/**
 * Display helpers for the Contacts screens. WhatsApp exposes names only
 * through saved contacts / message push names, so a contact may have
 * only a PN JID or LID; never render a raw JID as the primary label.
 */

export function formatPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.split("@")[0]?.split(":")[0] ?? "";
  return digits === "" ? phone : `+${digits}`;
}

export function contactLabel(contact: {
  name: string | null;
  phone: string | null;
}): string {
  return contact.name ?? formatPhone(contact.phone) ?? "Unknown contact";
}

export function contactInitials(contact: {
  name: string | null;
}): string {
  const source = contact.name ?? "";
  if (source === "") return "?";
  const parts = source.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join("");
  return letters.length === 0 ? "?" : letters.toUpperCase();
}
