"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { api, toApiError, type ApiError } from "@/lib/api";
import { mapFieldErrors } from "@/lib/form-errors";
import { errorMessage } from "@/lib/messages";
import { hasErrors, type FieldErrors } from "@/lib/validation";

const LINK_CLASS =
  "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    let active = true;
    api.setupStatus().then(
      (status) => {
        if (!active) return;
        setNeedsSetup(status.needsSetup);
        if (status.needsSetup) router.replace("/setup");
      },
      () => {
        // The connectivity banner reports an unreachable backend.
      },
    );
    return () => {
      active = false;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);

    const errors: FieldErrors = {};
    if (password.length === 0) errors.password = "Enter your password.";
    else if (password.length > 200) errors.password = "Use at most 200 characters.";
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setSubmitting(true);
    try {
      await api.login({ password });
      router.replace("/");
      router.refresh();
    } catch (cause) {
      const error = toApiError(cause);
      setFailure(error);
      const fields = mapFieldErrors(error.details);
      if (fields.password !== undefined) {
        setFieldErrors({ password: fields.password });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-600">
            Enter the administrator password for this installation.
          </p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <TextField
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            autoFocus
            required
            error={fieldErrors.password}
            disabled={submitting}
          />

          {failure === null ? null : (
            <Alert tone="error" title="Sign-in failed">
              {errorMessage(failure)}
            </Alert>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            Sign in
          </Button>
        </form>

        <div className="space-y-2 border-t border-slate-200 pt-4 text-sm text-slate-600">
          <p>
            <Link href="/recover" className={LINK_CLASS}>
              Forgot your password? Use a recovery code
            </Link>
          </p>
          {needsSetup ? (
            <p>
              No administrator exists yet.{" "}
              <Link href="/setup" className={LINK_CLASS}>
                Run first-time setup
              </Link>
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
