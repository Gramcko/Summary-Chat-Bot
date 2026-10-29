import type { NextConfig } from "next";

/**
 * Architecture §4.1: the browser only ever talks to this Next.js app.
 * Every `/api/*` request is rewritten to the backend so the httpOnly session
 * cookie stays same-origin and no CORS configuration is needed.
 *
 * `BACKEND_URL` is read on the server when the Next.js config is loaded. Note
 * that Next bakes rewrite destinations into `.next/routes-manifest.json` at
 * build time, so the variable must be present for `next build` (and for
 * `next dev`, which rebuilds the manifest). The default keeps the local
 * development setup working without any environment file.
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
