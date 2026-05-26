"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ForceResetPreview,
  ownerSyncPreviewForceReset,
} from "@/lib/api";

/**
 * Type-to-confirm modal for the "Force pull (discard local)" destructive
 * action. Replaces the bare ``window.confirm()`` that used to gate the
 * force-reset button.
 *
 * Why we needed this:
 *   * The previous gate was a single OS-level confirm dialog with a
 *     fixed message ("This will discard uncommitted changes…"). It
 *     never told the user WHAT was about to be discarded — making the
 *     "OK" click effectively blind. One user already lost data this way
 *     after an OAuth-token rotation desync (see git history).
 *   * Force-reset against a diverged repo can drop arbitrarily many
 *     local commits + working-tree edits. The user deserves to see the
 *     count, a sample, and have to TYPE the destructive word before
 *     the button enables — same pattern as DangerZonePanel uses for
 *     tenant deletion.
 *
 * Friction layers (mirrors DangerZonePanel):
 *   1. Modal-style overlay (cannot be dismissed by misclick).
 *   2. Preview block showing dirty files + commits about to be lost.
 *   3. Type-to-confirm input — must type "discard" verbatim before the
 *      destructive button enables.
 *
 * The preview is fetched lazily on mount via
 * ``GET /owner/sync/preview-force-reset``. Cheap (read-only git ops),
 * safe to fetch in the foreground while the modal renders.
 */

const CONFIRM_PHRASE = "discard";

export function ForceResetModal({
  open,
  onClose,
  onConfirm,
  isRunning,
}: {
  open: boolean;
  onClose: () => void;
  /** Called when the user has typed the confirm phrase and clicked the
   * destructive button. Parent owns the actual ``ownerSyncPull({force:true})``
   * call so failure handling + post-reset reload stays in one place. */
  onConfirm: () => void;
  /** Whether the parent is currently running the force-reset. Wired in
   * so the modal can disable inputs and show a "resetting…" label
   * without owning its own busy state. */
  isRunning: boolean;
}) {
  const [confirmText, setConfirmText] = useState<string>("");
  const [preview, setPreview] = useState<ForceResetPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);

  // Reset internal state every time the modal opens fresh — otherwise
  // a previous open's typed text or stale preview would leak through.
  useEffect(() => {
    if (!open) return;
    setConfirmText("");
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    let cancelled = false;
    ownerSyncPreviewForceReset()
      .then((r) => {
        if (cancelled) return;
        setPreview(r.preview);
        // The backend sets `error` on the preview when fetch failed
        // but local state is still usable — surface as a soft note,
        // not a blocking error.
        if (r.preview.error) {
          setPreviewError(r.preview.error);
        }
        setPreviewLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : "preview failed");
        setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const buttonReady =
    !isRunning && confirmText.trim().toLowerCase() === CONFIRM_PHRASE;

  const handleConfirm = useCallback(() => {
    if (!buttonReady) return;
    onConfirm();
  }, [buttonReady, onConfirm]);

  if (!open) return null;

  const ahead = preview?.ahead ?? 0;
  const dirtyCount = preview?.dirty_files.length ?? 0;
  const untrackedCount = preview?.untracked_files.length ?? 0;
  const losingCommits = preview?.commits_to_lose_total ?? 0;
  const gainingCommits = preview?.commits_to_gain_total ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="force-reset-modal-title"
      data-testid="force-reset-modal"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white border-2 border-red-400 shadow-2xl">
        <div className="border-b border-red-200 px-6 py-4">
          <h2
            id="force-reset-modal-title"
            className="text-lg font-semibold text-red-800"
          >
            Force-reset: discard local state and take whatever GitHub has
          </h2>
          <p className="mt-1 text-xs text-red-700/80">
            <code className="font-mono">git reset --hard origin/{preview?.branch ?? "…"}</code>{" "}
            · this action is permanent and cannot be undone.
          </p>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {previewLoading && (
            <div className="text-sm text-ink-muted italic">
              Computing what will be discarded…
            </div>
          )}

          {previewError && !previewLoading && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-semibold uppercase tracking-wider text-[10px]">
                Couldn&apos;t fully inspect remote
              </div>
              <p className="mt-1 leading-snug">{previewError}</p>
              <p className="mt-1 leading-snug">
                The preview below reflects local state, but remote info
                may be stale. Proceed at your own risk.
              </p>
            </div>
          )}

          {preview && !previewLoading && (
            <>
              {/* Summary line — the headline numbers the user needs to
                * see before they decide. */}
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <div className="text-xs uppercase tracking-wider font-semibold text-red-700">
                  What changes
                </div>
                <ul className="mt-2 text-sm space-y-1">
                  <li>
                    <span className="font-mono text-red-800">
                      {losingCommits}
                    </span>{" "}
                    local commit{losingCommits === 1 ? "" : "s"} will be{" "}
                    <span className="font-semibold">discarded</span>
                  </li>
                  <li>
                    <span className="font-mono text-red-800">
                      {dirtyCount}
                    </span>{" "}
                    modified tracked file
                    {dirtyCount === 1 ? "" : "s"} will be{" "}
                    <span className="font-semibold">reset to remote</span>
                  </li>
                  <li>
                    <span className="font-mono text-green-700">
                      {gainingCommits}
                    </span>{" "}
                    remote commit{gainingCommits === 1 ? "" : "s"} will be
                    applied to your hosted wiki
                  </li>
                  {untrackedCount > 0 && (
                    <li className="text-ink-muted">
                      <span className="font-mono">{untrackedCount}</span>{" "}
                      untracked file{untrackedCount === 1 ? "" : "s"} will be{" "}
                      <span className="italic">kept</span> (reset doesn&apos;t
                      touch untracked files)
                    </li>
                  )}
                </ul>
              </div>

              {/* Dirty-file sample — concrete paths the user can verify. */}
              {preview.dirty_files.length > 0 && (
                <details open className="text-xs">
                  <summary className="cursor-pointer font-semibold text-red-800">
                    Files about to be reset ({preview.dirty_files.length})
                  </summary>
                  <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-paper-soft bg-paper-softer p-2 font-mono">
                    {preview.dirty_files.slice(0, 30).map((f) => (
                      <li
                        key={f.path}
                        className="text-ink"
                        title={f.kind}
                      >
                        <span className="text-red-700 mr-2">
                          [{f.status.trim() || "?"}]
                        </span>
                        {f.path}
                      </li>
                    ))}
                    {preview.dirty_files.length > 30 && (
                      <li className="text-ink-muted italic">
                        …and {preview.dirty_files.length - 30} more
                      </li>
                    )}
                  </ul>
                </details>
              )}

              {/* Commit-loss sample — git log of what's about to disappear. */}
              {preview.commits_to_lose.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold text-red-800">
                    Commits about to be lost ({preview.commits_to_lose_total})
                  </summary>
                  <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-paper-soft bg-paper-softer p-2 font-mono">
                    {preview.commits_to_lose.map((c) => (
                      <li key={c.sha} className="text-ink">
                        <span className="text-ink-muted mr-2">{c.sha}</span>
                        {c.subject}
                      </li>
                    ))}
                    {preview.commits_to_lose_total >
                      preview.commits_to_lose.length && (
                      <li className="text-ink-muted italic">
                        …and{" "}
                        {preview.commits_to_lose_total -
                          preview.commits_to_lose.length}{" "}
                        more
                      </li>
                    )}
                  </ul>
                </details>
              )}

              {/* Untracked-file note — emphasise these SURVIVE. */}
              {preview.untracked_files.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold text-green-800">
                    Untracked files that will survive ({preview.untracked_files.length})
                  </summary>
                  <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-paper-soft bg-paper-softer p-2 font-mono">
                    {preview.untracked_files.slice(0, 30).map((p) => (
                      <li key={p} className="text-ink">
                        {p}
                      </li>
                    ))}
                    {preview.untracked_files.length > 30 && (
                      <li className="text-ink-muted italic">
                        …and {preview.untracked_files.length - 30} more
                      </li>
                    )}
                  </ul>
                </details>
              )}

              {/* Nothing-to-lose case — make it OBVIOUS the action is
                * still destructive in principle, but currently harmless. */}
              {ahead === 0 && dirtyCount === 0 && (
                <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-xs text-green-900">
                  Nothing local to lose right now — your working tree is
                  clean and matches your last push. Force-reset will still
                  fast-forward to remote, but no edits or commits will be
                  discarded.
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-paper-soft px-6 py-4 space-y-3">
          <label className="block text-xs text-ink-muted">
            Type{" "}
            <code className="font-mono bg-paper-softer px-1.5 py-0.5 rounded text-red-800">
              {CONFIRM_PHRASE}
            </code>{" "}
            to enable the destructive button:
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-paper-soft rounded font-mono text-sm focus:border-red-500 focus:outline-none"
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              spellCheck={false}
              disabled={isRunning}
              data-testid="force-reset-confirm-input"
            />
          </label>
          <div className="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={isRunning}
              className="px-4 py-2 rounded border border-paper-soft text-sm font-medium hover:bg-paper-soft disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!buttonReady}
              data-testid="force-reset-confirm-button"
              className="px-4 py-2 rounded bg-red-700 text-white text-sm font-semibold hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning ? "Resetting…" : "Force-reset to GitHub"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
