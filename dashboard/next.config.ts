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

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
