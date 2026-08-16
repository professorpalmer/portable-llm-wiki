"use client";

// Personal LLM URL panel — the "portability across every LLM" surface.
//
// Background: the tier system on this wiki is enforced server-side.
// Anyone hitting /<tenant>/llm anonymously gets the PUBLIC slice of the
// wiki; recruiters/friends climb the ladder by holding a tokenized
// share URL; private content is reserved for the owner. That gating is
// what makes "share my QR on LinkedIn" safe.
//
// But it creates a conflict with the project's other goal — PORTABILITY.
// I want my LLM (any LLM, ChatGPT today, Claude tomorrow, a local model
// on my laptop the day after) to see my FULL wiki including private
// notes so its answers about me are actually grounded. The session
// cookie that elevates me to owner-tier in MY browser doesn't travel —
// I can't paste a cookie into ChatGPT. The OSS OWNER_TOKEN env var
// only exists in self-hosted setups.
//
// The fix is a self-issued, revocable, scoped-to-just-me share token
// at PRIVATE tier. Same machinery as recruiter/friend tokens; same
// hashing in share_tokens.py; same revocation flow. The only thing
// that changes is who's allowed to hold it: just the owner. The token
// goes into 1Password (or wherever), gets pasted into each LLM tool
// once, and persists across sessions until revoked.
//
// Auth: private-tier tokens resolve to is_owner=True so MCP ingest /
// capture work for hosted users without the platform OWNER_TOKEN
// (Render env — operator-only). Recruiter/friend stay read-only.
//
// Why this panel is separate from ShareTokensPanel:
//   * Different INTENT. Share tokens are "give a stranger a slice of
//     my wiki"; personal tokens are "give MYSELF the master key for
//     pasting into AI tools". Conflating them invited a UX where the
//     user mints a recruiter token, hands it out, and then is
//     surprised the LLM only sees recruiter-tier content.
//   * Different DANGER LEVEL. A leaked recruiter token reveals career
//     pages — annoying but bounded. A leaked private token reveals
//     EVERYTHING. The panel's red banner + password-grade copy makes
//     that obvious; mixing it in with the share-with-others UI would
//     soften the warning.
//   * Different USE PATTERN. Share tokens are minted per recipient;
//     personal tokens are minted per device (ChatGPT desktop, Cursor
//     laptop, Claude mobile). The label hints below nudge users in
//     this direction so a future revocation can be device-specific.

import { useEffect, useState } from "react";
import {
  ownerListShareTokens,
  ownerMintShareToken,
  ownerRevokeShareToken,
  type MintedShareToken,
  type ShareTokenInfo,
} from "@/lib/api";
import { redactTokenizedUrl } from "@/lib/shareToken";
import { buildOfflineBriefing, isBriefingComplete } from "@/lib/briefing";
import { ConnectMarionetteButton } from "@/components/ConnectMarionetteButton";
import {
  MARIONETTE_CONNECT_HASH,
  scrollToMarionetteConnect,
  shouldFocusMarionetteConnect,
} from "@/lib/marionetteConnect";


// Mirror of ShareTokensPanel's helper so personal URLs are constructed
// the same way the rest of the codebase constructs LLM-handshake URLs.
// Kept inline (rather than imported from llmPrompts) because the
// llmPrompts.ShareTier union deliberately excludes "private" — the
// public/recruiter/friend flows there shouldn't accidentally pick up
// private-tier URL construction.
function tenantSegment(tenant?: string): string {
  return tenant ? `/${tenant}` : "";
}


export function PersonalLlmUrlPanel({
  publicBaseUrl,
  tenant,
}: {
  publicBaseUrl: string;
  tenant?: string;
}) {
  const [tokens, setTokens] = useState<ShareTokenInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newlyMinted, setNewlyMinted] = useState<MintedShareToken | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  // Briefing state — separate from copyOk because the briefing copy
  // is async (fetches + assembly take a few seconds) and we want to
  // show distinct "building…" / "copied!" / "partial" feedback.
  const [briefingState, setBriefingState] = useState<
    "idle" | "building" | "copied" | "partial" | "error"
  >("idle");

  // Filter list to only show PRIVATE-tier tokens. The same backend
  // endpoint returns ALL share tokens regardless of tier — the
  // ShareTokensPanel handles public/recruiter/friend, this one owns
  // private. Without this filter the two panels would double-list
  // identical rows.
  const privateTokens = tokens.filter((t) => t.tier === "private");

  useEffect(() => {
    if (!shouldFocusMarionetteConnect()) return;
    const t = window.setTimeout(() => scrollToMarionetteConnect(), 120);
    return () => window.clearTimeout(t);
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const r = await ownerListShareTokens(tenant);
      setTokens(r.tokens);
      // Intentionally do NOT setError(null) on success. The mount-time
      // refresh races with synchronous mint() validation errors set by
      // the user clicking the button — clearing the error here would
      // race-condition the "Label is required" message out of view a
      // few ms after it appeared. Errors stay sticky until the user
      // either fixes the input (next mint attempt clears it) or
      // dismisses by minting successfully.
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  async function mint() {
    if (label.trim().length < 1) {
      setError(
        "Label is required. Name it after the device or tool you'll paste it into (e.g. 'ChatGPT desktop', 'Cursor MBP').",
      );
      return;
    }
    setError(null);
    setMinting(true);
    setCopyOk(false);
    try {
      const r = await ownerMintShareToken(
        { label: label.trim(), tier: "private" },
        tenant,
      );
      setNewlyMinted(r);
      setLabel("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: string, lbl: string) {
    if (
      !confirm(
        `Revoke "${lbl}"? Any LLM still using this URL will fall back to PUBLIC-tier content. This action is permanent.`,
      )
    )
      return;
    try {
      await ownerRevokeShareToken(id, tenant);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function personalLlmUrl(token: string): string {
    return `${publicBaseUrl.replace(/\/+$/, "")}${tenantSegment(tenant)}/llm?t=${encodeURIComponent(token)}`;
  }

  async function copyMinted(token: string) {
    try {
      await navigator.clipboard.writeText(personalLlmUrl(token));
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1800);
    } catch {
      /* clipboard blocked — input is select-on-focus so user can grab manually */
    }
  }

  /** Copy a full offline briefing — handshake + manifest + top page
   *  contents — to clipboard, so the URL recipient can paste it into
   *  ANY LLM (including ChatGPT in search-only mode that can't fetch
   *  arbitrary URLs). This is the "always works regardless of the
   *  LLM's fetch capability" path. */
  async function copyBriefing(token: string) {
    setBriefingState("building");
    try {
      const blob = await buildOfflineBriefing({
        llmUrl: personalLlmUrl(token),
        token,
        tenant,
      });
      await navigator.clipboard.writeText(blob);
      setBriefingState(isBriefingComplete(blob) ? "copied" : "partial");
      setTimeout(() => setBriefingState("idle"), 2400);
    } catch {
      setBriefingState("error");
      setTimeout(() => setBriefingState("idle"), 2400);
    }
  }

  return (
    <section
      id={MARIONETTE_CONNECT_HASH}
      className="mt-6 bg-white border-2 border-red-200 rounded-xl p-5 scroll-mt-24 transition-shadow"
      data-testid="personal-llm-url-panel"
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <h2 className="text-sm uppercase tracking-wider text-red-900 font-semibold">
          Your personal LLM URL
        </h2>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-100 text-red-800 border border-red-200 font-semibold">
          private tier · master key
        </span>
      </div>
      <p className="text-xs text-ink-muted leading-relaxed">
        One URL that lets any LLM see your full wiki including private
        pages. Paste it into ChatGPT, Claude, Cursor, Gemini, or any tool that
        can fetch URLs — the model gets the same view of you that you get when
        you&apos;re signed in. Anyone else who holds the URL also sees
        everything, so treat it like a password (1Password, etc.). Revoke
        anytime; you can mint a new one in 5 seconds.
      </p>

      <ConnectMarionetteButton tenant={tenant || ""} force className="mt-4" />

      {/* Mint form. Label-first so the user has to think "which device
          is this for" — encourages per-device tokens which makes
          revoking a lost phone easier. */}
      <div className="mt-4 grid sm:grid-cols-[1fr_auto] gap-2 items-start">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Where will you paste it? (e.g. 'ChatGPT desktop', 'Cursor laptop', 'Claude mobile')"
          aria-label="Personal LLM URL label"
          className="border border-paper-soft rounded px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
        />
        <button
          onClick={mint}
          disabled={minting}
          className="px-4 py-2 rounded bg-red-700 text-white text-sm font-medium hover:bg-red-800 disabled:opacity-50"
        >
          {minting ? "minting…" : "mint personal URL"}
        </button>
      </div>
      <div className="mt-1 text-[11px] text-ink-muted">
        One token per device is the safe pattern. If your laptop gets stolen,
        revoke just that token instead of rotating every LLM you use.
      </div>

      {error && (
        <div className="mt-3 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* The show-once banner. Uses red (not amber, like ShareTokensPanel)
          to signal the higher danger level. */}
      {newlyMinted && (
        <div className="mt-4 p-4 rounded-xl border-2 border-red-400 bg-red-50">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="text-sm font-semibold text-red-900">
              Save this URL now. It will NEVER be shown again.
            </div>
            <button
              onClick={() => setNewlyMinted(null)}
              className="text-xs text-red-800 underline hover:text-red-900"
            >
              dismiss
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <div className="text-xs text-red-800">
              Labeled <span className="font-medium">{newlyMinted.label}</span>.
              Paste it into your AI tool of choice — the model will fetch the
              URL and get your full wiki on every conversation.
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                value={redactTokenizedUrl(personalLlmUrl(newlyMinted.token))}
                aria-label="Newly minted personal LLM URL"
                className="flex-1 border border-red-300 rounded px-2 py-1.5 text-xs font-mono bg-white"
              />
              <button
                onClick={() => copyMinted(newlyMinted.token)}
                className="px-3 py-1.5 rounded bg-red-700 text-white text-xs font-medium hover:bg-red-800"
              >
                {copyOk ? "copied ✓" : "copy URL"}
              </button>
            </div>
            {/* Briefing button. Surfaced here (under the URL, not
                next to it) because it's a SECONDARY path — the
                primary "paste this URL into ChatGPT" flow is for
                LLMs with fetch. The briefing is the fallback for
                LLMs that don't have fetch (ChatGPT in search-only
                mode, some Gemini configs, etc.). */}
            <div className="mt-1 flex items-baseline justify-between gap-3 flex-wrap">
              <button
                onClick={() => copyBriefing(newlyMinted.token)}
                disabled={briefingState === "building"}
                className="text-xs text-red-800 underline hover:text-red-900 disabled:opacity-60"
                aria-label="Copy offline briefing — handshake plus top pages"
              >
                {briefingState === "building"
                  ? "building briefing…"
                  : briefingState === "copied"
                    ? "briefing copied ✓"
                    : briefingState === "partial"
                      ? "partial briefing copied ⚠"
                      : briefingState === "error"
                        ? "briefing failed — try again"
                        : "or: copy full briefing (works in any LLM, no fetch needed)"}
              </button>
              <span className="text-[10px] text-red-700/80 italic">
                ~15KB paste · for ChatGPT search-mode &amp; other fetch-less tools
              </span>
            </div>
            <div className="text-[11px] text-red-700 leading-relaxed">
              After dismissing this banner the plaintext token cannot be
              recovered — only its hash is kept on the server. If you lose
              the URL, revoke this token and mint a fresh one.
            </div>
          </div>
        </div>
      )}

      {/* List existing private tokens so the user can audit + revoke. */}
      <div className="mt-5">
        <div className="text-[11px] uppercase tracking-wider text-ink-muted font-semibold mb-2">
          Active personal URLs
        </div>
        {loading ? (
          <div className="text-xs text-ink-muted">loading…</div>
        ) : privateTokens.length === 0 ? (
          <div className="text-xs text-ink-muted italic">
            No personal URLs minted yet. The form above mints one.
          </div>
        ) : (
          <ul className="space-y-2">
            {privateTokens.map((t) => (
              <li
                key={t.id}
                data-testid={`personal-token-${t.id}`}
                className={`p-3 rounded border ${
                  t.revoked
                    ? "border-paper-soft bg-paper-soft/40 opacity-60"
                    : "border-red-200 bg-red-50/40"
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-ink truncate">
                        {t.label}
                      </span>
                      {t.revoked && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">
                          revoked
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-ink-muted font-mono">
                      id: {t.id} · created {fmtDate(t.created_at)}
                      {t.expires_at && <> · expires {fmtDate(t.expires_at)}</>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {t.hits} hit{t.hits === 1 ? "" : "s"}
                      {t.last_used_at && (
                        <> · last used {fmtDate(t.last_used_at)}</>
                      )}
                    </div>
                  </div>
                  {!t.revoked && (
                    <button
                      onClick={() => revoke(t.id, t.label)}
                      className="text-xs text-red-700 hover:text-red-900 underline shrink-0"
                    >
                      revoke
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const ms = now.getTime() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
