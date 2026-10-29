"use client";

import { useEffect, useState } from "react";
import { api, isNetworkError, toApiError } from "@/lib/api";
import { Button } from "./ui/Button";

const POLL_MS = 30_000;

/**
 * Global connectivity check. Uses the public `/api/setup/status` probe so the
 * banner works on the auth screens too (a `401` there would be meaningless).
 */
export function BackendStatusBanner() {
  const [problem, setProblem] = useState<"unreachable" | "error" | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;

    const check = async () => {
      try {
        await api.setupStatus();
        if (active) setProblem(null);
      } catch (cause) {
        if (!active) return;
        const error = toApiError(cause);
        if (isNetworkError(error)) {
          setProblem("unreachable");
        } else if (error.status !== null && error.status >= 500) {
          setProblem("error");
        } else {
          setProblem(null);
        }
      }
    };

    void check();
    const interval = window.setInterval(() => {
      void check();
    }, POLL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [nonce]);

  if (problem === null) return null;

  return (
    <div role="status" className="border-b border-amber-300 bg-amber-100 text-amber-950">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-semibold">
            {problem === "unreachable"
              ? "Cannot reach the Summarly backend."
              : "The Summarly backend is reporting errors."}
          </span>{" "}
          Check that the backend service is running and that{" "}
          <code className="rounded bg-amber-200/60 px-1 py-0.5 font-mono text-[11px]">
            BACKEND_URL
          </code>{" "}
          points at it. Pages will show errors until the API responds.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setNonce((current) => current + 1)}
          className="self-start sm:self-auto"
        >
          Retry now
        </Button>
      </div>
    </div>
  );
}
