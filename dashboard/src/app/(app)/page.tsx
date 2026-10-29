"use client";

import type { ConnectionStatus, Group, SummaryRun } from "@summarly/contracts";
import Link from "next/link";
import {
  ConnectionBadge,
  RunStatusBadge,
  connectionHint,
} from "@/components/ui/Badges";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/States";
import { api } from "@/lib/api";
import { groupName } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { formatDateTime, formatInterval } from "@/lib/time";

interface OverviewData {
  connection: ConnectionStatus;
  groups: Group[];
  runs: SummaryRun[];
}

const RECENT_RUN_COUNT = 5;

async function loadOverview(): Promise<OverviewData> {
  const [connection, groups, runs] = await Promise.all([
    api.connection(),
    api.groups(),
    api.runs(),
  ]);
  return {
    connection,
    groups,
    runs: runs.items.slice(0, RECENT_RUN_COUNT),
  };
}

export default function OverviewPage() {
  const overview = useResource(loadOverview, []);
  const { data, error, loading, reload } = overview;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="WhatsApp connection health and the most recent summary runs."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
              Refresh
            </Button>
            <ButtonLink href="/runs" size="sm">
              Request a summary
            </ButtonLink>
          </>
        }
      />

      {loading && data === null ? (
        <LoadingBlock label="Loading connection and summary runs…" />
      ) : null}

      {error === null ? null : (
        <ErrorState
          error={error}
          title="Could not load the overview"
          onRetry={reload}
        />
      )}

      {data === null ? null : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="WhatsApp connection"
              description={connectionHint(data.connection.state)}
              actions={<ConnectionBadge state={data.connection.state} />}
            />
            <CardBody>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    State since
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    <time dateTime={data.connection.since}>
                      {formatDateTime(data.connection.since)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Last captured message
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {data.connection.lastMessageAt === null ? (
                      <span className="text-slate-500">No messages captured yet.</span>
                    ) : (
                      <time dateTime={data.connection.lastMessageAt}>
                        {formatDateTime(data.connection.lastMessageAt)}
                      </time>
                    )}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Recent summary runs"
              description="Newest first. Select a run to see its status and summary."
              actions={
                <ButtonLink href="/runs" variant="secondary" size="sm">
                  View all runs
                </ButtonLink>
              }
            />
            {data.runs.length === 0 ? (
              <div className="px-4 py-4 sm:px-5">
                <EmptyState
                  title="No summary runs yet"
                  description="Request a summary for a group and time period, or wait for the daily schedule."
                  action={
                    <ButtonLink href="/runs" variant="secondary" size="sm">
                      Request a summary
                    </ButtonLink>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {data.runs.map((run) => (
                  <li key={run.id}>
                    <Link
                      href={`/runs/${run.id}`}
                      className="flex flex-col gap-2 px-4 py-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {groupName(data.groups, run.groupId)}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-600">
                          {formatInterval(run.interval)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-3">
                        <span className="text-xs text-slate-500">
                          Requested {formatDateTime(run.createdAt)}
                        </span>
                        <RunStatusBadge status={run.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
