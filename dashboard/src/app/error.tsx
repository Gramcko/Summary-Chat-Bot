"use client";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <Alert tone="error" title="This page could not be rendered">
        <p>{error.message}</p>
        {error.digest === undefined ? null : (
          <p className="mt-1 text-xs opacity-80">Reference: {error.digest}</p>
        )}
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={reset}>
            Try again
          </Button>
        </div>
      </Alert>
    </div>
  );
}
