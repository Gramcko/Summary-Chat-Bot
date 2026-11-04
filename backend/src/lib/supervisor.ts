import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Worker supervision (docs/decisions/0008, product-upgrade round 3):
 * the backend spawns and supervises the `summary-worker` and
 * `bot-worker` child processes so that running the backend is enough —
 * no separate terminals required. The workers are ordinary Node
 * processes started from their package entry points; supervision owns
 * their lifetime and restart policy but never their internals.
 *
 * Restart policy: bounded exponential backoff (1s doubling to a 60s
 * cap) with a restart budget per sliding window (5 restarts per 10
 * minutes by default). When the budget is exhausted the supervisor logs
 * `worker_supervision_paused` and stops restarting THAT worker — the
 * backend keeps serving. A worker that stays up for 5 minutes resets
 * its backoff to the initial delay.
 *
 * Child environment: each child inherits the backend's environment
 * plus `SUMMARLY_PARENT_PID` (the backend's pid). The workers adopt a
 * parent-PID watchdog in a follow-up round (they are owned by another
 * workstream); until then the supervisor is the only containment: it
 * terminates children explicitly on shutdown (SIGTERM, then a force
 * kill ~10s later). Windows caveat: if the backend itself is killed
 * abruptly there is no graceful path to run and children may orphan —
 * stop the backend with Ctrl+C (graceful) instead of killing it.
 */

export type SupervisorLogger = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

/** One supervised worker process (identifiers/codes only in logs). */
export interface WorkerSpec {
  /** Stable worker id used in log events ("summary-worker", ...). */
  name: string;
  /** Executable (process.execPath for the real workers). */
  command: string;
  args: string[];
  /** How the entry point was selected (log field, see resolveWorkerEntry). */
  entry: WorkerEntry;
  /**
   * Set when the built entry is OLDER than the newest src file (fix
   * round A, m10): the supervisor logs `worker_entry_stale` but still
   * runs the build — documented behavior, never a silent mode switch.
   */
  staleByMs?: number | null;
}

export type WorkerEntry = "built" | "dev" | "dev-fallback";

export interface SupervisorOptions {
  log?: SupervisorLogger;
  /** Working directory for children (default: repository root, so each
   * worker's root-.env loader finds the shared .env). */
  cwd?: string;
  /** Extra environment for children; the parent env is always inherited. */
  env?: NodeJS.ProcessEnv;
  /** First restart delay; doubles per consecutive failure. */
  restartInitialMs?: number;
  /** Backoff cap. */
  restartMaxMs?: number;
  /** Restarts allowed per sliding window before pausing supervision. */
  maxRestarts?: number;
  /** Sliding window for the restart budget. */
  restartWindowMs?: number;
  /** Uptime after which the backoff resets to the initial delay. */
  stableAfterMs?: number;
  /** Grace period between SIGTERM and the force kill on stop(). */
  forceKillAfterMs?: number;
}

/**
 * Parses `SUPERVISE_WORKERS`. Unset/empty default to `true` (the
 * backend supervises its workers). Accepts the same true/false spellings
 * as SCHEDULER_ENABLED; anything else fails fast.
 */
export function parseSuperviseWorkers(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  if (value === "yes" || value === "1") return true;
  throw new Error(`SUPERVISE_WORKERS must be true or false, got "${raw}".`);
}

/**
 * The repository root, derived from this module's location (stable
 * whether running from src/ via tsx or from dist/).
 */
export function repoRoot(): string {
  // backend/src/lib (or backend/dist/lib) -> backend -> repository root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Newest file mtime (ms) under a directory tree; 0 when missing. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Raced with a delete; nothing to measure.
      }
    }
  }
  return newest;
}

/**
 * Entry-point rule (documented in AGENTS.md and .env.example): a worker
 * runs from its BUILT `dist/index.js` whenever that file exists;
 * otherwise from `src/index.ts` via `--import tsx`. `NODE_ENV=production`
 * expresses a preference for the built entry — when the build is
 * missing the dev entry runs instead (reported as `dev-fallback`) so a
 * production start never crash-loops on a missing file. Delete `dist/`
 * to force live sources after a local build.
 *
 * Staleness (fix round A, m10): when the built entry is OLDER than the
 * newest file under `src/`, the result carries `staleByMs` so the
 * supervisor can log `worker_entry_stale`. The built entry still runs —
 * switching entries silently would make dev and production behave
 * differently; the documented fix is a rebuild (or deleting `dist/`).
 */
export function resolveWorkerEntry(
  packageDir: string,
  nodeEnv: string | undefined = process.env["NODE_ENV"],
): { args: string[]; entry: WorkerEntry; staleByMs: number | null } {
  const builtEntry = join(packageDir, "dist", "index.js");
  const devEntry = join(packageDir, "src", "index.ts");
  if (existsSync(builtEntry)) {
    const builtAt = statSync(builtEntry).mtimeMs;
    const srcAt = newestMtimeMs(join(packageDir, "src"));
    const staleByMs = srcAt > builtAt ? Math.round(srcAt - builtAt) : null;
    return { args: [builtEntry], entry: "built", staleByMs };
  }
  if (nodeEnv === "production") {
    return {
      args: ["--import", "tsx", devEntry],
      entry: "dev-fallback",
      staleByMs: null,
    };
  }
  return { args: ["--import", "tsx", devEntry], entry: "dev", staleByMs: null };
}

/** The two real workers, resolved from the repository layout. */
export function defaultWorkerSpecs(options?: { nodeExec?: string }): WorkerSpec[] {
  const root = repoRoot();
  const command = options?.nodeExec ?? process.execPath;
  return ["summary-worker", "bot-worker"].map((name) => {
    const { args, entry, staleByMs } = resolveWorkerEntry(join(root, name));
    return { name, command, args, entry, staleByMs };
  });
}

interface WorkerState {
  spec: WorkerSpec;
  child: ChildProcess | null;
  /** Resolves when the current child has exited (null before first spawn). */
  exited: Promise<void> | null;
  resolveExit: (() => void) | null;
  /** Guards double handling of 'exit' + 'error' for one child. */
  settled: boolean;
  paused: boolean;
  /** Timestamps of restarts within the sliding window. */
  restartTimes: number[];
  backoffMs: number;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  stableTimer: ReturnType<typeof setTimeout> | undefined;
  forceTimer: ReturnType<typeof setTimeout> | undefined;
}

export class WorkerSupervisor {
  private readonly workers: WorkerState[];
  private readonly log: SupervisorLogger;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly restartInitialMs: number;
  private readonly restartMaxMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly stableAfterMs: number;
  private readonly forceKillAfterMs: number;
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(specs: WorkerSpec[], options: SupervisorOptions = {}) {
    this.workers = specs.map((spec) => ({
      spec,
      child: null,
      exited: null,
      resolveExit: null,
      settled: false,
      paused: false,
      restartTimes: [],
      backoffMs: options.restartInitialMs ?? 1000,
      restartTimer: undefined,
      stableTimer: undefined,
      forceTimer: undefined,
    }));
    this.log = options.log ?? (() => undefined);
    this.cwd = options.cwd ?? repoRoot();
    this.env = options.env ?? {};
    this.restartInitialMs = options.restartInitialMs ?? 1000;
    this.restartMaxMs = options.restartMaxMs ?? 60_000;
    this.maxRestarts = options.maxRestarts ?? 5;
    this.restartWindowMs = options.restartWindowMs ?? 10 * 60_000;
    this.stableAfterMs = options.stableAfterMs ?? 5 * 60_000;
    this.forceKillAfterMs = options.forceKillAfterMs ?? 10_000;
  }

  /** Spawns every worker once. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const state of this.workers) this.spawn(state);
  }

  /**
   * Terminates all children (SIGTERM, force kill after the grace
   * period) and resolves once every child has exited. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      const waits: Promise<void>[] = [];
      for (const state of this.workers) {
        // A pending restart must never fire once we are stopping.
        if (state.restartTimer !== undefined) clearTimeout(state.restartTimer);
        if (state.stableTimer !== undefined) clearTimeout(state.stableTimer);
        const child = state.child;
        if (child === null) continue;
        if (state.exited !== null) waits.push(state.exited);
        child.kill("SIGTERM");
        state.forceTimer = setTimeout(() => {
          // SIGTERM ignored (POSIX): take the child down forcefully.
          if (state.child === child) child.kill("SIGKILL");
        }, this.forceKillAfterMs);
      }
      await Promise.all(waits);
      this.log("workers_stopped", {});
    })();
    return this.stopPromise;
  }

  private spawn(state: WorkerState): void {
    const { spec } = state;
    const child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        // Read by the workers' parent-PID watchdog in a follow-up
        // round; harmless today.
        SUMMARLY_PARENT_PID: String(process.pid),
      },
      stdio: "inherit",
    });
    state.child = child;
    state.settled = false;
    state.exited = new Promise<void>((resolveExit) => {
      state.resolveExit = resolveExit;
    });
    // Stability resets the backoff (and the next exit starts fresh).
    state.stableTimer = setTimeout(() => {
      state.backoffMs = this.restartInitialMs;
    }, this.stableAfterMs);
    state.stableTimer.unref?.();
    if (spec.staleByMs !== null && spec.staleByMs !== undefined) {
      // The build is older than the worker's sources (fix round A,
      // m10): WARN only — the built entry still runs (documented rule;
      // the fix is a rebuild or deleting dist/).
      this.log("worker_entry_stale", {
        worker: spec.name,
        staleByMs: spec.staleByMs,
      });
    }
    this.log("worker_spawned", {
      worker: spec.name,
      pid: child.pid ?? -1,
      entry: spec.entry,
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Spawn failure (e.g. missing entry): 'exit' may not fire. Only
      // the error CODE is logged; the restart policy applies.
      this.onChildGone(state, null, null, error.code ?? "spawn_error");
    });
    child.on("exit", (code, signal) => {
      this.onChildGone(state, code, signal);
    });
  }

  private onChildGone(
    state: WorkerState,
    code: number | null,
    signal: string | null,
    errorCode: string | null = null,
  ): void {
    if (state.settled) return;
    state.settled = true;
    state.child = null;
    if (state.stableTimer !== undefined) clearTimeout(state.stableTimer);
    if (state.forceTimer !== undefined) clearTimeout(state.forceTimer);
    const resolveExit = state.resolveExit;
    state.resolveExit = null;
    resolveExit?.();

    if (this.stopping) {
      this.log("worker_exited", {
        worker: state.spec.name,
        code,
        signal,
        error: errorCode,
        restartInMs: null,
      });
      return;
    }

    const now = Date.now();
    state.restartTimes = state.restartTimes.filter(
      (time) => now - time < this.restartWindowMs,
    );
    if (state.paused || state.restartTimes.length >= this.maxRestarts) {
      if (!state.paused) {
        state.paused = true;
        this.log("worker_exited", {
          worker: state.spec.name,
          code,
          signal,
          error: errorCode,
          restartInMs: null,
        });
        // The backend keeps serving: only THIS worker stops restarting.
        this.log("worker_supervision_paused", {
          worker: state.spec.name,
          reason: "restart_limit",
        });
      }
      return;
    }

    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, this.restartMaxMs);
    state.restartTimes.push(now);
    this.log("worker_exited", {
      worker: state.spec.name,
      code,
      signal,
      error: errorCode,
      restartInMs: delay,
    });
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined;
      if (this.stopping) return;
      this.spawn(state);
    }, delay);
    state.restartTimer.unref?.();
  }
}
