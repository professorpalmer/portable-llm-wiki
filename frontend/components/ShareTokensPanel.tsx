"use client";

import { useEffect, useState } from "react";
import {
  ownerListShareTokens,
  ownerMintShareToken,
  ownerRevokeShareToken,
  type MintedShareToken,
  type ShareTokenInfo,
} from "@/lib/api";

type Tier = "public" | "recruiter" | "friend";

// Narrow ShareTokenInfo to the three "share with others" tiers this
// panel owns. The filter below uses this as a type predicate so the
// rendering code can index TIER_STYLE without TS complaining that
// `private` isn't a key.
type ShareTokenForOthers = Omit<
  import("@/lib/api").ShareTokenInfo,
  "tier"
> & { tier: Tier };

const TIER_DESC: Record<Tier, string> = {
  public: "Public-tier pages only. Same as anyone with the URL.",
  recruiter: "Public + recruiter pages. Career-facing.",
  friend: "Public + recruiter + friend pages. Personal but not sensitive.",
};

const TIER_STYLE: Record<Tier, string> = {
  public: "border-emerald-300 bg-emerald-50 text-emerald-800",
  recruiter: "border-blue-300 bg-blue-50 text-blue-800",
  friend: "border-purple-300 bg-purple-50 text-purple-800",
};

// Returns ("/" + tenant) in hosted mode, "" in single-tenant. We use a
// helper so the URL builders below stay one-line and the empty-string
// behavior is explicit (vs. forgetting a leading slash and producing
// "https://example.comprofessorpalmer/llm").
function tenantSegment(tenant?: string): string {
  return tenant ? `/${tenant}` : "";
}

export function ShareTokensPanel({
  publicBaseUrl,
  tenant,
}: {
  publicBaseUrl: string;
  tenant?: string;
}) {
  const [tokens, setTokens] = useState<ShareTokenForOthers[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<Tier>("recruiter");
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newlyMinted, setNewlyMinted] = useState<MintedShareToken | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const r = await ownerListShareTokens(tenant);
      // Private-tier tokens live in PersonalLlmUrlPanel — the "master
      // key" UX surface with its own red-banner warnings. Listing them
      // here too would double-show the rows AND soften their danger
      // signal by mixing them into the recruiter/friend rhythm. The
      // type predicate also narrows the tier union so the rendering
      // code below can index TIER_STYLE without a fallback branch.
      const others = r.tokens.filter(
        (t): t is ShareTokenForOthers => t.tier !== "private",
      );
      setTokens(others);
      setError(null);
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
      setError("Label is required (e.g. 'Recruiter at Acme', 'Conference attendee').");
      return;
    }
    setError(null);
    setMinting(true);
    setCopyOk(false);
    try {
      const r = await ownerMintShareToken({ label: label.trim(), tier }, tenant);
      setNewlyMinted(r);
      setLabel("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (!confirm(`Revoke "${label}"? This is permanent.`)) return;
    try {
      await ownerRevokeShareToken(id, tenant);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The LLM-handshake URL: this is the link recipients (or their
  // LLMs) actually fetch. `/llm?t=<token>` returns tier-filtered
  // markdown so the recipient gets the right content for their tier.
  // For human-browsing UX, see `humanShareUrl` below — different URL,
  // different audience.
  function llmShareUrl(token: string): string {
    return `${publicBaseUrl.replace(/\/+$/, "")}${tenantSegment(tenant)}/llm?t=${encodeURIComponent(token)}`;
  }

  // The human-browser URL: lands on the wiki UI with the share token
  // captured into localStorage so subsequent page navigation respects
  // the tier. Use this when DMing a person who'll browse with their
  // eyes; use llmShareUrl when handing the link to an LLM/QR.
  function humanShareUrl(token: string): string {
    return `${publicBaseUrl.replace(/\/+$/, "")}${tenantSegment(tenant)}?share=${encodeURIComponent(token)}`;
  }

  async function copyShare(token: string, which: "llm" | "human") {
    const url = which === "llm" ? llmShareUrl(token) : humanShareUrl(token);
    try {
      await navigator.clipboard.writeText(url);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1800);
    } catch {
      /* clipboard blocked — user can still select text */
    }
  }

  return (
    <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
      <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-1">
        Share tokens
      </h2>
      <p className="text-xs text-ink-muted">
        Mint a tokenized URL that grants someone access to a tier of your wiki.
        Each token tracks how many times it's been used and when. Revoke any
        time. The plaintext token is shown <em>once</em> at mint. Copy the URL
        before closing this banner.
      </p>

      {/* Mint form */}
      <div className="mt-4 grid sm:grid-cols-[1fr_auto_auto] gap-2 items-start">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. 'Recruiter at Acme' or 'Conference attendee')"
          className="border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as Tier)}
          className="border border-paper-soft rounded px-3 py-2 text-sm bg-paper"
        >
          <option value="public">public</option>
          <option value="recruiter">recruiter</option>
          <option value="friend">friend</option>
        </select>
        <button
          onClick={mint}
          disabled={minting}
          className="px-4 py-2 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
        >
          {minting ? "minting…" : "mint token"}
        </button>
      </div>
      <div className="mt-1 text-xs text-ink-muted">{TIER_DESC[tier]}</div>

      {error && (
        <div className="mt-3 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Banner that appears once on successful mint */}
      {newlyMinted && (
        <div className="mt-4 p-4 rounded-xl border-2 border-amber-300 bg-amber-50">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="text-sm font-semibold text-amber-900">
              Token minted. Copy this URL now. It will not be shown again.
            </div>
            <button
              onClick={() => setNewlyMinted(null)}
              className="text-xs text-amber-800 underline hover:text-amber-900"
            >
              dismiss
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <div className="text-xs text-amber-800">
              Tier: <span className="font-medium">{newlyMinted.tier}</span> ·
              Label: <span className="font-medium">{newlyMinted.label}</span>
            </div>

            {/* LLM URL — the link to give to an LLM (or paste into a    */}
            {/* QR). Resolves to the markdown handshake filtered to this */}
            {/* tier. Listed first because LLM sharing is the primary    */}
            {/* killer-app workflow.                                      */}
            <div className="flex flex-col gap-1">
              <div className="text-[10px] uppercase tracking-wider text-amber-900 font-semibold">
                URL for any LLM / QR code
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={llmShareUrl(newlyMinted.token)}
                  className="flex-1 border border-amber-300 rounded px-2 py-1.5 text-xs font-mono bg-white"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => copyShare(newlyMinted.token, "llm")}
                  className="px-3 py-1.5 rounded bg-amber-700 text-white text-xs font-medium hover:bg-amber-800"
                >
                  {copyOk ? "copied ✓" : "copy"}
                </button>
              </div>
            </div>

            {/* Human URL — the same token, but mounted at the tenant    */}
            {/* homepage so a recipient who clicks it lands in the React */}
            {/* wiki UI with their tier elevated via localStorage.       */}
            <div className="flex flex-col gap-1">
              <div className="text-[10px] uppercase tracking-wider text-amber-900 font-semibold">
                URL for humans (browse the wiki)
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={humanShareUrl(newlyMinted.token)}
                  className="flex-1 border border-amber-300 rounded px-2 py-1.5 text-xs font-mono bg-white"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => copyShare(newlyMinted.token, "human")}
                  className="px-3 py-1.5 rounded border border-amber-700 text-amber-900 bg-white text-xs font-medium hover:bg-amber-100"
                >
                  copy
                </button>
              </div>
            </div>

            <div className="text-xs text-amber-700">
              Two URLs, one token. Hand the LLM URL to an AI; hand the
              human URL to a person browsing with their eyes.
            </div>
          </div>
        </div>
      )}

      {/* Token list */}
      <div className="mt-5">
        {loading ? (
          <div className="text-xs text-ink-muted">loading…</div>
        ) : tokens.length === 0 ? (
          <div className="text-xs text-ink-muted">No share tokens yet.</div>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.id}
                className={`p-3 rounded border ${
                  t.revoked
                    ? "border-paper-soft bg-paper-soft/40 opacity-60"
                    : "border-paper-soft bg-paper"
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-ink truncate">
                        {t.label}
                      </span>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${
                          TIER_STYLE[t.tier]
                        }`}
                      >
                        {t.tier}
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
