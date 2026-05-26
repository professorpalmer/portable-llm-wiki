// Offline briefing builder — the workaround for LLMs that can't fetch.
//
// THE PROBLEM
// -----------
// Our handshake protocol (/llm?t=<token>) assumes the LLM can fetch
// arbitrary URLs. ChatGPT (today, 2026) ships in several modes; only
// SOME of them have direct URL-fetch capability:
//
//   * Atlas (browser product)           — has fetch ✓
//   * ChatGPT.com with "Browse" mode    — has fetch ✓
//   * ChatGPT.com in "Search" mode      — search only, NO fetch ✗
//   * Claude with web search            — has fetch ✓
//   * Cursor's chat                     — has fetch ✓
//
// In the "search only" environments, pasting a URL just runs a search
// FOR the URL. If the URL isn't already in Bing/Google's index (which
// our hosted, just-deployed wiki isn't), the search returns zero hits
// and the model honestly says "I can't dereference this". The owner
// has no control over which mode the recipient is in when they paste
// a URL into a DM.
//
// THE FIX
// -------
// Don't require the LLM to fetch. Build a single paste-ready blob,
// client-side from the owner's panel, that includes:
//
//   1. The handshake (so the LLM knows the protocol + etiquette)
//   2. The full visible-page manifest (so the LLM knows the catalog)
//   3. The actual markdown of the top pages (so the LLM can quote)
//   4. The original URL (so LLMs that CAN fetch go deeper)
//
// The blob is ~10-20KB of markdown. Pasted directly into any LLM
// (search-mode ChatGPT included), it bootstraps the conversation with
// the wiki's primary content already in context.
//
// WHY CLIENT-SIDE
// ---------------
// All the assembly happens in the owner's browser, using the same
// API endpoints any LLM would call. That way the briefing is a true
// preview — the owner sees exactly what an LLM with fetch would
// receive, with no special server-side path that could drift.
//
// We use the same-origin proxy (rewrites in next.config) for fetches
// so we don't trip CORS — the share panel runs on www.portablellm.wiki
// but the canonical handshake URL has the apex host baked in.
import { toSameOriginPath } from "./llmPrompts";


/** Page summary as returned by /wiki/manifest.json. Mirrors the
 *  backend's to_summary() shape — keeping the type narrow on purpose
 *  so a backend addition doesn't silently change what the briefing
 *  inlines. */
type ManifestPage = {
  slug: string;
  title: string;
  type: string;
  tier: string;
  excerpt?: string | null;
  word_count?: number;
  url?: string;
};


/** Full page payload from /wiki/page/<slug>. Same containment rules
 *  as ManifestPage above. */
type FullPage = ManifestPage & {
  body?: string;
};


/** Build a paste-ready briefing for any LLM, including those with no
 *  fetch capability.
 *
 *  Cancellation: pass an AbortSignal to bail out if the user closes
 *  the dialog mid-build (handshake + manifest + N page fetches can
 *  take a few seconds over a slow link).
 *
 *  Failure mode: if any individual fetch fails we keep going — a
 *  partial briefing (handshake + manifest but no page bodies) is
 *  vastly better than an empty error blob, and the URL is still in
 *  there so fetch-capable LLMs can pick up the slack. We tag missing
 *  sections in the output so the recipient understands the briefing
 *  is partial.
 *
 *  Size budget: we cap inlined page bodies at ~maxBodyBytes total so
 *  the paste doesn't blow up the recipient's context window. Default
 *  20KB is roughly the catalog + 4-6 short pages, plenty for the
 *  first-turn "who is this person" question. */
export async function buildOfflineBriefing(opts: {
  llmUrl: string;
  token: string;
  tenant?: string;
  /** Maximum number of pages to inline. Default 6. */
  maxPages?: number;
  /** Approximate byte budget for inlined page bodies. Default 20480. */
  maxBodyBytes?: number;
  /** Abort the in-flight fetches if the user dismisses the dialog. */
  signal?: AbortSignal;
}): Promise<string> {
  const maxPages = opts.maxPages ?? 6;
  const maxBodyBytes = opts.maxBodyBytes ?? 20480;

  const handshakePath = toSameOriginPath(opts.llmUrl);
  const tenantSeg = opts.tenant ? `/${opts.tenant}` : "";
  const manifestPath = `${tenantSeg}/wiki/manifest.json`;
  const tokenHeader = { "X-Share-Token": opts.token };

  // 1. Handshake. We use the LLM URL the owner already trusts — this
  //    is the same URL the recipient would paste, so the briefing is
  //    a true mirror of "what the LLM would see if it could fetch".
  let handshake = "";
  try {
    const r = await fetch(handshakePath, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: opts.signal,
    });
    if (r.ok) {
      handshake = await r.text();
    }
  } catch {
    /* swallowed — handshake stays empty, output flags it */
  }

  // 2. Manifest. Carry the share token in the header so the manifest
  //    is filtered to exactly the tier the recipient will see — no
  //    accidental leakage of higher-tier titles via the briefing.
  let manifestPages: ManifestPage[] = [];
  let viewerTier = "public";
  let wikiTitle = "";
  try {
    const r = await fetch(manifestPath, {
      headers: { ...tokenHeader, Accept: "application/json" },
      signal: opts.signal,
    });
    if (r.ok) {
      const data: {
        pages?: ManifestPage[];
        viewer_tier?: string;
        wiki_title?: string;
      } = await r.json();
      manifestPages = data.pages ?? [];
      viewerTier = data.viewer_tier ?? "public";
      wikiTitle = data.wiki_title ?? "";
    }
  } catch {
    /* swallowed — manifest stays empty, output flags it */
  }

  // 3. Pick pages to inline. Same priority as the backend's "notable
  //    pages" hint in the handshake: entities first (they answer
  //    "who is this about"), then decisions (high-information per
  //    word), then overviews (the org-level shape), then anything.
  //    Stable ordering inside each bucket — slugs are unique so a
  //    re-build produces the same briefing.
  const byType = (t: string) =>
    manifestPages.filter((p) => p.type === t);
  const priority = [
    ...byType("entity"),
    ...byType("decision"),
    ...byType("overview"),
    ...byType("project"),
    ...byType("concept"),
    ...manifestPages.filter(
      (p) => !["entity", "decision", "overview", "project", "concept"].includes(p.type),
    ),
  ];
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const candidates: ManifestPage[] = [];
  for (const p of priority) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    candidates.push(p);
  }

  // 4. Fetch page bodies one at a time, accumulating until we hit
  //    either the page count cap or the byte budget. Sequential
  //    rather than Promise.all because we want to stop as soon as the
  //    budget is exhausted (no point downloading a 50KB page if we
  //    only have 2KB of budget left).
  const inlined: FullPage[] = [];
  let bytesUsed = 0;
  for (const p of candidates) {
    if (inlined.length >= maxPages) break;
    if (bytesUsed >= maxBodyBytes) break;
    try {
      const r = await fetch(`${tenantSeg}/wiki/page/${p.slug}`, {
        headers: { ...tokenHeader, Accept: "application/json" },
        signal: opts.signal,
      });
      if (!r.ok) continue;
      const full: FullPage = await r.json();
      const bodySize = (full.body || "").length;
      // If THIS page alone would blow the rest of the budget, skip
      // it and try the next (shorter) one. Without this guard a
      // single 30KB page would either fill the briefing alone or
      // be dropped — we'd rather keep the shorter pages and skip
      // the one giant outlier.
      if (bytesUsed + bodySize > maxBodyBytes && inlined.length > 0) continue;
      inlined.push(full);
      bytesUsed += bodySize;
    } catch {
      /* skip and try the next */
    }
  }

  // 5. Assemble the final blob. Use clear ASCII section dividers so
  //    even a model with weak markdown parsing can find the seams.
  const lines: string[] = [];
  lines.push(
    "You are connected to a Portable LLM Wiki — a vendor-neutral, " +
      "markdown-based personal context system. The content below is " +
      "the wiki's protocol handshake, page catalog, and the most " +
      "important pages, included INLINE so you can answer questions " +
      "about the owner without needing to fetch anything else.",
  );
  lines.push("");
  lines.push(
    "If your environment supports web fetch, you can pull additional " +
      "pages from the wiki at this URL (same auth token already baked " +
      "in):",
  );
  lines.push("");
  lines.push(opts.llmUrl);
  lines.push("");
  lines.push("First task: introduce this person to me in 4-6 sentences, " +
    "then list the three most interesting things about them. Cite " +
    "the specific page titles you draw from using `[[Page Title]]` " +
    "syntax.");
  lines.push("");
  lines.push("════════════════════ HANDSHAKE ════════════════════");
  lines.push("");
  if (handshake) {
    lines.push(handshake.trim());
  } else {
    lines.push("(handshake fetch failed — see URL above for live copy)");
  }
  lines.push("");
  lines.push("════════════════════ MANIFEST ════════════════════");
  lines.push("");
  if (manifestPages.length > 0) {
    lines.push(
      `${wikiTitle || "This wiki"} has ${manifestPages.length} ` +
        `page${manifestPages.length === 1 ? "" : "s"} visible at the ` +
        `**${viewerTier}** tier:`,
    );
    lines.push("");
    for (const p of manifestPages) {
      const ex = (p.excerpt || "").trim().replace(/\s+/g, " ");
      const exShort = ex.length > 140 ? ex.slice(0, 140).trimEnd() + "…" : ex;
      lines.push(
        `- **${p.title}** (${p.type}) — ${exShort || "(no excerpt)"}`,
      );
    }
  } else {
    lines.push("(manifest fetch failed — see URL above for live copy)");
  }
  lines.push("");
  lines.push("════════════════════ PAGES ════════════════════");
  lines.push("");
  if (inlined.length > 0) {
    lines.push(
      `The ${inlined.length} highest-priority pages, included in full:`,
    );
    lines.push("");
    for (const p of inlined) {
      lines.push(`## ${p.title}`);
      lines.push(`*type: ${p.type} · tier: ${p.tier}*`);
      lines.push("");
      lines.push((p.body || "").trim());
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    if (manifestPages.length > inlined.length) {
      lines.push(
        `_${manifestPages.length - inlined.length} more page(s) ` +
          "available — fetch the URL above to read them._",
      );
    }
  } else {
    lines.push("(no pages could be fetched — see URL above for live copy)");
  }
  return lines.join("\n");
}


/** True when at least one of handshake/manifest/pages could be
 *  inlined. The button uses this to decide whether to surface a
 *  warning toast ("partial briefing — fetch failed for some pages")
 *  vs the normal "copied!" success. */
export function isBriefingComplete(text: string): boolean {
  // Cheap heuristic: if all three "fetch failed" hints are present,
  // we got nothing useful. If any one is absent, that section worked.
  const handshakeFailed = text.includes("(handshake fetch failed");
  const manifestFailed = text.includes("(manifest fetch failed");
  const pagesFailed = text.includes("(no pages could be fetched");
  return !(handshakeFailed && manifestFailed && pagesFailed);
}
