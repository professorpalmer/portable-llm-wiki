"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ConnectRepoResponse,
  GitHubSyncStatus,
  onboardingConnectRepo,
} from "@/lib/api";

/**
 * Type-to-confirm modal for relocating the tenant's wiki to a different
 * GitHub repo. Sister component to ForceResetModal.
 *
 * Why this exists (the load-bearing case):
 *   Users who bound their tenant before the product-source-repo guard
 *   shipped (2026-05-26) can end up stuck — their wiki points at a repo
 *   that's actually the product source, autopush fails forever after we
 *   rewrote the product-source history to scrub a token leak, and the
 *   force-reset button would discard their wiki content to recover. The
 *   only safe fix is to rebind to a separate wiki repo. /welcome can't
 *   do this (it gates the connect step on !connected), so the owner
 *   console needs its own switch flow.
 *
 * Friction layers (mirror ForceResetModal):
 *   1. Modal overlay (can't be dismissed by misclick).
 *   2. Current-binding header so the user sees what they're replacing.
 *   3. Type-to-confirm input — must type "switch" before the destructive
 *      button enables.
 *
 * Action mechanics:
 *   POST /onboarding/connect-repo with the user-supplied owner/name.
 *   The existing endpoint overwrites tenant.gh_repo and re-runs
 *   bootstrap_tenant, which fast-forwards the local wiki_root to the
 *   new remote's HEAD (see backend/app/persistence.py Case 1). All the
 *   destructive intent lives on the backend; this modal just plumbs
 *   user confirmation.
 *
 * Important: this is intentionally destructive. The new repo's HEAD
 * replaces whatever's currently in wiki_root. The current-repo HEADER
 * + the explanation paragraph below it call this out, and the
 * type-to-confirm input enforces a deliberate action.
 */

const CONFIRM_PHRASE = "switch";

const REPO_PATTERN = /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/;

export function SwitchRepoModal({
  open,
  onClose,
  currentRepo,
  onSwitched,
}: {
  open: boolean;
  onClose: () => void;
  /** Currently-bound repo — rendered so the user sees what gets
   * replaced. May be empty if the tenant is somehow in a half-connected
   * state, in which case we still let the user pick a new one. */
  currentRepo: string;
  /** Called with the connect-repo response + fresh sync status so the
   * parent can update its own panel state. The parent decides whether
   * to close the modal (typical) or keep it open to show errors. */
  onSwitched: (resp: ConnectRepoResponse, status: GitHubSyncStatus) => void;
}) {
  const [repoInput, setRepoInput] = useState<string>("");
  const [confirmText, setConfirmText] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRepoInput("");
    setConfirmText("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  const repoValid = REPO_PATTERN.test(repoInput.trim());
  const phraseTyped =
    confirmText.trim().toLowerCase() === CONFIRM_PHRASE;
  const buttonReady = !submitting && repoValid && phraseTyped;

  const handleSwitch = useCallback(async () => {
    if (!buttonReady) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await onboardingConnectRepo({
        create_new: false,
        repo: repoInput.trim(),
      });
      if (!resp.ok && !resp.connected) {
        // Endpoint returned a soft failure (bootstrap didn't fully
        // succeed but binding may still have changed). Surface the
        // message but let the parent decide what to do.
        setError(resp.message || "Switch failed");
        setSubmitting(false);
        return;
      }
      if (resp.status) {
        onSwitched(resp, resp.status);
      } else {
        // ConnectRepoResponse.status is technically optional; treat
        // missing status as success and let the parent re-fetch.
        onSwitched(resp, {
          connected: true,
          repo: resp.repo,
          branch: resp.branch,
          html_url: resp.html_url || `https://github.com/${resp.repo}`,
          last_synced_at: 0,
          last_error: "",
          pushes_made: 0,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
      setSubmitting(false);
    }
  }, [buttonReady, repoInput, onSwitched]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="switch-repo-modal-title"
      data-testid="switch-repo-modal"
    >
      <div className="w-full max-w-xl rounded-2xl bg-white border-2 border-amber-400 shadow-2xl">
        <div className="border-b border-amber-200 px-6 py-4">
          <h2
            id="switch-repo-modal-title"
            className="text-lg font-semibold text-amber-900"
          >
            Switch wiki backing repo
          </h2>
          <p className="mt-1 text-xs text-amber-800/80">
            Currently bound to{" "}
            <code className="font-mono text-amber-900">
              {currentRepo || "(no repo bound)"}
            </code>
            . Switching will repoint future autopushes at the new repo
            and reset your hosted wiki_root to the new remote&apos;s{" "}
            <code className="font-mono">HEAD</code>.
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 leading-snug">
            <div className="font-semibold uppercase tracking-wider text-[10px]">
              What this does
            </div>
            <ul className="mt-1 list-disc pl-4 space-y-1">
              <li>
                Updates this tenant&apos;s GitHub binding to the new
                repo.
              </li>
              <li>
                Re-bootstraps locally:{" "}
                <code className="font-mono">git reset --hard origin/&lt;branch&gt;</code>
                {" "}— anything in the hosted wiki_root that isn&apos;t
                already pushed to the OLD repo is gone after this.
              </li>
              <li>
                Refuses if the target looks like a product-source fork
                (has both <code className="font-mono">backend/</code>{" "}
                and <code className="font-mono">frontend/</code> at
                root).
              </li>
            </ul>
          </div>

          <label className="block text-xs text-ink-muted">
            New repo (<code className="font-mono">owner/name</code>) —
            must already exist on GitHub and be accessible with your
            current token:
            <input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-paper-soft rounded font-mono text-sm focus:border-amber-500 focus:outline-none"
              placeholder="professorpalmer/cary-wiki"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              data-testid="switch-repo-input"
            />
            {repoInput && !repoValid && (
              <span className="mt-1 block text-red-700">
                Must be in the form{" "}
                <code className="font-mono">owner/name</code>.
              </span>
            )}
          </label>

          <label className="block text-xs text-ink-muted">
            Type{" "}
            <code className="font-mono bg-paper-softer px-1.5 py-0.5 rounded text-amber-900">
              {CONFIRM_PHRASE}
            </code>{" "}
            to enable the switch button:
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-paper-soft rounded font-mono text-sm focus:border-amber-500 focus:outline-none"
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              data-testid="switch-repo-confirm-input"
            />
          </label>

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800">
              <div className="font-semibold uppercase tracking-wider text-[10px]">
                Switch failed
              </div>
              <p className="mt-1 leading-snug">{error}</p>
            </div>
          )}
        </div>

        <div className="border-t border-paper-soft px-6 py-4 flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded border border-paper-soft text-sm font-medium hover:bg-paper-soft disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSwitch}
            disabled={!buttonReady}
            data-testid="switch-repo-confirm-button"
            className="px-4 py-2 rounded bg-amber-700 text-white text-sm font-semibold hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Switching…" : "Switch repo"}
          </button>
        </div>
      </div>
    </div>
  );
}
