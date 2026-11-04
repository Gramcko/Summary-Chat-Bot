"use client";

import type { RunStatus } from "@summarly/contracts";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";

export type NotificationTone = "success" | "error" | "info";

export interface NotificationInput {
  title: string;
  description?: string;
  tone?: NotificationTone;
  /** Optional in-app link (e.g. the affected run). */
  href?: string;
}

interface NotificationItem extends NotificationInput {
  id: string;
}

interface NotificationContextValue {
  notify: (input: NotificationInput) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(
  null,
);

/** Access the toast API from any client component inside AppShell. */
export function useNotifications(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (context === null) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return context;
}

const POLL_MS = 10_000;
const TOAST_MS = 7_000;
const MAX_TOASTS = 4;

const TONE_STYLES: Record<NotificationTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-950",
  error: "border-red-200 bg-red-50 text-red-950",
  info: "border-sky-200 bg-sky-50 text-sky-950",
};

function Toaster({
  items,
  onDismiss,
}: {
  items: readonly NotificationItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`pointer-events-auto rounded-xl border px-4 py-3 shadow-raised ${
            TONE_STYLES[item.tone ?? "info"]
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{item.title}</p>
              {item.description === undefined ? null : (
                <p className="mt-0.5 text-xs leading-5 opacity-80">
                  {item.description}
                </p>
              )}
              {item.href === undefined ? null : (
                <Link
                  href={item.href}
                  onClick={() => onDismiss(item.id)}
                  className="mt-1 inline-block text-xs font-medium underline"
                >
                  Open
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded p-0.5 text-current opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Toast notifications for the authenticated app. Also polls summary runs
 * and announces status transitions (started/completed/failed) so the
 * admin does not have to keep a run page open.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const knownRuns = useRef<Map<string, RunStatus> | null>(null);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (input: NotificationInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((current) => [
        ...current.slice(-(MAX_TOASTS - 1)),
        { ...input, id },
      ]);
      const timer = setTimeout(() => dismiss(id), TOAST_MS);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const response = await api.runs();
        if (cancelled) return;
        const next = new Map(
          response.items.map((run) => [run.id, run.status] as const),
        );
        const previous = knownRuns.current;
        if (previous !== null) {
          for (const run of response.items) {
            const before = previous.get(run.id);
            if (before === run.status) continue;
            if (run.status === "completed") {
              notify({
                title: "Summary ready",
                description: "A summary run has completed.",
                tone: "success",
                href: `/runs/${run.id}`,
              });
            } else if (run.status === "failed") {
              notify({
                title: "Summary failed",
                description:
                  run.error?.message ?? "The run failed. Open it for details.",
                tone: "error",
                href: `/runs/${run.id}`,
              });
            } else if (before === "pending" && run.status === "processing") {
              notify({
                title: "Summary started",
                description: "The summary worker is processing your request.",
                tone: "info",
                href: `/runs/${run.id}`,
              });
            }
          }
        }
        knownRuns.current = next;
      } catch {
        // Polling is best-effort; do not spam failure toasts.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [notify]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <Toaster items={items} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
}
