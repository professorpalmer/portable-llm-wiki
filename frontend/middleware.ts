// Edge middleware: redirect bare reserved-page paths to the public demo
// tenant in hosted mode.
//
// Background
// ----------
// In hosted (multi-tenant) mode every wiki/owner page lives under
// /<tenant>/<page>. The bare routes /browse, /graph, /ask, /connect,
// /capture, /owner, /share, /page/<slug> exist for backward compat with
// single-tenant (OSS self-host) installs — but they have no tenant
// context, so any API call they make blows up with "tenantId required".
//
// Rather than letting users land on a broken page (and rather than
// duplicating the redirect logic inside every page component), we
// intercept those paths at the edge and bounce them to the public
// "avery" demo tenant. Signed-in users who happen to type a bare URL
// will land on the demo — they can use the @username chip in the nav
// to jump to their own wiki. The much more common in-app navigation
// path is via the nav links, which already point at /<their-tenant>/...
// so they never hit this middleware.
//
// Single-tenant mode short-circuits at the very top — the OSS self-host
// install still uses bare /browse, /graph, etc. natively.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const HOSTED = process.env.NEXT_PUBLIC_HOSTED_MODE === "1";

// First path segments that mean "this is a wiki page, not a tenant id"
// — must match the bare app-router page directories.
const RESERVED_PAGE_SLUGS = new Set([
  "browse",
  "graph",
  "ask",
  "connect",
  "capture",
  "owner",
  "share",
  "page",
]);

// Where to send anonymous viewers (or anyone hitting a bare reserved
// path with no other context). The public Avery demo is always there
// and read-only so it's a safe fallback.
const DEMO_TENANT = "avery";

export function middleware(req: NextRequest) {
  if (!HOSTED) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/" || pathname.startsWith("/_next/")) {
    return NextResponse.next();
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return NextResponse.next();

  const first = segments[0];
  if (!RESERVED_PAGE_SLUGS.has(first)) return NextResponse.next();

  // Bare reserved route → prefix with the demo tenant.
  const url = req.nextUrl.clone();
  url.pathname = `/${DEMO_TENANT}${pathname}`;
  // 307 preserves the request method (matters if someone POSTs to
  // /owner/ingest by hand, though no real client does).
  return NextResponse.redirect(url, 307);
}

export const config = {
  // Match everything except Next.js internals, the API proxy, static
  // assets, and the .well-known handshake routes (handled by rewrites).
  matcher: [
    "/((?!api/|_next/|favicon\\.|robots\\.txt|sitemap\\.|og$|og/|\\.well-known/).*)",
  ],
};
