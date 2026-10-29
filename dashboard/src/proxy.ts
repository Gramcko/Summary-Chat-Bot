import { NextResponse, type NextRequest } from "next/server";
import { sanitizeForwardingHeaders } from "./lib/forwarding-headers";

/**
 * Next.js 16 `proxy` (formerly middleware), Node runtime.
 *
 * Runs before the `/api/:path*` rewrite, so the headers changed here are the
 * ones the rewrite forwards to the backend. Only client-address headers are
 * removed and a constant marker is added (`src/lib/forwarding-headers.ts`
 * explains why); cookies, bodies, status codes, and response headers are left
 * untouched — the rewrite still owns the actual proxying.
 *
 * `config.matcher` must cover every backend rewrite source in `next.config.ts`.
 * Next requires a static literal here (an imported constant fails the build), so
 * the canonical pattern lives in `src/lib/proxy-matcher.ts` and
 * `tests/proxy-wiring.test.ts` asserts this literal matches it and covers the
 * sensitive paths.
 */
export function proxy(request: NextRequest): NextResponse {
  return NextResponse.next({
    request: { headers: sanitizeForwardingHeaders(request.headers) },
  });
}

export const config = {
  matcher: ["/api/:path*"],
};
