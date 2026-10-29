"use client";

import type { ProviderConfigPublic, ProviderConfigUpdate } from "@summarly/contracts";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { ApiKeyBadge } from "@/components/ui/Badges";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TextField } from "@/components/ui/Field";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import {
  hasErrors,
  validateProviderForm,
  type FieldErrors,
} from "@/lib/validation";

const FIELD_NAMES = ["provider", "model", "baseUrl", "apiKey"] as const;

interface ProviderFormProps {
  /** `null` when the backend reported `404` (not configured yet). */
  initial: ProviderConfigPublic | null;
  onSaved?: (config: ProviderConfigPublic) => void;
}

function buildBase(values: {
  provider: string;
  model: string;
  baseUrl: string;
}): ProviderConfigUpdate {
  const baseUrl = values.baseUrl.trim();
  return {
    provider: values.provider.trim(),
    model: values.model.trim(),
    baseUrl: baseUrl === "" ? null : baseUrl,
  };
}

export function ProviderForm({ initial, onSaved }: ProviderFormProps) {
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(initial?.hasApiKey ?? false);
  const [configured, setConfigured] = useState(initial !== null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function applyFieldErrors(mapped: FieldErrors): FieldErrors {
    const relevant: FieldErrors = {};
    for (const name of FIELD_NAMES) {
      const message = mapped[name];
      if (message !== undefined) relevant[name] = message;
    }
    return relevant;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);
    setFeedback(null);

    const errors = validateProviderForm({ provider, model, baseUrl, apiKey });
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    const body = buildBase({ provider, model, baseUrl });
    const trimmedKey = apiKey.trim();
    // Omitting `apiKey` keeps the stored key; a string replaces it.
    if (trimmedKey.length > 0) body.apiKey = trimmedKey;

    setSaving(true);
    try {
      const updated = await api.updateProvider(body);
      setApiKey("");
      setHasApiKey(updated.hasApiKey);
      setConfigured(true);
      setFieldErrors({});
      setFeedback("Provider settings saved.");
      onSaved?.(updated);
    } catch (cause) {
      const error = toApiError(cause);
      const relevant = applyFieldErrors(mapFieldErrors(error.details));
      setFieldErrors(relevant);
      if (!hasErrors(relevant)) setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  function handleAskRemove(): void {
    setFeedback(null);
    const errors = validateProviderForm({ provider, model, baseUrl, apiKey: "" });
    setFieldErrors(errors);
    if (hasErrors(errors)) return;
    setRemoveError(null);
    setConfirmRemove(true);
  }

  async function handleRemoveConfirmed(): Promise<void> {
    setRemoving(true);
    setRemoveError(null);
    try {
      // Explicit `null` clears the stored key (docs/api.md).
      const updated = await api.updateProvider({
        ...buildBase({ provider, model, baseUrl }),
        apiKey: null,
      });
      setHasApiKey(updated.hasApiKey);
      setConfigured(true);
      setConfirmRemove(false);
      setFeedback("Saved API key removed.");
      onSaved?.(updated);
    } catch (cause) {
      setRemoveError(toApiError(cause).message);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="AI provider"
        description="Used by the summary worker to generate summaries."
        actions={<ApiKeyBadge hasApiKey={hasApiKey} />}
      />
      <CardBody>
        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          {configured ? null : (
            <Alert tone="info" title="AI provider is not configured yet">
              Set the provider and model, then save. Summaries cannot be generated
              until a provider is configured.
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              id="provider"
              label="Provider"
              value={provider}
              onChange={setProvider}
              required
              placeholder="openai"
              hint="Identifier understood by the backend AI adapter."
              error={fieldErrors.provider}
              disabled={saving}
              spellCheck={false}
            />
            <TextField
              id="model"
              label="Model"
              value={model}
              onChange={setModel}
              required
              placeholder="gpt-4o-mini"
              hint="Provider-specific model identifier."
              error={fieldErrors.model}
              disabled={saving}
              spellCheck={false}
            />
          </div>

          <TextField
            id="base-url"
            label="Base URL (optional)"
            type="url"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://api.example.com/v1"
            hint="Override the provider API endpoint. Leave blank to use the provider default."
            error={fieldErrors.baseUrl}
            disabled={saving}
            spellCheck={false}
          />

          <TextField
            id="api-key"
            label="API key"
            type="password"
            value={apiKey}
            onChange={setApiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              hasApiKey ? "Leave blank to keep the saved key" : "Provider API key"
            }
            hint={
              hasApiKey
                ? "A key is saved. Leave this blank to keep it, or type a new key to replace it."
                : "No key is saved for this provider."
            }
            error={fieldErrors.apiKey}
            disabled={saving}
          />

          <p className="text-xs leading-5 text-slate-500">
            The saved key is write-only: it is stored server-side and the API never
            returns it, so it cannot be displayed here. Message content sent for
            summarization is subject to the provider&apos;s data-handling policy.
          </p>

          {failure === null ? null : (
            <Alert tone="error" title="Could not save the provider">
              {failure.message}
            </Alert>
          )}

          {feedback === null ? null : (
            <Alert tone="success" title={feedback} />
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="submit" loading={saving}>
              Save provider settings
            </Button>
            {hasApiKey ? (
              <Button
                variant="secondary"
                onClick={handleAskRemove}
                disabled={saving || removing}
              >
                Remove saved key
              </Button>
            ) : null}
          </div>
        </form>
      </CardBody>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the saved API key?"
        description={
          <p>
            Summaries will fail until a new key is saved, unless the configured
            provider does not require one. The saved key cannot be recovered or
            displayed again.
          </p>
        }
        confirmLabel="Remove key"
        loading={removing}
        error={removeError}
        onConfirm={() => void handleRemoveConfirmed()}
        onCancel={() => {
          setConfirmRemove(false);
          setRemoveError(null);
        }}
      />
    </Card>
  );
}
