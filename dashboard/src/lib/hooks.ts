"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * A load that was already in flight when the caller wrote data locally (for
 * example an optimistic update after a mutation, or a poll started just before
 * a save) is discarded: the local write is newer than the response. The next
 * load — manual refresh or the next poll — applies normally because it starts
 * after the write.
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
  /** Incremented by every local `setData` write. */
  const localWrites = useRef(0);

  useEffect(() => {
    let active = true;
    const writesAtStart = localWrites.current;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (!active) return;
        setLoading(false);
        // A local write landed while this request was in flight; keep it.
        if (localWrites.current !== writesAtStart) return;
        setDataState(value);
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
      localWrites.current += 1;
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
