"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchManifest,
  ownerExtractPdf,
  ownerGetJob,
  ownerImport,
  type ImportKind,
  type ImportResult,
} from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import { useIsOwnerOf } from "@/lib/useIsOwner";
import { OwnerGate } from "@/components/OwnerGate";

type Stage =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "running"; trackingId: string; startedAt: number; pagesBefore: Set<string> }
  | { kind: "done"; newPages: PageDelta[]; elapsed: number; trackingId: string }
  | { kind: "error"; message: string };

type PageDelta = {
  slug: string;
  title: string;
  section: string;
  type: string;
};

const KINDS: { id: ImportKind; label: string; hint: string; placeholder: string }[] = [
  {
    id: "resume",
    label: "Resume",
    hint: "Paste the plain-text content of a resume. Bullet points and section headers are fine.",
    placeholder:
      "Jane Doe\nSan Francisco · jane@doe.dev\n\nExperience\n----------\nStrand Bio — Founding Engineer (2024–present)\n  · Built X, Y, Z\n  · Shipped Z to production\n\nMedAxis — Senior Engineer (2018–2024)\n  · ...\n\nEducation\n---------\nStanford — BS CS, 2018",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    hint: "Copy your LinkedIn profile (About + Experience + Education + Skills). Easiest: 'See more' on each section, select-all, paste.",
    placeholder:
      "About\nFounding engineer focused on...\n\nExperience\nStrand Bio · Founding Engineer · 2024 - Present\n...",
  },
  {
    id: "bio",
    label: "Bio",
    hint: "A self-written bio or about-me page. The agent will pull out values, current projects, and what you care about.",
    placeholder:
      "I'm an engineer at a small biotech. I care about boring tools, calibrated honesty, and shipping things that compound. Currently working on...",
  },
  {
    id: "freeform",
    label: "Freeform",
    hint: "Anything else: an essay, a long Twitter/blog post, a personal manifesto. The agent will find structured entities/concepts/decisions inside it.",
    placeholder: "Paste any long-form content about yourself or your work...",
  },
];

const POLL_INTERVAL_MS = 4000;

export default function OwnerImportPage() {
  const tenant = useTenant();
  return (
    <OwnerGate tenant={tenant}>
      <OwnerImportPageInner tenant={tenant} />
    </OwnerGate>
  );
}

function OwnerImportPageInner({ tenant }: { tenant?: string }) {
  const ownerAccess = useIsOwnerOf(tenant);
  const authed = ownerAccess.ready && ownerAccess.isOwner;
  const [tokenInput, setTokenInput] = useState("");
  const [kind, setKind] = useState<ImportKind>("resume");
  const [content, setContent] = useState("");
  const [label, setLabel] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Tick to update elapsed-time displays.
  useEffect(() => {
    if (stage.kind !== "running" && stage.kind !== "submitting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage.kind]);

  const currentKind = useMemo(
    () => KINDS.find((k) => k.id === kind) ?? KINDS[0],
    [kind],
  );

  const canSubmit =
    authed && content.trim().length >= 20 && stage.kind !== "submitting" && stage.kind !== "running";

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    const startedAt = Date.now();
    setStage({ kind: "submitting" });
    try {
      const result: ImportResult = await ownerImport(
        {
          kind,
          content: content.trim(),
          label: label.trim() || undefined,
        },
        tenant,
      );

      // Hosted-mode synchronous fallback. When Puppetmaster isn't on
      // PATH (Render, vanilla Docker, etc.) the backend invokes
      // direct_drafter.draft_starter_pages and returns the pages
      // inline — there's no job to poll. Check this BEFORE treating
      // orchestrator.error as a hard failure, because in hosted mode
      // that field is always populated even on success.
      if (result.drafted) {
        if (result.drafted.error) {
          const hint =
            result.drafted.kind === "no_llm_configured"
              ? " — set an Anthropic or OpenAI API key in your Render env vars to enable drafting."
              : "";
          setStage({
            kind: "error",
            message: `Drafting failed: ${result.drafted.error}${hint}`,
          });
          return;
        }
        const newPages: PageDelta[] = (result.drafted.pages ?? []).map((p) => ({
          slug: p.slug,
          title: p.title,
          section: p.section,
          type: p.type,
        }));
        setStage({
          kind: "done",
          newPages,
          elapsed: Date.now() - startedAt,
          trackingId: result.drafted.backend
            ? `direct-llm:${result.drafted.backend}`
            : "direct-llm",
        });
        return;
      }

      if (result.orchestrator?.error) {
        setStage({
          kind: "error",
          message: `Orchestrator could not start: ${result.orchestrator.error}`,
        });
        return;
      }
      const trackingId = result.orchestrator?.tracking_id;
      if (!trackingId) {
        setStage({ kind: "error", message: "No tracking_id returned from the backend." });
        return;
      }
      setStage({
        kind: "running",
        trackingId,
        startedAt,
        pagesBefore: new Set(result.pages_before),
      });
    } catch (e) {
      setStage({ kind: "error", message: (e as Error).message });
    }
  }, [canSubmit, kind, content, label, tenant]);

  // Poll job status while running.
  useEffect(() => {
    if (stage.kind !== "running") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const { job } = await ownerGetJob(stage.trackingId, tenant);
        if (cancelled) return;
        if (job.status === "done") {
          // job finished — diff manifest to find new pages
          const manifest = await fetchManifest(tenant, { asOwner: true });
          if (cancelled) return;
          const newPages: PageDelta[] = manifest.pages
            .filter((p) => !stage.pagesBefore.has(p.slug))
            .map((p) => ({
              slug: p.slug,
              title: p.title,
              section: p.section,
              type: p.type,
            }));
          setStage({
            kind: "done",
            newPages,
            elapsed: Date.now() - stage.startedAt,
            trackingId: stage.trackingId,
          });
        } else if (job.status === "error") {
          setStage({
            kind: "error",
            message: `Orchestrator job failed: ${job.summary ?? "see job log at /owner"}`,
          });
        }
      } catch {
        // ignore transient errors; keep polling
      }
    };

    const t = setInterval(poll, POLL_INTERVAL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [stage]);

  if (!ownerAccess.ready) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-12 text-sm text-ink-muted">
        Checking your session…
      </div>
    );
  }

  // Only reached in OSS mode without a bearer token. In hosted mode the
  // surrounding OwnerGate has already gated us, so the hook resolves to
  // isOwner=true once /auth/me returns.
  if (!authed) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-12">
        <h1 className="text-3xl font-semibold text-ink">Import wizard</h1>
        <p className="mt-3 text-ink-muted">
          Owner-only. Paste your owner token to continue.
        </p>
        <div className="mt-5 flex gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="owner token"
            className="flex-1 border border-paper-soft rounded px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={() => {
              if (tokenInput) {
                window.localStorage.setItem("llmwiki:ownerToken", tokenInput);
                window.location.reload();
              }
            }}
            className="px-4 py-2 rounded bg-ink text-paper text-sm font-medium"
          >
            unlock
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-5 py-10">
      <div className="text-xs uppercase tracking-wider text-ink-muted font-medium">
        Owner · Cold-start
      </div>
      <h1 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-ink">
        Bootstrap your wiki
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
        Drop in a resume, a LinkedIn paste, a self-written bio, or any
        freeform content about yourself. A{" "}
        <a
          href="https://github.com/professorpalmer/Puppetmaster"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
          title="Cursor SDK agent CLI — opens GitHub"
        >
          Puppetmaster
        </a>{" "}
        agent (self-host) or direct LLM call (hosted) reads it and scaffolds
        6-12 starter wiki pages (entities, concepts, decisions, projects),
        all tagged{" "}
        <code className="font-mono text-[12px]">tier: private</code> so you
        can review before sharing anything.
      </p>

      {stage.kind === "idle" || stage.kind === "submitting" ? (
        <Form
          kind={kind}
          setKind={setKind}
          content={content}
          setContent={setContent}
          label={label}
          setLabel={setLabel}
          textareaRef={textareaRef}
          currentKind={currentKind}
          submit={submit}
          canSubmit={canSubmit}
          submitting={stage.kind === "submitting"}
          tenant={tenant}
        />
      ) : null}

      {stage.kind === "running" && (
        <RunningPanel
          trackingId={stage.trackingId}
          elapsedSec={Math.floor((now - stage.startedAt) / 1000)}
          tenant={tenant}
        />
      )}

      {stage.kind === "done" && (
        <DonePanel
          newPages={stage.newPages}
          elapsedMs={stage.elapsed}
          tenant={tenant}
          onAgain={() => {
            setContent("");
            setLabel("");
            setStage({ kind: "idle" });
          }}
        />
      )}

      {stage.kind === "error" && (
        <div className="mt-6 p-4 rounded border border-red-200 bg-red-50">
          <div className="text-sm font-semibold text-red-900">
            Import failed
          </div>
          <div className="mt-1 text-sm text-red-800 break-words">
            {stage.message}
          </div>
          <button
            onClick={() => setStage({ kind: "idle" })}
            className="mt-3 px-3 py-1.5 rounded border border-red-300 text-red-900 text-xs font-medium hover:bg-red-100"
          >
            try again
          </button>
        </div>
      )}

      <div className="mt-10 pt-6 border-t border-paper-soft text-xs text-ink-muted leading-relaxed">
        <div className="font-semibold text-ink-muted">How this works</div>
        <ol className="mt-2 list-decimal pl-5 space-y-1">
          <li>Your text gets saved to <code>raw/profile/YYYY-MM-DD-{kind}.md</code> (immutable).</li>
          <li>
            A drafter reads the source, pulls out entities / concepts / decisions / projects,
            and writes 6–12 starter wiki pages. On the hosted service this runs as a single
            synchronous LLM call (Anthropic or OpenAI, whichever key is configured); on a
            self-host with <code>PUPPETMASTER_BIN</code> on PATH it runs as a longer-form
            Cursor SDK agent that can cross-reference and update <code>index.md</code> + <code>log.md</code>.
          </li>
          <li>Each new page lands as <code>tier: private</code>; promote individually from the owner console.</li>
          <li>Runtime: ~20–60s on the hosted service; 60–180s with a self-hosted agent (hard-capped at 15 min).</li>
        </ol>
      </div>

      <div className="mt-4 text-xs">
        <Link href={tenant ? `/${tenant}/owner` : "/owner"} className="text-accent underline">
          ← back to owner console
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type PdfQueueStatus = "pending" | "extracting" | "done" | "error";

type PdfQueueItem = {
  id: string;
  file: File;
  status: PdfQueueStatus;
  error?: string;
  pages?: number;
  words?: number;
};

function makePdfId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function formatExtractedBlock(result: {
  text: string;
  source_filename: string;
  page_count: number;
  word_count: number;
}): string {
  const { source_filename, page_count, word_count, text } = result;
  const pageLabel = page_count === 1 ? "page" : "pages";
  const wordLabel = word_count === 1 ? "word" : "words";
  return [
    `--- BEGIN: ${source_filename} (${page_count} ${pageLabel}, ${word_count.toLocaleString()} ${wordLabel}) ---`,
    "",
    text.trim(),
    "",
    `--- END: ${source_filename} ---`,
  ].join("\n");
}

function Form({
  kind,
  setKind,
  content,
  setContent,
  label,
  setLabel,
  textareaRef,
  currentKind,
  submit,
  canSubmit,
  submitting,
  tenant,
}: {
  kind: ImportKind;
  setKind: (k: ImportKind) => void;
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  label: string;
  setLabel: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  currentKind: (typeof KINDS)[number];
  submit: () => void;
  canSubmit: boolean;
  submitting: boolean;
  tenant?: string;
}) {
  const [pdfQueue, setPdfQueue] = useState<PdfQueueItem[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (incoming: File[]) => {
    const filtered = incoming.filter(
      (f) =>
        f.type === "application/pdf" ||
        f.name.toLowerCase().endsWith(".pdf"),
    );
    if (filtered.length === 0) return;
    const items: PdfQueueItem[] = filtered.map((file) => ({
      id: makePdfId(file),
      file,
      status: "pending",
    }));
    setPdfQueue((prev) => [...prev, ...items]);
  };

  const removeAt = (id: string) => {
    setPdfQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const clearQueue = () => {
    setPdfQueue((prev) => prev.filter((q) => q.status === "extracting"));
  };

  const extractAll = async () => {
    if (extracting) return;
    // Snapshot the queue once so async iteration doesn't keep re-scanning
    // state. We process items that are pending or previously errored
    // (retry-on-click). Already-done items are skipped so the textarea
    // doesn't accumulate duplicates.
    const snapshot = pdfQueue.filter(
      (q) => q.status === "pending" || q.status === "error",
    );
    if (snapshot.length === 0) return;

    setExtracting(true);

    const totalAfterBatch = pdfQueue.length;
    if (!label.trim() && totalAfterBatch > 1) {
      setLabel(`PDF batch: ${totalAfterBatch} files`);
    }

    for (const target of snapshot) {
      setPdfQueue((prev) =>
        prev.map((q) =>
          q.id === target.id
            ? { ...q, status: "extracting", error: undefined }
            : q,
        ),
      );
      try {
        const result = await ownerExtractPdf(target.file, tenant);
        setPdfQueue((prev) =>
          prev.map((q) =>
            q.id === target.id
              ? {
                  ...q,
                  status: "done",
                  pages: result.page_count,
                  words: result.word_count,
                }
              : q,
          ),
        );
        const block = formatExtractedBlock(result);
        // Functional updates so consecutive appends within this loop
        // stack on top of each other (the closure captured `content` is
        // stale after the first iteration).
        setContent((prev) => (prev.length > 0 ? `${prev}\n\n${block}` : block));
        if (totalAfterBatch === 1) {
          setLabel((prev) =>
            prev.trim() ? prev : `PDF: ${result.source_filename}`,
          );
        }
      } catch (e) {
        setPdfQueue((prev) =>
          prev.map((q) =>
            q.id === target.id
              ? { ...q, status: "error", error: (e as Error).message }
              : q,
          ),
        );
      }
    }

    setExtracting(false);
    textareaRef.current?.focus();
  };

  const pendingCount = pdfQueue.filter(
    (q) => q.status === "pending" || q.status === "error",
  ).length;
  const doneCount = pdfQueue.filter((q) => q.status === "done").length;
  const errorCount = pdfQueue.filter((q) => q.status === "error").length;

  return (
    <div className="mt-7 space-y-5">
      <div>
        <div className="text-xs uppercase tracking-wider text-ink-muted font-medium mb-2">
          What are you importing?
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className={`text-left p-3 rounded border ${
                kind === k.id
                  ? "border-accent bg-accent/5 text-ink"
                  : "border-paper-soft bg-white text-ink-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              <div className="text-sm font-semibold">{k.label}</div>
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs text-ink-muted">{currentKind.hint}</div>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-ink-muted font-medium">
          Label (optional)
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. 'Updated resume 2026-05'"
          className="mt-1 w-full border border-paper-soft rounded px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <label className="text-xs uppercase tracking-wider text-ink-muted font-medium">
            Content
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const fs = e.target.files ? Array.from(e.target.files) : [];
                if (fs.length > 0) addFiles(fs);
                // Reset so re-picking the same file fires onChange again.
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={extracting}
              className="text-xs px-2.5 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink disabled:opacity-50"
            >
              + extract from PDFs
            </button>
          </div>
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
          className={`mt-2 cursor-pointer border-2 border-dashed rounded-lg px-4 py-3 text-center transition ${
            dragging
              ? "border-accent bg-accent/5"
              : "border-paper-soft hover:border-ink-muted"
          }`}
        >
          <div className="text-xs text-ink-muted">
            {pdfQueue.length === 0 ? (
              <>
                <span className="text-ink font-medium">Drop PDFs here</span>{" "}
                or click to pick. Multiple OK, processed one at a time.
              </>
            ) : (
              <>
                <span className="text-ink font-medium">
                  Drop more PDFs ({pdfQueue.length} queued)
                </span>{" "}
                or click to add. Processed sequentially below.
              </>
            )}
          </div>
        </div>

        {pdfQueue.length > 0 && (
          <div className="mt-2 space-y-2" data-testid="pdf-queue">
            <div className="flex items-center justify-between text-xs text-ink-muted">
              <span>
                {pdfQueue.length} PDF{pdfQueue.length === 1 ? "" : "s"} queued
                {(doneCount > 0 || errorCount > 0) && (
                  <>
                    {" · "}
                    <span className="text-emerald-700">{doneCount} done</span>
                    {errorCount > 0 && (
                      <>
                        {" · "}
                        <span className="text-red-700">
                          {errorCount} failed
                        </span>
                      </>
                    )}
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={clearQueue}
                disabled={extracting}
                className="underline hover:text-ink disabled:opacity-50"
              >
                clear queue
              </button>
            </div>
            <ul className="rounded border border-paper-soft divide-y divide-paper-soft bg-white">
              {pdfQueue.map((item) => (
                <PdfQueueRow
                  key={item.id}
                  item={item}
                  onRemove={() => removeAt(item.id)}
                  disabled={extracting}
                />
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={extractAll}
                disabled={extracting || pendingCount === 0}
                className="text-xs px-3 py-1.5 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
              >
                {extracting
                  ? `extracting…`
                  : pendingCount === pdfQueue.length
                    ? `extract all (${pendingCount})`
                    : `extract ${pendingCount} remaining`}
              </button>
              {errorCount > 0 && !extracting && (
                <span className="text-xs text-red-700">
                  {errorCount} failed. Click extract again to retry.
                </span>
              )}
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={currentKind.placeholder}
          rows={14}
          className="mt-3 w-full border border-paper-soft rounded px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none leading-relaxed"
        />
        <div className="mt-1 flex justify-between text-xs text-ink-muted">
          <span>
            {content.length.toLocaleString()} chars · min 20
          </span>
          <span>tip: longer = better page coverage, up to ~50k chars</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="px-5 py-2.5 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
        >
          {submitting ? "submitting…" : "Draft pages →"}
        </button>
        <span className="text-xs text-ink-muted">
          Job runs in the background. Average ~90s.
        </span>
      </div>
    </div>
  );
}

function PdfQueueRow({
  item,
  onRemove,
  disabled,
}: {
  item: PdfQueueItem;
  onRemove: () => void;
  disabled: boolean;
}) {
  const badge =
    item.status === "pending"
      ? { text: "pending", className: "bg-paper-soft text-ink-muted" }
      : item.status === "extracting"
        ? { text: "extracting…", className: "bg-amber-100 text-amber-800" }
        : item.status === "done"
          ? { text: "done", className: "bg-emerald-100 text-emerald-800" }
          : { text: "error", className: "bg-red-100 text-red-800" };

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-xs">
      <span
        className={`px-1.5 py-0.5 rounded font-medium tracking-wide ${badge.className}`}
      >
        {badge.text}
      </span>
      <div className="flex-1 min-w-0">
        <div className="truncate font-mono text-ink">{item.file.name}</div>
        {item.status === "done" && item.pages != null && item.words != null && (
          <div className="text-[11px] text-ink-muted">
            {item.pages} {item.pages === 1 ? "page" : "pages"} ·{" "}
            {item.words.toLocaleString()} words appended to content
          </div>
        )}
        {item.status === "error" && item.error && (
          <div className="text-[11px] text-red-700 truncate" title={item.error}>
            {item.error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled || item.status === "extracting"}
        aria-label={`remove ${item.file.name} from queue`}
        className="text-ink-muted hover:text-ink disabled:opacity-30"
      >
        ×
      </button>
    </li>
  );
}

function RunningPanel({
  trackingId,
  elapsedSec,
  tenant,
}: {
  trackingId: string;
  elapsedSec: number;
  tenant?: string;
}) {
  const browseHref = tenant ? `/${tenant}/browse` : "/browse";
  return (
    <div className="mt-7 p-5 rounded-xl border border-paper-soft bg-paper-soft/40">
      <div className="flex items-center gap-3">
        <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
        <div className="text-sm font-semibold text-ink">
          Drafting pages. Agent job running…
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <Cell label="tracking id">
          <code className="font-mono">{trackingId}</code>
        </Cell>
        <Cell label="elapsed">{formatElapsed(elapsedSec)}</Cell>
      </div>
      <div className="mt-3 text-xs text-ink-muted leading-relaxed">
        The agent is reading your source, identifying entities/concepts/
        decisions/projects, and writing markdown pages with cross-references.
        Most imports complete in 60-180 seconds. You can close this tab. The
        job continues server-side. Re-open the import wizard to check status,
        or visit{" "}
        <Link href={browseHref} className="underline">
          browse
        </Link>{" "}
        to watch pages appear.
      </div>
    </div>
  );
}

function DonePanel({
  newPages,
  elapsedMs,
  onAgain,
  tenant,
}: {
  newPages: PageDelta[];
  elapsedMs: number;
  onAgain: () => void;
  tenant?: string;
}) {
  const ownerHref = tenant ? `/${tenant}/owner` : "/owner";
  const browseHref = tenant ? `/${tenant}/browse` : "/browse";
  const graphHref = tenant ? `/${tenant}/graph` : "/graph";
  const pageHref = (slug: string) =>
    tenant
      ? `/${tenant}/page/${encodeURIComponent(slug)}`
      : `/page/${encodeURIComponent(slug)}`;
  const grouped = useMemo(() => {
    const m = new Map<string, PageDelta[]>();
    for (const p of newPages) {
      const k = p.section || p.type || "other";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [newPages]);

  return (
    <div className="mt-7 p-5 rounded-xl border border-green-200 bg-green-50">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-base font-semibold text-green-900">
          Drafted {newPages.length} page{newPages.length === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-green-800">
          completed in {(elapsedMs / 1000).toFixed(1)}s
        </div>
      </div>

      {newPages.length === 0 ? (
        <div className="mt-3 text-sm text-green-900 leading-relaxed">
          The job completed but the manifest doesn&apos;t show any new pages
          yet. The agent might have only updated existing pages, or the
          import returned without writing files. Check the{" "}
          <Link href={ownerHref} className="underline">
            owner console
          </Link>{" "}
          for the job log.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {grouped.map(([section, pages]) => (
            <div key={section}>
              <div className="text-[11px] uppercase tracking-wider text-green-800 font-semibold mb-1.5">
                {section} · {pages.length}
              </div>
              <ul className="space-y-1">
                {pages.map((p) => (
                  <li key={p.slug} className="flex items-baseline gap-2">
                    <Link
                      href={pageHref(p.slug)}
                      className="text-sm text-green-900 underline font-medium"
                    >
                      {p.title || p.slug}
                    </Link>
                    <span className="text-[11px] font-mono text-green-700">
                      {p.slug}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href={browseHref}
          className="px-3 py-1.5 rounded bg-green-700 text-white text-xs font-medium hover:bg-green-800"
        >
          browse all pages →
        </Link>
        <Link
          href={graphHref}
          className="px-3 py-1.5 rounded border border-green-300 text-green-900 text-xs font-medium hover:bg-green-100"
        >
          view graph
        </Link>
        <button
          onClick={onAgain}
          className="px-3 py-1.5 rounded border border-green-300 text-green-900 text-xs font-medium hover:bg-green-100"
        >
          import another
        </button>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</div>
      <div className="mt-0.5 text-ink">{children}</div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
