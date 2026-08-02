"use client";

// Chat-style interface over the wiki. Multi-turn, with the conversation
// history threaded back to the LLM so follow-ups like "tell me more" or
// "what about X?" carry context. Each assistant turn shows citations +
// optional retrieval-debug for transparency about which pages were used.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  streamChatWithWiki,
  type ChatResponse,
  type ChatTurn,
} from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { useTenant } from "@/lib/useTenant";

type Turn =
  | {
      kind: "user";
      content: string;
      id: number;
    }
  | {
      kind: "assistant";
      content: string;
      id: number;
      citations: ChatResponse["citations"];
      retrieval: ChatResponse["retrieval"];
      backend: ChatResponse["backend"];
      model: ChatResponse["model"];
      viewerTier: string;
    }
  | {
      kind: "error";
      content: string;
      id: number;
    };

const SUGGESTIONS = [
  "What are this wiki's foundational concepts?",
  "Summarize the most recent decisions.",
  "What projects are documented here?",
  "What's missing? What should I ingest next?",
];

let _turnId = 0;
const newId = () => ++_turnId;

export default function AskPage() {
  const tenant = useTenant();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll the conversation to the latest turn on each update.
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const buildHistory = (): ChatTurn[] => {
    // Convert internal turns to the API's [{role, content}] shape, skipping
    // error turns (they're UI affordances, not real conversation history).
    const out: ChatTurn[] = [];
    for (const t of turns) {
      if (t.kind === "user") out.push({ role: "user", content: t.content });
      else if (t.kind === "assistant")
        out.push({ role: "assistant", content: t.content });
    }
    return out;
  };

  async function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed || pending) return;

    const history = buildHistory();
    const userTurn: Turn = {
      kind: "user",
      content: trimmed,
      id: newId(),
    };
    // Reserve the assistant turn up-front so tokens stream into it as they arrive.
    const assistantId = newId();
    const placeholder: Turn = {
      kind: "assistant",
      content: "",
      id: assistantId,
      citations: [],
      retrieval: null,
      backend: "keyword",
      model: null,
      viewerTier: "public",
    };
    setTurns((t) => [...t, userTurn, placeholder]);
    setDraft("");
    setPending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = "";
    let streamError: string | null = null;

    try {
      await streamChatWithWiki(
        trimmed,
        history,
        (evt) => {
          if (evt.type === "start") {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId && t.kind === "assistant"
                  ? {
                      ...t,
                      citations: evt.citations,
                      retrieval: evt.retrieval,
                      backend: evt.backend,
                      model: evt.model,
                      viewerTier: evt.viewer_tier,
                    }
                  : t,
              ),
            );
          } else if (evt.type === "token") {
            accumulated += evt.text;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId && t.kind === "assistant"
                  ? { ...t, content: accumulated }
                  : t,
              ),
            );
          } else if (evt.type === "error") {
            streamError = evt.message;
          }
        },
        controller.signal,
        tenant,
      );
    } catch (e) {
      // AbortError (user clicked stop) — leave whatever streamed in place.
      const aborted = (e as Error).name === "AbortError";
      if (!aborted) {
        streamError = (e as Error).message;
      }
    } finally {
      setPending(false);
      abortRef.current = null;
    }

    if (streamError) {
      const errorTurn: Turn = {
        kind: "error",
        content: streamError,
        id: newId(),
      };
      setTurns((t) => [...t, errorTurn]);
    }
  }

  const stop = () => {
    abortRef.current?.abort();
  };

  const reset = () => {
    abortRef.current?.abort();
    setTurns([]);
    setDraft("");
  };

  return (
    <div className="max-w-3xl mx-auto px-5 py-8">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Chat with the wiki
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Multi-turn conversation. Follow-ups know what you asked before.
            Every answer cites the pages it&apos;s drawn from.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            onClick={reset}
            className="text-xs text-ink-muted hover:text-ink underline"
          >
            new chat
          </button>
        )}
      </div>

      {turns.length === 0 && (
        <div className="mt-6 p-5 rounded border border-paper-soft bg-paper-soft/40">
          <div className="text-sm text-ink-muted mb-3">
            Try one of these to get started:
          </div>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                disabled={pending}
                className="text-xs bg-white border border-paper-soft text-ink px-2.5 py-1.5 rounded hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.length > 0 && (
        <div className="mt-6 space-y-4">
          {turns.map((t) => {
            // Hide the placeholder assistant bubble until the first token
            // arrives — otherwise the empty bubble looks like a bug.
            if (t.kind === "assistant" && t.content === "") return null;
            return <TurnBubble key={t.id} turn={t} tenant={tenant} />;
          })}
          {pending && (
            <div className="flex items-center justify-between gap-2 text-sm text-ink-muted py-2 pl-2">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
                <span>
                  {turns[turns.length - 1]?.kind === "assistant" &&
                  (turns[turns.length - 1] as Turn & { content: string })
                    .content !== ""
                    ? "streaming…"
                    : "thinking…"}
                </span>
              </div>
              <button
                onClick={stop}
                className="text-xs text-ink-muted hover:text-ink underline"
              >
                stop
              </button>
            </div>
          )}
          <div ref={scrollRef} />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className={`${
          turns.length === 0 ? "mt-6" : "mt-6 sticky bottom-4 z-10"
        }`}
      >
        <div className="bg-white border border-paper-soft rounded-lg shadow-sm">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={
              turns.length === 0
                ? "Ask a question (Cmd+Enter to submit)"
                : "Ask a follow-up…"
            }
            className="w-full p-3 text-base bg-transparent rounded-lg resize-none focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send(draft);
              }
            }}
          />
          <div className="flex items-center justify-between px-3 py-2 border-t border-paper-soft">
            <span className="text-xs text-ink-muted">
              {turns.length === 0
                ? "Cmd+Enter to send"
                : `${
                    Math.floor(
                      buildHistory().filter((h) => h.role === "user").length,
                    )
                  } prior turn${
                    buildHistory().filter((h) => h.role === "user").length ===
                    1
                      ? ""
                      : "s"
                  } in context`}
            </span>
            <button
              type="submit"
              disabled={pending || !draft.trim()}
              className="px-3 py-1.5 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
            >
              {pending ? "thinking…" : "send"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function TurnBubble({ turn, tenant }: { turn: Turn; tenant?: string }) {
  const prefix = tenant ? `/${tenant}` : "";
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-accent/10 text-ink rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed">
          {turn.content}
        </div>
      </div>
    );
  }
  if (turn.kind === "error") {
    return (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
        Error: {turn.content}
      </div>
    );
  }

  // Assistant turn — full markdown answer + citations + retrieval debug.
  return (
    <div className="flex justify-start">
      <div className="max-w-full sm:max-w-[92%] w-full">
        <div className="bg-white border border-paper-soft rounded-2xl rounded-bl-md px-4 py-3">
          <Markdown tenant={tenant}>{turn.content}</Markdown>
        </div>

        <div className="mt-1.5 px-1 flex items-center gap-3 text-[11px] text-ink-muted">
          <span>
            backend: <code className="font-mono text-ink">{turn.backend}</code>
          </span>
          {turn.model && (
            <span>
              model: <code className="font-mono text-ink">{turn.model}</code>
            </span>
          )}
          <span>
            tier:{" "}
            <code className="font-mono text-ink">{turn.viewerTier}</code>
          </span>
        </div>

        {turn.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {turn.citations.map((c) => (
              <Link
                key={c.slug}
                href={`${prefix}/page/${encodeURIComponent(c.slug)}`}
                className="text-xs border border-paper-soft bg-white rounded px-2 py-0.5 text-ink hover:border-accent hover:text-accent"
              >
                {c.title}
              </Link>
            ))}
          </div>
        )}

        {turn.retrieval && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-ink-muted hover:text-ink">
              retrieval · {turn.retrieval.total_pages_in_context} pages ·{" "}
              {turn.retrieval.edge_count} edges ·{" "}
              <code className="font-mono">{turn.retrieval.strategy}</code>
            </summary>
            <div className="mt-2 grid sm:grid-cols-2 gap-3 bg-paper-soft rounded-lg p-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">
                  Anchors (keyword)
                </div>
                <ul className="space-y-0.5">
                  {turn.retrieval.anchors.map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`${prefix}/page/${encodeURIComponent(a.slug)}`}
                        className="text-ink hover:text-accent"
                      >
                        ★ {a.title}{" "}
                        <span className="text-ink-muted tabular-nums">
                          ({a.score})
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">
                  Expanded ({turn.retrieval.hops}-hop walk)
                </div>
                <ul className="space-y-0.5">
                  {turn.retrieval.expanded.length === 0 && (
                    <li className="text-ink-muted">(none)</li>
                  )}
                  {turn.retrieval.expanded.map((e) => (
                    <li key={e.slug}>
                      <Link
                        href={`${prefix}/page/${encodeURIComponent(e.slug)}`}
                        className="text-ink-muted hover:text-ink"
                      >
                        · {e.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
