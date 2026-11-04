import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSessionArtefact,
  purgeSessionDir,
} from "../src/whatsapp/session-storage.js";

/**
 * Session-state purge (ADR 0008, M-3): the admin logout deletes ONLY
 * the auth-state artefacts `useMultiFileAuthState` writes (verified
 * against the installed Baileys 6.7.24); unknown files are never
 * touched and are reported. The directory itself may stay. The helper
 * is idempotent and never exposes the directory path (failures carry
 * error codes).
 */

describe("isSessionArtefact (allow-list, verified against Baileys 6.7.24)", () => {
  it("matches the files useMultiFileAuthState writes", () => {
    for (const name of [
      "creds.json",
      "pre-key-1.json",
      "session-123-456@s.whatsapp.net-7.json".replace(/\//g, "__"),
      "session-ABCDEF.json",
      "sender-key-111-222@g.us.json",
      "sender-key-memory-3.json",
      "app-state-sync-key-XYZ.json",
      "app-state-sync-version-0.json",
    ]) {
      expect(isSessionArtefact(name)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const name of [
      "notes.txt",
      "backup.tar",
      "creds.json.bak",
      "creds.jsonx",
      "pre-key.json", // no id suffix: not a store artefact
      "my-creds.json",
      "",
    ]) {
      expect(isSessionArtefact(name)).toBe(false);
    }
  });
});

describe("purgeSessionDir (admin logout cleanup)", () => {
  it("removes only auth-state artefacts, keeps the rest and the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-purge-"));
    writeFileSync(join(dir, "creds.json"), "{}");
    writeFileSync(join(dir, "app-state-sync-key-0.json"), "{}");
    writeFileSync(join(dir, "pre-key-5.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    mkdirSync(join(dir, "subdir"), { recursive: true });
    writeFileSync(join(dir, "subdir", "creds.json"), "{}"); // nested: not ours

    const unknown: number[] = [];
    const result = purgeSessionDir(dir, (count) => unknown.push(count));

    expect(result).toEqual({ removed: 3, kept: 2 });
    expect(unknown).toEqual([2]); // reported, never touched
    expect(existsSync(dir)).toBe(true); // the directory stays
    expect(existsSync(join(dir, "creds.json"))).toBe(false);
    expect(existsSync(join(dir, "app-state-sync-key-0.json"))).toBe(false);
    expect(existsSync(join(dir, "pre-key-5.json"))).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "subdir"))).toBe(true); // unknown entry
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "subdir"]);
  });

  it("is idempotent: an already-empty or missing directory is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-purge-"));
    expect(purgeSessionDir(dir)).toEqual({ removed: 0, kept: 0 });
    expect(purgeSessionDir(dir)).toEqual({ removed: 0, kept: 0 });
    expect(purgeSessionDir(join(dir, "never-existed"))).toEqual({
      removed: 0,
      kept: 0,
    });
  });
});
