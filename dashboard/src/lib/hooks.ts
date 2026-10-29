"use client";

import { useCallback, useEffect, useState } from "react";
import { toApiError, type ApiError } from "./api";

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (value: T | ((previous: T | null) => T | null)) => void;
}

/**
 * Minimal data-loading hook: no state library, one request at a time, and a
 * cancelled-flag so late responses never overwrite newer state.
 *
 * `deps` controls when the loader re-runs; the loader itself is intentionally
 * not a dependency (callers pass inline functions).
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (!active) return;
        setDataState(value);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(toApiError(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const setData = useCallback(
    (value: T | ((previous: T | null) => T | null)) => {
      setDataState((previous) =>
        typeof value === "function"
          ? (value as (previous: T | null) => T | null)(previous)
          : value,
      );
    },
    [],
  );

  return { data, error, loading, reload, setData };
}
