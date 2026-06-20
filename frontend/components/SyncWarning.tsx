"use client";

import type { SyncVerdict } from "@/lib/api";

/**
 * Renders a durability warning when a just-saved write will NOT reach a git
 * remote (and therefore won't survive a restart or appear on a hosted site).
 *
 * This is the UI half of the "no silent no-op" guarantee: the backend stamps
 * every content-create response with a {@link SyncVerdict}; whenever
 * `will_sync` is false we surface the actionable detail loudly instead of
 * letting a green "Saved" message imply durability it doesn't have.
 *
 * Renders nothing when the write is durable (or when no verdict is present),
 * so it's safe to drop after any create result block.
 */
export function SyncWarning({ sync }: { sync?: SyncVerdict | null }) {
  if (!sync || sync.will_sync) return null;

  const isTenant = sync.mode === "tenant";
  // A repo is genuinely missing only in the no_repo_connected case (or when
  // the backend reports no remote at all). For every other tenant reason
  // (autopush disabled, bootstrap pending) a repo IS connected, so telling
  // the user to "Connect a GitHub repo" is wrong and confusing — point them
  // at the owner console to finish/trigger the sync instead.
  const needsRepoConnected =
    isTenant && (sync.reason === "no_repo_connected" || !sync.remote);
  const ctaLabel = needsRepoConnected
    ? "Connect a GitHub repo in the owner console →"
    : "Open the owner console to sync →";
  // Headline reflects where the write actually landed: a hosted tenant
  // write is safe on the server (just not yet mirrored to GitHub), whereas
  // a self-host local_only write only exists on local disk.
  const headline = isTenant
    ? "Saved on the server — not yet on GitHub"
    : "Saved locally — not yet durable";

  return (
    <div
      role="alert"
      data-testid="sync-warning"
      className="mt-2 p-3 rounded border border-amber-300 bg-amber-50 text-xs text-amber-900"
    >
      <div className="font-semibold">{headline}</div>
      <p className="mt-1">{sync.detail}</p>
      {isTenant ? (
        <a
          href="/owner"
          className="mt-2 inline-block underline hover:text-amber-950"
        >
          {ctaLabel}
        </a>
      ) : null}
    </div>
  );
}

export default SyncWarning;
