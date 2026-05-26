"use client";

// useTierToken
// ============
//
// Hook that resolves a (mint-on-demand, cache-locally) share token
// for a given tier. Used by /share to drive its tier-toggle QR
// generation. Print-asset banners (LinkedIn cover, post card,
// square thumbnail) are now generated offline via
// scripts/generate_banners.py rather than this hook + a /brand page.
//
// PROBLEM
// -------
// Share-token plaintexts are only returned at mint time. The server
// stores only a SHA-256 hash, so /owner/share-tokens lists tokens by
// id but doesn't (and can't) recover the plaintext we need to build a
// tier-gated URL.
//
// To make a "Public / Recruiter / Friend" toggle feel instant, we
// cache the plaintext from each first-mint in localStorage, keyed by
// (tenant, tier). On subsequent loads we look up the cached plaintext,
// verify the token is still active on the backend, and reuse it.
//
// If the cache is empty OR the cached token has been revoked, we mint
// a fresh one labeled "Quick share QR — <tier>". Tokens minted this
// way still appear in the ShareTokensPanel where the owner can audit
// hits, revoke, or rename them.
//
// SECURITY
// --------
// localStorage is XSS-readable, but the same is true of any owner UI
// state on a tenant page. The plaintext is owner-secret data that the
// owner controls; storing it for fast tier-toggle UX is acceptable.
// We deliberately do NOT use sessionStorage — owners expect tier
// toggles to persist across page reloads / tab restores.

import { useCallback, useEffect, useState } from "react";

import {
  ownerListShareTokens,
  ownerMintShareToken,
  type ShareTokenInfo,
} from "@/lib/api";
import type { ShareTier } from "@/lib/llmPrompts";


export type TierTokenState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; token: string; tokenId: string; label: string }
  | { kind: "no-token-yet" }
  | { kind: "error"; message: string };


function cacheKey(tenant: string | undefined, tier: ShareTier): string {
  // Tenant scope prevents one tenant's cached token from leaking into
  // another tenant's UI if the same browser is signed into multiple
  // accounts via the /auth/switch-account flow. The "v1" prefix is a
  // versioning hook in case we ever want to change the cache shape.
  return `pllm:tier-token:v1:${tenant || "default"}:${tier}`;
}


function loadCached(
  tenant: string | undefined,
  tier: ShareTier,
): { token: string; tokenId: string } | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(cacheKey(tenant, tier));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== "string" || typeof parsed?.tokenId !== "string") {
      return null;
    }
    return { token: parsed.token, tokenId: parsed.tokenId };
  } catch {
    return null;
  }
}


function saveCached(
  tenant: string | undefined,
  tier: ShareTier,
  token: string,
  tokenId: string,
): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      cacheKey(tenant, tier),
      JSON.stringify({ token, tokenId }),
    );
  } catch {
    // Quota errors, private browsing, etc. — fall back to memory-only.
  }
}


function clearCached(tenant: string | undefined, tier: ShareTier): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(cacheKey(tenant, tier));
  } catch {
    // ignore
  }
}


/** Resolve (or mint) a share token for the given tier.
 *
 *  Returns `{ kind: "ready", token, ... }` when a usable token exists,
 *  along with helper functions to force-remint or clear the cache.
 *
 *  Public tier short-circuits to `{ kind: "ready", token: "" }` so
 *  callers can use a single return shape — public URLs just don't
 *  carry the `?t=` query string. */
export function useTierToken(opts: {
  tenant?: string;
  tier: ShareTier;
  /** If false, the hook is in "preview only" mode — no auto-mint, no
   *  network. Useful when the page wants to show the toggle UI before
   *  the owner has consented to mint anything yet. */
  autoMint?: boolean;
}): {
  state: TierTokenState;
  /** Force a mint-and-replace, e.g. after the user clicks "rotate". */
  mintFresh: () => Promise<void>;
  /** Clear local cache (owner clicked "forget this token on this
   *  device"). Doesn't revoke server-side — use ShareTokensPanel for
   *  that. */
  forget: () => void;
} {
  const { tenant, tier, autoMint = true } = opts;
  const [state, setState] = useState<TierTokenState>({ kind: "idle" });

  const mintFresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const minted = await ownerMintShareToken(
        {
          label: `Quick share QR — ${tier}`,
          tier,
        },
        tenant,
      );
      saveCached(tenant, tier, minted.token, minted.id);
      setState({
        kind: "ready",
        token: minted.token,
        tokenId: minted.id,
        label: minted.label,
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [tenant, tier]);

  const forget = useCallback(() => {
    clearCached(tenant, tier);
    setState({ kind: "no-token-yet" });
  }, [tenant, tier]);

  useEffect(() => {
    // Public tier never needs a token. Short-circuit so the UI can
    // render its public-only state immediately on mount.
    if (tier === "public") {
      setState({ kind: "ready", token: "", tokenId: "", label: "Public" });
      return;
    }

    let cancelled = false;
    (async () => {
      setState({ kind: "loading" });

      const cached = loadCached(tenant, tier);
      if (cached) {
        // Verify the cached token still resolves on the server (could
        // have been revoked from another device or via the panel).
        try {
          const list = await ownerListShareTokens(tenant);
          const live = list.tokens.find(
            (t: ShareTokenInfo) => t.id === cached.tokenId && !t.revoked,
          );
          if (cancelled) return;
          if (live) {
            setState({
              kind: "ready",
              token: cached.token,
              tokenId: cached.tokenId,
              label: live.label,
            });
            return;
          }
          // Cached token is gone — clear and fall through to mint.
          clearCached(tenant, tier);
        } catch {
          // Network / auth failure. Show the cached token anyway —
          // the user can still copy/scan it and we'll re-verify on
          // the next render.
          if (cancelled) return;
          setState({
            kind: "ready",
            token: cached.token,
            tokenId: cached.tokenId,
            label: `Quick share QR — ${tier}`,
          });
          return;
        }
      }

      if (!autoMint) {
        if (!cancelled) setState({ kind: "no-token-yet" });
        return;
      }

      // No cached token — mint one.
      if (!cancelled) await mintFresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [tenant, tier, autoMint, mintFresh]);

  return { state, mintFresh, forget };
}
