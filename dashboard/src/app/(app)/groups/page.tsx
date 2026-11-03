"use client";

import type { Group } from "@summarly/contracts";
import Link from "next/link";
import { useEffect } from "react";
import { GroupSettingsCard } from "@/components/groups/GroupSettingsCard";
import { IanaTimeZoneOptions } from "@/components/TimeZones";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/States";
import { api } from "@/lib/api";
import {
  HISTORY_IMPORT_POLL_MS,
  anyHistoryImportInFlight,
} from "@/lib/history-import";
import { useResource } from "@/lib/hooks";

export default function GroupsPage() {
  const groups = useResource(() => api.groups(), []);

  // Keep the import badges live while the bot-worker is importing, and stop as
  // soon as nothing is pending/running. Manual refresh stays available.
  const polling = anyHistoryImportInFlight(groups.data);
  const reloadGroups = groups.reload;
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reloadGroups, HISTORY_IMPORT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reloadGroups]);

  function handleSaved(updated: Group): void {
    groups.setData((previous) => {
      if (previous === null) return [updated];
      return previous.map((group) => (group.id === updated.id ? updated : group));
    });
  }

  const data = groups.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        description="Choose which groups are monitored and when their daily summary should be generated. Time zones are IANA names and the daily cutoff is a local HH:mm time."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={groups.reload}
            disabled={groups.loading}
          >
            Refresh
          </Button>
        }
      />

      {/* Shared suggestions for the time zone fields on this page. */}
      <IanaTimeZoneOptions />

      {groups.loading && data === null ? (
        <LoadingBlock label="Loading groups…" />
      ) : null}

      {groups.error === null ? null : (
        <ErrorState
          error={groups.error}
          title="Could not load groups"
          onRetry={groups.reload}
        />
      )}

      {data !== null && data.length === 0 ? (
        <EmptyState
          title="No groups available yet"
          description={
            <>
              Groups appear here after the WhatsApp connection captures them.
              Check the connection status on the{" "}
              <Link href="/" className="font-medium text-brand-700 underline">
                overview
              </Link>
              .
            </>
          }
          action={
            <ButtonLink href="/" variant="secondary" size="sm">
              View connection status
            </ButtonLink>
          }
        />
      ) : null}

      {data !== null && data.length > 0 ? (
        <div className="space-y-4">
          {data.map((group) => (
            <GroupSettingsCard key={group.id} group={group} onSaved={handleSaved} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
