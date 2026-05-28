"use client";

// Tenant landing page list — the grouped-by-section catalog of pages a
// visitor sees beneath the "ask this wiki" panel. Lives in its own
// module (instead of inline in app/[tenant]/page.tsx) so:
//
//   1. The Page module can keep its strict Next.js export contract
//      (only `default` + the metadata exports are allowed there).
//   2. PageRow + TierToggle become directly testable from
//      frontend/tests/TenantTierToggle.test.tsx without spinning up
//      the whole landing page and mocking the half-dozen fetches it
//      kicks off on mount.
//
// The big-picture UX: when the viewer owns this tenant, each row shows
// an inline tier dropdown so the owner can re-tier pages without
// clicking into the per-page detail view one at a time. That's how
// you move "my divorce notes" from public → private without leaving
// the landing page. Non-owners see a read-only badge instead.

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  fetchManifest,
  ownerSetTier,
  type Manifest,
  type PageSummary,
  type SyncVerdict,
} from "@/lib/api";
import { SyncWarning } from "@/components/SyncWarning";


// Tailwind classes for tier-coloured pills. Mirrors the per-page detail
// view (frontend/app/page/[slug]/page.tsx) so a glance at the badge here
// matches what the page-detail header shows. Keep these in sync.
const TIER_PILL: Record<PageSummary["tier"], string> = {
  public: "bg-emerald-50 text-emerald-700 border-emerald-200",
  recruiter: "bg-blue-50 text-blue-700 border-blue-200",
  friend: "bg-purple-50 text-purple-700 border-purple-200",
  private: "bg-red-50 text-red-700 border-red-200",
};


export function PageList({
  manifest,
  tenantId,
  isOwnerView,
  onManifestChanged,
}: {
  manifest: Manifest | null;
  tenantId: string;
  /** True when /auth/me resolved a session belonging to this tenant.
   *  Drives whether each row shows a tier-changing dropdown or a
   *  read-only viewer-tier-already-implied label. */
  isOwnerView: boolean;
  /** Called after a successful tier mutation so the parent can refresh
   *  the cached manifest. Each PATCH triggers a manifest refetch (vs
   *  patching the single row locally) because changing tier can move
   *  a page in/out of the visible set for the current viewer entirely. */
  onManifestChanged: (next: Manifest) => void;
}) {
  const pages = manifest?.pages ?? [];
  const grouped = useMemo(() => {
    const out: Record<string, PageSummary[]> = {};
    for (const p of pages) {
      const k = p.section || "other";
      if (!out[k]) out[k] = [];
      out[k].push(p);
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a.title.localeCompare(b.title));
    }
    return out;
  }, [pages]);

  async function onTierChanged() {
    // Refresh from server so the response counts (and visibility set)
    // stay consistent with what the backend believes. Using the same
    // fetcher as the parent means the auth headers travel with it.
    try {
      const next = await fetchManifest(tenantId);
      onManifestChanged(next);
    } catch {
      /* swallow — UI keeps optimistic state */
    }
  }

  if (!manifest) {
    return (
      <section className="mt-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-ink-muted font-semibold">
          Pages
        </div>
        <p className="mt-2 text-sm text-ink-muted">
          Loading or no pages drafted yet.
        </p>
      </section>
    );
  }

  const sectionNames = Object.keys(grouped).sort();
  const total = pages.length;

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-ink-muted font-semibold">
            Pages
          </div>
          <div className="text-lg font-semibold text-ink">
            {total} {total === 1 ? "page" : "pages"} across {sectionNames.length}{" "}
            {sectionNames.length === 1 ? "section" : "sections"}
          </div>
        </div>
        {isOwnerView ? (
          <span
            className="text-[11px] text-ink-muted max-w-[260px] text-right"
            title="Change a page's tier inline. Recruiter scans of your QR see public+recruiter; friends see public+recruiter+friend; private stays on your LLM only."
          >
            click any badge to retier — your LLM sees everything
          </span>
        ) : null}
      </div>

      {total === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          No pages yet. The owner is still drafting.
        </p>
      ) : (
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          {sectionNames.map((section) => (
            <div
              key={section}
              className="border border-paper-soft rounded-2xl bg-white p-4"
            >
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
                  {section}
                </div>
                <div className="text-[11px] text-ink-muted">
                  {grouped[section].length}
                </div>
              </div>
              <ul className="mt-2 space-y-1.5">
                {grouped[section].slice(0, 12).map((p) => (
                  <PageRow
                    key={p.slug}
                    page={p}
                    tenantId={tenantId}
                    isOwnerView={isOwnerView}
                    onTierChanged={onTierChanged}
                  />
                ))}
                {grouped[section].length > 12 && (
                  <li className="text-[11px] text-ink-muted italic">
                    +{grouped[section].length - 12} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


// One row in the section list. Always links to the page detail view;
// the inline tier control is added on the right when the viewer owns
// this tenant. Non-owners see a static tier badge (gives context to
// recruiter/friend viewers who can tell "this page is in my tier" at
// a glance) — public-tier viewers just see a quiet badge too, which
// keeps visual rhythm without leaking information they don't already
// have from the URL they followed.
export function PageRow({
  page,
  tenantId,
  isOwnerView,
  onTierChanged,
}: {
  page: PageSummary;
  tenantId: string;
  isOwnerView: boolean;
  onTierChanged: () => void;
}) {
  return (
    <li className="flex items-center gap-2 min-w-0">
      <Link
        href={`/${tenantId}/page/${encodeURIComponent(page.slug)}`}
        className="flex-1 text-sm text-ink hover:text-accent truncate min-w-0"
      >
        {page.title}
      </Link>
      {isOwnerView ? (
        <TierToggle
          slug={page.slug}
          tier={page.tier}
          tenantId={tenantId}
          onTierChanged={onTierChanged}
        />
      ) : (
        <span
          className={`shrink-0 text-[10px] uppercase tracking-wide font-semibold border rounded px-1.5 py-0.5 ${TIER_PILL[page.tier] || ""}`}
        >
          {page.tier}
        </span>
      )}
    </li>
  );
}


// Inline tier-changer for owners. Renders a styled <select> coloured
// by current tier; switching it PATCHes the backend and then asks the
// parent to refetch the manifest (because changing tier can move a
// page in/out of the visible set for the current viewer entirely —
// e.g. demoting from public to private would, for a recruiter-viewing-
// as-themselves owner-in-recruiter-preview, immediately remove the
// row, which is the right UX signal that "yes, the change landed").
//
// We use a native <select> instead of a custom popover so:
//   * Keyboard users get free arrow-key tier cycling.
//   * Mobile users get the native iOS/Android tier wheel.
//   * We don't have to maintain a positioned floating layer.
//
// The trade-off: native selects don't accept per-option background
// colours on most platforms. We compromise by colouring the SELECT
// itself by current tier (so the row's overall colour matches the
// detail-page badge) while the dropdown options render in the
// platform default.
export function TierToggle({
  slug,
  tier,
  tenantId,
  onTierChanged,
}: {
  slug: string;
  tier: PageSummary["tier"];
  tenantId: string;
  onTierChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncVerdict | null>(null);

  async function onSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as PageSummary["tier"];
    if (next === tier) return;
    setErr(null);
    setSync(null);
    setBusy(true);
    try {
      const res = await ownerSetTier(slug, next, tenantId);
      setSync(res.sync ?? null);
      onTierChanged();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {err && (
          <span
            className="text-[10px] text-red-700 max-w-[160px] truncate"
            title={err}
          >
            {err}
          </span>
        )}
        <select
          value={tier}
          onChange={onSelect}
          disabled={busy}
          aria-label={`Change tier for ${slug}`}
          title="Change this page's tier. The badge colour mirrors the detail page."
          className={`text-[10px] uppercase tracking-wide font-semibold border rounded px-1.5 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-ink ${TIER_PILL[tier] || ""} ${busy ? "opacity-50 cursor-wait" : ""}`}
        >
          <option value="public">public</option>
          <option value="recruiter">recruiter</option>
          <option value="friend">friend</option>
          <option value="private">private</option>
        </select>
      </div>
      <SyncWarning sync={sync} />
    </div>
  );
}
