import type { ReactNode } from "react";

/**
 * Centered layout for the unauthenticated screens: first-run setup, sign-in,
 * and recovery.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-600 text-base font-bold text-white shadow-sm"
          >
            S
          </span>
          <p className="text-sm font-semibold text-slate-900">Summarly</p>
          <p className="mt-0.5 text-sm text-slate-600">
            Self-hosted WhatsApp group summaries
          </p>
        </div>
        {children}
      </div>
      <p className="mt-8 max-w-md text-center text-xs leading-5 text-slate-500">
        This installation stores messages in its own PostgreSQL database.
        Summary requests send the selected message content to the AI provider you
        configure.
      </p>
    </div>
  );
}
