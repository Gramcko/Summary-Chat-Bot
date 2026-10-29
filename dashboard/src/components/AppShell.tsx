"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, toApiError } from "@/lib/api";
import { errorMessage } from "@/lib/messages";
import { Button } from "./ui/Button";

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/groups", label: "Groups" },
  { href: "/runs", label: "Summary runs" },
  { href: "/settings", label: "Settings" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout(): Promise<void> {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      router.replace("/login");
      router.refresh();
    } catch (cause) {
      setLogoutError(errorMessage(toApiError(cause)));
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow"
      >
        Skip to main content
      </a>

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
            >
              S
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Summarly</p>
              <p className="text-xs text-slate-500">WhatsApp group summaries</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Main">
              <ul className="flex flex-wrap items-center gap-1">
                {NAV_ITEMS.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={`inline-block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          active
                            ? "bg-brand-50 text-brand-700"
                            : "text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <Button
              variant="secondary"
              size="sm"
              loading={loggingOut}
              onClick={() => void handleLogout()}
            >
              Sign out
            </Button>
          </div>
        </div>
        {logoutError === null ? null : (
          <div className="mx-auto max-w-6xl px-4 pb-3 sm:px-6">
            <p role="alert" className="text-sm font-medium text-red-700">
              {logoutError}
            </p>
          </div>
        )}
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
