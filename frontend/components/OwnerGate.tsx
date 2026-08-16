// Owner-only access guard for hosted-mode pages.
//
// Used to wrap /[tenant]/owner, /[tenant]/capture, /[tenant]/share —
// pages that must NOT be viewable by anyone other than the tenant owner.
//
// Behavior:
//   * Single-tenant (OSS) mode  → render children unconditionally. The
//     OSS install uses the owner-bearer-token model and is its own auth.
//   * Hosted mode + not signed in → "Sign in to see this" with a CTA.
//   * Hosted mode + signed in as a DIFFERENT tenant → "This is @other's
//     wiki — go to YOUR owner page" with a CTA.
//   * Hosted mode + signed in as the matching tenant → render children.
//
// We deliberately render explanatory UI rather than silently redirecting,
// for the same reason /welcome doesn't silently redirect: it makes
// real bugs (cookie loss, ownership mixups) immediately visible instead
// of trapping the user in an invisible loop.

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiBase, authMe, isHostedMode, type AuthMeResponse } from "@/lib/api";
import { loginReturnTo } from "@/lib/safeReturnTo";

type GateState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "anonymous" }
  | { kind: "wrong-tenant"; viewerTenant: string; viewerLogin: string }
  | {
      // The viewer is signed in and the session says they own this tenant,
      // but the backend has no record of it. This happens on Render free
      // tier after the container restarts (ephemeral disk wipes the
      // tenants directory) before the user has re-signed-in. Re-signing
      // in is the fix — the OAuth callback re-provisions the tenant and
      // auto-pulls from the connected GitHub repo if there is one.
      kind: "tenant-missing";
      tenantId: string;
    }
  | { kind: "error"; message: string };

export function OwnerGate({
  tenant,
  children,
}: {
  /** URL tenant id for this page. Required in hosted mode. */
  tenant: string | undefined;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<GateState>(
    isHostedMode() ? { kind: "loading" } : { kind: "ok" },
  );

  useEffect(() => {
    if (!isHostedMode()) return;
    let cancelled = false;
    (async () => {
      try {
        const me: AuthMeResponse = await authMe();
        if (cancelled) return;
        if (!me.authenticated || !me.user) {
          setState({ kind: "anonymous" });
          return;
        }
        if (me.user.tenant_id !== tenant) {
          setState({
            kind: "wrong-tenant",
            viewerTenant: me.user.tenant_id,
            viewerLogin: me.user.login,
          });
          return;
        }
        // The session says we own this tenant, but the backend has no
        // record of it. Most common cause: Render container restart
        // wiped ephemeral disk before the user re-authed. We can't
        // recover silently — the gh_token died with the tenant — so
        // we surface the state with a re-sign-in CTA.
        if (me.tenant === null) {
          setState({ kind: "tenant-missing", tenantId: me.user.tenant_id });
          return;
        }
        setState({ kind: "ok" });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  if (state.kind === "ok") return <>{children}</>;
  if (state.kind === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-5 py-20 text-ink-muted text-sm">
        Checking your session…
      </div>
    );
  }
  if (state.kind === "anonymous") {
    const signInUrl = `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
      loginReturnTo(),
    )}`;
    return (
      <PanelMessage
        eyebrow="owner only"
        title="Sign in to see this."
        body="This page lets the wiki owner manage their content. Sign in with GitHub to continue."
        primary={{ label: "Sign in with GitHub", href: signInUrl }}
        secondary={{ label: "Back to home", href: "/" }}
      />
    );
  }
  if (state.kind === "wrong-tenant") {
    return (
      <PanelMessage
        eyebrow="not your wiki"
        title={`This is @${tenant ?? ""}'s owner page.`}
        body={`You're signed in as @${state.viewerLogin}. You can only manage your own wiki.`}
        primary={{ label: "Go to my owner page", href: `/${state.viewerTenant}/owner` }}
        secondary={{
          label: `View @${tenant ?? ""}'s public wiki`,
          href: `/${tenant ?? ""}`,
        }}
      />
    );
  }
  if (state.kind === "tenant-missing") {
    const signInUrl = `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
      loginReturnTo(),
    )}`;
    return (
      <PanelMessage
        eyebrow="wiki not on server"
        title="Your wiki data isn't on our server right now."
        body={
          `Your @${state.tenantId} session is valid, but the backend has no ` +
          `record of your wiki. This is almost always because our free-tier ` +
          `container restarted and wiped the local cache before you re-signed-in. ` +
          `Re-sign-in and we'll restore everything from your connected GitHub repo automatically.`
        }
        primary={{ label: "Re-sign in with GitHub", href: signInUrl }}
        secondary={{ label: "Back to home", href: "/" }}
      />
    );
  }
  return (
    <PanelMessage
      eyebrow="auth check failed"
      title="We couldn't verify your sign-in."
      body={state.message}
      primary={{ label: "Try again", href: typeof window !== "undefined" ? window.location.href : "/" }}
      secondary={{ label: "Back to home", href: "/" }}
    />
  );
}

function PanelMessage({
  eyebrow,
  title,
  body,
  primary,
  secondary,
}: {
  eyebrow: string;
  title: string;
  body: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  return (
    <div className="max-w-2xl mx-auto px-5 py-16 sm:py-20">
      <p className="text-xs uppercase tracking-[0.2em] text-accent font-medium">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-ink">{title}</h1>
      <p className="mt-4 text-ink-muted leading-relaxed">{body}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href={primary.href}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
        >
          {primary.label}
        </Link>
        {secondary && (
          <Link
            href={secondary.href}
            className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:border-ink-muted"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}
