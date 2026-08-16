"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { getShareToken, redactTokenizedUrl, SHARE_TOKEN_CHANGE_EVENT } from "@/lib/shareToken";

export function HandshakeCallout({
  tenant,
  isOwnerView,
}: {
  tenant: string;
  /** True when /auth/me resolved a session belonging to this tenant.
   *  When true we add a footnote explaining that this visible URL is
   *  public-tier — and link the owner to /owner where they can mint
   *  a personal URL that includes their private content. Without this
   *  affordance owners would assume copying the URL they see here is
   *  what gives them LLM portability, and they'd be missing their
   *  private notes from every LLM conversation. */
  isOwnerView: boolean;
}) {
  // Vanity URL — Next.js rewrites /<tenant>/llm to /t/<tenant>/llm on
  // the backend (see frontend/next.config.mjs). Short + memorable for
  // the "paste this URL into ChatGPT" pitch.
  //
  // If the visitor arrived via a tier-elevated share link
  // (`?share=<token>`), ShareTokenCatcher has already stashed the
  // token in the share-token store. Copy includes `?t=<token>` so the
  // URL we hand out grants the same tier the visitor is browsing —
  // but the raw token is never painted into the DOM.
  const publicLlmUrl = `https://portablellm.wiki/${tenant}/llm`;
  const [shareToken, setShareTokenState] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setShareTokenState(getShareToken(tenant));
    sync();
    if (typeof window === "undefined") return;
    window.addEventListener("wiki:preview-as-change", sync);
    window.addEventListener(SHARE_TOKEN_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("wiki:preview-as-change", sync);
      window.removeEventListener(SHARE_TOKEN_CHANGE_EVENT, sync);
    };
  }, [tenant]);
  const copyUrl = shareToken
    ? `${publicLlmUrl}?t=${encodeURIComponent(shareToken)}`
    : publicLlmUrl;
  const visibleUrl = shareToken ? redactTokenizedUrl(copyUrl) : publicLlmUrl;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(copyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <section className="border-2 border-ink rounded-2xl bg-white p-5 sm:p-6 shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(14,14,16,0.18)]">
      <div className="text-[11px] uppercase tracking-[0.22em] font-semibold text-accent">
        Paste this URL into any LLM
      </div>
      <div className="mt-1.5 text-lg sm:text-xl font-semibold tracking-tight text-ink">
        One URL. Any model. Full context.
      </div>
      <p className="mt-1.5 text-sm text-ink-muted leading-relaxed">
        Any LLM that can fetch URLs can now read this wiki — try Claude,
        ChatGPT, Cursor, Gemini.
      </p>

      <div className="mt-4 flex items-center gap-2 bg-paper-soft/70 rounded-lg p-2 pr-2.5">
        <code className="flex-1 font-mono text-sm text-ink truncate px-2 py-1.5">
          {visibleUrl}
        </code>
        <button
          onClick={copy}
          className="shrink-0 px-3 py-1.5 rounded-md bg-ink text-paper text-xs font-medium hover:bg-ink-soft inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-3 text-xs flex items-center gap-3 flex-wrap">
        <a
          href={publicLlmUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          preview what an LLM sees →
        </a>
        {isOwnerView && !shareToken && (
          // The URL above is the PUBLIC-tier link — the same artifact a
          // stranger gets when they scan the QR. Pasting it into YOUR
          // ChatGPT gives ChatGPT only your public pages, which silently
          // strips out exactly the private context that would make its
          // answers about you actually useful. The fix lives in /owner
          // (PersonalLlmUrlPanel) — a one-time mint that produces a
          // tokenized URL revealing your full wiki. This footnote is
          // owner-only, and suppressed when a share token is active
          // (because then copy already includes ?t=… elevating to that
          // tier).
          <Link
            href={`/${tenant}/owner#personal-llm-url`}
            className="text-red-700 hover:text-red-900 hover:underline"
            title="Mint a private-tier URL for your own LLMs — they'll see your full wiki including private notes."
          >
            this URL is public-tier · get your personal LLM URL →
          </Link>
        )}
      </div>
    </section>
  );
}
