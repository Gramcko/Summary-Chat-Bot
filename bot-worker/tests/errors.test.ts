import { describe, expect, it } from "vitest";
import { errorReason, redactJids, redactPaths } from "../src/lib/errors.js";

/**
 * Safe error summaries (audit L3): fs error codes are preferred over
 * messages (which embed file paths), and path-like substrings are
 * redacted from whatever remains. The session directory path must
 * never reach the logs (ADR 0004).
 */

describe("redactPaths", () => {
  it("redacts Windows drive paths", () => {
    expect(
      redactPaths("failed to open C:\\Users\\me\\.summarly\\wa\\creds.json"),
    ).toBe("failed to open <path>");
  });

  it("redacts POSIX-style paths", () => {
    expect(
      redactPaths("ENOENT while reading /var/lib/summarly/wa-session/creds.json"),
    ).toBe("ENOENT while reading <path>");
  });

  it("keeps ordinary text untouched", () => {
    expect(redactPaths("connection lost (attempt 2)")).toBe(
      "connection lost (attempt 2)",
    );
  });
});

describe("redactJids (SA-L3)", () => {
  it("redacts user JIDs with and without device suffixes", () => {
    expect(redactJids("failed for 1234567890:12@s.whatsapp.net")).toBe(
      "failed for <jid>",
    );
    expect(redactJids("failed for 1234567890@s.whatsapp.net")).toBe(
      "failed for <jid>",
    );
  });

  it("redacts group, LID, broadcast, and newsletter JIDs", () => {
    expect(redactJids("chat 111111111111-2222@g.us")).toBe("chat <jid>");
    expect(redactJids("from 987654321:34@lid")).toBe("from <jid>");
    expect(redactJids("status@broadcast")).toBe("<jid>");
    expect(redactJids("123456789@newsletter")).toBe("<jid>");
  });

  it("redacts several JIDs in one message", () => {
    expect(
      redactJids("a 1@s.whatsapp.net and 2@g.us and 3@lid"),
    ).toBe("a <jid> and <jid> and <jid>");
  });
});

describe("errorReason", () => {
  it("returns the code for fs errors carrying a path", () => {
    const error = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open 'C:\\secret\\wa-session\\creds.json'",
      ),
      { code: "ENOENT", path: "C:\\secret\\wa-session\\creds.json" },
    );
    expect(errorReason(error)).toBe("ENOENT");
  });

  it("returns the code for known fs codes even without a path (audit L3)", () => {
    // fs errors assembled or re-thrown elsewhere lose `path` but keep
    // the code — the message may still embed the path, so prefer code.
    const error = Object.assign(
      new Error("EACCES: permission denied, open '/home/me/wa/creds.json'"),
      { code: "EACCES" },
    );
    expect(errorReason(error)).toBe("EACCES");
  });

  it("keeps non-fs driver messages (redacted)", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    );
    expect(errorReason(error)).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("redacts paths from plain error messages", () => {
    const error = new Error(
      "failed to read /home/user/.summarly/wa-session/creds.json",
    );
    expect(errorReason(error)).toBe("failed to read <path>");
  });

  it("redacts JIDs from driver messages (SA-L3)", () => {
    expect(
      errorReason(new Error("decrypt failed for 1234567890:12@s.whatsapp.net")),
    ).toBe("decrypt failed for <jid>");
    expect(errorReason(new Error("stale batch for 111-222@g.us"))).toBe(
      "stale batch for <jid>",
    );
  });

  it("truncates long messages", () => {
    const reason = errorReason(new Error("x".repeat(500)));
    expect(reason).toHaveLength(200);
  });

  it("handles non-Error values", () => {
    expect(errorReason("plain string failure")).toBe("plain string failure");
    expect(errorReason(undefined)).toBe("undefined");
  });
});
