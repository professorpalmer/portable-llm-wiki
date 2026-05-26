"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  fetchPage,
  ownerSetTier,
  ownerGetPageRaw,
  ownerReplacePage,
  type PageFull,
} from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import { useIsOwnerOf } from "@/lib/useIsOwner";
import { Markdown } from "@/components/Markdown";

const tierStyles: Record<string, string> = {
  public: "bg-emerald-50 text-emerald-700 border-emerald-200",
  recruiter: "bg-blue-50 text-blue-700 border-blue-200",
  friend: "bg-purple-50 text-purple-700 border-purple-200",
  private: "bg-red-50 text-red-700 border-red-200",
};

export default function PageView() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const tenant = useTenant();
  const slug = params?.slug;
  const [page, setPage] = useState<PageFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingTier, setSavingTier] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editMarkdown, setEditMarkdown] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const ownerAccess = useIsOwnerOf(tenant);
  const tokenReady = ownerAccess.ready;
  const hasOwnerToken = ownerAccess.ready && ownerAccess.isOwner;

  // App-route prefix for internal Links and router pushes. In hosted mode
  // every wiki page lives under /<tenant>/...; in single-tenant mode this
  // is empty and routes stay at the root.
  const appPrefix = tenant ? `/${tenant}` : "";

  useEffect(() => {
    if (!slug) return;
    setPage(null);
    setError(null);
    fetchPage(slug, tenant)
      .then(setPage)
      .catch((e) => setError((e as Error).message));
  }, [slug, tenant]);

  async function changeTier(newTier: PageFull["tier"]) {
    if (!page) return;
    try {
      setSavingTier(true);
      await ownerSetTier(page.slug, newTier, tenant);
      const refreshed = await fetchPage(page.slug, tenant);
      setPage(refreshed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingTier(false);
    }
  }

  async function openEditor() {
    if (!page) return;
    setEditError(null);
    try {
      const raw = await ownerGetPageRaw(page.slug, tenant);
      setEditMarkdown(raw.markdown);
      setEditing(true);
    } catch (e) {
      setEditError((e as Error).message);
    }
  }

  async function saveEdits() {
    if (!page) return;
    setEditError(null);
    setSaving(true);
    try {
      await ownerReplacePage(page.slug, editMarkdown, tenant);
      const refreshed = await fetchPage(page.slug, tenant);
      setPage(refreshed);
      setEditing(false);
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-10">
        <div className="p-4 rounded border border-red-200 bg-red-50 text-red-700">
          {error}
        </div>
        <button
          onClick={() => router.push(`${appPrefix}/browse`)}
          className="mt-4 text-sm text-ink-muted hover:text-ink"
        >
          ← back to browse
        </button>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-10 text-sm text-ink-muted">
        loading…
      </div>
    );
  }

  return (
    <article className="max-w-3xl mx-auto px-5 py-8">
      <div className="flex items-center gap-3 text-xs text-ink-muted">
        <Link href={`${appPrefix}/browse`} className="hover:text-ink">browse</Link>
        <span>/</span>
        <span>{page.section}</span>
        <span>/</span>
        <span className="text-ink">{page.slug}</span>
      </div>

      <header className="mt-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          {page.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`uppercase tracking-wide font-semibold border rounded px-1.5 py-0.5 ${tierStyles[page.tier] || ""}`}
          >
            {page.tier}
          </span>
          <span className="text-ink-muted">{page.type}</span>
          {page.created && (
            <span className="text-ink-muted">created {page.created}</span>
          )}
          {page.updated && (
            <span className="text-ink-muted">updated {page.updated}</span>
          )}
          <span className="text-ink-muted">{page.word_count} words</span>
          <span className="text-ink-muted font-mono">{page.rel_path}</span>
        </div>
        {tokenReady && hasOwnerToken && (
          <div className="mt-3 flex flex-wrap gap-2 items-center text-xs">
            <span className="text-ink-muted">Set tier:</span>
            {(["public", "recruiter", "friend", "private"] as const).map((t) => (
              <button
                key={t}
                disabled={savingTier || t === page.tier}
                onClick={() => changeTier(t)}
                className={`px-2 py-1 rounded border ${
                  t === page.tier
                    ? "border-accent text-accent cursor-default"
                    : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
                } disabled:opacity-50`}
              >
                {t}
              </button>
            ))}
            <span className="text-ink-muted">·</span>
            <button
              onClick={editing ? () => setEditing(false) : openEditor}
              className={`px-2 py-1 rounded border ${
                editing
                  ? "border-accent text-accent"
                  : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
              }`}
            >
              {editing ? "exit edit" : "edit"}
            </button>
          </div>
        )}
        {page.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {page.tags.map((t) => (
              <span
                key={t}
                className="text-[11px] bg-paper-soft text-ink-muted px-1.5 py-0.5 rounded"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </header>

      <hr className="my-6 border-paper-soft" />

      {editing ? (
        <section className="bg-white border border-accent/30 rounded-xl p-4">
          <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
            <h2 className="text-sm uppercase tracking-wider text-ink-muted">
              Editing <code className="font-mono text-xs">{page.rel_path}</code>
            </h2>
            <div className="flex gap-2 items-center text-xs">
              <button
                onClick={() => setShowPreview((v) => !v)}
                className={`px-2 py-1 rounded border ${
                  showPreview
                    ? "border-accent text-accent"
                    : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
                }`}
              >
                {showPreview ? "hide preview" : "show preview"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-2 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
              >
                cancel
              </button>
              <button
                onClick={saveEdits}
                disabled={saving}
                className="px-3 py-1 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
              >
                {saving ? "saving…" : "save"}
              </button>
            </div>
          </div>
          {editError && (
            <div className="mb-2 p-2 rounded border border-red-200 bg-red-50 text-red-700 text-xs">
              {editError}
            </div>
          )}
          <div
            className={
              showPreview
                ? "grid lg:grid-cols-2 gap-3"
                : "block"
            }
          >
            <textarea
              value={editMarkdown}
              onChange={(e) => setEditMarkdown(e.target.value)}
              spellCheck={false}
              className="w-full min-h-[60vh] border border-paper-soft rounded p-3 text-sm font-mono bg-paper focus:border-accent focus:outline-none whitespace-pre"
            />
            {showPreview && (
              <div className="min-h-[60vh] border border-paper-soft rounded p-3 bg-paper-soft/40 overflow-y-auto">
                <Markdown>{stripFrontmatter(editMarkdown)}</Markdown>
              </div>
            )}
          </div>
          <div className="mt-2 text-xs text-ink-muted">
            Full markdown editor including frontmatter. Save writes directly to{" "}
            <code className="font-mono">{page.rel_path}</code> and reloads the index.
          </div>
        </section>
      ) : (
        <Markdown>{page.rendered_body || page.body}</Markdown>
      )}

      {(page.links_out_resolved.length > 0 || page.links_in_resolved.length > 0) && (
        <section className="mt-10 grid sm:grid-cols-2 gap-5 border-t border-paper-soft pt-6">
          {page.links_out_resolved.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-ink-muted mb-2">
                Links out
              </h3>
              <ul className="space-y-1 text-sm">
                {page.links_out_resolved.map((l) => (
                  <li key={l.slug}>
                    <Link
                      href={`${appPrefix}/page/${encodeURIComponent(l.slug)}`}
                      className="text-ink hover:text-accent"
                    >
                      → {l.title}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">{l.section}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {page.links_in_resolved.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-ink-muted mb-2">
                Links in
              </h3>
              <ul className="space-y-1 text-sm">
                {page.links_in_resolved.map((l) => (
                  <li key={l.slug}>
                    <Link
                      href={`${appPrefix}/page/${encodeURIComponent(l.slug)}`}
                      className="text-ink hover:text-accent"
                    >
                      ← {l.title}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">{l.section}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {page.sources.length > 0 && (
        <section className="mt-8">
          <h3 className="text-xs uppercase tracking-wider text-ink-muted mb-2">
            Sources (provenance)
          </h3>
          <ul className="text-sm space-y-1 font-mono text-ink-muted">
            {page.sources.map((s) => (
              <li key={s}>· {s}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

// Strip leading YAML frontmatter for the live preview so we don't show the
// `---` fences twice. The actual saved file still includes them; only the
// preview hides them.
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const lines = md.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return md;
  return lines.slice(endIdx + 1).join("\n");
}
