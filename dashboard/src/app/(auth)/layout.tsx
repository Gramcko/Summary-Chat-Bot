import type { ReactNode } from "react";

/**
 * Centered layout for the unauthenticated screens: first-run setup, sign-in,
 * and recovery.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">
            Summarly
          </p>
          <p className="mt-1 text-sm text-slate-600">
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
