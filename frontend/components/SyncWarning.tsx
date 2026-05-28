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
  return (
    <div
      role="alert"
      data-testid="sync-warning"
      className="mt-2 p-3 rounded border border-amber-300 bg-amber-50 text-xs text-amber-900"
    >
      <div className="font-semibold">Saved locally — not yet durable</div>
      <p className="mt-1">{sync.detail}</p>
      {isTenant ? (
        <a
          href="/owner"
          className="mt-2 inline-block underline hover:text-amber-950"
        >
          Connect a GitHub repo in the owner console →
        </a>
      ) : null}
    </div>
  );
}

export default SyncWarning;
