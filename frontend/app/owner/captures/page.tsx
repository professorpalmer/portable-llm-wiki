"use client";

// Capture history view: lists raw/ source files with inline previews,
// re-ingest, and delete actions. This is the "what does my wiki actually
// know about?" surface — the place where you go to audit, prune, or
// re-process old captures after improving your prompts.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ownerDeleteRaw,
  ownerListRaw,
  ownerRawBulk,
  ownerReadRaw,
  ownerReingestRaw,
  type RawFile,
  type SyncVerdict,
} from "@/lib/api";
import { SyncWarning } from "@/components/SyncWarning";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; rows: RawFile[] }
  | { kind: "error"; message: string };

const KIND_COLORS: Record<string, string> = {
  conversations: "bg-blue-50 text-blue-700 border-blue-200",
  imports: "bg-purple-50 text-purple-700 border-purple-200",
  voice: "bg-emerald-50 text-emerald-700 border-emerald-200",
  vision: "bg-amber-50 text-amber-700 border-amber-200",
  other: "bg-paper-soft text-ink-muted border-paper-soft",
};

const KIND_FILTERS: { id: string | "all"; label: string }[] = [
  { id: "all", label: "all" },
  { id: "conversations", label: "paste" },
  { id: "imports", label: "imports" },
  { id: "voice", label: "voice" },
  { id: "vision", label: "vision" },
];

export default function CapturesPage() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [openRel, setOpenRel] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string>("");
  const [openLoading, setOpenLoading] = useState<boolean>(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncVerdict | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  const reload = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const rows = await ownerListRaw(200);
      setStatus({ kind: "ok", rows });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const openFile = async (rel: string) => {
    setOpenRel(rel);
    setOpenLoading(true);
    setOpenContent("");
    try {
      const content = await ownerReadRaw(rel);
      setOpenContent(content);
    } catch (e) {
      setOpenContent(`# could not load\n\n${(e as Error).message}`);
    } finally {
      setOpenLoading(false);
    }
  };

  const onDelete = async (rel: string) => {
    if (
      !confirm(
        `Delete this raw capture?\n\n${rel}\n\nPages already drafted from it will NOT be deleted.`,
      )
    ) {
      return;
    }
    setActionMsg(null);
    setSync(null);
    try {
      const res = await ownerDeleteRaw(rel);
      setActionMsg(`deleted ${rel}`);
      setSync(res.sync ?? null);
      if (openRel === rel) {
        setOpenRel(null);
        setOpenContent("");
      }
      await reload();
    } catch (e) {
      setActionMsg(`failed: ${(e as Error).message}`);
    }
  };

  const onReingest = async (rel: string) => {
    setActionMsg(null);
    try {
      const result = await ownerReingestRaw(rel);
      setActionMsg(
        `re-ingest queued (job ${result.tracking_id}). watch /owner for status`,
      );
    } catch (e) {
      setActionMsg(`failed: ${(e as Error).message}`);
    }
  };

  const rows = status.kind === "ok" ? status.rows : [];
  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (filter !== "all" && r.kind !== filter) return false;
        if (search) {
          const needle = search.toLowerCase();
          if (
            !r.rel_path.toLowerCase().includes(needle) &&
            !(r.excerpt || "").toLowerCase().includes(needle)
          ) {
            return false;
          }
        }
        return true;
      }),
    [rows, filter, search],
  );

  const toggleSelected = (rel: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(filteredRows.map((r) => r.rel_path)));
  };

  const clearSelection = () => setSelected(new Set());

  const onBulk = async (action: "delete" | "reingest") => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    const verb = action === "delete" ? "delete" : "re-ingest";
    const confirmMsg =
      action === "delete"
        ? `Delete ${paths.length} raw capture${paths.length === 1 ? "" : "s"}? Pages derived from them will NOT be deleted.`
        : `Queue ${paths.length} re-ingest job${paths.length === 1 ? "" : "s"}? Each will run sequentially.`;
    if (!confirm(confirmMsg)) return;

    setActionMsg(null);
    setSync(null);
    setBulkRunning(true);
    try {
      const result = await ownerRawBulk(action, paths);
      setSync(result.sync ?? null);
      const failureSummary =
        result.error_count > 0
          ? ` · ${result.error_count} failed (${result.results
              .filter((r) => !r.ok)
              .slice(0, 2)
              .map((r) => r.error)
              .join("; ")})`
          : "";
      setActionMsg(
        `${verb}: ${result.ok_count}/${result.total} ok${failureSummary}`,
      );
      clearSelection();
      if (action === "delete") {
        // Drop deleted rows from the open detail if shown
        if (openRel && result.results.some((r) => r.ok && r.rel_path === openRel)) {
          setOpenRel(null);
          setOpenContent("");
        }
        await reload();
      }
    } catch (e) {
      setActionMsg(`failed: ${(e as Error).message}`);
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-5 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-muted font-medium">
            Owner · capture history
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-semibold tracking-tight text-ink">
            Raw captures
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <Link href="/owner" className="underline hover:text-ink">
            ← owner console
          </Link>
          <Link href="/capture" className="underline hover:text-ink">
            new capture
          </Link>
        </div>
      </div>

      <p className="mt-3 text-sm text-ink-muted leading-relaxed max-w-2xl">
        Everything you&apos;ve dropped into the wiki via paste, voice, vision,
        or import. Each capture lives at <code>raw/&lt;kind&gt;/&lt;file&gt;.md</code>{" "}
        on disk and is preserved indefinitely. Re-ingest if you&apos;ve
        improved your prompt templates; delete if it&apos;s scratch you
        no longer need.
      </p>

      {/* Filter bar */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5 flex-wrap">
          {KIND_FILTERS.map((f) => {
            const count =
              f.id === "all"
                ? rows.length
                : rows.filter((r) => r.kind === f.id).length;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`text-xs px-2.5 py-1 rounded border ${
                  filter === f.id
                    ? "border-accent bg-accent/5 text-ink"
                    : "border-paper-soft bg-white text-ink-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                {f.label}{" "}
                <span className="text-ink-muted/70">({count})</span>
              </button>
            );
          })}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search path or text…"
          className="ml-auto text-sm border border-paper-soft rounded px-3 py-1.5 w-56 focus:border-accent focus:outline-none"
        />
      </div>

      {actionMsg && (
        <div className="mt-4 px-3 py-2 rounded bg-paper-soft text-xs text-ink">
          {actionMsg}
        </div>
      )}
      <SyncWarning sync={sync} />

      {/* Bulk action bar — sticky so it stays visible while scrolling a long list */}
      {selected.size > 0 && (
        <div className="mt-4 sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-ink text-paper rounded px-3 py-2 text-sm shadow">
          <span className="font-medium">
            {selected.size} selected
          </span>
          <span className="text-paper/70 text-xs">
            ({filteredRows.length} visible)
          </span>
          <button
            onClick={selectAllVisible}
            disabled={bulkRunning}
            className="text-xs px-2 py-0.5 rounded border border-paper/30 hover:bg-paper/10 disabled:opacity-50"
          >
            select all visible
          </button>
          <button
            onClick={clearSelection}
            disabled={bulkRunning}
            className="text-xs px-2 py-0.5 rounded border border-paper/30 hover:bg-paper/10 disabled:opacity-50"
          >
            clear
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => onBulk("reingest")}
              disabled={bulkRunning}
              className="text-xs px-3 py-1 rounded bg-paper/15 hover:bg-paper/25 disabled:opacity-50"
            >
              {bulkRunning ? "running…" : "re-ingest all"}
            </button>
            <button
              onClick={() => onBulk("delete")}
              disabled={bulkRunning}
              className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              delete all
            </button>
          </div>
        </div>
      )}

      {status.kind === "loading" && (
        <div className="mt-6 text-sm text-ink-muted">loading…</div>
      )}
      {status.kind === "error" && (
        <div className="mt-6 text-sm text-red-700">
          {status.message}{" "}
          <button onClick={reload} className="ml-2 underline">
            retry
          </button>
        </div>
      )}

      {status.kind === "ok" && (
        <div className="mt-6 grid md:grid-cols-2 gap-4">
          {/* List */}
          <div className="space-y-2">
            {filteredRows.length === 0 && (
              <div className="text-sm text-ink-muted py-8 text-center border border-dashed border-paper-soft rounded">
                {rows.length === 0
                  ? "no captures yet. go to /capture"
                  : "no captures match this filter"}
              </div>
            )}
            {filteredRows.map((r) => (
              <CaptureRow
                key={r.rel_path}
                row={r}
                isOpen={openRel === r.rel_path}
                isSelected={selected.has(r.rel_path)}
                onToggleSelect={() => toggleSelected(r.rel_path)}
                onOpen={() => openFile(r.rel_path)}
                onDelete={() => onDelete(r.rel_path)}
                onReingest={() => onReingest(r.rel_path)}
              />
            ))}
          </div>

          {/* Detail */}
          <div className="md:sticky md:top-6 self-start">
            {openRel ? (
              <div className="border border-paper-soft rounded bg-white">
                <div className="px-3 py-2 border-b border-paper-soft flex items-center justify-between gap-2">
                  <code className="text-xs font-mono text-ink-muted break-all">
                    {openRel}
                  </code>
                  <button
                    onClick={() => {
                      setOpenRel(null);
                      setOpenContent("");
                    }}
                    className="text-xs text-ink-muted hover:text-ink"
                  >
                    close ×
                  </button>
                </div>
                <pre className="p-3 max-h-[60vh] overflow-auto text-xs font-mono whitespace-pre-wrap text-ink">
                  {openLoading ? "loading…" : openContent}
                </pre>
              </div>
            ) : (
              <div className="text-sm text-ink-muted py-12 text-center border border-dashed border-paper-soft rounded">
                click a capture to preview its full source
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CaptureRow({
  row,
  isOpen,
  isSelected,
  onToggleSelect,
  onOpen,
  onDelete,
  onReingest,
}: {
  row: RawFile;
  isOpen: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onReingest: () => void;
}) {
  const kindClass = KIND_COLORS[row.kind] || KIND_COLORS.other;
  const date = new Date(row.mtime * 1000);
  const dateStr = date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const filename =
    row.rel_path.split("/").pop()?.replace(/\.md$/, "") || row.rel_path;

  return (
    <div
      className={`border rounded p-3 cursor-pointer transition ${
        isSelected
          ? "border-accent bg-accent/10"
          : isOpen
            ? "border-accent bg-accent/5"
            : "border-paper-soft bg-white hover:border-ink/30"
      }`}
      onClick={onOpen}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`select ${filename}`}
          className="mt-0.5 cursor-pointer accent-ink"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${kindClass}`}
            >
              {row.kind}
            </span>
            <span className="text-[11px] text-ink-muted whitespace-nowrap">
              {dateStr}
            </span>
          </div>
          <div className="text-sm font-medium text-ink break-words">
            {filename}
          </div>
          {row.excerpt && (
            <div className="mt-1 text-xs text-ink-muted leading-relaxed line-clamp-2">
              {row.excerpt}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="text-ink-muted">
              {(row.size / 1024).toFixed(1)} KB
            </span>
            <span className="text-ink-muted">·</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReingest();
              }}
              className="text-ink-muted hover:text-ink underline"
            >
              re-ingest
            </button>
            <span className="text-ink-muted">·</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-red-600 hover:text-red-700 underline"
            >
              delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
