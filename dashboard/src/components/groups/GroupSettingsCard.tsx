"use client";

import type { Group } from "@summarly/contracts";
import { useRef, useState, type FormEvent } from "react";
import { useNotifications } from "@/components/notifications/NotificationProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CheckboxField, TextField } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { TIME_ZONE_LIST_ID } from "@/components/TimeZones";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import {
  requiresHistoryImportPrompt,
  summarizeHistoryImport,
} from "@/lib/history-import";
import { hasErrors, validateGroupForm, type FieldErrors } from "@/lib/validation";

const FIELD_NAMES = ["timezone", "summaryTime"] as const;

interface GroupSettingsCardProps {
  group: Group;
  onSaved: (group: Group) => void;
  /** Render the card's own header (name, id, monitored badge). */
  showHeader?: boolean;
}

interface ActionError {
  title: string;
  message: string;
  /** True when the failing action was a history-import request. */
  retryImport: boolean;
}

export function GroupSettingsCard({
  group,
  onSaved,
  showHeader = true,
}: GroupSettingsCardProps) {
  const { notify } = useNotifications();
  const baseId = `group-${group.id}`;
  const [timezone, setTimezone] = useState(group.timezone);
  const [summaryTime, setSummaryTime] = useState<string | null>(group.summaryTime);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const [confirmMonitor, setConfirmMonitor] = useState(false);
  const [monitorIntent, setMonitorIntent] = useState<"import" | "only" | null>(null);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  /** Entry guard: a double-click can fire before the disabled state re-renders. */
  const monitorInFlight = useRef(false);

  const formBusy = saving || monitorBusy || importBusy || clearing;
  const importSummary = summarizeHistoryImport(group.historyImport);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);
    setFeedback(null);

    const errors = validateGroupForm({ timezone, summaryTime });
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setSaving(true);
    try {
      const updated = await api.updateGroup(group.id, {
        timezone: timezone.trim(),
        summaryTime,
      });
      setTimezone(updated.timezone);
      setSummaryTime(updated.summaryTime);
      setFieldErrors({});
      setFeedback("Group settings saved.");
      onSaved(updated);
    } catch (cause) {
      const error = toApiError(cause);
      const mapped = mapFieldErrors(error.details);
      const relevant: FieldErrors = {};
      for (const name of FIELD_NAMES) {
        const message = mapped[name];
        if (message !== undefined) relevant[name] = message;
      }
      setFieldErrors(relevant);
      if (!hasErrors(relevant)) setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  async function stopMonitoring(): Promise<void> {
    setMonitorBusy(true);
    setActionError(null);
    setFeedback(null);
    try {
      const updated = await api.updateGroup(group.id, { monitored: false });
      onSaved(updated);
      setFeedback("Monitoring is off for this group.");
    } catch (cause) {
      setActionError({
        title: "Could not change monitoring",
        message: toApiError(cause).message,
        retryImport: false,
      });
    } finally {
      setMonitorBusy(false);
    }
  }

  /**
   * `POST /api/groups/:id/history-import`. Errors are surfaced on the card so a
   * successful monitor PATCH is never rolled back by an import failure.
   */
  async function requestHistoryImport(): Promise<void> {
    setImportBusy(true);
    setActionError(null);
    setFeedback(null);
    try {
      const result = await api.requestHistoryImport(group.id);
      onSaved(result.group);
      setFeedback(
        result.accepted
          ? "History import requested."
          : "A history import is already in progress.",
      );
      notify({
        title: result.accepted
          ? "History import requested"
          : "History import already running",
        description: result.accepted
          ? "The bot worker will import older messages when WhatsApp provides them."
          : "An import is already pending or running for this group.",
        tone: result.accepted ? "success" : "info",
      });
    } catch (cause) {
      const error = toApiError(cause);
      setActionError({
        title: "History import request failed",
        message: error.message,
        retryImport: true,
      });
      notify({
        title: "History import request failed",
        description: error.message,
        tone: "error",
      });
    } finally {
      setImportBusy(false);
    }
  }

  async function monitorGroup(withImport: boolean): Promise<void> {
    if (monitorInFlight.current) return;
    monitorInFlight.current = true;
    setMonitorIntent(withImport ? "import" : "only");
    setMonitorBusy(true);
    setMonitorError(null);
    setActionError(null);
    setFeedback(null);
    try {
      const updated = await api.updateGroup(group.id, { monitored: true });
      onSaved(updated);
      setConfirmMonitor(false);
      if (withImport) {
        await requestHistoryImport();
      } else {
        setFeedback("Group is now monitored.");
      }
    } catch (cause) {
      // The PATCH failed: keep the dialog open so the admin can retry/cancel.
      setMonitorError(toApiError(cause).message);
    } finally {
      monitorInFlight.current = false;
      setMonitorBusy(false);
      setMonitorIntent(null);
    }
  }

  function handleMonitoredChange(next: boolean): void {
    if (formBusy || next === group.monitored) return;
    if (requiresHistoryImportPrompt(group.monitored, next)) {
      setMonitorError(null);
      setConfirmMonitor(true);
      return;
    }
    void stopMonitoring();
  }

  async function handleClearConfirmed(): Promise<void> {
    setClearing(true);
    setClearError(null);
    setFailure(null);
    try {
      // Explicit `null` clears the daily cutoff (docs/api.md).
      const updated = await api.updateGroup(group.id, { summaryTime: null });
      setTimezone(updated.timezone);
      setSummaryTime(updated.summaryTime);
      setFeedback("Daily summary time cleared.");
      setConfirmClear(false);
      onSaved(updated);
    } catch (cause) {
      setClearError(toApiError(cause).message);
    } finally {
      setClearing(false);
    }
  }

  const showImportRetryInAlert =
    actionError?.retryImport === true &&
    group.monitored &&
    importSummary?.showRetry !== true;

  return (
    <Card>
      {showHeader ? (
        <CardHeader
          title={group.name}
          description={
            <span className="break-all font-mono text-xs text-slate-500">
              {group.id}
            </span>
          }
          actions={
            <Badge tone={group.monitored ? "success" : "neutral"} dot>
              {group.monitored ? "Monitored" : "Not monitored"}
            </Badge>
          }
        />
      ) : null}
      <CardBody>
        <div className="space-y-4">
          <form noValidate onSubmit={handleSubmit} className="space-y-4">
            <CheckboxField
              id={`${baseId}-monitored`}
              label="Monitor this group"
              checked={group.monitored}
              onChange={handleMonitoredChange}
              description="Changes apply immediately. Monitored groups are captured and included in scheduled daily summaries."
              disabled={formBusy}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                id={`${baseId}-timezone`}
                label="Time zone"
                value={timezone}
                onChange={setTimezone}
                list={TIME_ZONE_LIST_ID}
                required
                hint="IANA name, for example Europe/Madrid or America/Bogota."
                error={fieldErrors.timezone}
                disabled={formBusy}
                spellCheck={false}
              />

              <div>
                <div className="flex items-end gap-2">
                  <TextField
                    id={`${baseId}-summary-time`}
                    label="Daily summary time"
                    type="time"
                    step={60}
                    value={summaryTime ?? ""}
                    onChange={(value) => setSummaryTime(value === "" ? null : value)}
                    hint={
                      summaryTime === null
                        ? "No daily cutoff is set."
                        : "Local time in the group time zone (24-hour HH:mm)."
                    }
                    error={fieldErrors.summaryTime}
                    disabled={formBusy}
                    className="flex-1"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mb-1 shrink-0"
                    onClick={() => {
                      setClearError(null);
                      setConfirmClear(true);
                    }}
                    disabled={formBusy || summaryTime === null}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            </div>

            {failure === null ? null : (
              <Alert tone="error" title="Could not save this group">
                {failure.message}
              </Alert>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div aria-live="polite" className="text-sm">
                {feedback === null ? null : (
                  <span className="font-medium text-emerald-700">{feedback}</span>
                )}
              </div>
              <Button type="submit" loading={saving} disabled={monitorBusy || importBusy}>
                Save changes
              </Button>
            </div>
          </form>

          {actionError === null ? null : (
            <Alert tone="error" title={actionError.title}>
              <p>{actionError.message}</p>
              {showImportRetryInAlert ? (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={importBusy}
                    onClick={() => void requestHistoryImport()}
                  >
                    Retry import
                  </Button>
                </div>
              ) : null}
            </Alert>
          )}

          {importSummary === null ? (
            group.monitored ? (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-slate-600">
                    Older messages were never imported for this group.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={importBusy}
                    disabled={monitorBusy || saving}
                    onClick={() => void requestHistoryImport()}
                  >
                    Import older messages
                  </Button>
                </div>
              </div>
            ) : null
          ) : (
            <div
              className="rounded-lg border border-slate-200 px-3 py-2"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-2">
                {importSummary.inFlight ? (
                  <Spinner className="h-4 w-4 text-sky-600" />
                ) : null}
                <Badge
                  tone={
                    importSummary.inFlight
                      ? "info"
                      : importSummary.status === "failed"
                        ? "danger"
                        : "success"
                  }
                  dot
                >
                  {importSummary.badgeLabel}
                </Badge>
                <span className="text-sm text-slate-800">
                  {importSummary.message}
                </span>
              </div>
              {importSummary.detail === null ? null : (
                <p className="mt-1 text-xs text-slate-500">{importSummary.detail}</p>
              )}
              {importSummary.hint === null ? null : (
                <p className="mt-1 text-xs font-medium text-amber-700">
                  {importSummary.hint}
                </p>
              )}
              {importSummary.showRetry ? (
                group.monitored ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={importBusy}
                      disabled={monitorBusy || saving}
                      onClick={() => void requestHistoryImport()}
                    >
                      Retry import
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-slate-600">
                    Turn monitoring on to retry the import.
                  </p>
                )
              ) : null}
            </div>
          )}
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirmMonitor}
        title="Monitor this group and retrieve old messages?"
        description={
          <div className="space-y-2">
            <p>
              <strong>Retrieve old messages?</strong> WhatsApp may provide a
              limited, partial history of messages sent before monitoring.
              Imported messages are stored like live ones and will be included in
              summaries, which are sent to the configured AI provider.
            </p>
            <p className="text-xs text-slate-500">
              Choose “Monitor only” to skip the import; you can request it later
              from this group card.
            </p>
          </div>
        }
        confirmLabel="Monitor & import history"
        alternativeLabel="Monitor only"
        onAlternative={() => void monitorGroup(false)}
        alternativeLoading={monitorBusy && monitorIntent === "only"}
        loading={monitorBusy && monitorIntent === "import"}
        error={monitorError}
        onConfirm={() => void monitorGroup(true)}
        onCancel={() => {
          setConfirmMonitor(false);
          setMonitorError(null);
        }}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Clear the daily summary time?"
        description={
          <p>
            The scheduled daily summary for <strong>{group.name}</strong> will be
            disabled until a summary time is set again. Existing runs and
            summaries are not deleted.
          </p>
        }
        confirmLabel="Clear summary time"
        loading={clearing}
        error={clearError}
        onConfirm={() => void handleClearConfirmed()}
        onCancel={() => {
          setConfirmClear(false);
          setClearError(null);
        }}
      />
    </Card>
  );
}
