"use client";

import { useCallback, useState } from "react";

import { ownerDeleteAccount } from "@/lib/api";

/**
 * Self-service tenant deletion panel for the hosted owner console.
 *
 * Wipes everything the hosted service stores about the caller:
 *   * the on-disk tenant directory (working tree, OAuth token,
 *     share tokens, search index)
 *   * the in-memory tenant registry entry
 *   * the session cookie
 *
 * Does NOT touch the user's GitHub repository — their content is theirs
 * and travels with them. Self-host the OSS build, point
 * ``WIKI_GIT_REMOTE`` at the same repo, and the wiki keeps working.
 *
 * Friction by design:
 *   * Collapsed by default behind a ``<details>``.
 *   * Type-the-tenant-id confirmation before the button enables.
 *   * Final ``confirm()`` modal before the network call.
 *
 * Hidden in OSS / single-tenant mode where there's no concept of a
 * "tenant on a hosted service to delete".
 */
export function DangerZonePanel({
  tenant,
  hosted,
  githubRepo,
}: {
  tenant?: string;
  hosted: boolean;
  /** The user's "owner/repo" string from the GitHub sync panel, if any.
   * Surfaced after deletion so the goodbye copy can link directly to
   * the repo the user owns and keeps. */
  githubRepo?: string | null;
}) {
  const [confirmText, setConfirmText] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedRepo, setDeletedRepo] = useState<string | null>(null);

  const onDelete = useCallback(async () => {
    if (!tenant || confirmText !== tenant) return;
    const final = window.confirm(
      `Last chance.\n\nDeleting will wipe everything portablellm.wiki stores for "${tenant}":\n\n` +
        "  • the tenant directory (working tree, search index, share tokens)\n" +
        "  • the stored GitHub OAuth token\n" +
        "  • your session cookie\n\n" +
        "Your GitHub repository is NOT touched. You keep all your content.\n\n" +
        "Proceed?",
    );
    if (!final) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ownerDeleteAccount();
      setDeletedRepo(res.github_repo || githubRepo || "");
      // Belt and suspenders: the backend already cleared the session
      // cookie, but the SPA still has a stale auth state in memory.
      // Send the user to "/" with a marker so the landing page can
      // show a goodbye-and-here's-your-repo card if it wants to.
      setTimeout(() => {
        const goodbye = res.github_repo
          ? `/?goodbye=${encodeURIComponent(res.github_repo)}`
          : "/?goodbye=1";
        window.location.assign(goodbye);
      }, 1200);
    } catch (e) {
      setError((e as Error).message || "delete failed");
    } finally {
      setBusy(false);
    }
  }, [confirmText, githubRepo, tenant]);

  if (!hosted || !tenant) return null;

  if (deletedRepo !== null) {
    return (
      <section className="mt-10 bg-white border border-red-300 rounded-xl p-5">
        <h2 className="text-sm uppercase tracking-wider text-red-700 font-semibold mb-2">
          Goodbye
        </h2>
        <p className="text-sm text-ink leading-relaxed">
          Your hosted tenant is wiped. The GitHub repo with your wiki
          markdown is untouched
          {deletedRepo ? (
            <>
              {" "}
              — it lives at{" "}
              <a
                href={`https://github.com/${deletedRepo}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2"
              >
                {deletedRepo}
              </a>
              .
            </>
          ) : (
            "."
          )}{" "}
          You can re-import here later, self-host the OSS build pointed
          at it, or do nothing — the wiki survives.
        </p>
      </section>
    );
  }

  const buttonReady = confirmText.trim() === tenant && !busy;

  return (
    <section className="mt-10 bg-white border border-red-300 rounded-xl p-5">
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-red-700 hover:text-red-800">
          Danger zone — leave portablellm.wiki
        </summary>
        <div className="mt-4 space-y-4 text-sm leading-relaxed">
          <p className="text-ink">
            Wipes everything portablellm.wiki stores about you. Your
            GitHub repo with the markdown is{" "}
            <span className="font-semibold">not touched</span> — that's
            the whole portability story: we host a layer on top, you own
            the durable storage.
          </p>

          <div className="grid sm:grid-cols-2 gap-3 text-xs">
            <div className="border border-paper-soft rounded p-3 bg-paper-soft/40">
              <div className="font-semibold text-ink mb-1">What gets deleted</div>
              <ul className="list-disc pl-4 text-ink-muted space-y-0.5">
                <li>Your tenant directory on our disk</li>
                <li>Your stored GitHub OAuth token (revoked at GitHub)</li>
                <li>Share tokens and revocation history</li>
                <li>Search index, ingestion jobs, lint history</li>
                <li>Your session cookie</li>
              </ul>
            </div>
            <div className="border border-paper-soft rounded p-3 bg-paper-soft/40">
              <div className="font-semibold text-ink mb-1">What stays yours</div>
              <ul className="list-disc pl-4 text-ink-muted space-y-0.5">
                <li>Your GitHub repository and every commit in it</li>
                <li>All markdown pages, frontmatter, history</li>
                <li>Your GitHub identity (just the OAuth grant ends)</li>
                <li>
                  Ability to self-host the OSS build pointed at the same
                  repo — the wiki keeps working
                </li>
              </ul>
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-muted mb-1">
              Type your tenant id ({" "}
              <code className="font-mono">{tenant}</code> ) to confirm:
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full px-3 py-2 border border-paper-soft rounded font-mono text-sm"
              placeholder={tenant}
              autoComplete="off"
              spellCheck={false}
              data-testid="danger-zone-confirm-input"
            />
          </div>

          {error && (
            <div className="p-2 rounded border border-red-200 bg-red-50 text-red-700 text-xs">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onDelete}
            disabled={!buttonReady}
            data-testid="danger-zone-delete-button"
            className="w-full px-4 py-2 rounded bg-red-700 text-white text-sm font-medium hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Deleting…" : "Delete my hosted tenant"}
          </button>
        </div>
      </details>
    </section>
  );
}
