import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  defaultParentAlive,
  startParentWatchdog,
} from "../src/lib/parent-watchdog.js";

/**
 * Parent-PID watchdog (fix round B, risk): a supervised bot-worker must
 * notice its parent disappearing and shut down gracefully instead of
 * orphaning a live WhatsApp session. Mirrors
 * summary-worker/tests/parent-watchdog.test.ts. No database, queue, or
 * WhatsApp account involved.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A pid guaranteed to be gone: a child that has already exited. */
async function gonePid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? -1;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

describe("defaultParentAlive (signal-0 probe)", () => {
  it("sees a live process as alive and an exited child as gone", async () => {
    expect(defaultParentAlive(process.pid)).toBe(true);
    expect(defaultParentAlive(await gonePid())).toBe(false);
  });
});

describe("startParentWatchdog (SUMMARLY_PARENT_PID watchdog)", () => {
  it("fires onParentGone exactly once when the parent disappears (gone pid)", async () => {
    const pid = await gonePid();
    let calls = 0;
    startParentWatchdog({
      pid,
      intervalMs: 20,
      onParentGone: () => {
        calls += 1;
      },
    });
    await sleep(250);
    expect(calls).toBe(1);
  });

  it("never fires while the parent is alive (live-pid case)", async () => {
    let calls = 0;
    const stop = startParentWatchdog({
      pid: process.pid,
      intervalMs: 20,
      onParentGone: () => {
        calls += 1;
      },
    });
    await sleep(150);
    stop();
    expect(calls).toBe(0);
  });

  it("stop() cancels the polling before the parent could vanish", async () => {
    const pid = await gonePid();
    let calls = 0;
    const stop = startParentWatchdog({
      pid,
      intervalMs: 20,
      onParentGone: () => {
        calls += 1;
      },
    });
    stop();
    await sleep(120);
    expect(calls).toBe(0);
  });

  it("honors an injected liveness probe (fake pid semantics)", async () => {
    let alive = true;
    let calls = 0;
    startParentWatchdog({
      pid: 4242,
      intervalMs: 20,
      isParentAlive: () => alive,
      onParentGone: () => {
        calls += 1;
      },
    });
    await sleep(80);
    expect(calls).toBe(0); // still "alive"
    alive = false;
    await sleep(120);
    expect(calls).toBe(1);
  });
});
