import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BackendStatusBanner } from "@/components/BackendStatusBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Summarly",
    template: "%s · Summarly",
  },
  description:
    "Self-hosted dashboard for WhatsApp group daily summaries: connection status, groups, runs, and summaries.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">
        <BackendStatusBanner />
        {children}
      </body>
    </html>
  );
}
