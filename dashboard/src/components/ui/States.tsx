import type { ReactNode } from "react";
import type { ApiError } from "@/lib/api";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600"
    >
      <Spinner className="h-4 w-4 text-slate-500" />
      <span>{label}</span>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description === undefined ? null : (
        <div className="mx-auto mt-1 max-w-prose text-sm text-slate-600">
          {description}
        </div>
      )}
      {action === undefined ? null : (
        <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>
      )}
    </div>
  );
}

interface ErrorStateProps {
  error: ApiError;
  title?: string;
  onRetry?: () => void;
}

export function ErrorState({
  error,
  title = "Something went wrong",
  onRetry,
}: ErrorStateProps) {
  return (
    <Alert tone="error" title={title}>
      <p>{error.message}</p>
      {error.details.length === 0 ? null : (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {error.details.map((detail) => (
            <li key={`${detail.path}:${detail.message}`}>
              {detail.path.length > 0 ? `${detail.path}: ` : ""}
              {detail.message}
            </li>
          ))}
        </ul>
      )}
      {onRetry === undefined ? null : (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </Alert>
  );
}
