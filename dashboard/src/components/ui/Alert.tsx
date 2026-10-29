import type { ReactNode } from "react";

export type AlertTone = "info" | "success" | "warning" | "error";

const TONE_CLASSES: Record<AlertTone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Inline feedback. Errors use `role="alert"` (assertive); everything else uses
 * `role="status"` so it is announced without stealing focus.
 */
export function Alert({
  tone = "info",
  title,
  children,
  className = "",
}: AlertProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-3 text-sm ${TONE_CLASSES[tone]} ${className}`}
    >
      {title === undefined ? null : <p className="font-semibold">{title}</p>}
      {children === undefined ? null : (
        <div className={title === undefined ? "" : "mt-1"}>{children}</div>
      )}
    </div>
  );
}
