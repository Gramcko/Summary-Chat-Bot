"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { api, toApiError } from "@/lib/api";
import { errorMessage } from "@/lib/messages";
import { Button } from "./ui/Button";

type IconName =
  | "overview"
  | "groups"
  | "runs"
  | "connection"
  | "settings"
  | "menu"
  | "close"
  | "logout";

const ICON_PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.6" />
      <rect x="14" y="3" width="7" height="7" rx="1.6" />
      <rect x="3" y="14" width="7" height="7" rx="1.6" />
      <rect x="14" y="14" width="7" height="7" rx="1.6" />
    </>
  ),
  groups: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8" />
      <path d="M17.6 19a5.4 5.4 0 0 0-2-4.2" />
    </>
  ),
  runs: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  connection: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
      <path d="M14 14h3v3h-3zM20.2 14v.01M14 20.2v.01M20.2 20.2v.01" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M18 7h2M4 17h2M10 17h10" />
      <circle cx="15.5" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 16l4-4-4-4M14 12H3" />
    </>
  ),
};

function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-[18px] w-[18px] shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/groups", label: "Groups", icon: "groups" },
  { href: "/runs", label: "Summary runs", icon: "runs" },
  { href: "/connection", label: "Connection", icon: "connection" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white shadow-sm"
      >
        S
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-slate-900">Summarly</p>
        {compact ? null : (
          <p className="text-xs text-slate-500">WhatsApp group summaries</p>
        )}
      </div>
    </div>
  );
}

interface NavListProps {
  pathname: string;
  onNavigate?: () => void;
}

function NavList({ pathname, onNavigate }: NavListProps) {
  return (
    <nav aria-label="Primary">
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-brand-50 text-brand-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon
                  name={item.icon}
                  className={active ? "text-brand-600" : "text-slate-400"}
                />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface SignOutButtonProps {
  loading: boolean;
  onClick: () => void;
  className?: string;
}

function SignOutButton({ loading, onClick, className = "" }: SignOutButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={loading}
      onClick={onClick}
      className={`w-full justify-start gap-3 text-slate-600 ${className}`}
    >
      {loading ? null : <Icon name="logout" className="text-slate-400" />}
      Sign out
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const drawerRef = useRef<HTMLDialogElement | null>(null) as RefObject<
    HTMLDialogElement | null
  >;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    const drawer = drawerRef.current;
    if (drawer !== null && drawer.open) drawer.close();
  }, [pathname]);

  function openDrawer(): void {
    const drawer = drawerRef.current;
    if (drawer === null) return;
    setDrawerOpen(true);
    drawer.showModal();
  }

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
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-raised"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden border-r border-slate-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="px-5 py-5">
          <Link href="/" className="rounded-lg">
            <Brand />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <NavList pathname={pathname} />
        </div>
        <div className="border-t border-slate-200 px-3 py-3">
          <SignOutButton loading={loggingOut} onClick={() => void handleLogout()} />
          <p className="mt-2 px-3 text-[11px] leading-4 text-slate-400">
            Self-hosted · administrator
          </p>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={openDrawer}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>
          <Brand compact />
          <span className="h-10 w-10" aria-hidden="true" />
        </header>

        <main
          id="main"
          className="mx-auto w-full max-w-6xl scroll-mt-24 px-4 py-6 sm:px-6 lg:scroll-mt-8 lg:px-8 lg:py-10"
        >
          {children}
        </main>
      </div>

      {/* Mobile drawer (native dialog: focus trap, Escape, backdrop) */}
      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        onClose={() => setDrawerOpen(false)}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[85vw] rounded-none border-0 p-0 text-slate-900 shadow-raised backdrop:bg-slate-900/40"
      >
        <div className="flex h-full flex-col bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-4">
            <Brand />
            <button
              type="button"
              onClick={() => drawerRef.current?.close()}
              aria-label="Close navigation"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            <NavList
              pathname={pathname}
              onNavigate={() => drawerRef.current?.close()}
            />
          </div>
          <div className="border-t border-slate-200 px-3 py-3">
            <SignOutButton
              loading={loggingOut}
              onClick={() => void handleLogout()}
            />
            {logoutError === null || !drawerOpen ? null : (
              <p role="alert" className="mt-2 px-3 text-xs font-medium text-red-700">
                {logoutError}
              </p>
            )}
          </div>
        </div>
      </dialog>

      {logoutError === null || drawerOpen ? null : (
        <div
          role="alert"
          className="fixed bottom-4 left-4 right-4 z-40 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 shadow-raised lg:left-[17rem] lg:right-auto lg:max-w-md"
        >
          Could not sign out: {logoutError}
        </div>
      )}
    </div>
  );
}
