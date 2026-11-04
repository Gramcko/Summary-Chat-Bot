"use client";

import type { Group } from "@summarly/contracts";
import Link from "next/link";
import { useEffect } from "react";
import { Badge } from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import {
  HISTORY_IMPORT_POLL_MS,
  anyHistoryImportInFlight,
  summarizeHistoryImport,
} from "@/lib/history-import";
import { useResource } from "@/lib/hooks";

function GroupRow({ group }: { group: Group }) {
  const importSummary = summarizeHistoryImport(group.historyImport);

  return (
    <li>
      <Link
        href={`/groups/${group.id}`}
        className="group flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition-colors hover:border-brand-300 sm:flex-row sm:items-center sm:justify-between sm:p-5"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">
              {group.name}
            </p>
            <Badge tone={group.monitored ? "success" : "neutral"} dot>
              {group.monitored ? "Monitored" : "Not monitored"}
            </Badge>
            {importSummary === null ? null : importSummary.inFlight ? (
              <Badge tone="info" dot>
                {importSummary.badgeLabel}
              </Badge>
            ) : importSummary.status === "failed" ? (
              <Badge tone="danger" dot>
                {importSummary.badgeLabel}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {group.timezone}
            {group.summaryTime === null
              ? " · no daily cutoff"
              : ` · daily cutoff ${group.summaryTime}`}
            {group.chatId === null ? " · chat not linked yet" : ""}
          </p>
          {importSummary === null ? null : (
            <p className="mt-1 text-xs text-slate-600">
              {importSummary.message}
              {importSummary.detail === null ? "" : ` · ${importSummary.detail}`}
            </p>
          )}
        </div>
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center gap-1 self-start text-sm font-medium text-brand-700 group-hover:underline sm:self-center"
        >
          Open
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </Link>
    </li>
  );
}

export default function GroupsPage() {
  const groups = useResource(() => api.groups(), []);

  // Keep import badges live while the bot-worker is importing.
  const polling = anyHistoryImportInFlight(groups.data);
  const reload = groups.reload;
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reload, HISTORY_IMPORT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reload]);

  const data = groups.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        description="Every captured WhatsApp group. Open a group for its summaries, member roster, chat history, and monitoring settings."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={reload}
              disabled={groups.loading}
            >
              Refresh
            </Button>
            <ButtonLink href="/runs" size="sm">
              Request a summary
            </ButtonLink>
          </>
        }
      />

      {groups.loading && data === null ? (
        <div className="space-y-3">
          <SkeletonCard label="Loading groups…" />
          <SkeletonCard label="Loading groups…" />
        </div>
      ) : null}

      {groups.error === null ? null : (
        <ErrorState
          error={groups.error}
          title="Could not load groups"
          onRetry={reload}
        />
      )}

      {data !== null && data.length === 0 ? (
        <EmptyState
          title="No groups available yet"
          description="Groups appear here after the WhatsApp connection captures them. Link a device on the Connection screen if the session is not connected."
          action={
            <ButtonLink href="/connection" variant="secondary" size="sm">
              Open connection
            </ButtonLink>
          }
        />
      ) : null}

      {data !== null && data.length > 0 ? (
        <ul className="space-y-3">
          {data.map((group) => (
            <GroupRow key={group.id} group={group} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
