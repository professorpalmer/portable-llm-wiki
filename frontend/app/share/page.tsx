"use client";

// The /share page is the killer-app surface. The visitor here is the
// wiki owner — they want a URL to hand to someone (recruiter, friend,
// LLM) such that the recipient's model "just knows" how to talk about
// the owner.
//
// The pitch (top of page): one URL. Paste it into ChatGPT / Claude /
// Cursor / Gemini. The LLM fetches a self-describing markdown briefing
// from /llm and uses that to query the wiki for the rest of the
// conversation. No plugin, no MCP setup, no token exchange.
//
// Below the fold: a fold-out preview of what the LLM actually sees
// (builds trust — the owner can audit before sharing), plus the
// legacy prompt templates and MCP install path for power users.

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { fetchPublicConfig } from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import { OwnerGate } from "@/components/OwnerGate";
import { buildOfflineBriefing, isBriefingComplete } from "@/lib/briefing";
import {
  buildHumanShareUrl,
  buildLlmUrlForTier,
  buildQrPayload,
  PROMPT_TEMPLATES,
  toSameOriginPath,
  TIER_BADGE_CLASSES,
  TIER_DESCRIPTION,
  TIER_LABEL,
  type PromptVariant,
  type ShareTier,
} from "@/lib/llmPrompts";
import { useTierToken } from "@/lib/useTierToken";

export default function SharePage() {
  const tenant = useTenant();
  return (
    <OwnerGate tenant={tenant}>
      <SharePageInner tenant={tenant} />
    </OwnerGate>
  );
}

function SharePageInner({ tenant }: { tenant?: string }) {
  const [base, setBase] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [previewMd, setPreviewMd] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Currently-selected sharing tier. The toggle swaps this between
  // Public / Recruiter / Friend; each tier produces a different URL,
  // QR, and downstream prompt buttons, all derived from the same
  // build helpers in lib/llmPrompts.ts.
  //
  // We default to "public" because that's the most common share
  // pattern (resume, social, generic LinkedIn). Owners who want
  // recruiter / friend QRs click the toggle and the system auto-mints
  // a token on first use (cached in localStorage thereafter).
  const [tier, setTier] = useState<ShareTier>("public");
  const tierToken = useTierToken({ tenant, tier });

  useEffect(() => {
    fetchPublicConfig()
      .then((c) => setBase(c.public_base_url || window.location.origin))
      .catch(() => setBase(window.location.origin));
  }, []);

  // We hand out TWO distinct URLs from this page — they look similar
  // but serve different audiences:
  //
  //   llmUrl   → /<tenant>/llm[?t=<token>]
  //              The URL a HUMAN pastes into ChatGPT / Claude / Cursor.
  //              Returns the self-describing markdown handshake; the
  //              copy buttons + prompt-template row below all hand out
  //              this URL.
  //
  //   humanUrl → /<tenant>[?share=<token>]
  //              The URL we encode in the QR. When scanned by a phone
  //              camera, it opens the tenant landing page in a browser
  //              — the landing page renders the wiki AND surfaces a
  //              prominent "Paste this URL into any LLM" widget with a
  //              one-click copy of llmUrl. So the QR-scan flow gives a
  //              human the wiki UI, and the paste-into-LLM flow still
  //              works via the on-page widget.
  //
  // Encoding llmUrl directly in the QR (an earlier iteration) opened
  // raw markdown when scanned, which surprised most users — the QR's
  // dominant use case is "phone camera scans → tap Open → look at it",
  // not "vision-AI decodes QR → follow the URL".
  //
  // While the share token is still being minted/loaded for non-public
  // tiers, both URLs fall back to the public form so the page never
  // shows a broken QR; the toggle UI shows a "minting…" indicator.
  const tokenReady = tier === "public" || tierToken.state.kind === "ready";
  const liveToken =
    tierToken.state.kind === "ready" ? tierToken.state.token : null;
  const llmUrl =
    base && tokenReady
      ? buildLlmUrlForTier({ origin: base, tenant, tier, token: liveToken })
      : "";
  const humanUrl =
    base && tokenReady
      ? buildHumanShareUrl({ origin: base, tenant, tier, token: liveToken })
      : "";

  useEffect(() => {
    if (!humanUrl) return;
    // Encode the URL ONLY (no wrapper prompt). Phone cameras only
    // offer a one-tap "Open in browser" action when the entire
    // decoded payload is a URL — any prefix like "GET …" demotes the
    // payload to plain text and the user has to tap a chip to open
    // it. See lib/llmPrompts.ts:buildQrPayload for the full rationale.
    //
    // We encode humanUrl (the landing page) instead of llmUrl (the
    // raw markdown handshake) so phone scans land on the rendered
    // wiki — not a wall of markdown text. See the humanUrl/llmUrl
    // comment above for why this asymmetry exists.
    QRCode.toDataURL(buildQrPayload(humanUrl), {
      width: 320,
      margin: 1,
      color: { dark: "#0e0e10", light: "#fafaf7" },
      errorCorrectionLevel: "M",
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, [humanUrl]);

  // Reset preview when tier changes — the cached markdown was for the
  // previous tier and would be misleading.
  useEffect(() => {
    setPreviewMd(null);
    setPreviewOpen(false);
  }, [tier]);

  function copy(text: string, tag: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    }
  }

  async function loadPreview() {
    if (previewMd) {
      setPreviewOpen((v) => !v);
      return;
    }
    setPreviewOpen(true);
    // CRITICAL: fetch the SAME-ORIGIN path, not the absolute canonical
    // URL we display + copy + encode in the QR. The displayed llmUrl is
    // built off public_base_url (e.g. https://portablellm.wiki/...)
    // because the QR/copy buttons must hand out the canonical link.
    // But when the user is browsing on https://www.portablellm.wiki/
    // the displayed URL is cross-origin — fetching it triggers a CORS
    // preflight against the apex, which fails if www isn't in the
    // backend's CORS allowlist. The same fetch as a SAME-ORIGIN
    // request (Next.js rewrites /<tenant>/llm → /t/<tenant>/llm on the
    // backend) sidesteps CORS entirely and works regardless of host
    // config. See lib/llmPrompts.ts:toSameOriginPath for the rationale.
    const fetchUrl = toSameOriginPath(llmUrl);
    try {
      const r = await fetch(fetchUrl);
      const text = await r.text();
      if (!r.ok) {
        // Surface the actual HTTP status + body. Most common case:
        // 404 with `{"detail":"tenant '<x>' not found"}` when the
        // user's wiki has been wiped from a Render restart and not
        // yet re-hydrated from GitHub. Without this branch the user
        // sees "loading…" forever or a vague catch message and has
        // no idea what's wrong.
        let detail = text;
        try {
          const j = JSON.parse(text);
          if (j && typeof j.detail === "string") detail = j.detail;
        } catch {
          // not JSON; keep raw text
        }
        setPreviewMd(
          `HTTP ${r.status}: ${detail}\n\n` +
            `(Open the URL directly in a new tab to see the same response.)`,
        );
        return;
      }
      setPreviewMd(text);
    } catch (e) {
      // True network failure (server unreachable, DNS, offline). Now
      // that we fetch same-origin, this should be VERY rare — if the
      // /share page rendered, the same origin is reachable. Surface
      // the error message + the canonical URL the user can open in a
      // new tab to verify the live response.
      const msg = e instanceof Error ? e.message : String(e);
      setPreviewMd(
        `Network error fetching the preview: ${msg}\n\n` +
          `Try opening ${llmUrl} directly in a new tab.`,
      );
    }
  }

  const isPublic = base && !base.includes("localhost") && !base.includes("127.0.0.1");

  return (
    <div className="max-w-2xl mx-auto px-5 py-10">
      {/* ============================================================== */}
      {/* HERO — the one-URL pitch                                       */}
      {/* ============================================================== */}
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          One URL. Any LLM.
        </h1>
        <p className="mt-2 text-sm sm:text-base text-ink-muted leading-relaxed max-w-md mx-auto">
          Hand this QR code (or copy the URL) to anyone. They paste it into
          ChatGPT, Claude, Cursor, or Gemini, and the LLM instantly knows
          how to talk about you.
        </p>
      </div>

      {/* Local-URL warning (cloud LLMs can't reach localhost). */}
      {base && !isPublic && (
        <div className="mt-6 p-3 rounded border border-amber-200 bg-amber-50 text-amber-800 text-xs">
          <span className="font-semibold">Local URL only.</span> Cloud LLMs
          (ChatGPT, Claude, Gemini) can&apos;t reach <code>{base}</code>. To
          test the full flow, start a public tunnel:{" "}
          <code className="font-mono">cloudflared tunnel --url http://localhost:3000</code>{" "}
          and set <code>PUBLIC_BASE_URL</code> in <code>backend/.env</code>{" "}
          to the printed <code>*.trycloudflare.com</code> URL.
        </div>
      )}

      {/* ============================================================== */}
      {/* TIER TOGGLE — pick which audience this QR is for                */}
      {/* ============================================================== */}
      {/* Three buttons swap between Public, Recruiter, and Friend tiers. */}
      {/* The selected tier drives the URL/QR/prompts below: public uses */}
      {/* the bare /llm endpoint, non-public uses /llm?t=<token> with a   */}
      {/* mint-on-demand token cached per-tier in localStorage (see       */}
      {/* useTierToken). Owners can still mint, audit, and revoke         */}
      {/* individual tokens from /<tenant>/owner — this toggle is for     */}
      {/* the fast "I just want a recruiter QR for my résumé" flow.       */}
      <TierToggle tier={tier} onChange={setTier} state={tierToken.state} />

      {/* ============================================================== */}
      {/* THE QR + URL — the primary artifact                             */}
      {/* ============================================================== */}
      <section className="mt-6 bg-white border border-paper-soft rounded-2xl p-6 sm:p-8 flex flex-col items-center shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(14,14,16,0.18)]">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="QR code (scan or copy URL)"
            className="w-72 h-72 rounded"
          />
        ) : (
          <div className="w-72 h-72 bg-paper-soft animate-pulse rounded" />
        )}

        <div className="mt-5 text-center w-full">
          <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
            Paste this into any LLM
          </div>
          <code className="mt-1.5 inline-block font-mono text-sm sm:text-base text-ink break-all px-3 py-1.5 bg-paper-soft/70 rounded">
            {llmUrl || "loading…"}
          </code>
        </div>

        {isPublic && (
          <div className="mt-3 flex justify-center w-full">
            <span className="text-[10px] uppercase tracking-wider font-semibold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">
              ✓ reachable from cloud LLMs
            </span>
          </div>
        )}

        {/* ============================================================ */}
        {/* PROMPT BUILDER — three force-fetch variants for stubborn LLMs */}
        {/* ============================================================ */}
        {/* Even with a clean URL, many LLMs (ChatGPT, Claude) will web-  */}
        {/* search the domain instead of actually GETting it. These       */}
        {/* templates wrap the URL in imperative "fetch this URL and     */}
        {/* follow its API instructions" prompts that reliably trigger   */}
        {/* the browse/web tool. We offer three escalating aggressiveness*/}
        {/* levels so the owner picks based on how lazy their target LLM */}
        {/* has been. See lib/llmPrompts.ts for the canonical wordings.  */}
        <div className="mt-6 w-full">
          <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2 text-center">
            Copy a ready-made LLM prompt
          </div>
          <PromptButtonRow llmUrl={llmUrl} />
        </div>

        {/* ============================================================ */}
        {/* OFFLINE BRIEFING — the bulletproof, no-fetch-required path    */}
        {/* ============================================================ */}
        {/* The three prompts above still depend on the recipient's LLM  */}
        {/* actually fetching the URL. ChatGPT in "search" mode (and     */}
        {/* some Gemini/Perplexity configs) DON'T fetch — they web-search */}
        {/* the URL string, find nothing (a just-deployed wiki isn't      */}
        {/* indexed), and give up or hallucinate. This button sidesteps   */}
        {/* that class of failure entirely: it assembles the handshake +  */}
        {/* page manifest + the actual top-page CONTENT into one ~15KB    */}
        {/* clipboard blob, so even a zero-fetch model answers from real  */}
        {/* wiki content already in its context. This is the artifact to  */}
        {/* hand someone when you don't control which mode their LLM is   */}
        {/* in. Built client-side from the same APIs an LLM would call,   */}
        {/* tier-scoped by the live token, so it's a true mirror of what  */}
        {/* the recipient is allowed to see. */}
        <OfflineBriefingButton
          llmUrl={llmUrl}
          token={liveToken ?? ""}
          tenant={tenant}
          ready={Boolean(llmUrl) && tokenReady}
        />

        <button
          onClick={loadPreview}
          className="mt-5 text-xs text-ink-muted hover:text-ink underline"
        >
          {previewOpen ? "hide" : "preview"} what an LLM sees when they fetch this URL
        </button>
      </section>

      {/* ============================================================== */}
      {/* PREVIEW — collapsible, builds trust before sharing             */}
      {/* ============================================================== */}
      {previewOpen && (
        <section className="mt-4 border border-paper-soft rounded-xl bg-paper-soft/40 overflow-hidden">
          <div className="px-4 py-2 border-b border-paper-soft bg-white flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
              The briefing your LLM reads
            </span>
            <code className="text-[11px] text-ink-muted font-mono">
              GET /llm
            </code>
          </div>
          <pre className="text-[11px] font-mono leading-snug p-4 overflow-x-auto whitespace-pre-wrap text-ink max-h-96">
            {previewMd ?? "loading…"}
          </pre>
        </section>
      )}

      {/* ============================================================== */}
      {/* HOW IT WORKS — 3 steps, no fluff                               */}
      {/* ============================================================== */}
      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-[0.18em] text-ink-muted font-semibold mb-3">
          How it works
        </h2>
        <ol className="space-y-3 text-sm text-ink-muted leading-relaxed">
          <li className="flex gap-3">
            <span className="font-mono text-ink-muted text-xs mt-0.5 w-5">1.</span>
            <span>
              You hand someone the QR or the URL above.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-ink-muted text-xs mt-0.5 w-5">2.</span>
            <span>
              They paste it into any LLM chat (ChatGPT, Claude, Cursor,
              Gemini, Perplexity, anything that can fetch URLs).
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-ink-muted text-xs mt-0.5 w-5">3.</span>
            <span>
              The model reads the briefing, learns the API, and answers
              their questions about you using your wiki, with citations
              back to specific pages. No plugin install, no auth dance.
            </span>
          </li>
        </ol>
        <p className="mt-4 text-xs text-ink-muted">
          The URL grants <strong>public-tier</strong> read access. To share
          higher tiers (<code>recruiter</code>, <code>friend</code>), mint a
          share token in{" "}
          <a
            className="text-accent hover:underline"
            href={`${tenant ? `/${tenant}` : ""}/owner`}
          >
            /owner
          </a>{" "}
          and append <code>?t=&lt;token&gt;</code> to the URL.
        </p>
      </section>

      {/* ============================================================== */}
      {/* ADVANCED — old prompt templates + MCP, behind a toggle         */}
      {/* ============================================================== */}
      <section className="mt-10 border-t border-paper-soft pt-6">
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="text-xs uppercase tracking-[0.18em] text-ink-muted font-semibold hover:text-ink inline-flex items-center gap-2"
        >
          <span>Advanced sharing options</span>
          <span aria-hidden>{advancedOpen ? "−" : "+"}</span>
        </button>

        {advancedOpen && (
          <div className="mt-6 space-y-10">
            <ManualPrompts base={base} tenant={tenant} onCopy={(t) => copy(t, "prompt")} copied={copied === "prompt"} />
            <MCPInstall base={base} tenant={tenant} onCopy={(t) => copy(t, "mcp")} copied={copied === "mcp"} />
          </div>
        )}
      </section>
    </div>
  );
}

// ====================================================================
// TierToggle — Public / Recruiter / Friend selector
// ====================================================================
//
// Three pill buttons stacked into one container. The selected tier is
// filled with its tier color (matching ShareTokensPanel's palette so
// the same color means the same tier across the product); the others
// render as outlines. Below the row we surface the tier's description
// and a tiny status line for non-public tiers ("minting token…",
// "ready: <label>", or an error).
//
// We pass the full TierTokenState in so the toggle can render the
// minting / error states inline — keeps the surrounding QR section
// clean and consolidates all the per-tier ancillary info in one place.

function TierToggle({
  tier,
  onChange,
  state,
}: {
  tier: ShareTier;
  onChange: (tier: ShareTier) => void;
  state: ReturnType<typeof useTierToken>["state"];
}) {
  const tiers: ShareTier[] = ["public", "recruiter", "friend"];
  return (
    <section className="mt-8">
      <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
        Who is this QR for?
      </div>
      <div className="flex flex-wrap gap-2">
        {tiers.map((t) => {
          const selected = t === tier;
          const colorClasses = selected
            ? TIER_BADGE_CLASSES[t]
            : "border-paper-soft bg-white text-ink-muted hover:text-ink hover:border-ink/30";
          return (
            <button
              key={t}
              onClick={() => onChange(t)}
              className={`px-4 py-2 rounded-full border text-sm font-medium transition-colors ${colorClasses}`}
            >
              {TIER_LABEL[t]}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-muted leading-relaxed">
        {TIER_DESCRIPTION[tier]}
      </p>
      {tier !== "public" && (
        <div className="mt-2 text-[11px] font-mono text-ink-muted">
          {state.kind === "loading" && <span>minting tier token…</span>}
          {state.kind === "ready" && state.tokenId && (
            <span>
              ✓ using token <span className="text-ink">{state.tokenId}</span>
              {" — "}
              <span title={state.label}>“{state.label}”</span>
            </span>
          )}
          {state.kind === "error" && (
            <span className="text-red-700">error: {state.message}</span>
          )}
          {state.kind === "no-token-yet" && (
            <span>no token cached yet — toggle to mint one</span>
          )}
        </div>
      )}
    </section>
  );
}


// ====================================================================
// PromptButtonRow — three force-fetch variants surfaced under the QR
// ====================================================================
//
// The bare URL works in modern LLMs that aggressively use their browse
// tool (Cursor, Claude Code, Cline), but ChatGPT and Claude.ai often
// just web-search the domain instead of fetching the actual URL. The
// "Who am I?" and "Full briefing" templates wrap the URL in an
// imperative prompt that reliably forces a real fetch.
//
// Each variant has its own copy-feedback state so the user can see
// which one they just grabbed without the others showing "Copied".

function PromptButtonRow({ llmUrl }: { llmUrl: string }) {
  const [copiedId, setCopiedId] = useState<PromptVariant | null>(null);

  const handleCopy = (variant: PromptVariant, build: (u: string) => string) => {
    if (!llmUrl) return;
    const payload = build(llmUrl);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(payload);
      setCopiedId(variant);
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {PROMPT_TEMPLATES.map((t) => {
        const isCopied = copiedId === t.id;
        // The bare-URL variant is the primary action (most common
        // ask); the other two are escalations for stubborn LLMs. We
        // mark the primary with ink/paper, the others with a softer
        // outline so the user's eye lands on "just the URL" first.
        const isPrimary = t.id === "url-only";
        const buttonClass = isPrimary
          ? "px-3 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft inline-flex items-center justify-center gap-1.5"
          : "px-3 py-2.5 rounded-lg border border-ink/15 bg-paper text-ink text-sm font-medium hover:border-ink/40 inline-flex items-center justify-center gap-1.5";
        return (
          <div key={t.id} className="flex flex-col items-stretch">
            <button
              onClick={() => handleCopy(t.id, t.build)}
              disabled={!llmUrl}
              className={`${buttonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              title={t.description}
            >
              {isCopied ? (
                <>
                  <span>Copied</span>
                  <span aria-hidden>✓</span>
                </>
              ) : (
                <>
                  <span>{t.label}</span>
                  <span aria-hidden className="text-ink-muted">↗</span>
                </>
              )}
            </button>
            <p className="mt-1.5 text-[10px] leading-snug text-ink-muted text-center">
              {t.description}
            </p>
          </div>
        );
      })}
    </div>
  );
}


// ====================================================================
// OfflineBriefingButton — the no-fetch-required share artifact
// ====================================================================
//
// Surfaced on the PUBLIC /share page (previously this capability lived
// only in the owner-private PersonalLlmUrlPanel). Builds a single
// paste-ready blob — handshake + manifest + the actual content of the
// top pages — so a recipient whose LLM CANNOT fetch (ChatGPT search
// mode, etc.) still gets real wiki content in-context instead of a
// fabricated answer.
//
// Tier-correct: passes the live tier token through to buildOfflineBriefing
// so the blob contains exactly the pages the recipient is allowed to see
// (public-only when no token; recruiter/friend pages when a token is
// active). For the public tier the token is "" and the blob inlines the
// public pages — still fully functional, just public-scoped.
//
// Resilient: buildOfflineBriefing never throws on a partial fetch (it
// tags missing sections), and isBriefingComplete tells us whether to
// show the success or the "partial" warning state.

type BriefingState = "idle" | "building" | "copied" | "partial" | "error";

export function OfflineBriefingButton({
  llmUrl,
  token,
  tenant,
  ready,
}: {
  llmUrl: string;
  token: string;
  tenant?: string;
  ready: boolean;
}) {
  const [state, setState] = useState<BriefingState>("idle");

  async function copyBriefing() {
    if (!ready || state === "building") return;
    setState("building");
    try {
      const blob = await buildOfflineBriefing({ llmUrl, token, tenant });
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(blob);
      }
      setState(isBriefingComplete(blob) ? "copied" : "partial");
      setTimeout(() => setState("idle"), 2400);
    } catch {
      // True failure (network down, clipboard blocked). The three
      // URL-based prompts above remain available as the fallback.
      setState("error");
      setTimeout(() => setState("idle"), 2400);
    }
  }

  const label =
    state === "building"
      ? "building briefing…"
      : state === "copied"
        ? "briefing copied ✓"
        : state === "partial"
          ? "partial briefing copied ⚠ (some pages unreachable)"
          : state === "error"
            ? "briefing failed — try a prompt above instead"
            : "Copy full briefing — works in ANY LLM, no fetch needed";

  return (
    <div className="mt-3 w-full">
      <button
        onClick={copyBriefing}
        disabled={!ready || state === "building"}
        title="Assembles the handshake + your top pages into one paste. Use this for ChatGPT search mode or any tool that won't fetch a URL."
        aria-label="Copy full offline briefing — works in any LLM without fetching"
        className="w-full px-3 py-2.5 rounded-lg border border-accent/40 bg-accent/5 text-accent text-sm font-medium hover:border-accent/70 hover:bg-accent/10 inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <span aria-hidden>📋</span>
        <span>{label}</span>
      </button>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-muted text-center">
        Most bulletproof option. ~15KB paste with real page content baked
        in — answers correctly even when the recipient&apos;s LLM can&apos;t
        open links (ChatGPT search mode, some Gemini/Perplexity setups).
      </p>
    </div>
  );
}


// ====================================================================
// Manual prompt templates — for LLMs that can't fetch URLs (rare now)
// ====================================================================

function ManualPrompts({
  base,
  tenant,
  onCopy,
  copied,
}: {
  base: string;
  tenant?: string;
  onCopy: (t: string) => void;
  copied: boolean;
}) {
  const templates = useMemo(() => {
    // Recipients paste these prompts into ChatGPT / Claude / etc. so the
    // URLs must be the public, recipient-facing URLs (not the /api/backend
    // proxy that the frontend uses internally). In hosted mode each wiki
    // lives under its tenant prefix.
    const tenantPath = tenant ? `/${tenant}` : "";
    const wikiRoot = `${base}${tenantPath}`;
    return [
      {
        id: "introduce",
        label: "Brief intro",
        prompt:
          `Fetch ${wikiRoot}/.well-known/llm-wiki.json to learn the API, then ` +
          `${wikiRoot}/wiki/manifest.json for the list of public pages. Read ` +
          `2-3 of them and give me a 1-paragraph intro to the person who owns ` +
          `this wiki. Cite the pages you used.`,
      },
      {
        id: "interview-prep",
        label: "Interview prep",
        prompt:
          `Load ${wikiRoot}/wiki/manifest.json. Then read the public pages it ` +
          `lists. I'm interviewing this person. Give me 5 thoughtful questions ` +
          `to ask them, grounded in what their wiki actually says. Cite pages.`,
      },
      {
        id: "match",
        label: "Job match check",
        prompt:
          `Pull ${wikiRoot}/wiki/manifest.json. Based on the public pages, ` +
          `would this person be a good fit for [paste role description here]? ` +
          `Cite the wiki pages you used.`,
      },
    ];
  }, [base, tenant]);
  const [chosenId, setChosenId] = useState("introduce");
  const chosen = templates.find((t) => t.id === chosenId) ?? templates[0];

  return (
    <div>
      <h3 className="text-sm uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
        Manual prompt templates
      </h3>
      <p className="text-xs text-ink-muted leading-relaxed mb-3">
        For LLMs that can&apos;t fetch URLs autonomously (rare now), paste one
        of these instead. They spell out exactly which endpoints to hit.
      </p>
      <div className="flex gap-2 mb-3 flex-wrap">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => setChosenId(t.id)}
            className={`text-xs px-2.5 py-1 rounded border ${
              chosen?.id === t.id
                ? "border-accent text-accent"
                : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre className="bg-paper-soft text-ink rounded-lg p-3 text-xs whitespace-pre-wrap font-mono leading-snug">
        {chosen?.prompt ?? ""}
      </pre>
      <button
        onClick={() => chosen && onCopy(chosen.prompt)}
        className="mt-2 text-xs px-2.5 py-1 border border-paper-soft rounded hover:border-ink"
      >
        {copied ? "Copied" : "Copy prompt"}
      </button>
    </div>
  );
}

// ====================================================================
// MCP install — unchanged from the previous version
// ====================================================================

function MCPInstall({
  base,
  tenant,
  onCopy,
  copied,
}: {
  base: string;
  tenant?: string;
  onCopy: (t: string) => void;
  copied: boolean;
}) {
  const cfg = useMemo(() => {
    // WIKI_BASE_URL points the MCP server at the wiki's public-facing root.
    // Single-tenant: <base>. Hosted: <base>/<tenant> so /wiki/* and /llm
    // hit the right tenant on the multi-tenant backend (next.config rewrites
    // forward those to /t/<tenant>/...).
    const baseUrl =
      (base || "http://localhost:8000") + (tenant ? `/${tenant}` : "");
    return JSON.stringify(
      {
        mcpServers: {
          "portable-llm-wiki": {
            command: "npx",
            args: ["-y", "portable-llm-wiki-mcp"],
            env: { WIKI_BASE_URL: baseUrl },
          },
        },
      },
      null,
      2,
    );
  }, [base, tenant]);

  return (
    <div>
      <h3 className="text-sm uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
        MCP for Cursor / Claude Desktop
      </h3>
      <p className="text-xs text-ink-muted leading-relaxed">
        If the recipient uses Cursor or Claude Desktop, they can install
        the MCP server once and the wiki shows up as typed tools (
        <code className="font-mono">query_wiki</code>,{" "}
        <code className="font-mono">read_page</code>,{" "}
        <code className="font-mono">search_wiki</code>, …) in every
        conversation forever. No URL paste needed each time.
      </p>
      <pre className="mt-3 bg-paper-soft text-ink rounded-lg p-3 text-[11px] whitespace-pre-wrap font-mono">
        {cfg}
      </pre>
      <button
        onClick={() => onCopy(cfg)}
        className="mt-2 text-xs px-2.5 py-1 border border-paper-soft rounded hover:border-ink"
      >
        {copied ? "Copied" : "Copy MCP config"}
      </button>
    </div>
  );
}
