"use client";

import type { ApiMessage } from "@summarly/contracts";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badges";
import { formatTimeOnly } from "@/lib/time";

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join("");
  return letters.length === 0 ? "?" : letters.toUpperCase();
}

export interface MessageBubbleProps {
  message: ApiMessage;
  /** Time zone for the displayed timestamp (browser local when omitted). */
  timeZone?: string;
  /** Optional extra metadata after the timestamp (e.g. a group name). */
  meta?: ReactNode;
}

/** One chat-style message bubble shared by group and contact views. */
export function MessageBubble({ message, timeZone, meta }: MessageBubbleProps) {
  const sender = message.senderName ?? message.senderId;
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700"
      >
        {initials(sender)}
      </span>
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3.5 py-2.5 shadow-card">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-xs font-semibold text-slate-800">{sender}</p>
          <time
            dateTime={message.sentAt}
            className="text-[11px] tabular-nums text-slate-500"
          >
            {formatTimeOnly(message.sentAt, timeZone)}
          </time>
          {meta}
          {message.messageType === "link" ? <Badge tone="info">Link</Badge> : null}
        </div>
        {message.body.length === 0 ? (
          <p className="mt-1 text-sm italic text-slate-400">No text content</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
            {message.body}
          </p>
        )}
      </div>
    </div>
  );
}
