import Link from "next/link";
import type { PageSummary } from "@/lib/api";

const tierStyles: Record<PageSummary["tier"], string> = {
  public: "bg-emerald-50 text-emerald-700 border-emerald-200",
  recruiter: "bg-blue-50 text-blue-700 border-blue-200",
  friend: "bg-purple-50 text-purple-700 border-purple-200",
  private: "bg-red-50 text-red-700 border-red-200",
};

export function PageCard({ page, tenant }: { page: PageSummary; tenant?: string }) {
  // Hosted mode: link to /<tenant>/page/<slug>. Single-tenant: /page/<slug>.
  const href = tenant
    ? `/${encodeURIComponent(tenant)}/page/${encodeURIComponent(page.slug)}`
    : `/page/${encodeURIComponent(page.slug)}`;
  return (
    <Link
      href={href}
      className="block border border-paper-soft rounded-lg p-4 bg-white hover:border-accent transition-colors"
    >
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold text-ink truncate flex-1">{page.title}</h3>
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold border rounded px-1.5 py-0.5 ${tierStyles[page.tier]}`}
        >
          {page.tier}
        </span>
      </div>
      <div className="mt-1 text-xs text-ink-muted flex gap-2">
        <span>{page.section}</span>
        <span>·</span>
        <span>{page.word_count} words</span>
        {page.updated && (
          <>
            <span>·</span>
            <span>updated {page.updated}</span>
          </>
        )}
      </div>
      {page.excerpt && (
        <p className="mt-2 text-sm text-ink-muted line-clamp-3 leading-snug">
          {page.excerpt}
        </p>
      )}
      {page.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {page.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="text-[10px] bg-paper-soft text-ink-muted px-1.5 py-0.5 rounded"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
