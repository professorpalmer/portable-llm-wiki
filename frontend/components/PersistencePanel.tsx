"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ownerPersistenceFlush,
  ownerPersistenceStatus,
  type PersistenceFlushResult,
  type PersistenceStatus,
} from "@/lib/api";

const POLL_INTERVAL_MS = 12_000;

export function PersistencePanel({ tenant }: { tenant?: string } = {}) {
  const [status, setStatus] = useState<PersistenceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);
  const [lastFlushResult, setLastFlushResult] =
    useState<PersistenceFlushResult | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const refresh = useCallback(async () => {
    try {
      const s = await ownerPersistenceStatus(tenant);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tenant]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Tick "n ago" timers every second so the UI feels live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const onFlush = async () => {
    setFlushing(true);
    try {
      const result = await ownerPersistenceFlush(tenant);
      setLastFlushResult(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFlushing(false);
    }
  };

  if (!status) {
    return (
      <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted">
          Persistence
        </h2>
        {error ? (
          <div className="mt-2 text-sm text-red-700">{error}</div>
        ) : (
          <div className="mt-2 text-sm text-ink-muted">loading…</div>
        )}
      </section>
    );
  }

  if (!status.enabled) {
    return (
      <section className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h2 className="text-sm uppercase tracking-wider text-amber-900 font-semibold">
            Persistence: <span className="text-amber-700">disabled</span>
          </h2>
          <span className="text-xs text-amber-800">no git remote configured</span>
        </div>
        <p className="mt-2 text-sm text-amber-900 leading-relaxed">
          Writes (ingest, capture, page edits, import) are saved to disk but{" "}
          <span className="font-semibold">won&apos;t survive a container restart</span>{" "}
          unless you wire the backend to a git remote.
        </p>
        <details className="mt-3 text-xs text-amber-900">
          <summary className="cursor-pointer font-semibold">
            How to enable git-backed persistence
          </summary>
          <ol className="mt-2 list-decimal pl-5 space-y-1 leading-relaxed">
            <li>
              Create an empty private GitHub repo (e.g. <code>my-wiki</code>).
            </li>
            <li>
              Generate a PAT with <code>repo</code> scope at{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                github.com/settings/tokens
              </a>
              .
            </li>
            <li>
              In your Render dashboard, set the env var{" "}
              <code className="font-mono">WIKI_GIT_REMOTE</code> to{" "}
              <code className="font-mono">
                https://USER:PAT@github.com/USER/my-wiki.git
              </code>
              .
            </li>
            <li>Redeploy. On boot the container clones the repo; every mutation pushes.</li>
          </ol>
        </details>
      </section>
    );
  }

  const lastOkAgo = status.last_flush_ok ? now - status.last_flush_ok : null;
  const lastAttemptAgo = status.last_flush_attempt
    ? now - status.last_flush_attempt
    : null;

  return (
    <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted font-semibold">
          Persistence{" "}
          <span className="ml-1 text-emerald-700 normal-case font-medium">
            · synced
          </span>
        </h2>
        <button
          onClick={onFlush}
          disabled={flushing}
          className="text-xs px-2.5 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink disabled:opacity-50"
        >
          {flushing ? "syncing…" : "force sync now"}
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 text-xs">
        <Cell label="remote">
          <code className="font-mono text-[11px] break-all">
            {status.remote}
          </code>
        </Cell>
        <Cell label="branch">
          <code className="font-mono">{status.branch}</code>
        </Cell>
        <Cell label="commits made">
          <span className="text-ink font-semibold">{status.commits_made}</span>
        </Cell>
        <Cell label="pushes made">
          <span className="text-ink font-semibold">{status.pushes_made}</span>
        </Cell>
        <Cell label="last successful push">
          {lastOkAgo == null ? (
            <span className="text-ink-muted">never</span>
          ) : (
            <span className="text-ink">{formatAgo(lastOkAgo)}</span>
          )}
        </Cell>
        <Cell label="last attempt">
          {lastAttemptAgo == null ? (
            <span className="text-ink-muted">never</span>
          ) : (
            <span className="text-ink">{formatAgo(lastAttemptAgo)}</span>
          )}
        </Cell>
        {status.pending_message_count > 0 && (
          <Cell label="pending">
            <span className="text-amber-700">
              {status.pending_message_count} writes queued
              {status.timer_scheduled && ` (flushing in ≤${status.push_delay_s}s)`}
            </span>
          </Cell>
        )}
        <Cell label="commit author">
          <span className="text-ink-muted">
            {status.user_name} &lt;{status.user_email}&gt;
          </span>
        </Cell>
      </div>

      {status.last_error && (
        <div className="mt-3 p-3 rounded bg-red-50 border border-red-200 text-xs text-red-900 break-words">
          <span className="font-semibold">last error: </span>
          <code className="font-mono">{status.last_error}</code>
        </div>
      )}

      {lastFlushResult && (
        <div
          className={`mt-3 p-3 rounded border text-xs ${
            lastFlushResult.error
              ? "bg-red-50 border-red-200 text-red-900"
              : lastFlushResult.pushed
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-paper-soft border-paper-soft text-ink-muted"
          }`}
        >
          {lastFlushResult.error ? (
            <>
              <span className="font-semibold">force sync failed: </span>
              <code className="font-mono">{lastFlushResult.error}</code>
            </>
          ) : lastFlushResult.pushed ? (
            <>
              <span className="font-semibold">force sync pushed.</span>{" "}
              {lastFlushResult.commit_summary && (
                <code className="font-mono">
                  {lastFlushResult.commit_summary}
                </code>
              )}
            </>
          ) : (
            <>
              <span className="font-semibold">nothing to sync.</span>{" "}
              {lastFlushResult.skipped || "no pending changes."}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function formatAgo(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
