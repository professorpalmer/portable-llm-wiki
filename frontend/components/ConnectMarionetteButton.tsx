"use client";

import { useEffect, useState } from "react";
import { fetchPublicConfig, ownerMintShareToken } from "@/lib/api";
import {
  buildPersonalLlmUrl,
  handoffToMarionette,
  isMarionetteClient,
  rememberMarionetteClientFromLocation,
} from "@/lib/marionetteConnect";

/**
 * One-click (or auto) handoff: mint a private personal LLM URL labeled
 * "Marionette" and deep-link into the desktop app.
 */
export function ConnectMarionetteButton({
  tenant,
  auto = false,
  force = false,
  className = "",
}: {
  tenant: string;
  /** When true, mint + handoff once on mount (welcome DoneView). */
  auto?: boolean;
  /** Show even when not opened via ?client=marionette (Owner console). */
  force?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const show =
    force || isMarionetteClient() || rememberMarionetteClientFromLocation();

  async function connect() {
    if (!tenant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cfg = await fetchPublicConfig().catch(() => null);
      const publicBase =
        (cfg && cfg.public_base_url) ||
        (typeof window !== "undefined" ? window.location.origin : "");
      const minted = await ownerMintShareToken(
        { label: "Marionette", tier: "private" },
        tenant,
      );
      const url = buildPersonalLlmUrl(publicBase, tenant, minted.token);
      handoffToMarionette(url);
      setDone(true);
    } catch (e) {
      setError((e as Error).message || "Could not connect to Marionette");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!auto || !show || !tenant) return;
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, show, tenant]);

  if (!show) return null;

  return (
    <div className={className} data-testid="connect-marionette">
      <button
        type="button"
        onClick={() => void connect()}
        disabled={busy || done}
        className="px-4 py-2.5 rounded-lg bg-accent text-paper text-sm font-medium hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-2"
      >
        {busy
          ? "Linking Marionette…"
          : done
            ? "Sent to Marionette"
            : "Connect to Marionette"}
      </button>
      <p className="mt-2 text-xs text-ink-muted leading-relaxed max-w-md">
        Mints a private personal LLM URL and opens Marionette so the wiki
        graph links at owner tier — no copy/paste.
      </p>
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
