"use client";

import type { ConnectionStatus } from "@summarly/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { PairingDetails } from "@/components/connection/PairingDetails";
import { Alert } from "@/components/ui/Alert";
import { ConnectionBadge, connectionHint } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, PageHeader } from "@/components/ui/States";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { api, toApiError, type ApiError } from "@/lib/api";
import {
  CONNECTION_POLL_MS,
  isLinkingExpired,
  secondsUntil,
  shouldPollConnection,
} from "@/lib/connection";
import { useResource } from "@/lib/hooks";
import { formatDateTime } from "@/lib/time";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function LinkedPanel({ status }: { status: ConnectionStatus }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700"
      >
        ✓
      </span>
      <p className="text-base font-semibold text-emerald-900">
        This device is linked
      </p>
      <p className="max-w-sm text-sm text-emerald-800">
        Messages from monitored groups are captured and can be summarised. The
        bot worker reconnects automatically if the link drops.
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-3 text-left sm:grid-cols-2">
        <Detail label="Connected since">
          <time dateTime={status.since}>{formatDateTime(status.since)}</time>
        </Detail>
        <Detail label="Last captured message">
          {status.lastMessageAt === null ? (
            <span className="text-slate-500">No messages captured yet.</span>
          ) : (
            <time dateTime={status.lastMessageAt}>
              {formatDateTime(status.lastMessageAt)}
            </time>
          )}
        </Detail>
      </dl>
    </div>
  );
}

export default function ConnectionPage() {
  const connection = useResource(() => api.connection(), []);
  const status = connection.data;
  /**
   * After an unlink the bot worker re-arms pairing within seconds. The status
   * can still read "connected" for a moment (the request is asynchronous), so
   * keep polling until a non-connected state is observed — then the normal rule
   * takes over. Without this the screen would stop polling right before the new
   * QR / pairing code appears.
   */
  const [refreshAfterUnlink, setRefreshAfterUnlink] = useState(false);
  const polling = refreshAfterUnlink || shouldPollConnection(status);
  const reload = connection.reload;

  const [now, setNow] = useState(() => Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  // Poll for a live QR / pairing code while pairing; stop once connected.
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(reload, CONNECTION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [polling, reload]);

  // One-second tick for the countdown while pairing.
  useEffect(() => {
    if (!polling) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [polling]);

  // The forced watch after an unlink ends as soon as the worker reports the
  // session is no longer connected (normal polling continues from there).
  useEffect(() => {
    if (refreshAfterUnlink && status !== null && status.state !== "connected") {
      setRefreshAfterUnlink(false);
    }
  }, [refreshAfterUnlink, status]);

  async function handleUnlink(): Promise<void> {
    setUnlinking(true);
    setUnlinkError(null);
    setActionError(null);
    try {
      await api.logoutConnection();
      setConfirmOpen(false);
      // Watch for the re-armed pairing payload the bot worker publishes.
      setRefreshAfterUnlink(true);
      setFeedback(
        "Unlink requested. The bot worker will end the session; a new pairing code will appear here automatically.",
      );
      reload();
    } catch (cause) {
      setUnlinkError(toApiError(cause).message);
    } finally {
      setUnlinking(false);
    }
  }

  const linking = status?.linking ?? null;
  const expired = linking !== null && isLinkingExpired(linking, now);
  const seconds = linking === null ? 0 : secondsUntil(linking.expiresAt, now);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connection"
        description="Link this installation to WhatsApp, watch the session state, and end the session when needed."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={reload}
            disabled={connection.loading}
          >
            Refresh
          </Button>
        }
      />

      {connection.error === null ? null : (
        <ErrorState
          error={connection.error}
          title="Could not load the connection status"
          onRetry={reload}
        />
      )}

      {status === null ? (
        connection.error === null ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <SkeletonCard label="Loading connection status…" />
            <SkeletonCard label="Loading pairing state…" />
          </div>
        ) : null
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <Card>
              <CardHeader
                title="WhatsApp session"
                description={connectionHint(status.state)}
                actions={<ConnectionBadge state={status.state} />}
              />
              <CardBody>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Detail label="State since">
                    <time dateTime={status.since}>
                      {formatDateTime(status.since)}
                    </time>
                  </Detail>
                  <Detail label="Last captured message">
                    {status.lastMessageAt === null ? (
                      <span className="text-slate-500">No messages captured yet.</span>
                    ) : (
                      <time dateTime={status.lastMessageAt}>
                        {formatDateTime(status.lastMessageAt)}
                      </time>
                    )}
                  </Detail>
                </dl>

                <div className="mt-5 border-t border-slate-200 pt-4">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setUnlinkError(null);
                      setConfirmOpen(true);
                    }}
                    disabled={unlinking}
                  >
                    End session / Unlink
                  </Button>
                  <p className="mt-2 text-xs text-slate-500">
                    Ends the linked WhatsApp session. Captured messages and
                    summaries stay in the database; the bot worker stops
                    capturing until you link a device again.
                  </p>
                </div>
              </CardBody>
            </Card>

            <Alert tone="info" title="Pairing codes are live credentials">
              The QR code or pairing code below is a one-time ticket served only
              on this authenticated page. Do not share screenshots of it. If it
              expires, a new one appears automatically.
            </Alert>
          </div>

          <Card>
            <CardHeader
              title={status.state === "connected" ? "Linked device" : "Link a device"}
              description={
                status.state === "connected"
                  ? "The session is active."
                  : "Scan the QR code or enter the pairing code in WhatsApp."
              }
            />
            <CardBody>
              {status.state === "connected" ? (
                <LinkedPanel status={status} />
              ) : linking === null ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center">
                  <span
                    aria-hidden="true"
                    className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
                  />
                  <p role="status" className="text-sm font-medium text-slate-800">
                    Waiting for the pairing code…
                  </p>
                  <p className="max-w-xs text-xs text-slate-500">
                    The bot worker publishes a QR code or pairing code while it
                    is linking. This page checks every few seconds.
                  </p>
                </div>
              ) : (
                <PairingDetails
                  linking={linking}
                  remainingSeconds={seconds}
                  expired={expired}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {actionError === null ? null : (
        <Alert tone="error" title="Could not request the unlink">
          {actionError.message}
        </Alert>
      )}

      <div aria-live="polite">
        {feedback === null ? null : (
          <Alert tone="success" title="Unlink requested">
            {feedback}
          </Alert>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="End the WhatsApp session?"
        description={
          <p>
            The bot worker will log out and stop capturing messages until you
            link a device again. Captured messages, imported history, and
            summaries are kept.
          </p>
        }
        confirmLabel="End session"
        loading={unlinking}
        error={unlinkError}
        onConfirm={() => void handleUnlink()}
        onCancel={() => {
          setConfirmOpen(false);
          setUnlinkError(null);
        }}
      />
    </div>
  );
}
