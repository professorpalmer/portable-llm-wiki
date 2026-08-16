"use client";

// Public tenant landing — portablellm.wiki/<tenant>.
//
// This is the viral surface: a stranger who clicks a share link lands
// here. The page must do three things in <5 seconds:
//   1. Communicate whose wiki this is (header).
//   2. Offer a paste-this-URL handoff to any LLM (the /llm handshake).
//   3. Let the visitor ask a question and see a real answer with citations.
//
// Page browsing is intentionally light in v1.0 — the manifest renders a
// grouped list, but per-page detail views live at /[tenant]/page/<slug>
// in a later release (links shown but flagged).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  apiBase,
  askWiki,
  fetchManifest,
  type Manifest,
} from "@/lib/api";
import { HandshakeCallout } from "@/components/HandshakeCallout";
import { Markdown } from "@/components/Markdown";
import { PageList } from "@/components/TenantPageList";

// ---------- API shapes ----------------------------------------------------

type TenantMeta = {
  id: string;
  display_name?: string;
  is_demo?: boolean;
  gh_login?: string | null;
  visibility?: string;
  created_at?: string;
};

// We use the canonical Manifest type from lib/api directly (re-declaring
// it here got us a stale shape where `tier` was an optional string
// instead of the strict union — that broke type inference once we
// needed to PATCH the tier inline). PageList + the tier toggle live in
// frontend/components/TenantPageList.tsx so Next.js's page-export
// allowlist doesn't reject them.

type AuthMeResponse = {
  authenticated: boolean;
  user?: { tenant_id: string; login: string; name: string; avatar_url: string };
};

// ---------- Page ----------------------------------------------------------

export default function TenantLandingPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = (params?.tenant ?? "").toString();

  const [tenantMeta, setTenantMeta] = useState<TenantMeta | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [viewerLogin, setViewerLogin] = useState<string | null>(null);
  const [viewerTenant, setViewerTenant] = useState<string | null>(null);

  const [loadingTenant, setLoadingTenant] = useState(true);
  const [tenantError, setTenantError] = useState<"not-found" | "other" | null>(
    null,
  );

  // ---- Initial fetches ----------------------------------------------------

  useEffect(() => {
    if (!tenant) return;
    let cancelled = false;

    (async () => {
      try {
        const r = await fetch(
          `${apiBase()}/tenants/${encodeURIComponent(tenant)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (r.status === 404) {
          setTenantError("not-found");
          return;
        }
        if (!r.ok) {
          setTenantError("other");
          return;
        }
        const data = (await r.json()) as TenantMeta;
        if (!cancelled) setTenantMeta(data);
      } catch {
        if (!cancelled) setTenantError("other");
      } finally {
        if (!cancelled) setLoadingTenant(false);
      }
    })();

    (async () => {
      try {
        // Use fetchManifest (vs a raw fetch) so the request carries the
        // viewer's session cookie + bearer token. Without auth, the
        // backend resolves the viewer as anonymous and returns only
        // public pages — which means the OWNER landing on their own
        // wiki couldn't see their own private pages. The whole point
        // of the inline tier-toggle UX below is that the owner can
        // SEE what's at what tier; auth on this fetch makes that work.
        const data = await fetchManifest(tenant);
        if (!cancelled) setManifest(data);
      } catch {
        // Manifest is non-critical for the viral surface; ignore.
      }
    })();

    (async () => {
      try {
        const r = await fetch(`${apiBase()}/auth/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (cancelled || !r.ok) return;
        const data = (await r.json()) as AuthMeResponse;
        if (cancelled) return;
        if (data.authenticated && data.user) {
          setViewerLogin(data.user.login);
          setViewerTenant(data.user.tenant_id);
        }
      } catch {
        // Anonymous viewer is fine; ignore.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenant]);

  const isOwnerView = useMemo(
    () => !!viewerTenant && viewerTenant === tenant,
    [viewerTenant, tenant],
  );

  // ---- Render --------------------------------------------------------------

  if (loadingTenant) {
    return (
      <div className="max-w-4xl mx-auto px-5 py-16 text-ink-muted text-sm">
        Loading wiki…
      </div>
    );
  }

  if (tenantError === "not-found") {
    return <NotFoundView tenant={tenant} />;
  }

  if (!tenantMeta) {
    return (
      <div className="max-w-4xl mx-auto px-5 py-16">
        <h1 className="text-2xl font-semibold text-ink">
          Wiki temporarily unavailable
        </h1>
        <p className="mt-2 text-ink-muted">
          Try again in a moment. If this keeps happening, the backend may be
          down.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-5 py-10 sm:py-14">
      <TenantHeader
        tenant={tenantMeta}
        viewerLogin={viewerLogin}
        isOwnerView={isOwnerView}
      />

      <HandshakeCallout tenant={tenantMeta.id} isOwnerView={isOwnerView} />

      <AskInline tenant={tenantMeta.id} />

      <PageList
        manifest={manifest}
        tenantId={tenantMeta.id}
        isOwnerView={isOwnerView}
        onManifestChanged={(next) => setManifest(next)}
      />

      <Footer />
    </div>
  );
}

// ---------- Header --------------------------------------------------------

function TenantHeader({
  tenant,
  viewerLogin,
  isOwnerView,
}: {
  tenant: TenantMeta;
  viewerLogin: string | null;
  isOwnerView: boolean;
}) {
  const name = tenant.display_name || tenant.id;
  const ghLogin = tenant.gh_login || null;
  const isDemo = !!tenant.is_demo;

  return (
    <div className="border-b border-paper-soft pb-6 mb-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink-muted font-semibold">
            <span>portablellm.wiki/{tenant.id}</span>
            {isDemo && (
              <span className="text-accent normal-case tracking-normal text-[10px] bg-paper-soft border border-paper-soft rounded px-1.5 py-0.5">
                Public demo · read-only
              </span>
            )}
          </div>
          <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            {name}&apos;s wiki
          </h1>
          {ghLogin && (
            <p className="mt-1 text-sm text-ink-muted">
              <a
                href={`https://github.com/${ghLogin}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-ink"
              >
                @{ghLogin} on GitHub →
              </a>
            </p>
          )}
        </div>
        {isOwnerView && (
          <Link
            href={`/${tenant.id}/owner`}
            className="text-xs px-3 py-1.5 rounded-lg border border-ink/15 hover:border-ink text-ink-muted hover:text-ink"
            title="Owner controls"
          >
            This is your wiki — go to /{tenant.id}/owner →
          </Link>
        )}
        {!isOwnerView && viewerLogin && (
          <Link
            href="/me"
            className="text-xs text-ink-muted hover:text-ink"
            title="Go to your own wiki"
          >
            you&apos;re signed in as @{viewerLogin}
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------- Inline ask form -----------------------------------------------

type ChatMessage =
  | { role: "user"; content: string; id: number }
  | {
      role: "assistant";
      content: string;
      citations: { slug: string; title: string }[];
      id: number;
    }
  | { role: "error"; content: string; id: number };

let _msgId = 0;
const nextMsgId = () => ++_msgId;

function AskInline({ tenant }: { tenant: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const send = useCallback(async () => {
    const q = draft.trim();
    if (!q || pending) return;
    setMessages((m) => [...m, { role: "user", content: q, id: nextMsgId() }]);
    setDraft("");
    setPending(true);
    try {
      const data = await askWiki(q, tenant);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.answer || "(empty answer)",
          citations: data.citations || [],
          id: nextMsgId(),
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setMessages((m) => [
        ...m,
        { role: "error", content: msg, id: nextMsgId() },
      ]);
    } finally {
      setPending(false);
    }
  }, [draft, pending, tenant]);

  return (
    <section className="mt-8 border border-paper-soft rounded-2xl bg-white p-5 sm:p-6">
      <div className="text-[11px] uppercase tracking-[0.22em] text-ink-muted font-semibold">
        Ask this wiki
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        Same retrieval the LLM handshake uses. Cited answers, no hallucinations.
      </p>

      <div className="mt-4 space-y-3 max-h-96 overflow-auto pr-1">
        {messages.length === 0 ? (
          <div className="text-sm text-ink-muted italic">
            Try: <button
              onClick={() => setDraft("Who is this person?")}
              className="text-accent hover:underline"
            >
              Who is this person?
            </button>{" "}
            ·{" "}
            <button
              onClick={() => setDraft("What do they work on?")}
              className="text-accent hover:underline"
            >
              What do they work on?
            </button>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} tenant={tenant} />)
        )}
        <div ref={scrollRef} />
      </div>

      <div className="mt-4 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Ask about decisions, projects, people…"
          className="flex-1 resize-none border border-paper-soft rounded-xl px-3.5 py-2.5 text-sm bg-paper-soft/30 focus:outline-none focus:border-ink/40"
        />
        <button
          onClick={() => void send()}
          disabled={!draft.trim() || pending}
          className="px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? "Asking…" : "Ask"}
        </button>
      </div>
    </section>
  );
}

function Bubble({ m, tenant }: { m: ChatMessage; tenant: string }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-ink text-paper rounded-2xl rounded-tr-md px-3.5 py-2 text-sm">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        {m.content}
      </div>
    );
  }
  // Render the assistant body through the shared <Markdown> component
  // so [[wikilinks]] become real <Link>s to /<tenant>/page/<slug> and
  // regular markdown (lists, bold, headings, inline links) renders
  // correctly. Previously this was a raw whitespace-pre-wrap <div>
  // which made every [[Concept]] mention in the answer look clickable
  // but actually be inert text.
  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] border border-paper-soft bg-paper-soft/40 rounded-2xl rounded-tl-md px-3.5 py-2.5">
        <div className="text-sm text-ink leading-relaxed">
          <Markdown tenant={tenant}>{m.content}</Markdown>
        </div>
        {m.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.citations.map((c) => (
              <Link
                key={c.slug}
                href={`/${tenant}/page/${encodeURIComponent(c.slug)}`}
                className="text-[11px] font-mono border border-paper-soft bg-white rounded-full px-2 py-0.5 text-ink-muted hover:text-ink hover:border-ink/40"
              >
                [[{c.title}]]
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Page list (manifest, grouped by section) ----------------------
//
// The component implementation lives in
// frontend/components/TenantPageList.tsx — it's just imported here.
// See the header comment there for why we split it out (Next.js page
// export contract + testability).


// ---------- Footer + not-found state --------------------------------------

function Footer() {
  return (
    <footer className="mt-16 pt-6 border-t border-paper-soft text-sm text-ink-muted flex flex-wrap items-center justify-between gap-3">
      <span>
        Make your own at{" "}
        <Link href="/" className="text-ink hover:text-accent">
          portablellm.wiki →
        </Link>
      </span>
      <span className="text-xs">
        vendor-neutral by design · markdown in your git
      </span>
    </footer>
  );
}

function NotFoundView({ tenant }: { tenant: string }) {
  return (
    <div className="max-w-2xl mx-auto px-5 py-20 text-center">
      <div className="text-[11px] uppercase tracking-[0.22em] text-ink-muted font-semibold">
        404
      </div>
      <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
        No wiki at /{tenant}.
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed">
        Either the URL is misspelled or this person hasn&apos;t set up their
        portable LLM wiki yet. Want one of your own?
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/signup"
          className="px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft"
        >
          Create your own at portablellm.wiki →
        </Link>
        <Link
          href="/"
          className="px-4 py-2.5 rounded-lg border border-ink/15 text-ink text-sm font-medium hover:border-ink"
        >
          What is this?
        </Link>
      </div>
    </div>
  );
}
