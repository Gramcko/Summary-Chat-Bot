import type { ConnectionState, RunStatus } from "@summarly/contracts";
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-900 ring-amber-200",
  danger: "bg-red-50 text-red-800 ring-red-200",
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-slate-400",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ tone = "neutral", dot = false, children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`}
        />
      ) : null}
      {children}
    </span>
  );
}

const RUN_STATUS: Record<
  RunStatus,
  { label: string; tone: BadgeTone }
> = {
  pending: { label: "Pending", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const config = RUN_STATUS[status];
  return (
    <Badge tone={config.tone} dot>
      {config.label}
    </Badge>
  );
}

/** Short explanation shown next to a run status. */
export function runStatusHint(status: RunStatus): string {
  switch (status) {
    case "pending":
      return "Queued. A worker has not picked this run up yet.";
    case "processing":
      return "The summary is being generated. This page refreshes automatically.";
    case "completed":
      return "The summary was generated and saved.";
    case "failed":
      return "The run failed. Safe error details are shown below.";
  }
}

const CONNECTION_STATE: Record<
  ConnectionState,
  { label: string; tone: BadgeTone }
> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting", tone: "info" },
  disconnected: { label: "Disconnected", tone: "danger" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <Badge tone={CONNECTION_STATE[state].tone} dot>
      {CONNECTION_STATE[state].label}
    </Badge>
  );
}

export function connectionHint(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "The WhatsApp Web session is linked and messages can be captured.";
    case "connecting":
      return "The bot worker is linking the WhatsApp Web session.";
    case "disconnected":
      return "The WhatsApp session is not connected. The bot worker reconnects automatically; summaries may miss messages until it does.";
    case "unavailable":
      return "No connection status has been reported by the bot worker yet.";
  }
}

export function ApiKeyBadge({ hasApiKey }: { hasApiKey: boolean }) {
  return hasApiKey ? (
    <Badge tone="success" dot>
      API key saved
    </Badge>
  ) : (
    <Badge tone="neutral" dot>
      No API key saved
    </Badge>
  );
}
