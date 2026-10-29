"use client";

import type { Group } from "@summarly/contracts";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CheckboxField, TextField } from "@/components/ui/Field";
import { TIME_ZONE_LIST_ID } from "@/components/TimeZones";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import { hasErrors, validateGroupForm, type FieldErrors } from "@/lib/validation";

const FIELD_NAMES = ["monitored", "timezone", "summaryTime"] as const;

interface GroupSettingsCardProps {
  group: Group;
  onSaved: (group: Group) => void;
}

export function GroupSettingsCard({ group, onSaved }: GroupSettingsCardProps) {
  const baseId = `group-${group.id}`;
  const [monitored, setMonitored] = useState(group.monitored);
  const [timezone, setTimezone] = useState(group.timezone);
  const [summaryTime, setSummaryTime] = useState<string | null>(group.summaryTime);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  function applySaved(updated: Group, message: string): void {
    setMonitored(updated.monitored);
    setTimezone(updated.timezone);
    setSummaryTime(updated.summaryTime);
    setFieldErrors({});
    setFeedback(message);
    onSaved(updated);
  }

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
        monitored,
        timezone: timezone.trim(),
        summaryTime,
      });
      applySaved(updated, "Group settings saved.");
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

  async function handleClearConfirmed(): Promise<void> {
    setClearing(true);
    setClearError(null);
    setFailure(null);
    try {
      // Explicit `null` clears the daily cutoff (docs/api.md).
      const updated = await api.updateGroup(group.id, { summaryTime: null });
      applySaved(updated, "Daily summary time cleared.");
      setConfirmClear(false);
    } catch (cause) {
      setClearError(toApiError(cause).message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={group.name}
        description={
          <span className="break-all font-mono text-xs text-slate-500">
            {group.id}
          </span>
        }
        actions={
          <Badge tone={monitored ? "success" : "neutral"} dot>
            {monitored ? "Monitored" : "Not monitored"}
          </Badge>
        }
      />
      <CardBody>
        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <CheckboxField
            id={`${baseId}-monitored`}
            label="Monitor this group"
            checked={monitored}
            onChange={setMonitored}
            description="Monitored groups are captured and included in scheduled daily summaries."
            error={fieldErrors.monitored}
            disabled={saving}
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
              disabled={saving}
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
                  disabled={saving}
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
                  disabled={saving || summaryTime === null}
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
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>

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
