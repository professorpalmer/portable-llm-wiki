"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchPublicConfig, authMe } from "@/lib/api";
import { ConnectMarionetteButton } from "@/components/ConnectMarionetteButton";
import { rememberMarionetteClientFromLocation } from "@/lib/marionetteConnect";

/**
 * Existing-owner entry: open from Marionette Settings / Wiki pill when the
 * user already has a portablellm.wiki account. Marks client=marionette and
 * offers one-click Connect.
 */
export default function ConnectMarionettePage() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rememberMarionetteClientFromLocation("?client=marionette");
    try {
      sessionStorage.setItem("pllmwiki.client.marionette", "1");
    } catch {
      /* ignore */
    }
    authMe()
      .then((res) => {
        const tid = res?.user?.tenant_id || res?.tenant?.id;
        if (tid) setTenant(tid);
        else setError("Sign in with GitHub first, then return here.");
      })
      .catch(() => setError("Sign in with GitHub first, then return here."));
    void fetchPublicConfig().catch(() => null);
  }, []);

  return (
    <div className="max-w-lg mx-auto px-5 py-12">
      <div className="text-xs uppercase tracking-wider text-ink-muted font-medium">
        Marionette
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        Connect your wiki
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed text-sm">
        Link this portablellm.wiki tenant to the Marionette app at owner
        tier. New here?{" "}
        <Link
          href="/welcome?client=marionette"
          className="text-accent underline"
        >
          Create a wiki first
        </Link>
        .
      </p>

      {error && (
        <div className="mt-6 p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
          {error}{" "}
          <Link href="/welcome?client=marionette" className="underline">
            Sign up
          </Link>
        </div>
      )}

      {tenant && (
        <div className="mt-8">
          <ConnectMarionetteButton tenant={tenant} auto />
        </div>
      )}
    </div>
  );
}
