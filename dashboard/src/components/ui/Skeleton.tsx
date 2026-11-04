interface SkeletonProps {
  className?: string;
}

/** Decorative placeholder block; wrap with a `role="status"` label. */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-slate-200/80 ${className}`}
    />
  );
}

interface SkeletonRowsProps {
  label?: string;
  rows?: number;
}

/** A small stack of skeleton lines with an accessible loading label. */
export function SkeletonRows({ label = "Loading…", rows = 3 }: SkeletonRowsProps) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

/** Card-shaped skeleton used while a page's data loads. */
export function SkeletonCard({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-1/4" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
