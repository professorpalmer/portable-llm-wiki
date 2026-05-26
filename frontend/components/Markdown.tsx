"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";

// [[Target Title]] or [[Target Title|display label]]. Matches the
// backend WIKILINK_RE in ``wiki.py`` so the frontend can resolve
// wikilinks in canned/streamed content that never went through the
// backend renderer (e.g. HeroStream fallback answers).
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Convert ``[[X]]`` and ``[[X|y]]`` wikilink syntax into standard
 * markdown links keyed by slug. Emits ``/wiki/page/<slug>`` so the
 * existing link handler below picks them up (and rewrites to the
 * tenant-aware route when a tenant is in scope). Kept symmetrical
 * with the backend so wikilinks render identically whether the
 * markdown was streamed from the LLM or hand-baked into a component. */
export function preprocessWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, (_match, target, label) => {
    const display = (label ?? target).trim();
    const slug = slugify(target);
    if (!slug) return display;
    return `[${display}](/wiki/page/${slug})`;
  });
}

export function Markdown({
  children,
  tenant,
}: {
  children: string;
  /** When set, ``/wiki/page/<slug>`` links resolve to
   * ``/<tenant>/page/<slug>``. Without it, they resolve to
   * ``/page/<slug>`` (single-tenant / OSS / preview). */
  tenant?: string;
}) {
  // Inline-rewrite [[wikilinks]] before react-markdown sees the text,
  // since react-markdown doesn't natively understand wiki link syntax.
  const processed = preprocessWikilinks(children);
  return (
    <div className="prose-wiki">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...rest }) {
            if (typeof href === "string" && href.startsWith("/wiki/page/")) {
              const slug = href.replace("/wiki/page/", "");
              const dest = tenant
                ? `/${tenant}/page/${encodeURIComponent(slug)}`
                : `/page/${encodeURIComponent(slug)}`;
              return (
                <Link href={dest} {...(rest as object)}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
