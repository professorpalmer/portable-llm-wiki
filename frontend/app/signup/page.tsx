"use client";

// Thin sign-up page that hands off to GitHub OAuth.
//
// We do the redirect from a useEffect on the client (rather than a Next
// `redirect()` on the server) so that:
//
//   1. The page renders a visible fallback message during the brief
//      flash before the redirect fires (better than a blank page).
//   2. The redirect target is a cross-origin-ish backend endpoint that
//      issues its own 302 to github.com; doing it from the client side
//      keeps any auth cookies set by the proxy on the right origin.
//
// `window.location.replace` (not `assign`) so /signup doesn't end up in
// the browser back-button history — the user would just bounce back
// here and re-redirect.

import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api";

export default function SignupPage() {
  // ``apiBase()`` reads a public env var (set in next.config.mjs) — that's
  // a client-side concern, so derive the href in an effect to avoid SSR /
  // CSR mismatch warnings.
  const [signinHref, setSigninHref] = useState("/api/backend/auth/github/login?return_to=/welcome");

  useEffect(() => {
    const href = `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
      typeof window !== "undefined" ? `${window.location.origin}/welcome` : "/welcome",
    )}`;
    setSigninHref(href);
    window.location.replace(href);
  }, []);

  const SIGNIN_HREF = signinHref;

  return (
    <div className="max-w-md mx-auto px-5 py-20 text-center">
      <div className="text-[11px] uppercase tracking-[0.22em] text-accent font-semibold">
        Portable LLM Wiki
      </div>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink">
        Redirecting to GitHub…
      </h1>
      <p className="mt-3 text-sm text-ink-muted leading-relaxed">
        You&apos;ll be back here once GitHub confirms your identity. If your
        browser doesn&apos;t redirect automatically,{" "}
        <a href={SIGNIN_HREF} className="text-accent underline">
          continue to GitHub
        </a>
        .
      </p>
    </div>
  );
}
