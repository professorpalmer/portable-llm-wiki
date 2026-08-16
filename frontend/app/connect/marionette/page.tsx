"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiBase, authMe } from "@/lib/api";
import { loginReturnTo } from "@/lib/safeReturnTo";
import {
  buildOwnerConnectPath,
  rememberMarionetteClientFromLocation,
} from "@/lib/marionetteConnect";

/**
 * Marionette entry: remember loopback return+nonce, then either sign in or
 * jump straight to Owner console scrolled to Connect to Marionette.
 */
export default function ConnectMarionettePage() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "signin" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [signInHref, setSignInHref] = useState("");

  useEffect(() => {
    rememberMarionetteClientFromLocation();
    try {
      sessionStorage.setItem("pllmwiki.client.marionette", "1");
    } catch {
      /* ignore */
    }

    setSignInHref(
      `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
        loginReturnTo("/connect/marionette"),
      )}`,
    );

    let cancelled = false;
    authMe()
      .then((res) => {
        if (cancelled) return;
        const tid = res?.user?.tenant_id || res?.tenant?.id;
        if (tid) {
          router.replace(buildOwnerConnectPath(String(tid)));
          return;
        }
        setStatus("signin");
        setError("Sign in with GitHub to link your wiki to Marionette.");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("signin");
        setError("Sign in with GitHub to link your wiki to Marionette.");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="max-w-lg mx-auto px-5 py-12">
      <div className="text-xs uppercase tracking-wider text-ink-muted font-medium">
        Marionette
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        Connect your wiki
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed text-sm">
        Sign in, then we open your Owner console on the{" "}
        <span className="text-ink font-medium">Connect to Marionette</span>{" "}
        button — one click to link at private tier.
      </p>

      {status === "loading" && (
        <p className="mt-8 text-sm text-ink-muted">Checking your session…</p>
      )}

      {status === "signin" && (
        <div className="mt-8 space-y-4">
          {error && (
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
              {error}
            </div>
          )}
          <a
            href={signInHref}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-accent text-paper text-sm font-medium hover:opacity-90"
          >
            Sign in with GitHub
          </a>
          <p className="text-xs text-ink-muted">
            New here?{" "}
            <Link
              href={(() => {
                try {
                  const u = new URL("/welcome", "https://portablellm.wiki");
                  u.searchParams.set("client", "marionette");
                  // client=marionette is the only query we forward. share/t/return/nonce
                  // stay out of login and onboarding URLs.
                  return `${u.pathname}?${u.searchParams.toString()}`;
                } catch {
                  return "/welcome?client=marionette";
                }
              })()}
              className="text-accent underline"
            >
              Create a wiki first
            </Link>
            , then you&apos;ll land on Connect automatically.
          </p>
        </div>
      )}
    </div>
  );
}
