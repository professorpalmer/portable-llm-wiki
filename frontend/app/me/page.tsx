"use client";

// /me — convenience redirect to the signed-in user's wiki.
//
// Hosted-mode shortcut. After GitHub OAuth, the session cookie tells us
// who the viewer is; we route them to portablellm.wiki/<their-tenant>.
// Useful for nav links and external links that want a stable URL for
// "go to your own wiki" without knowing the tenant id ahead of time.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiBase } from "@/lib/api";

type AuthMeResponse = {
  authenticated: boolean;
  user?: { tenant_id: string; login: string; name: string; avatar_url: string };
};

export default function MeRedirectPage() {
  const router = useRouter();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase()}/auth/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`auth/me ${r.status}`);
        const data = (await r.json()) as AuthMeResponse;
        if (cancelled) return;
        if (data.authenticated && data.user?.tenant_id) {
          router.replace(`/${data.user.tenant_id}`);
        } else {
          router.replace("/signup");
        }
      } catch {
        if (cancelled) return;
        // Network/backend down: fall back to /signup so the user still
        // ends up somewhere actionable rather than a blank screen.
        setErrored(true);
        router.replace("/signup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="flex items-center gap-3 text-ink-muted text-sm">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse"
            style={{ animationDelay: "300ms" }}
          />
        </span>
        <span>{errored ? "Could not check session, redirecting…" : "Redirecting…"}</span>
      </div>
    </div>
  );
}
