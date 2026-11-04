import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultWorkerSpecs,
  parseSuperviseWorkers,
  repoRoot,
  resolveWorkerEntry,
  WorkerSupervisor,
  type SupervisorLogger,
  type WorkerSpec,
} from "../src/lib/supervisor.js";

/**
 * Worker supervision (ADR 0008 round 3). These tests spawn REAL child
 * processes (tiny `node -e` fakes) so the restart policy, the shutdown
 * kill path, and SUMMARLY_PARENT_PID are proven against actual
 * processes — without any WhatsApp account, database, or queue.
 */

type Event = {
  event: string;
  fields: Record<string, string | number | boolean | null>;
};

function captureLog(): { events: Event[]; log: SupervisorLogger } {
  const events: Event[] = [];
  return {
    events,
    log: (event, fields) => {
      events.push({ event, fields });
    },
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempFiles: string[] = [];

function tempFile(prefix: string): string {
  const file = join(tmpdir(), `${prefix}-${randomUUID()}.txt`);
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  while (tempFiles.length > 0) {
    const file = tempFiles.pop();
    if (file !== undefined) {
      try {
        rmSync(file, { force: true, recursive: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

describe("parseSuperviseWorkers (SUPERVISE_WORKERS)", () => {
  it("defaults to enabled and accepts the usual true spellings", () => {
    expect(parseSuperviseWorkers(undefined)).toBe(true);
    expect(parseSuperviseWorkers("")).toBe(true);
    expect(parseSuperviseWorkers(" true ")).toBe(true);
    expect(parseSuperviseWorkers("yes")).toBe(true);
    expect(parseSuperviseWorkers("1")).toBe(true);
  });

  it("disables supervision for the false spellings", () => {
    expect(parseSuperviseWorkers("false")).toBe(false);
    expect(parseSuperviseWorkers("NO")).toBe(false);
    expect(parseSuperviseWorkers("0")).toBe(false);
    expect(parseSuperviseWorkers("False")).toBe(false);
  });

  it("fails fast on anything else", () => {
    expect(() => parseSuperviseWorkers("maybe")).toThrow(/SUPERVISE_WORKERS/);
  });
});

describe("resolveWorkerEntry (built vs dev, documented rule)", () => {
  it("uses the built entry whenever dist/index.js exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-entry-"));
    tempFiles.push(dir);
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.js"), "");
    const resolved = resolveWorkerEntry(dir, undefined);
    expect(resolved.entry).toBe("built");
    expect(resolved.args).toEqual([join(dir, "dist", "index.js")]);
    // No src/ to compare against: not stale.
    expect(resolved.staleByMs).toBeNull();
  });

  it("flags a built entry older than src files as stale (m10)", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-entry-"));
    tempFiles.push(dir);
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "src"));
    const built = join(dir, "dist", "index.js");
    const source = join(dir, "src", "index.ts");
    writeFileSync(built, "");
    writeFileSync(source, "");
    // The build is a minute OLDER than the newest source file.
    const past = new Date(Date.now() - 60_000);
    utimesSync(built, past, past);
    const resolved = resolveWorkerEntry(dir, undefined);
    expect(resolved.entry).toBe("built"); // still runs the build (documented)
    expect(resolved.staleByMs).toBeGreaterThanOrEqual(59_000);
  });

  it("reports no staleness when the build is newer than src", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-entry-"));
    tempFiles.push(dir);
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "src"));
    const built = join(dir, "dist", "index.js");
    const source = join(dir, "src", "index.ts");
    writeFileSync(built, "");
    writeFileSync(source, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(source, past, past);
    expect(resolveWorkerEntry(dir, undefined).staleByMs).toBeNull();
  });

  it("uses the tsx dev entry when nothing has been built", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-entry-"));
    tempFiles.push(dir);
    const resolved = resolveWorkerEntry(dir, undefined);
    expect(resolved.entry).toBe("dev");
    expect(resolved.args).toEqual([
      "--import",
      "tsx",
      join(dir, "src", "index.ts"),
    ]);
  });

  it("production without a build falls back to the dev entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarly-entry-"));
    tempFiles.push(dir);
    const resolved = resolveWorkerEntry(dir, "production");
    expect(resolved.entry).toBe("dev-fallback");
    expect(resolved.args).toEqual([
      "--import",
      "tsx",
      join(dir, "src", "index.ts"),
    ]);
  });

  it("defaultWorkerSpecs covers summary-worker and bot-worker", () => {
    const specs = defaultWorkerSpecs();
    expect(specs.map((spec) => spec.name)).toEqual([
      "summary-worker",
      "bot-worker",
    ]);
    for (const spec of specs) {
      expect(spec.command).toBe(process.execPath);
      // Either entry form points into the right package directory.
      expect(spec.args.join(" ")).toContain(join(repoRoot(), spec.name));
    }
    // repoRoot is the workspace root (package.json + backend/ live there).
    expect(existsSync(join(repoRoot(), "package.json"))).toBe(true);
    expect(existsSync(join(repoRoot(), "backend"))).toBe(true);
  });
});

describe("WorkerSupervisor (real child processes)", () => {
  it(
    "spawns both workers with SUMMARLY_PARENT_PID and reports their pids",
    async () => {
      const files = new Map<string, string>();
      const specs: WorkerSpec[] = ["fake-a", "fake-b"].map((name) => {
        const file = tempFile(`supervisor-parent-${name}`);
        files.set(name, file);
        return {
          name,
          command: process.execPath,
          args: [
            "-e",
            // Receipt: parent pid + own pid, then stay alive.
            'require("node:fs").writeFileSync(' +
              `${JSON.stringify(file)}, ` +
              'String(process.env.SUMMARLY_PARENT_PID) + " " + String(process.pid));' +
              "setInterval(() => {}, 1000);",
          ],
          entry: "dev",
        };
      });
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor(specs, {
        log,
        forceKillAfterMs: 500,
      });
      supervisor.start();

      await until(
        () => events.filter((e) => e.event === "worker_spawned").length === 2,
      );
      const spawns = events.filter((e) => e.event === "worker_spawned");
      for (const { fields } of spawns) {
        expect(typeof fields["pid"]).toBe("number");
        expect(fields["pid"]).toBeGreaterThan(0);
        expect(alive(fields["pid"] as number)).toBe(true);
        expect(fields["entry"]).toBe("dev");
      }

      // Both children see their parent's pid in the environment, and the
      // logged spawn pid matches each child's own report.
      await until(() => [...files.values()].every((f) => existsSync(f)));
      for (const [name, file] of files) {
        const receipt = readFileSync(file, "utf8").trim();
        const [parentPid, ownPid] = receipt.split(" ");
        expect(parentPid).toBe(String(process.pid));
        const loggedPid = spawns.find((e) => e.fields["worker"] === name)?.fields[
          "pid"
        ];
        expect(Number(ownPid)).toBe(loggedPid);
      }

      await supervisor.stop();
      expect(events.some((e) => e.event === "workers_stopped")).toBe(true);
      for (const { fields } of spawns) {
        expect(alive(fields["pid"] as number)).toBe(false);
      }
      // Fresh dev entries: no staleness warning.
      expect(events.some((e) => e.event === "worker_entry_stale")).toBe(false);
    },
    20_000,
  );

  it(
    "logs worker_entry_stale for a stale built entry (and still runs it)",
    async () => {
      const spec: WorkerSpec = {
        name: "stale-built",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        entry: "built",
        staleByMs: 61_000,
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        forceKillAfterMs: 500,
      });
      supervisor.start();
      await until(() => events.some((e) => e.event === "worker_spawned"));
      const stale = events.find((e) => e.event === "worker_entry_stale");
      expect(stale?.fields).toEqual({ worker: "stale-built", staleByMs: 61_000 });
      // Warning only — the built entry still runs (documented rule).
      expect(
        events.find((e) => e.event === "worker_spawned")?.fields["entry"],
      ).toBe("built");
      await supervisor.stop();
    },
    20_000,
  );

  it(
    "restarts an unexpectedly exiting worker with bounded exponential backoff",
    async () => {
      const spec: WorkerSpec = {
        name: "flaky",
        command: process.execPath,
        args: ["-e", "process.exit(3);"],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        restartInitialMs: 40,
        restartMaxMs: 160,
        maxRestarts: 10,
        restartWindowMs: 60_000,
        stableAfterMs: 60_000,
        forceKillAfterMs: 500,
      });
      supervisor.start();

      await until(
        () => events.filter((e) => e.event === "worker_exited").length >= 4,
      );
      const exits = events.filter((e) => e.event === "worker_exited");
      // 40 -> 80 -> 160 -> 160 (cap); every exit carries the real code.
      expect(exits.map((e) => e.fields["restartInMs"])).toEqual([
        40, 80, 160, 160,
      ]);
      expect(exits.every((e) => e.fields["code"] === 3)).toBe(true);
      await supervisor.stop();
    },
    20_000,
  );

  it(
    "pauses supervision after the restart budget is exhausted (backend keeps running)",
    async () => {
      const spec: WorkerSpec = {
        name: "dying",
        command: process.execPath,
        args: ["-e", "process.exit(7);"],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        restartInitialMs: 30,
        restartMaxMs: 120,
        maxRestarts: 2,
        restartWindowMs: 60_000,
        stableAfterMs: 60_000,
        forceKillAfterMs: 500,
      });
      supervisor.start();

      await until(() =>
        events.some((e) => e.event === "worker_supervision_paused"),
      );
      const pause = events.find((e) => e.event === "worker_supervision_paused");
      expect(pause?.fields).toEqual({ worker: "dying", reason: "restart_limit" });
      // Initial spawn + 2 restarts, then the third exit pauses it.
      expect(events.filter((e) => e.event === "worker_spawned")).toHaveLength(3);
      const exits = events.filter((e) => e.event === "worker_exited");
      expect(exits).toHaveLength(3);
      expect(exits[2]?.fields["restartInMs"]).toBeNull();

      // No further spawns after the pause.
      await sleep(400);
      expect(events.filter((e) => e.event === "worker_spawned")).toHaveLength(3);
      await supervisor.stop();
    },
    20_000,
  );

  it(
    "resets the backoff once the worker stays up long enough",
    async () => {
      // Each life lasts 400ms; stableAfterMs is 150ms, so life 2 counts
      // as stable and the backoff restarts from the initial delay.
      const spec: WorkerSpec = {
        name: "slowly-dying",
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(1), 400);"],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        restartInitialMs: 30,
        restartMaxMs: 200,
        maxRestarts: 10,
        restartWindowMs: 60_000,
        stableAfterMs: 150,
        forceKillAfterMs: 500,
      });
      supervisor.start();

      await until(
        () => events.filter((e) => e.event === "worker_exited").length >= 2,
      );
      const exits = events.filter((e) => e.event === "worker_exited");
      expect(exits[0]?.fields["restartInMs"]).toBe(30);
      // Not 60: the stable timer reset the backoff during life 2.
      expect(exits[1]?.fields["restartInMs"]).toBe(30);
      await supervisor.stop();
    },
    20_000,
  );

  it(
    "stop() terminates the children, reports workers_stopped, and is idempotent",
    async () => {
      const spec: WorkerSpec = {
        name: "long-lived",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        forceKillAfterMs: 500,
      });
      supervisor.start();
      await until(() =>
        events.some((e) => e.event === "worker_spawned"),
      );
      const pid = events.find((e) => e.event === "worker_spawned")?.fields[
        "pid"
      ] as number;
      expect(alive(pid)).toBe(true);

      await supervisor.stop();
      await supervisor.stop(); // idempotent
      expect(alive(pid)).toBe(false);
      expect(events.filter((e) => e.event === "workers_stopped")).toHaveLength(1);
      const exit = events.find((e) => e.event === "worker_exited");
      expect(exit?.fields["restartInMs"]).toBeNull();
    },
    20_000,
  );

  it(
    "does not restart after stop() even with a restart already scheduled",
    async () => {
      const spec: WorkerSpec = {
        name: "quick-exit",
        command: process.execPath,
        args: ["-e", "process.exit(1);"],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        restartInitialMs: 150,
        forceKillAfterMs: 500,
      });
      supervisor.start();
      await until(() =>
        events.some((e) => e.event === "worker_exited"),
      );
      // A restart is pending (150ms) — stop() must cancel it.
      await supervisor.stop();
      await sleep(400);
      expect(events.filter((e) => e.event === "worker_spawned")).toHaveLength(1);
      expect(events.some((e) => e.event === "workers_stopped")).toBe(true);
    },
    20_000,
  );

  it(
    "applies the restart policy to spawn failures (ENOENT)",
    async () => {
      const spec: WorkerSpec = {
        name: "missing-binary",
        command: join(tmpdir(), `no-such-binary-${randomUUID()}`),
        args: [],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        restartInitialMs: 30,
        restartMaxMs: 100,
        maxRestarts: 1,
        restartWindowMs: 60_000,
        stableAfterMs: 60_000,
        forceKillAfterMs: 500,
      });
      supervisor.start();

      await until(() =>
        events.some((e) => e.event === "worker_supervision_paused"),
      );
      const exits = events.filter((e) => e.event === "worker_exited");
      expect(exits[0]?.fields["error"]).toBe("ENOENT");
      expect(exits).toHaveLength(2); // one restart, then the pause
      await supervisor.stop();
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "force-kills a child that ignores SIGTERM after the grace period",
    async () => {
      const spec: WorkerSpec = {
        name: "sigterm-ignoring",
        command: process.execPath,
        args: [
          "-e",
          'process.on("SIGTERM", () => {});setInterval(() => {}, 1000);',
        ],
        entry: "dev",
      };
      const { events, log } = captureLog();
      const supervisor = new WorkerSupervisor([spec], {
        log,
        forceKillAfterMs: 150,
      });
      supervisor.start();
      await until(() =>
        events.some((e) => e.event === "worker_spawned"),
      );
      const pid = events.find((e) => e.event === "worker_spawned")?.fields[
        "pid"
      ] as number;

      await supervisor.stop(); // SIGTERM ignored -> SIGKILL after 150ms
      expect(alive(pid)).toBe(false);
    },
    20_000,
  );
});
