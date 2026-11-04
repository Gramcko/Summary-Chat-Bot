import type { NextConfig } from "next";

/**
 * Architecture §4.1: the browser only ever talks to this Next.js app.
 * Every `/api/*` request is rewritten to the backend so the httpOnly session
 * cookie stays same-origin and no CORS configuration is needed.
 *
 * `BACKEND_URL` is read on the server when the Next.js config is loaded, and
 * Next bakes rewrite destinations into `.next/routes-manifest.json` at build
 * time — set the variable for `next build` (and for `next dev`).
 *
 * Before the rewrite forwards a request, `src/proxy.ts` strips client-supplied
 * client-address headers (`x-forwarded-for`, `x-real-ip`, ...). Do not remove
 * that file: without it a client can choose its own backend rate-limit bucket.
 *
 * If another backend proxy source is added to these rewrites, extend the matcher
 * in `src/proxy.ts` (`src/lib/proxy-matcher.ts`, asserted by
 * `tests/proxy-wiring.test.ts`) so the new path is sanitized as well.
 */
const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:3000").replace(
  /\/+$/,
  "",
);

/**
 * Development-only: Next.js 16 blocks HMR/dev resources from origins it does
 * not know. When you open the dev server from another device on your LAN
 * (e.g. http://192.168.1.50:3001), add that host here via the
 * NEXT_ALLOWED_DEV_ORIGINS env var (comma-separated, dashboard/.env.local is
 * gitignored). This setting has no effect on `next build`/`next start`.
 * Keep the dev server on trusted networks: it has no HTTPS or network
 * hardening (production deployment is Phase F).
 */
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The user-facing dashboard should not show Next.js's dev indicator.
  devIndicators: false,
  allowedDevOrigins,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
