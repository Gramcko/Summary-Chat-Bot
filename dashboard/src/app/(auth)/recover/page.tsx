"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import { errorMessage } from "@/lib/messages";
import {
  PASSWORD_MIN_LENGTH,
  hasErrors,
  validatePassword,
  validatePasswordConfirmation,
  validateRecoveryCode,
  type FieldErrors,
} from "@/lib/validation";

const LINK_CLASS =
  "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800";

export default function RecoverPage() {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recovered, setRecovered] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);

    const errors: FieldErrors = {};
    const codeError = validateRecoveryCode(recoveryCode);
    if (codeError !== null) errors.recoveryCode = codeError;
    const passwordError = validatePassword(newPassword);
    if (passwordError !== null) errors.newPassword = passwordError;
    const confirmationError = validatePasswordConfirmation(
      newPassword,
      confirmation,
    );
    if (confirmationError !== null) errors.confirmPassword = confirmationError;
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setSubmitting(true);
    try {
      await api.recover({
        recoveryCode: recoveryCode.trim(),
        newPassword,
      });
      setRecoveryCode("");
      setNewPassword("");
      setConfirmation("");
      setRecovered(true);
    } catch (cause) {
      const error = toApiError(cause);
      if (error.status === 401 || error.status === 404 || error.status === 429) {
        setFailure(error);
      } else {
        const fields = mapFieldErrors(error.details);
        if (hasErrors(fields)) setFieldErrors(fields);
        else setFailure(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (recovered) {
    return (
      <Card>
        <CardBody className="space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Password reset
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Your password was changed and every existing session was signed
              out. The recovery code you used can no longer be used.
            </p>
          </div>
          <Alert tone="success" title="Recovery complete">
            Sign in with your new password.
          </Alert>
          <ButtonLink href="/login" className="w-full">
            Go to sign in
          </ButtonLink>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            Recover access
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Use one of the single-use recovery codes created during first-time
            setup to set a new administrator password.
          </p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <TextField
            id="recovery-code"
            label="Recovery code"
            value={recoveryCode}
            onChange={setRecoveryCode}
            autoComplete="off"
            spellCheck={false}
            mono
            autoFocus
            required
            hint="Copy it exactly as it was shown."
            error={fieldErrors.recoveryCode}
            disabled={submitting}
          />

          <TextField
            id="new-password"
            label="New password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            required
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            error={fieldErrors.newPassword}
            disabled={submitting}
          />

          <TextField
            id="new-password-confirmation"
            label="Confirm new password"
            type="password"
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="new-password"
            required
            error={fieldErrors.confirmPassword}
            disabled={submitting}
          />

          {failure === null ? null : (
            <Alert tone="error" title="Recovery failed">
              {errorMessage(failure)}
            </Alert>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            Set new password
          </Button>
        </form>

        <p className="border-t border-slate-200 pt-4 text-sm text-slate-600">
          <Link href="/login" className={LINK_CLASS}>
            Back to sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
