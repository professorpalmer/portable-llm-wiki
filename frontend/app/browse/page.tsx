"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchManifest, searchWiki, type Manifest, type PageSummary } from "@/lib/api";
import { PageCard } from "@/components/PageCard";
import { useTenant } from "@/lib/useTenant";

const SECTION_ORDER = [
  "projects",
  "concepts",
  "decisions",
  "entities",
  "queries",
  "sources",
  "root",
  "other",
];

export default function BrowsePage() {
  const tenant = useTenant();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [searchResults, setSearchResults] = useState<PageSummary[] | null>(null);
  const [tierFilter, setTierFilter] = useState<string>("");
  const [sectionFilter, setSectionFilter] = useState<string>("");

  useEffect(() => {
    fetchManifest(tenant)
      .then(setManifest)
      .catch((e) => setError((e as Error).message));
  }, [tenant]);

  useEffect(() => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await searchWiki(q, tenant);
        setSearchResults(res.results);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 220);
    return () => clearTimeout(handle);
  }, [q, tenant]);

  const grouped = useMemo(() => {
    if (!manifest) return {} as Record<string, PageSummary[]>;
    const filtered = manifest.pages.filter((p) => {
      if (tierFilter && p.tier !== tierFilter) return false;
      if (sectionFilter && p.section !== sectionFilter) return false;
      return true;
    });
    const groups: Record<string, PageSummary[]> = {};
    for (const p of filtered) {
      if (!groups[p.section]) groups[p.section] = [];
      groups[p.section].push(p);
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => a.title.localeCompare(b.title));
    }
    return groups;
  }, [manifest, tierFilter, sectionFilter]);

  const tiers = useMemo(() => {
    if (!manifest) return [];
    const s = new Set(manifest.pages.map((p) => p.tier));
    return Array.from(s);
  }, [manifest]);

  return (
    <div className="max-w-5xl mx-auto px-5 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Every page visible to your current tier.
      </p>

      <div className="mt-5 flex flex-wrap gap-3 items-center">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pages (title, tags, body)"
          className="flex-1 min-w-[240px] border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none bg-white"
        />
        <select
          value={sectionFilter}
          onChange={(e) => setSectionFilter(e.target.value)}
          className="border border-paper-soft rounded px-2 py-2 text-sm bg-white"
        >
          <option value="">all sections</option>
          {manifest &&
            Object.keys(manifest.sections).map((s) => (
              <option key={s} value={s}>
                {s} ({manifest.sections[s]})
              </option>
            ))}
        </select>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="border border-paper-soft rounded px-2 py-2 text-sm bg-white"
        >
          <option value="">all tiers</option>
          {tiers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mt-6 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {searchResults ? (
        <section className="mt-6">
          <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
            Search · {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
          </h2>
          {searchResults.length === 0 && (
            <div className="text-sm text-ink-muted">No pages match.</div>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            {searchResults.map((p) => (
              <PageCard key={p.slug} page={p} tenant={tenant} />
            ))}
          </div>
        </section>
      ) : manifest ? (
        SECTION_ORDER.filter((s) => grouped[s]?.length).map((section) => (
          <section key={section} className="mt-8">
            <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
              {section} · {grouped[section].length}
            </h2>
            <div className="grid md:grid-cols-2 gap-3">
              {grouped[section].map((p) => (
                <PageCard key={p.slug} page={p} tenant={tenant} />
              ))}
            </div>
          </section>
        ))
      ) : (
        <div className="mt-8 text-sm text-ink-muted">loading…</div>
      )}

      {manifest && manifest.page_count === 0 && (
        <div className="mt-10 p-5 border border-paper-soft rounded-xl bg-white">
          <h3 className="font-semibold">No pages visible at this tier.</h3>
          <p className="mt-1 text-sm text-ink-muted">
            This wiki contains content, but none of it is marked accessible at
            your current tier. If this is your own instance, authenticate as
            owner (click the badge in the nav) to see everything and reassign
            tiers. Otherwise, ask whoever shared this URL with you for a token
            that grants higher access.
          </p>
        </div>
      )}
    </div>
  );
}
