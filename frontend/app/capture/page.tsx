"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  isHostedMode,
  llmWritebackSpecUrl,
  onboardingImportUrl,
  ownerCaptureAudio,
  ownerCaptureConfig,
  ownerCaptureImage,
  ownerCapturePaste,
  ownerCaptureStructured,
  ownerCaptureVerbatim,
  type CaptureConfig,
  type CaptureResult,
  type OnboardingImportResponse,
  type VerbatimCaptureResult,
  type WritebackResult,
} from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import { useIsOwnerOf } from "@/lib/useIsOwner";
import { OwnerGate } from "@/components/OwnerGate";
import { SyncWarning } from "@/components/SyncWarning";

type Mode = "paste" | "url" | "verbatim" | "from-llm" | "image" | "voice";
type Subdir = "conversations" | "articles" | "meetings" | "assets";

const SUBDIRS: Subdir[] = ["conversations", "articles", "meetings", "assets"];

export default function CapturePage() {
  const tenant = useTenant();
  return (
    <OwnerGate tenant={tenant}>
      <CapturePageInner tenant={tenant} />
    </OwnerGate>
  );
}

function CapturePageInner({ tenant }: { tenant?: string }) {
  const ownerAccess = useIsOwnerOf(tenant);
  const isOwner = ownerAccess.ready && ownerAccess.isOwner;
  const hosted = isHostedMode();
  // Screenshot + voice both depend on server-side LLM keys
  // (OPENAI_API_KEY for Whisper, ANTHROPIC/OPENAI for vision). The
  // hosted deploy intentionally doesn't ship those — costs would
  // accrue to us, not the user, and the donations-funded model
  // doesn't pencil. So in hosted mode we only show "paste" + "url"
  // (neither needs a transcription LLM — the optional ingest step
  // uses the chat-LLM which IS configured server-side). Self-hosters
  // get the full set including screenshot + voice memo.
  // "from-llm" works in both hosted + self-host: it's pure validation +
  // file writes, no server-side LLM call. The LLM the user was chatting
  // with already produced the structured content client-side.
  // "verbatim" is the trusted-input cousin of "from-llm" — same
  // no-LLM-pass guarantee, but for a single markdown file with
  // frontmatter rather than the structured-JSON shape an LLM produces.
  // Useful for hand-drafted pages and for pasting curated LLM output
  // you've already reviewed (where the JSON-roundtrip would be lossy).
  const availableModes: readonly Mode[] = hosted
    ? (["paste", "url", "verbatim", "from-llm"] as const)
    : (["paste", "url", "verbatim", "from-llm", "image", "voice"] as const);
  const [mode, setMode] = useState<Mode>("paste");
  const [cfg, setCfg] = useState<CaptureConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    ownerCaptureConfig(tenant)
      .then(setCfg)
      .catch((e) => setCfgError((e as Error).message));
  }, [isOwner, tenant]);

  if (!ownerAccess.ready) {
    return <div className="max-w-3xl mx-auto px-5 py-10 text-sm text-ink-muted">loading…</div>;
  }

  if (!isOwner) {
    return <CaptureDemoPreview tenant={tenant} />;
  }

  return (
    <div className="max-w-3xl mx-auto px-5 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Capture</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {hosted
            ? "Paste text, scrape a URL, or push structured pages back from a ChatGPT/Claude session. We write what you give us and (optionally) ingest it into structured wiki pages."
            : "Frictionless ingest. Drop a screenshot, paste a Slack thread, scrape a URL, push pages back from an LLM session, record a voice memo. We write a raw source you can then review and run through the full ingest pipeline."}
        </p>
        {hosted && (
          <p className="mt-2 text-xs text-ink-muted">
            Screenshot + voice memo are self-host only — they need server-side
            transcription keys that the hosted deploy doesn&apos;t ship.{" "}
            <a
              href="https://github.com/professorpalmer/portable-llm-wiki#self-host"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Self-host to enable them
            </a>
            .
          </p>
        )}
      </header>

      {cfgError && (
        <div className="mb-4 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          Couldn't load capture config: {cfgError}
        </div>
      )}

      {availableModes.length > 1 && (
        <nav className="flex gap-2 mb-5 border-b border-paper-soft">
          {availableModes.map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px transition ${
                mode === m
                  ? "border-accent text-ink font-medium"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {m === "paste" && "paste"}
              {m === "url" && "url"}
              {m === "verbatim" && "verbatim"}
              {m === "from-llm" && "from LLM"}
              {m === "image" && "screenshot"}
              {m === "voice" && "voice memo"}
            </button>
          ))}
        </nav>
      )}

      {mode === "paste" && <PastePanel tenant={tenant} />}
      {mode === "url" && <UrlPanel tenant={tenant} />}
      {mode === "verbatim" && <VerbatimPanel tenant={tenant} />}
      {mode === "from-llm" && <FromLLMPanel tenant={tenant} />}
      {mode === "image" && !hosted && <ImagePanel cfg={cfg} tenant={tenant} />}
      {mode === "voice" && !hosted && <VoicePanel cfg={cfg} tenant={tenant} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SubdirPicker({
  value,
  onChange,
}: {
  value: Subdir;
  onChange: (s: Subdir) => void;
}) {
  return (
    <label className="text-xs text-ink-muted flex items-center gap-2">
      Save under raw/
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Subdir)}
        className="border border-paper-soft rounded px-2 py-1 text-xs bg-paper"
      >
        {SUBDIRS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}

function ResultCard({
  result,
  label,
  tenant,
}: {
  result: CaptureResult;
  label: string;
  tenant?: string;
}) {
  return (
    <div className="mt-5 p-4 rounded border border-emerald-200 bg-emerald-50 text-sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-medium text-emerald-800">{label}</div>
          <div className="text-xs text-emerald-700 mt-0.5 font-mono">{result.rel_path}</div>
          {result.asset_rel_path && (
            <div className="text-xs text-emerald-700 mt-0.5 font-mono">
              asset: {result.asset_rel_path}
            </div>
          )}
          <div className="text-xs text-emerald-700 mt-0.5">
            {result.size.toLocaleString()} chars
            {result.transcribed_by && ` · transcribed by ${result.transcribed_by}`}
          </div>
        </div>
        {result.orchestrator?.tracking_id && (
          <Link
            href={`${tenant ? `/${tenant}` : ""}/owner`}
            className="text-xs underline text-emerald-800 hover:text-emerald-900"
          >
            ingest job {result.orchestrator.tracking_id.slice(0, 8)}… →
          </Link>
        )}
      </div>
      {result.text_preview && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-emerald-800 hover:text-emerald-900">
            Preview transcribed text ({result.text_preview.length} chars)
          </summary>
          <pre className="mt-2 text-xs text-emerald-900 whitespace-pre-wrap font-mono bg-emerald-100/60 p-2 rounded max-h-64 overflow-y-auto">
            {result.text_preview}
          </pre>
        </details>
      )}
    </div>
  );
}

function IngestToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  // This control defaults ON. The label reads as "uncheck to opt OUT
  // of the default ingest". Phrased the other way around it looked
  // like a power-user feature, which made most users skip it and end
  // up with orphan raw files that never became wiki pages.
  //
  // The backend now picks the ingest backend automatically:
  //   * self-host with Puppetmaster on PATH  -> orchestrator (deeper agent run)
  //   * hosted / no Puppetmaster              -> direct_drafter (1-5 focused pages)
  // So the UI no longer has to explain "Self-host only" for ingest —
  // it works everywhere.
  return (
    <label className="flex items-start gap-2 text-xs text-ink-muted cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="text-ink">
          Generate wiki pages from this capture.
        </span>{" "}
        Uncheck to save the raw source only (e.g. for batch review,
        archive snapshots, or large dumps you want to process later).
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Paste panel
// ---------------------------------------------------------------------------

function PastePanel({ tenant }: { tenant?: string }) {
  const [content, setContent] = useState("");
  const [label, setLabel] = useState("");
  const [subdir, setSubdir] = useState<Subdir>("conversations");
  // Ingest defaults ON across the capture surface. The product
  // promise is "capture -> wiki page". Defaulting OFF makes ingest
  // an opt-in to the main feature, which is exactly backwards. The
  // toggle stays as a secondary opt-out for raw-only saves (big
  // PDF dumps, batch reviews, archive snapshots).
  const [runIngest, setRunIngest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (content.trim().length < 1) {
      setError("Paste something first.");
      return;
    }
    if (label.trim().length < 1) {
      setError("Give it a short label so the filename is meaningful.");
      return;
    }
    setSaving(true);
    try {
      const res = await ownerCapturePaste(
        {
          content,
          label: label.trim(),
          subdir,
          run_orchestrator: runIngest,
        },
        tenant,
      );
      setResult(res);
      setContent("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <label className="block text-xs text-ink-muted mb-1">Label (becomes filename slug)</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. slack-thread-on-portable-wiki"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-ink-muted mb-1">
          Content. Paste a chat thread, article excerpt, transcript, anything.
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={`A [9:22 PM]\nOoh that is cool\n\nB [9:26 PM]\nIt auto ingests every so often…`}
          spellCheck={false}
          className="w-full min-h-[40vh] border border-paper-soft rounded p-3 text-sm font-mono focus:border-accent focus:outline-none"
        />
        <div className="mt-1 text-xs text-ink-muted">
          {content.length.toLocaleString()} chars
        </div>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <SubdirPicker value={subdir} onChange={setSubdir} />
        <IngestToggle value={runIngest} onChange={setRunIngest} />
      </div>
      {error && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}
      <button
        onClick={submit}
        disabled={saving}
        className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
      >
        {saving
          ? runIngest
            ? "saving + ingesting…"
            : "saving…"
          : runIngest
            ? "capture + ingest"
            : "save raw only"}
      </button>

      {result && (
        <ResultCard
          result={result}
          label={runIngest ? "Captured + ingest queued" : "Saved (raw only)"}
          tenant={tenant}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// URL panel — scrape any public webpage as a raw source
// ---------------------------------------------------------------------------
//
// Wires the post-onboarding URL scrape into the capture surface. The
// backend endpoint (/onboarding/import-url) is reusable post-onboarding
// — it's just named for its primary caller. Path is:
//
//   user pastes URL
//     → backend fetches + extracts main content (url_scrape.scrape)
//     → writes raw/imports/<id>.md
//     → if run_orchestrator: Puppetmaster drafts entities/concepts/
//       decisions pages with citations back to the raw source.
//
// The "Run ingest" toggle is opt-OUT (default ON) because the user
// almost always wants the structured wiki pages when scraping. They
// can flip it off to just stash the raw scrape for later.

function UrlPanel({ tenant }: { tenant?: string }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [runIngest, setRunIngest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OnboardingImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Paste a URL first.");
      return;
    }
    if (!/^https?:\/\//.test(trimmed)) {
      setError("URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await onboardingImportUrl({
        url: trimmed,
        label: label.trim() || undefined,
        run_orchestrator: runIngest,
      });
      setResult(res);
      if (res.ok) {
        setUrl("");
        setLabel("");
      } else {
        setError(
          `Scrape failed — the URL may be unreachable, behind auth, or block automated requests.`,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <label className="block text-xs text-ink-muted mb-1">URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-portfolio.com/about"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
          disabled={saving}
        />
        <p className="mt-1 text-xs text-ink-muted">
          Works on most public pages: portfolio sites, blog posts,
          documentation, Substack, LinkedIn About, GitHub READMEs.
          Pages behind auth or with anti-bot guards may fail.
        </p>
      </div>
      <div>
        <label className="block text-xs text-ink-muted mb-1">
          Label (optional)
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. my-portfolio-about-section"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
          disabled={saving}
        />
      </div>

      <div className="flex items-start justify-between flex-wrap gap-3">
        <label className="flex items-start gap-2 text-xs text-ink-muted cursor-pointer max-w-xl">
          <input
            type="checkbox"
            checked={runIngest}
            onChange={(e) => setRunIngest(e.target.checked)}
            className="mt-0.5"
            disabled={saving}
          />
          <span>
            <span className="text-ink">
              Ingest into structured wiki pages.
            </span>{" "}
            Drafts entities, concepts, and decisions extracted from the
            scrape, each citing the raw source. Uncheck to save only the
            raw markdown.
          </span>
        </label>
      </div>

      {error && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={saving}
        className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
      >
        {saving
          ? runIngest
            ? "scraping + ingesting…"
            : "scraping…"
          : runIngest
            ? "scrape + ingest"
            : "scrape (raw only)"}
      </button>

      {result?.ok && (
        <div className="mt-2 p-4 rounded border border-emerald-200 bg-emerald-50 text-sm">
          <div className="font-medium text-emerald-800">
            Scraped
            {result.scraped?.title ? `: ${result.scraped.title}` : ""}
          </div>
          <div className="mt-1 text-xs text-emerald-700 font-mono">
            {result.raw_path}
          </div>
          {typeof result.scraped?.word_count === "number" && (
            <div className="mt-0.5 text-xs text-emerald-700">
              {result.scraped.word_count.toLocaleString()} words extracted
            </div>
          )}
          {result.orchestrator_started && result.tracking_id && (
            <div className="mt-2 text-xs text-emerald-800">
              Ingest job{" "}
              <a
                href={`${tenant ? `/${tenant}` : ""}/owner`}
                className="underline hover:text-emerald-900"
              >
                {result.tracking_id.slice(0, 8)}…
              </a>{" "}
              running — new wiki pages will land in a few minutes.
            </div>
          )}
          {!result.orchestrator_started && runIngest && (
            <div className="mt-2 text-xs text-amber-700">
              Ingest did not start. Raw scrape is saved; you can re-run
              ingest from the owner console.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Verbatim panel — paste a complete markdown file (frontmatter + body)
// and have the wiki save it exactly as-is to wiki/<section>/<slug>.md
// with no LLM in the loop.
// ---------------------------------------------------------------------------
//
// The trusted-input path. Every other capture mode either:
//   * runs the input through an LLM (paste/url/image/voice) which
//     fragments it into 1-5 drafter-decided pages with forced-private
//     tier, OR
//   * accepts pre-structured JSON (from-llm) which is fine for chat
//     output but lossy if you want to preserve exact frontmatter +
//     body markdown.
//
// Verbatim closes the gap: you wrote a page, you want it saved as
// you wrote it. Frontmatter wins (including tier). Bytes preserved.
//
// Light client-side validation extracts ``type`` and ``title`` from
// the frontmatter so the preview can show "this will land at
// wiki/<section>/<slug>.md as tier: X". Strict validation happens
// server-side; client only catches the obvious mistakes (missing
// frontmatter, unknown type) before bothering the network.

const VERBATIM_TYPES = [
  "entity",
  "concept",
  "decision",
  "project",
  "query",
  "source",
] as const;

type VerbatimType = (typeof VERBATIM_TYPES)[number];

const TYPE_TO_SECTION: Record<VerbatimType, string> = {
  entity: "entities",
  concept: "concepts",
  decision: "decisions",
  project: "projects",
  query: "queries",
  source: "sources",
};

type VerbatimPreview = {
  type: VerbatimType;
  title: string;
  tier: "public" | "recruiter" | "friend" | "private";
  customSlug: string | null;
  bodyChars: number;
};

/** Hand-rolled frontmatter peek. Server does the real validation;
 *  this just gives the user a live preview of what we'll send. We
 *  parse only the leading ``---`` block, scan for the few fields we
 *  care about, and bail (return null) on anything ambiguous.
 *
 *  We don't pull in js-yaml just for this — frontmatter values come
 *  in two flavors: scalars (``title: Foo``) and short arrays
 *  (``tags: [a, b]``). We only need scalars, so a regex per field is
 *  cheaper than a full YAML parser. */
function previewFrontmatter(content: string): VerbatimPreview | null {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) {
    return null;
  }
  const closingIdx = trimmed.indexOf("\n---", 4);
  if (closingIdx === -1) return null;
  const fmBlock = trimmed.slice(4, closingIdx);
  const afterClose = closingIdx + "\n---".length;
  // The body starts after the next newline following the closing
  // ``---`` marker. We tolerate ``---\n`` (typical) and ``---<EOF>``.
  const body = trimmed
    .slice(afterClose)
    .replace(/^\r?\n/, "")
    .trim();

  function field(name: string): string | null {
    // Match ``<name>: value`` at the start of a line. Strip surrounding
    // quotes if present. Multiline values aren't supported (they'd be
    // unusual for the fields we care about anyway).
    const re = new RegExp(`^${name}:\\s*(.+)$`, "mi");
    const m = fmBlock.match(re);
    if (!m) return null;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }

  const rawType = field("type");
  const title = field("title");
  if (!rawType || !title) return null;
  if (!VERBATIM_TYPES.includes(rawType as VerbatimType)) return null;
  const rawTier = field("tier");
  const tier =
    rawTier === "public" ||
    rawTier === "recruiter" ||
    rawTier === "friend" ||
    rawTier === "private"
      ? rawTier
      : "private";
  return {
    type: rawType as VerbatimType,
    title,
    tier,
    customSlug: field("slug"),
    bodyChars: body.length,
  };
}

const VERBATIM_PLACEHOLDER = `---
type: source
title: 2025 Performance Review
tier: private
tags: [foreflight, performance-review, 2025]
---

# 2025 Performance Review

Body content. Cross-references like [[ForeFlight ML Systems]] survive.
`;

function VerbatimPanel({ tenant }: { tenant?: string }) {
  const [content, setContent] = useState("");
  const [slugOverride, setSlugOverride] = useState("");
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerbatimCaptureResult | null>(null);

  const preview = content.trim() ? previewFrontmatter(content) : null;
  // Effective slug (what the server will likely use). Mirrors the
  // backend resolution order: explicit override > frontmatter slug >
  // title-derived. We slugify locally for the preview only — server
  // is the source of truth.
  const previewSlug = (() => {
    const source = slugOverride.trim() || preview?.customSlug || preview?.title;
    if (!source) return "";
    return source
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  })();
  const previewPath =
    preview && previewSlug
      ? `wiki/${TYPE_TO_SECTION[preview.type]}/${
          preview.type === "decision" && !/^\d{4}-\d{2}-\d{2}-/.test(previewSlug)
            ? `<today>-${previewSlug}`
            : previewSlug
        }.md`
      : null;

  async function submit() {
    setError(null);
    if (content.trim().length === 0) {
      setError("Paste a markdown file with YAML frontmatter.");
      return;
    }
    if (!preview) {
      setError(
        "Couldn't find a valid frontmatter block. The first line must be '---' and the block must include 'type:' (one of: entity, concept, decision, project, query, source) and 'title:'.",
      );
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await ownerCaptureVerbatim(
        {
          content,
          slug: slugOverride.trim() || undefined,
          force_overwrite: forceOverwrite,
        },
        tenant,
      );
      setResult(res);
      setContent("");
      setSlugOverride("");
      setForceOverwrite(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="p-3 rounded border border-paper-soft bg-paper-soft/40 text-xs text-ink-muted">
        <span className="text-ink font-medium">Verbatim mode.</span> Paste a
        full markdown file (frontmatter + body) and we&apos;ll write it
        directly to{" "}
        <span className="font-mono">wiki/&lt;section&gt;/&lt;slug&gt;.md</span>{" "}
        with the bytes preserved exactly. No LLM pass, no fragmentation.
        Tier is set by your{" "}
        <span className="font-mono">tier:</span> frontmatter field — this is
        the one capture path where{" "}
        <span className="text-ink">tier is not force-clamped to private</span>,
        so be deliberate about what you mark{" "}
        <span className="font-mono">public</span>.
      </div>

      <div>
        <label className="block text-xs text-ink-muted mb-1">
          Markdown content (frontmatter + body)
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={VERBATIM_PLACEHOLDER}
          spellCheck={false}
          className="w-full min-h-[50vh] border border-paper-soft rounded p-3 text-xs font-mono focus:border-accent focus:outline-none"
          data-testid="verbatim-content-input"
        />
        <div className="mt-1 text-xs text-ink-muted">
          {content.length.toLocaleString()} chars
          {preview && (
            <>
              {" · "}
              <span className="text-ink">body</span>{" "}
              {preview.bodyChars.toLocaleString()} chars
            </>
          )}
        </div>
      </div>

      <div>
        <label className="block text-xs text-ink-muted mb-1">
          Slug override (optional — defaults to slugified title or
          frontmatter <span className="font-mono">slug:</span> field)
        </label>
        <input
          value={slugOverride}
          onChange={(e) => setSlugOverride(e.target.value)}
          placeholder="e.g. 2025-performance-review"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
          data-testid="verbatim-slug-input"
        />
      </div>

      {preview && previewPath && (
        <div
          className="p-3 rounded border border-paper-soft bg-paper text-xs space-y-1"
          data-testid="verbatim-preview"
        >
          <div className="text-ink-muted">Will write to:</div>
          <div className="font-mono text-ink">{previewPath}</div>
          <div className="text-ink-muted mt-2">
            <span className="font-medium text-ink">{preview.title}</span>
            {" · "}
            type <span className="font-mono">{preview.type}</span>
            {" · "}
            tier{" "}
            <span
              className={`font-mono ${
                preview.tier === "public"
                  ? "text-rose-700"
                  : preview.tier === "recruiter"
                    ? "text-amber-700"
                    : preview.tier === "friend"
                      ? "text-emerald-700"
                      : "text-ink"
              }`}
              data-testid="verbatim-preview-tier"
            >
              {preview.tier}
            </span>
            {preview.tier === "public" && (
              <span className="ml-2 text-rose-700">
                — visible to anyone, no auth required
              </span>
            )}
          </div>
        </div>
      )}

      {content.trim().length > 0 && !preview && (
        <div
          className="p-3 rounded border border-amber-200 bg-amber-50 text-xs text-amber-900"
          data-testid="verbatim-no-preview"
        >
          Can&apos;t preview yet — content needs a valid YAML frontmatter
          block at the top with at least{" "}
          <span className="font-mono">type:</span> (one of:{" "}
          {VERBATIM_TYPES.join(", ")}) and{" "}
          <span className="font-mono">title:</span>.
        </div>
      )}

      <label className="flex items-start gap-2 text-xs text-ink-muted cursor-pointer">
        <input
          type="checkbox"
          checked={forceOverwrite}
          onChange={(e) => setForceOverwrite(e.target.checked)}
          className="mt-0.5"
          data-testid="verbatim-force-overwrite"
        />
        <span>
          <span className="text-ink">Overwrite if a page with this slug already exists.</span>{" "}
          Off by default — conflicts get a{" "}
          <span className="font-mono">-verbatim-&lt;today&gt;</span> suffix so
          your existing page is preserved. Flip on for iterating on the same
          page (typo fixes, re-submissions).
        </span>
      </label>

      {error && (
        <div
          className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700"
          data-testid="verbatim-error"
        >
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={saving || !preview}
        className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
        data-testid="verbatim-submit"
      >
        {saving ? "saving…" : "save verbatim"}
      </button>

      {result && (
        <div
          className="mt-2 p-4 rounded border border-emerald-200 bg-emerald-50 text-sm"
          data-testid="verbatim-result"
        >
          <div className="font-medium text-emerald-800">
            {result.overwrote_existing
              ? "Replaced existing page"
              : result.conflict
                ? "Saved (existing page preserved)"
                : "Saved"}
          </div>
          <div className="mt-1 text-xs text-emerald-700 font-mono">
            {result.written.rel_path}
          </div>
          <div className="mt-1 text-xs text-emerald-700">
            <Link
              href={`${tenant ? `/${tenant}` : ""}/page/${encodeURIComponent(
                result.written.slug,
              )}`}
              className="underline hover:text-emerald-900"
            >
              {result.written.title}
            </Link>{" "}
            · type{" "}
            <span className="font-mono">{result.written.page_type}</span> ·
            tier <span className="font-mono">{result.written.tier}</span>
          </div>
          {result.conflict && (
            <div className="mt-2 p-2 rounded bg-amber-100/70 border border-amber-200 text-xs text-amber-900">
              A page with this slug already existed. We saved your new version
              as <span className="font-mono">{result.conflict.wrote_as}</span>{" "}
              instead of overwriting. Re-submit with &ldquo;overwrite&rdquo;
              checked to replace the existing page.
            </div>
          )}
          <SyncWarning sync={result.sync} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// From-LLM panel — accept pre-structured JSON from a ChatGPT/Claude session.
//
// The "writeback loop":
//   1. user shares wiki URL/QR with their LLM of choice
//   2. they iterate together (build, code, decide, learn)
//   3. they ask the LLM to structure the conversation into wiki pages,
//      pointing it at /llm-writeback-spec for the schema
//   4. they paste the LLM's JSON here
//   5. this panel previews + commits
//
// Why a paste flow instead of an API key + direct LLM call from the
// browser: keeps us out of "we're charging the user OR paying for
// their LLM tokens" territory. The user's LLM did the work; we just
// validate + file.
// ---------------------------------------------------------------------------

type FromLLMStep = "edit" | "preview" | "done";

type ParsedDraft = {
  session_label: string;
  pages: Array<{
    slug?: string;
    title: string;
    section: "entities" | "concepts" | "decisions" | "projects" | "queries";
    tags?: string[];
    body: string;
  }>;
};

function FromLLMPanel({ tenant }: { tenant?: string }) {
  const [json, setJson] = useState("");
  const [parsed, setParsed] = useState<ParsedDraft | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [step, setStep] = useState<FromLLMStep>("edit");
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<WritebackResult | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const specUrl = llmWritebackSpecUrl();
  const promptText = `Please read ${specUrl} for the exact JSON format my personal LLM wiki uses for writeback. Then turn the useful parts of our conversation into wiki pages matching that schema. Output ONLY the JSON object — no commentary, no markdown fences. Use [[wikilinks]] to cross-reference pages where it makes sense.`;

  function copyPrompt() {
    navigator.clipboard.writeText(promptText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  }

  function tryPreview() {
    setParseError(null);
    const trimmed = json.trim();
    if (!trimmed) {
      setParseError("Paste the JSON your LLM produced.");
      return;
    }
    // Tolerate fenced output — some LLMs ignore the "no fences" rule.
    let candidate = trimmed;
    const fence = candidate.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
    if (fence) candidate = fence[1].trim();
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch (e) {
      setParseError(`Not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      setParseError("Expected a JSON object at the top level.");
      return;
    }
    const o = obj as Record<string, unknown>;
    const label = typeof o.session_label === "string" ? o.session_label.trim() : "";
    if (label.length < 3) {
      setParseError(
        "Missing or too-short `session_label` (must be >= 3 chars). " +
          "It becomes the citation on every page so provenance stays " +
          "attached.",
      );
      return;
    }
    const pages = o.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      setParseError("Missing or empty `pages` array.");
      return;
    }
    if (pages.length > 50) {
      setParseError(
        `Too many pages (${pages.length}). Writeback caps at 50 per commit.`,
      );
      return;
    }
    // Light client-side validation — backend will do the strict pass.
    const cleaned: ParsedDraft["pages"] = [];
    const validSections = new Set([
      "entities",
      "concepts",
      "decisions",
      "projects",
      "queries",
    ]);
    for (const [i, p] of pages.entries()) {
      if (typeof p !== "object" || p === null) {
        setParseError(`Page ${i} is not an object.`);
        return;
      }
      const pr = p as Record<string, unknown>;
      const title = typeof pr.title === "string" ? pr.title.trim() : "";
      const section =
        typeof pr.section === "string" ? pr.section.trim().toLowerCase() : "";
      const body = typeof pr.body === "string" ? pr.body.trim() : "";
      if (!title || !body || !validSections.has(section)) {
        setParseError(
          `Page ${i} is incomplete. Required: title, body, section (one of: ${[
            ...validSections,
          ].join(", ")}).`,
        );
        return;
      }
      cleaned.push({
        slug: typeof pr.slug === "string" ? pr.slug : undefined,
        title,
        section: section as ParsedDraft["pages"][number]["section"],
        body,
        tags: Array.isArray(pr.tags)
          ? (pr.tags.filter((t) => typeof t === "string") as string[])
          : undefined,
      });
    }
    setParsed({ session_label: label, pages: cleaned });
    setStep("preview");
  }

  async function commit() {
    if (!parsed) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await ownerCaptureStructured(
        {
          session_label: parsed.session_label,
          pages: parsed.pages,
        },
        tenant,
      );
      setResult(res);
      setStep("done");
    } catch (e) {
      setCommitError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setJson("");
    setParsed(null);
    setParseError(null);
    setResult(null);
    setCommitError(null);
    setStep("edit");
  }

  if (step === "done" && result) {
    return (
      <section className="space-y-4">
        <div className="p-4 rounded border border-emerald-200 bg-emerald-50">
          <div className="text-sm font-medium text-emerald-800">
            Wrote {result.page_count} page{result.page_count === 1 ? "" : "s"}{" "}
            from <span className="font-mono">{result.session_label}</span>.
          </div>
          <ul className="mt-3 space-y-1">
            {result.written.map((p) => (
              <li key={p.rel_path} className="text-xs text-emerald-900">
                <span className="inline-block w-20 text-emerald-700">
                  {p.section}
                </span>
                <Link
                  href={`${tenant ? `/${tenant}` : ""}/page/${encodeURIComponent(
                    p.slug,
                  )}`}
                  className="underline hover:text-emerald-700"
                >
                  {p.title}
                </Link>{" "}
                <span className="text-emerald-700">· tier {p.tier}</span>
              </li>
            ))}
          </ul>
          {result.conflicts.length > 0 && (
            <div className="mt-3 p-2 rounded bg-amber-100/70 border border-amber-200 text-xs text-amber-900">
              <div className="font-medium">
                {result.conflicts.length} slug
                {result.conflicts.length === 1 ? "" : "s"} already existed:
              </div>
              <ul className="mt-1 space-y-0.5">
                {result.conflicts.map((c) => (
                  <li key={c.slug} className="font-mono">
                    {c.slug} → wrote as {c.wrote_as}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.errors.length > 0 && (
            <details className="mt-3 text-xs text-emerald-900">
              <summary className="cursor-pointer">
                {result.errors.length} validation warning
                {result.errors.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5 ml-4 list-disc">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-xs text-emerald-900">
            All pages start at <span className="font-mono">tier: private</span>.
            Open each one to review and promote when you&apos;re ready.
          </p>
        </div>
        <button
          onClick={reset}
          className="px-4 py-2 rounded border border-paper-soft text-sm hover:border-ink"
        >
          Send another batch
        </button>
      </section>
    );
  }

  if (step === "preview" && parsed) {
    return (
      <section className="space-y-4">
        <div className="p-3 rounded border border-paper-soft bg-paper-soft/40">
          <div className="text-xs text-ink-muted">Session</div>
          <div className="font-mono text-sm text-ink">{parsed.session_label}</div>
          <div className="mt-2 text-xs text-ink-muted">
            {parsed.pages.length} page{parsed.pages.length === 1 ? "" : "s"} to
            write. All will land at{" "}
            <span className="font-mono">tier: private</span>; you review and
            promote.
          </div>
        </div>

        <ol className="space-y-3">
          {parsed.pages.map((p, i) => (
            <li
              key={i}
              className="p-3 rounded border border-paper-soft bg-paper"
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-paper-soft text-ink-muted">
                  {p.section}
                </span>
                <h3 className="text-sm font-semibold text-ink">{p.title}</h3>
                {p.slug && (
                  <span className="text-xs text-ink-muted font-mono">
                    {p.slug}
                  </span>
                )}
              </div>
              {p.tags && p.tags.length > 0 && (
                <div className="mt-1 flex gap-1 flex-wrap">
                  {p.tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-paper-soft text-ink-muted"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-ink-muted line-clamp-3 whitespace-pre-wrap">
                {p.body.slice(0, 280)}
                {p.body.length > 280 && "…"}
              </p>
            </li>
          ))}
        </ol>

        {commitError && (
          <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
            {commitError}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={commit}
            disabled={committing}
            className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
          >
            {committing
              ? "committing…"
              : `Commit ${parsed.pages.length} page${parsed.pages.length === 1 ? "" : "s"}`}
          </button>
          <button
            onClick={() => setStep("edit")}
            disabled={committing}
            className="px-4 py-2 rounded border border-paper-soft text-sm hover:border-ink disabled:opacity-50"
          >
            Back to JSON
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div className="p-4 rounded border border-paper-soft bg-paper-soft/40">
        <h2 className="text-sm font-semibold text-ink">
          1. Give your LLM this prompt
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          After a productive chat, paste this into ChatGPT / Claude /
          Cursor / wherever. The link below is the public spec your LLM
          fetches to learn the exact JSON shape we accept.
        </p>
        <pre className="mt-3 text-xs font-mono text-ink whitespace-pre-wrap bg-paper border border-paper-soft rounded p-3">
          {promptText}
        </pre>
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <button
            onClick={copyPrompt}
            className="px-3 py-1.5 rounded border border-paper-soft text-xs hover:border-ink"
          >
            {copied ? "copied!" : "copy prompt"}
          </button>
          <a
            href={specUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline decoration-dotted underline-offset-2 text-ink-muted hover:text-ink"
          >
            view spec ({specUrl}) →
          </a>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-ink">
          2. Paste the JSON your LLM produced
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          We&apos;ll parse it, show you a preview, and only write to disk
          after you confirm. Fenced{" "}
          <code className="font-mono text-[10px] px-1 bg-paper-soft rounded">
            ```json
          </code>{" "}
          blocks are tolerated.
        </p>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={`{\n  "session_label": "chatgpt-2026-05-24-pricing",\n  "pages": [\n    { "title": "...", "section": "concepts", "body": "...", "tags": ["..."] }\n  ]\n}`}
          rows={14}
          className="mt-2 w-full border border-paper-soft rounded px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
        />
      </div>

      {parseError && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          {parseError}
        </div>
      )}

      <div className="flex items-start justify-between flex-wrap gap-3">
        <ul className="text-xs text-ink-muted space-y-1 max-w-md">
          <li>
            <span className="text-ink">Quality guards:</span> all pages
            land at <span className="font-mono">tier: private</span>; you
            review + promote manually.
          </li>
          <li>
            Existing slugs aren&apos;t overwritten — conflicts get a{" "}
            <span className="font-mono">-from-llm-&lt;date&gt;</span> suffix.
          </li>
          <li>
            Every page records the session label in its{" "}
            <span className="font-mono">sources:</span> frontmatter.
          </li>
        </ul>
        <button
          onClick={tryPreview}
          className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft"
        >
          Parse + preview
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Image panel — drag-drop, paste-from-clipboard, file picker
// ---------------------------------------------------------------------------

type QueueStatus = "pending" | "uploading" | "ok" | "error";
type QueueItem = {
  file: File;
  preview: string;
  status: QueueStatus;
  error?: string;
  result?: CaptureResult;
};

function ImagePanel({ cfg, tenant }: { cfg: CaptureConfig | null; tenant?: string }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [label, setLabel] = useState("");
  const [subdir, setSubdir] = useState<Subdir>("articles");
  // See PastePanel for why ingest defaults ON.
  const [runIngest, setRunIngest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Clean up object URLs on unmount to avoid leaks. Browsers cap blob: URLs
  // per origin and screenshots are heavy, so leaking these eventually breaks.
  useEffect(() => {
    return () => {
      queue.forEach((q) => URL.revokeObjectURL(q.preview));
    };
    // We intentionally only clean up on unmount; per-item cleanup happens
    // inline in removeAt / clearAll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (incoming: File[]) => {
    const filtered = incoming.filter((f) => f.type.startsWith("image/"));
    if (filtered.length === 0) return;
    const newItems: QueueItem[] = filtered.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      status: "pending",
    }));
    setQueue((prev) => [...prev, ...newItems]);
  };

  const removeAt = (idx: number) => {
    setQueue((prev) => {
      const item = prev[idx];
      if (item) URL.revokeObjectURL(item.preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const clearAll = () => {
    queue.forEach((q) => URL.revokeObjectURL(q.preview));
    setQueue([]);
  };

  // Clipboard paste support — works anywhere on the page. Supports paste
  // of multiple images (rare in practice — most OSes give one — but cheap).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (!e.clipboardData) return;
      const pasted: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            const ext = blob.type.split("/")[1] || "png";
            pasted.push(
              new File(
                [blob],
                `pasted-${Date.now()}-${pasted.length}.${ext}`,
                { type: blob.type },
              ),
            );
          }
        }
      }
      if (pasted.length > 0) {
        addFiles(pasted);
        e.preventDefault();
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setError(null);
    if (queue.length === 0) {
      setError("Drop files, paste images, or pick one or more.");
      return;
    }
    if (label.trim().length < 1) {
      setError("Give it a short label so filenames are meaningful.");
      return;
    }
    setSaving(true);

    const baseLabel = label.trim();
    const total = queue.length;
    // We process sequentially to keep vision API costs predictable and
    // avoid spike-throttling. Each capture takes ~5-15s so a 5-pic batch
    // still finishes inside a normal attention span.
    for (let i = 0; i < total; i++) {
      const item = queue[i];
      if (item.status === "ok") continue;

      const perFileLabel =
        total > 1 ? `${baseLabel}-${i + 1}` : baseLabel;

      setQueue((prev) =>
        prev.map((q, idx) =>
          idx === i ? { ...q, status: "uploading", error: undefined } : q,
        ),
      );

      try {
        const res = await ownerCaptureImage(
          {
            file: item.file,
            filename: item.file.name,
            label: perFileLabel,
            subdir,
            // Only run ingest on the last item — running N orchestrator jobs
            // in a tight loop would torch the Anthropic API budget.
            run_orchestrator: runIngest && i === total - 1,
          },
          tenant,
        );
        setQueue((prev) =>
          prev.map((q, idx) =>
            idx === i ? { ...q, status: "ok", result: res } : q,
          ),
        );
      } catch (e) {
        setQueue((prev) =>
          prev.map((q, idx) =>
            idx === i
              ? { ...q, status: "error", error: (e as Error).message }
              : q,
          ),
        );
      }
    }

    setSaving(false);
  }

  const imageAvailable = cfg?.image.available ?? false;
  const okCount = queue.filter((q) => q.status === "ok").length;
  const errorCount = queue.filter((q) => q.status === "error").length;
  const pendingCount = queue.filter(
    (q) => q.status === "pending" || q.status === "uploading",
  ).length;

  return (
    <section className="space-y-4">
      {cfg && (
        <div className="text-xs text-ink-muted">
          Transcription via{" "}
          <span className="text-ink font-medium">
            {cfg.image.backend ?? "none"}
          </span>{" "}
          {cfg.image.model && <>· {cfg.image.model}</>}
        </div>
      )}
      {!imageAvailable && cfg && (
        <div className="p-3 rounded border border-amber-200 bg-amber-50 text-sm text-amber-800">
          No vision LLM is configured. Set <code>ANTHROPIC_API_KEY</code> or{" "}
          <code>OPENAI_API_KEY</code> in <code>backend/.env</code> to enable screenshot
          transcription.
        </div>
      )}

      <div>
        <label className="block text-xs text-ink-muted mb-1">
          Label{" "}
          {queue.length > 1 && (
            <span className="text-ink-muted">
              (will be suffixed with -1, -2, … for each file)
            </span>
          )}
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. dashboard-numbers-from-pitch-deck"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const fs = Array.from(e.dataTransfer.files);
          if (fs.length > 0) addFiles(fs);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer border-2 border-dashed rounded-xl p-6 text-center transition ${
          dragging
            ? "border-accent bg-accent/5"
            : "border-paper-soft hover:border-ink-muted"
        }`}
      >
        <div className="text-sm text-ink-muted">
          <div className="text-2xl mb-2">⤓</div>
          <div>
            <span className="text-ink font-medium">
              {queue.length === 0
                ? "Drop screenshots"
                : `Drop more (${queue.length} queued)`}
            </span>
            , click to pick file(s), or <kbd className="font-mono">⌘V</kbd>{" "}
            paste from clipboard.
          </div>
          <div className="text-xs mt-2">
            PNG, JPG, WebP. Max 20 MB each. Batches process sequentially.
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const fs = e.target.files ? Array.from(e.target.files) : [];
            if (fs.length > 0) addFiles(fs);
            // Reset so re-picking the same file fires onChange again.
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      </div>

      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              {queue.length} {queue.length === 1 ? "file" : "files"} queued
              {(okCount > 0 || errorCount > 0) && (
                <>
                  {" · "}
                  <span className="text-emerald-700">{okCount} done</span>
                  {errorCount > 0 && (
                    <>
                      {" · "}
                      <span className="text-red-700">
                        {errorCount} failed
                      </span>
                    </>
                  )}
                  {pendingCount > 0 && (
                    <>
                      {" · "}
                      <span className="text-amber-700">
                        {pendingCount} pending
                      </span>
                    </>
                  )}
                </>
              )}
            </span>
            <button
              onClick={clearAll}
              disabled={saving}
              className="underline hover:text-ink disabled:opacity-50"
            >
              clear all
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {queue.map((q, i) => (
              <QueueThumb
                key={i}
                item={q}
                onRemove={() => removeAt(i)}
                disabled={saving}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <SubdirPicker value={subdir} onChange={setSubdir} />
        <IngestToggle value={runIngest} onChange={setRunIngest} />
      </div>
      {error && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}
      <button
        onClick={submit}
        disabled={saving || !imageAvailable || queue.length === 0}
        className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
      >
        {saving
          ? `transcribing ${okCount + errorCount + 1}/${queue.length}…`
          : queue.length > 1
            ? runIngest
              ? `transcribe + ingest ${queue.length} files`
              : `transcribe ${queue.length} files (raw only)`
            : runIngest
              ? "transcribe + ingest"
              : "transcribe (raw only)"}
      </button>

      {queue.some((q) => q.result) && (
        <div className="mt-2 space-y-2">
          {queue.map((q, i) =>
            q.result ? (
              <ResultCard
                key={i}
                result={q.result}
                label={`Transcribed: ${q.file.name}`}
                tenant={tenant}
              />
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}

function QueueThumb({
  item,
  onRemove,
  disabled,
}: {
  item: QueueItem;
  onRemove: () => void;
  disabled: boolean;
}) {
  const statusOverlay =
    item.status === "uploading"
      ? "bg-amber-500/70"
      : item.status === "ok"
        ? "bg-emerald-500/60"
        : item.status === "error"
          ? "bg-red-500/70"
          : null;
  const statusLabel =
    item.status === "uploading"
      ? "uploading…"
      : item.status === "ok"
        ? "done"
        : item.status === "error"
          ? "failed"
          : null;

  return (
    <div className="relative aspect-square rounded border border-paper-soft overflow-hidden bg-paper-soft">
      <img
        src={item.preview}
        alt={item.file.name}
        className="absolute inset-0 w-full h-full object-cover"
      />
      {statusOverlay && (
        <div
          className={`absolute inset-0 flex items-center justify-center text-white text-xs font-medium ${statusOverlay}`}
          title={item.error}
        >
          {statusLabel}
        </div>
      )}
      <button
        onClick={onRemove}
        disabled={disabled || item.status === "uploading"}
        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-white/90 text-ink text-xs leading-none flex items-center justify-center hover:bg-white disabled:opacity-30"
        title="remove"
      >
        ×
      </button>
      <div className="absolute bottom-0 left-0 right-0 text-[10px] text-white bg-black/50 px-1 py-0.5 truncate">
        {item.file.name}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice panel — MediaRecorder or file upload
// ---------------------------------------------------------------------------

function VoicePanel({ cfg, tenant }: { cfg: CaptureConfig | null; tenant?: string }) {
  const [label, setLabel] = useState("");
  const [subdir, setSubdir] = useState<Subdir>("meetings");
  // See PastePanel for why ingest defaults ON.
  const [runIngest, setRunIngest] = useState(true);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("voice-memo.webm");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [audioUrl]);

  function setAudioFromBlob(blob: Blob, fname: string) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudio(blob);
    setAudioUrl(URL.createObjectURL(blob));
    setFilename(fname);
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioFromBlob(blob, `voice-${Date.now()}.webm`);
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
      startedAtRef.current = Date.now();
      setElapsed(0);
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch (e) {
      setError(
        "Microphone access denied or unavailable. Try the file upload below."
      );
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  async function submit() {
    setError(null);
    if (!audio) {
      setError("Record or upload an audio file first.");
      return;
    }
    if (label.trim().length < 1) {
      setError("Give it a short label so the filename is meaningful.");
      return;
    }
    setSaving(true);
    try {
      const res = await ownerCaptureAudio(
        {
          file: audio,
          filename,
          label: label.trim(),
          subdir,
          run_orchestrator: runIngest,
        },
        tenant,
      );
      setResult(res);
      setAudio(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const audioAvailable = cfg?.audio.available ?? false;
  const mmss = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;

  return (
    <section className="space-y-4">
      {cfg && (
        <div className="text-xs text-ink-muted">
          Transcription via{" "}
          <span className="text-ink font-medium">{cfg.audio.backend ?? "none"}</span>{" "}
          {cfg.audio.model && <>· {cfg.audio.model}</>}
        </div>
      )}
      {!audioAvailable && cfg && (
        <div className="p-3 rounded border border-amber-200 bg-amber-50 text-sm text-amber-800">
          OpenAI Whisper requires <code>OPENAI_API_KEY</code> in{" "}
          <code>backend/.env</code>. Currently unavailable.
        </div>
      )}

      <div>
        <label className="block text-xs text-ink-muted mb-1">Label</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. reflections-on-portable-wiki-shipping"
          className="w-full border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      <div className="border border-paper-soft rounded-xl p-5 bg-paper-soft/30">
        <div className="text-xs uppercase tracking-wider text-ink-muted mb-3">
          Record
        </div>
        <div className="flex items-center gap-4">
          {!recording ? (
            <button
              onClick={startRecording}
              disabled={!audioAvailable}
              className="px-4 py-2 rounded bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50"
            >
              ● start recording
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft"
            >
              ◼ stop
            </button>
          )}
          {(recording || elapsed > 0) && (
            <span className="text-sm font-mono text-ink">{mmss}</span>
          )}
        </div>

        {audioUrl && !recording && (
          <div className="mt-4 flex items-center gap-3">
            <audio src={audioUrl} controls className="flex-1" />
            <button
              onClick={() => {
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                setAudio(null);
                setAudioUrl(null);
                setElapsed(0);
              }}
              className="text-xs text-ink-muted underline hover:text-ink"
            >
              clear
            </button>
          </div>
        )}

        <div className="mt-4 text-xs text-ink-muted">
          Or upload an existing audio file:{" "}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="underline hover:text-ink"
          >
            pick file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/webm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setAudioFromBlob(f, f.name);
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <SubdirPicker value={subdir} onChange={setSubdir} />
        <IngestToggle value={runIngest} onChange={setRunIngest} />
      </div>
      {error && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}
      <button
        onClick={submit}
        disabled={saving || !audioAvailable}
        className="px-4 py-2 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
      >
        {saving
          ? "transcribing…"
          : runIngest
            ? "transcribe + ingest"
            : "transcribe (raw only)"}
      </button>

      {result && (
        <ResultCard
          result={result}
          label={runIngest ? "Transcribed + ingest queued" : "Transcribed (raw only)"}
          tenant={tenant}
        />
      )}
    </section>
  );
}

const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fprofessorpalmer%2Fportable-llm-wiki";

function CaptureDemoPreview({ tenant }: { tenant?: string }) {
  const hosted = isHostedMode();
  return (
    <div className="max-w-4xl mx-auto px-5 py-10">
      <div className="text-[11px] sm:text-xs uppercase tracking-[0.22em] text-accent font-semibold">
        Demo preview
      </div>
      <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
        Capture anything into your wiki.
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
        Paste a Slack thread{!hosted && ", drop a screenshot, record a voice memo"}.
        The backend writes a raw source file, then (optionally) a{" "}
        <a
          href="https://github.com/professorpalmer/Puppetmaster"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
          title="Cursor SDK agent CLI — opens GitHub"
        >
          Puppetmaster
        </a>{" "}
        agent reads it and drafts new wiki pages with citations back to the
        source. This is how your context grows without you sitting down to
        write.
      </p>

      <div className="mt-8 grid sm:grid-cols-3 gap-3">
        <ModePreview
          label="Paste"
          desc="Drop a Slack thread, article excerpt, transcript, or any text. Saved to raw/conversations/ in one POST."
          endpoint="POST /owner/capture/paste"
        />
        <ModePreview
          label="Screenshot"
          desc="Drag a PNG (chat, whiteboard, a paper figure). OCR + entity extraction runs server-side."
          endpoint="POST /owner/capture/image"
          badge={hosted ? "self-host only" : undefined}
        />
        <ModePreview
          label="Voice memo"
          desc="Record from the browser or upload a file. Whisper transcribes; the transcript becomes the source."
          endpoint="POST /owner/capture/audio"
          badge={hosted ? "self-host only" : undefined}
        />
      </div>

      <section className="mt-10 rounded-xl bg-paper-soft/60 border border-paper-soft p-5">
        <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
          The pipeline
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <code className="font-mono text-ink bg-white px-2 py-0.5 rounded border border-paper-soft">
            capture
          </code>
          <span className="text-ink-muted">→</span>
          <code className="font-mono text-ink bg-white px-2 py-0.5 rounded border border-paper-soft">
            raw/&lt;subdir&gt;/&lt;date&gt;-&lt;slug&gt;.md
          </code>
          <span className="text-ink-muted">→</span>
          <a
            href="https://github.com/professorpalmer/Puppetmaster"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-ink bg-white px-2 py-0.5 rounded border border-paper-soft hover:bg-paper-soft"
            title="Cursor SDK agent CLI — opens GitHub"
          >
            Puppetmaster ingest
          </a>
          <span className="text-ink-muted">→</span>
          <code className="font-mono text-ink bg-white px-2 py-0.5 rounded border border-paper-soft">
            wiki/{`{`}entities,concepts,decisions{`}`}/*.md
          </code>
        </div>
        <p className="mt-3 text-xs text-ink-muted leading-relaxed">
          The raw file is the immutable source-of-truth. Every wiki page
          drafted from it carries a citation back, so provenance never
          breaks. You review the drafts before they get committed.
        </p>
      </section>

      <section className="mt-10 rounded-2xl border border-ink bg-ink text-paper p-6 sm:p-7">
        <div className="text-[11px] uppercase tracking-[0.18em] text-accent font-semibold">
          To capture for real
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Run your own instance.
        </h2>
        <p className="mt-2 text-sm text-paper/70 leading-relaxed max-w-xl">
          This deployment is the public Avery Chen demo. To capture into{" "}
          <em>your</em> markdown folder, host your own (free, one click).
          Render auto-generates an owner token; bring your own wiki
          directory or start fresh.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={RENDER_DEPLOY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-paper text-ink text-sm font-medium hover:bg-paper-soft"
          >
            Deploy to Render <span aria-hidden>→</span>
          </a>
          <Link
            href={`${tenant ? `/${tenant}` : ""}/owner`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-paper/30 text-paper/80 text-sm hover:text-paper hover:border-paper/60"
          >
            Already running? Authenticate <span aria-hidden>→</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

function ModePreview({
  label,
  desc,
  endpoint,
  badge,
}: {
  label: string;
  desc: string;
  endpoint: string;
  /** Optional pill rendered next to the title, e.g. "self-host only" so
   * the hosted demo doesn't advertise capture modes that don't ship on
   * portablellm.wiki (vision + Whisper need server-side LLM keys). */
  badge?: string;
}) {
  return (
    <div
      className={`rounded-xl border bg-white p-4 ${
        badge ? "border-paper-soft opacity-75" : "border-paper-soft"
      }`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-ink">{label}</div>
        {badge && (
          <span className="text-[10px] uppercase tracking-wider font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-muted leading-relaxed">{desc}</p>
      <code className="mt-3 inline-block text-[10px] font-mono text-ink-muted">
        {endpoint}
      </code>
    </div>
  );
}
