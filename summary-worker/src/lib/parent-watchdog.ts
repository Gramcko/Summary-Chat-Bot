/**
 * Parent-PID watchdog (fix round A; ADR 0008 worker supervision).
 *
 * When the backend supervises this worker it exports
 * `SUMMARLY_PARENT_PID`. If that parent disappears — e.g. a force-
 * killed backend on Windows, where nothing cascades to the children —
 * the worker shuts itself down gracefully instead of orphaning and
 * double-consuming the queue. A worker started standalone (no env var)
 * runs unwatched and is unaffected.
 *
 * The bot-worker adopts the same watchdog in round B (its files belong
 * to another workstream here).
 */

export interface ParentWatchdogOptions {
  /** The supervising process's pid (from SUMMARLY_PARENT_PID). */
  pid: number;
  /** Poll cadence in milliseconds (default 2000). */
  intervalMs?: number;
  /** Called ONCE when the parent is gone (start the graceful shutdown). */
  onParentGone: () => void;
  /** Liveness probe (tests inject); default: signal-0 existence probe. */
  isParentAlive?: (pid: number) => boolean;
}

/**
 * True while the pid exists. EPERM counts as alive (it exists but is
 * not ours to signal); ESRCH means gone.
 */
export function defaultParentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Starts polling the parent pid; returns a stop() for teardown. The
 * timer is unref'd — the watchdog never keeps the process alive.
 */
export function startParentWatchdog(
  options: ParentWatchdogOptions,
): () => void {
  const intervalMs = options.intervalMs ?? 2000;
  const isAlive = options.isParentAlive ?? defaultParentAlive;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!isAlive(options.pid)) {
      stopped = true;
      clearInterval(timer);
      options.onParentGone();
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
