/**
 * Header sanitization for the `/api/*` proxy.
 *
 * Why this exists
 * ---------------
 * The backend rate-limits login/recovery per `request.ip` and trusts
 * `x-forwarded-for` only from `TRUSTED_PROXIES` (by default loopback, which is
 * where the dashboard proxy connects from). The dashboard must therefore
 * guarantee that the backend never receives a client-chosen address: otherwise
 * a client could pick its own rate-limit bucket (unlimited password guessing)
 * or lock out an arbitrary third-party address.
 *
 * What Next.js actually gives us (verified empirically on Next.js 16.4.3,
 * self-hosted `next start`, Node runtime, both a route handler and `proxy.ts`):
 * - `NextRequest` exposes no `ip`/socket property, and the request's internal
 *   symbol carries only `{ cookies, nextUrl, url }`, so the TCP peer address is
 *   not reachable from application code;
 * - Next fills `x-forwarded-for` from the socket only when the client did not
 *   send one (`req.headers["x-forwarded-for"] ??= socket.remoteAddress`), and
 *   forwards a client-supplied value verbatim; `x-real-ip` is never touched.
 *
 * A synthesized value is therefore indistinguishable from a spoofed one, so the
 * safe design is to strip the whole client-address family. The backend then
 * rate-limits the proxy's own loopback address: one shared bucket for every
 * client (no bucket shopping, no third-party lockout). If a trustworthy client
 * address becomes available from Next's public API, this is the single place to
 * start forwarding it instead.
 */

/** Client-supplied address headers that must never reach the backend. */
export const CLIENT_ADDRESS_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-client-ip",
  "x-original-forwarded-for",
  "x-original-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-cluster-client-ip",
] as const;

/**
 * Marker set on every sanitized request.
 *
 * Two reasons:
 * 1. Fail-open guard: `NextResponse.next({ request: { headers } })` only
 *    applies the override when the header set is non-empty. If the deletions
 *    ever produced an empty set, Next would keep the original headers and the
 *    strip would silently disappear. This constant header makes the override
 *    unconditional.
 * 2. Operator signal: the backend (and the smoke check) can tell that a request
 *    came through the sanitizer. A client-supplied value is overwritten, never
 *    trusted.
 */
export const PROXY_MARKER_HEADER = "x-summarly-proxy";
export const PROXY_MARKER_VALUE = "strip";

/**
 * Returns a copy of `incoming` without any client-address header, always
 * carrying the proxy marker. The input is not mutated, so the caller keeps
 * Next's original request headers intact.
 */
export function sanitizeForwardingHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of CLIENT_ADDRESS_HEADERS) {
    headers.delete(name);
  }
  // `set` (not `append`) overwrites any client-supplied marker.
  headers.set(PROXY_MARKER_HEADER, PROXY_MARKER_VALUE);
  return headers;
}
