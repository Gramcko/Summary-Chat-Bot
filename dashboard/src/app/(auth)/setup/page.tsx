"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { ErrorState, LoadingBlock } from "@/components/ui/States";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import {
  PASSWORD_MIN_LENGTH,
  hasErrors,
  validatePassword,
  validatePasswordConfirmation,
  type FieldErrors,
} from "@/lib/validation";
import { RecoveryCodesPanel } from "@/components/setup/RecoveryCodesPanel";

type Status = "checking" | "ready" | "completed" | "error";

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [statusError, setStatusError] = useState<ApiError | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const loadStatus = useCallback(async () => {
    setStatus("checking");
    setStatusError(null);
    try {
      const result = await api.setupStatus();
      setStatus(result.needsSetup ? "ready" : "completed");
    } catch (cause) {
      setStatusError(toApiError(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);

    const errors: FieldErrors = {};
    const passwordError = validatePassword(password);
    if (passwordError !== null) errors.password = passwordError;
    const confirmationError = validatePasswordConfirmation(password, confirmation);
    if (confirmationError !== null) errors.confirmPassword = confirmationError;
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setSubmitting(true);
    try {
      const response = await api.createAdmin({ password });
      setPassword("");
      setConfirmation("");
      setRecoveryCodes(response.recoveryCodes);
    } catch (cause) {
      const error = toApiError(cause);
      if (error.status === 409) {
        setStatus("completed");
      } else {
        const fields = mapFieldErrors(error.details);
        if (fields.password !== undefined) {
          setFieldErrors({ password: fields.password });
        } else {
          setFailure(error);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "checking") {
    return <LoadingBlock label="Checking this installation…" />;
  }

  if (status === "error") {
    return (
      <ErrorState
        error={statusError ?? toApiError(new Error("Setup status unavailable."))}
        title="Cannot check the setup status"
        onRetry={() => void loadStatus()}
      />
    );
  }

  if (recoveryCodes !== null) {
    return (
      <RecoveryCodesPanel
        codes={recoveryCodes}
        onContinue={() => router.replace("/login")}
      />
    );
  }

  if (status === "completed") {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Setup already completed
          </h1>
          <Alert tone="info" title="An administrator already exists">
            First-time setup is accepted exactly once. Sign in with the
            administrator password, or use a recovery code if you no longer have
            it.
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ButtonLink href="/login" className="w-full sm:w-auto">
              Go to sign in
            </ButtonLink>
            <ButtonLink href="/recover" variant="secondary" className="w-full sm:w-auto">
              Recover access
            </ButtonLink>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            First-time setup
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Create the administrator password for this installation. You will get
            ten single-use recovery codes afterwards.
          </p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <TextField
            id="new-password"
            label="Administrator password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            autoFocus
            required
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. Stored as a salted scrypt hash.`}
            error={fieldErrors.password}
            disabled={submitting}
          />

          <TextField
            id="confirm-password"
            label="Confirm password"
            type="password"
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="new-password"
            required
            error={fieldErrors.confirmPassword}
            disabled={submitting}
          />

          {failure === null ? null : (
            <Alert tone="error" title="Setup failed">
              {failure.message}
            </Alert>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            Create administrator
          </Button>
        </form>

        <p className="border-t border-slate-200 pt-4 text-sm text-slate-600">
          Already configured this installation?{" "}
          <Link
            href="/login"
            className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
          >
            Go to sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
