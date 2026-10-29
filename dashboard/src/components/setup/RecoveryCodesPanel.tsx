"use client";

import { useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { CheckboxField } from "@/components/ui/Field";

type ActionState = "idle" | "done" | "failed";

interface RecoveryCodesPanelProps {
  codes: readonly string[];
  onContinue: () => void;
}

/**
 * Recovery codes are returned exactly once by `POST /api/setup`. They live only
 * in component state: never in localStorage, the URL, or a log.
 */
export function RecoveryCodesPanel({ codes, onContinue }: RecoveryCodesPanelProps) {
  const [copyState, setCopyState] = useState<ActionState>("idle");
  const [downloadState, setDownloadState] = useState<ActionState>("idle");
  const [acknowledged, setAcknowledged] = useState(false);
  const checkboxId = useId();

  async function handleCopy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
  }

  function handleDownload(): void {
    try {
      const lines = [
        "Summarly Chat Bot — administrator recovery codes",
        `Generated: ${new Date().toISOString()}`,
        "",
        ...codes,
        "",
        "Each code can be used once to reset the administrator password.",
        "Store this file somewhere safe and delete it once the codes are saved.",
        "",
      ];
      const blob = new Blob([lines.join("\n")], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "summarly-recovery-codes.txt";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloadState("done");
    } catch {
      setDownloadState("failed");
    }
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        <Alert tone="warning" title="Save these now — they will never be shown again">
          <p>
            These ten codes are the only way to reset the administrator password
            if you forget it. They are stored as hashes on the server, so nobody
            — including the Summarly backend — can show them again. Do not
            refresh or leave this page until you have saved them.
          </p>
        </Alert>

        <div>
          <h1 className="text-lg font-semibold text-slate-900">Recovery codes</h1>
          <p className="mt-1 text-sm text-slate-600">
            Each code can be used once on the recovery screen.
          </p>
        </div>

        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {codes.map((code, index) => (
            <li
              key={code}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <span className="w-5 shrink-0 text-right text-xs text-slate-500">
                {index + 1}.
              </span>
              <code className="select-all break-all font-mono text-sm tracking-wide text-slate-900">
                {code}
              </code>
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="secondary" onClick={() => void handleCopy()}>
            Copy all codes
          </Button>
          <Button variant="secondary" onClick={handleDownload}>
            Download as text file
          </Button>
        </div>

        <div className="space-y-1 text-sm" aria-live="polite">
          {copyState === "done" ? (
            <p className="text-emerald-700">Codes copied to the clipboard.</p>
          ) : null}
          {copyState === "failed" ? (
            <p className="text-red-700">
              Copy failed — select the codes above and copy them manually.
            </p>
          ) : null}
          {downloadState === "done" ? (
            <p className="text-emerald-700">
              Download started. Keep the file somewhere safe.
            </p>
          ) : null}
          {downloadState === "failed" ? (
            <p className="text-red-700">
              Download failed — select the codes above and save them manually.
            </p>
          ) : null}
        </div>

        <div className="border-t border-slate-200 pt-4">
          <CheckboxField
            id={checkboxId}
            label="I have saved my recovery codes"
            checked={acknowledged}
            onChange={setAcknowledged}
            description="You will not see them again. Losing every code means resetting the administrator from the server."
          />
          <div className="mt-4">
            <Button onClick={onContinue} disabled={!acknowledged} className="w-full">
              Continue to sign in
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
