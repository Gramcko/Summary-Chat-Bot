"use client";

import { useCallback, useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for destructive actions. Uses a native `<dialog>` so focus
 * trapping, `Escape`, and the backdrop come from the platform.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openRef = useRef(open);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handleClose = () => {
      if (openRef.current) onCancel();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onCancel]);

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) onCancel();
    },
    [onCancel],
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={handleBackdropClick}
      className="w-[min(92vw,28rem)] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/50"
    >
      <div className="px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div id={descriptionId} className="mt-2 text-sm text-slate-600">
          {description}
        </div>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
