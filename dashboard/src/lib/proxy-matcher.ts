/**
 * Matcher for the Next.js `proxy` (formerly middleware) entry point.
 *
 * Next applies `config.matcher` from `src/proxy.ts` to decide which requests
 * run through the sanitizer. Keeping the pattern in this dependency-free module
 * lets `tests/proxy-wiring.test.ts` assert coverage under plain `node:test`
 * (`next/server` cannot be imported outside a Next build), while `src/proxy.ts`
 * wires it into `config.matcher`.
 *
 * Semantics used below (Next matcher / path-to-regexp subset):
 *   `/api/:path*` → `/api`, `/api/`, and everything below it.
 *
 * If a backend proxy source is ever added to `next.config.ts` rewrites, it must
 * be covered by this matcher too — otherwise its client-address headers reach
 * the backend unsanitized.
 */
export const PROXY_MATCHER: string[] = ["/api/:path*"];
