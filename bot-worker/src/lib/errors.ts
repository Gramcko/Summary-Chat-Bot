/**
 * Safe error summaries for operational logs (AGENTS.md, ADR 0004):
 * identifiers, codes, and truncated driver messages only — never
 * message content, credentials, or file paths (fs errors carry the
 * WhatsApp session directory in their message and are reduced to their
 * stable error code).
 */

/**
 * NodeJS errno codes raised by file-system operations. Their messages
 * embed file paths, so the code alone is exposed even when the error
 * object carries no `path` property (audit L3: fs errors assembled or
 * re-thrown elsewhere may lose `path` but keep the code).
 */
const FS_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EFBIG",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "EXDEV",
]);

/**
 * Redacts path-like substrings (Windows drive/UNC paths and POSIX-style
 * path segments) from free-text messages before logging.
 */
export function redactPaths(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, "<path>")
    .replace(/\\\\[^\s"'<>|]+/g, "<path>")
    .replace(/(^|[\s"'(])\/[\w.@+-]+(?:\/[\w.@+-]+)+/g, "$1<path>");
}

/**
 * Redacts WhatsApp JIDs and JID/email-like tokens (SA-L3): legacy JIDs
 * embed phone numbers and device suffixes (`12345:12@s.whatsapp.net`,
 * `…@lid`, `…@g.us`, `…@broadcast`, `…@newsletter`), so any
 * `user@server` token in a message becomes `<jid>` before logging.
 */
export function redactJids(message: string): string {
  return message.replace(/[\w.:+\-]+@[A-Za-z0-9.\-]+/g, "<jid>");
}

export function errorReason(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown;
      path?: unknown;
      message?: unknown;
    };
    // fs/system errors embed file paths in `message`: expose the stable
    // code instead — whenever a path is present, and for the known
    // fs errno codes even when it is not (they never carry useful,
    // path-free context worth keeping).
    if (typeof candidate.code === "string") {
      if (candidate.path !== undefined || FS_ERROR_CODES.has(candidate.code)) {
        return candidate.code;
      }
    }
    if (typeof candidate.message === "string") {
      return redactJids(redactPaths(candidate.message)).slice(0, 200);
    }
  }
  return redactJids(redactPaths(String(error))).slice(0, 200);
}
