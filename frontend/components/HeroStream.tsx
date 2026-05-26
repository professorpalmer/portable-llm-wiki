"use client";

// The killer-feature of the landing page: a live streaming demo of the
// portable-llm-wiki protocol. On mount we type out a pre-canned question
// character-by-character, then stream a real answer from /wiki/chat/stream
// over SSE, then surface citations as chips linking back into the wiki.
//
// The component is showcase-grade: if the backend is unreachable or errors,
// it silently falls back to a hardcoded answer per prompt so the landing
// page NEVER looks broken to a first-time visitor.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildQrPayload } from "@/lib/llmPrompts";
import { streamChatWithWiki, type ChatStreamEvent } from "@/lib/api";
import { Markdown } from "@/components/Markdown";

type CannedPrompt = {
  question: string;
  // Fallback shown if the backend stream errors or yields no tokens.
  fallbackAnswer: string;
  fallbackCitations: { slug: string; title: string }[];
};

// Hand-picked so they all produce strong, citation-rich answers off the
// Avery / Strand Bio seed wiki. Order matters — the first one is what
// loads on first paint, so it should be the most punchy.
//
// Selection bias: prefer questions that traverse multiple pages and feel
// emotionally textured (real human deliberation), not just factual
// lookups. The "aha" comes from the LLM clearly using Avery's actual
// life as the substrate, not generic LLM knowledge.
const PROMPTS: CannedPrompt[] = [
  {
    // "Who am I?" is the demo's anchor question — it's what an LLM asks
    // itself after a user pastes the wiki URL (or scans the QR) and says
    // "use this as my context." The answer is phrased in second person
    // ("You are Avery Chen…") because that's how the recipient LLM will
    // internalize it: as facts about its operator. This visually closes
    // the loop with the QR-next-to-the-question layout: scan the QR →
    // any LLM can answer "who am I?" → here's what it says.
    //
    // Densest hyperlink + tier display in the canned set so a single
    // streamed answer communicates the "portable DB of you" thesis at a
    // glance: name, role, company, principles, key relationships,
    // current decisions.
    question: "Who am I?",
    fallbackAnswer:
      "You are **Avery Chen**, founding engineer at [[Strand Bio]] — a nine-person synthetic-biology startup in San Francisco. You run all of engineering and report directly to CEO [[Linh Park]].\n\n" +
      "**The 30-second version**\n\n" +
      "- You joined Strand in late 2025 off a cold email from Linh, a few months after [[2024-08-15 Leaving Grad School|leaving]] your computational-biology PhD at Stanford under [[Hannah Wu]].\n" +
      "- You own *how it ships*; Linh owns *what to build*. Disagreements get arbitrated on [[Demo Friday]] — the operating cadence you both adopted from a shared belief in [[Provenance Over Recall]].\n" +
      "- You operate by five named principles: [[Boring Stack First]], [[Provenance Over Recall]], [[Small Teams Compounding]], [[Working Memory]], and [[Demo Friday]].\n\n" +
      "**How you work.** Direct, fast, opinionated, with the receipts. Every meaningful decision lands in a saved deliberation (the wiki you're reading) before it lands in Slack — see [[2026-04-12 Postgres Over Mongo|the Postgres choice]] or [[2026-05-20 Postpone Series A|the Series-A postponement]]. You hire one role ahead of pain when you can; defer when policy or capital constraints make waiting cheaper.\n\n" +
      "**Currently navigating.** Series A pushed to mid-2027 ([[2026-05-20 Postpone Series A]]). The VP-of-Eng hire is on hold until the role is scoped and [[Theo Nakamura]]'s remote-by-default setup stops colliding with your [[2026-04-30 Keep Team Onsite|new 4-day-onsite policy]].",
    fallbackCitations: [
      { slug: "avery-chen", title: "Avery Chen" },
      { slug: "strand-bio", title: "Strand Bio" },
      { slug: "linh-park", title: "Linh Park" },
      { slug: "hannah-wu", title: "Hannah Wu" },
      { slug: "2024-08-15-leaving-grad-school", title: "Leaving Grad School" },
      { slug: "boring-stack-first", title: "Boring stack first" },
      { slug: "provenance-over-recall", title: "Provenance over recall" },
      { slug: "small-teams-compounding", title: "Small teams compounding" },
      { slug: "working-memory", title: "Working memory" },
      { slug: "demo-friday", title: "Demo Friday" },
      { slug: "2026-05-20-postpone-series-a", title: "Postpone Series A" },
      { slug: "2026-04-30-keep-team-onsite", title: "Keep Team Onsite" },
      { slug: "2026-04-12-postgres-over-mongo", title: "Postgres over Mongo" },
      { slug: "theo-nakamura", title: "Theo Nakamura" },
    ],
  },
  {
    question: "Why did Avery leave her PhD program?",
    fallbackAnswer:
      "Avery left Stanford in August 2024, three years into a planned five-year PhD in computational biology under Dr. Hannah Wu.\n\n" +
      "The trigger was a competing group's preprint that matched what would have been thesis chapter four, six months before Avery would have submitted. The realistic completion timeline jumped from 18 to 30 months, and the thesis-as-distinct-contribution argument collapsed.\n\n" +
      "Avery's own log of the decision names three reasons, in order of weight: the opportunity cost suddenly visible (the competing preprint), the work that mattered was downstream (deployment, not method extension), and the advisor's incentives diverged from hers. *Not all well-intentioned mentors give advice optimized for the mentee.*\n\n" +
      "Wu's recommendation letter included the line Avery saved: *\"Their decision is correct under their stated objectives. I do not agree with every objective.\"*",
    fallbackCitations: [
      { slug: "2024-08-15-leaving-grad-school", title: "Leaving Grad School" },
      { slug: "hannah-wu", title: "Hannah Wu" },
      { slug: "avery-chen", title: "Avery Chen" },
    ],
  },
  {
    question: "Should Avery hire a VP of Engineering right now?",
    fallbackAnswer:
      "No, and the wiki has a saved deliberation on exactly this question dated 2026-05-22.\n\n" +
      "Three pages bear on the answer:\n\n" +
      "- **Theo Nakamura.** A plausible candidate Avery has been informally tracking, but the relationship is warm-not-deep and Theo is currently remote.\n" +
      "- **Keep Team Onsite (2026-04-30).** The new 4-day-onsite policy makes Theo's current setup a blocker until at least Q4 2026.\n" +
      "- **Postpone Series A (2026-05-20).** The natural moment for a VP Eng hire is *after* a Series A, and the Series A was just pushed to mid-2027.\n\n" +
      "Avery's own conclusion: don't surface Theo to Linh yet. The role hasn't been scoped, the constraint stack has shifted twice in two weeks, and the cost of waiting six months is approximately zero. Instead, draft a one-pager titled *\"When do we need a VP Eng?\"* with no candidates named, and bring it to a non-demo 1:1 with Linh.",
    fallbackCitations: [
      { slug: "should-i-bring-up-the-vp-eng-hire-with-linh", title: "Should I bring up the VP Eng hire with Linh?" },
      { slug: "theo-nakamura", title: "Theo Nakamura" },
      { slug: "2026-05-20-postpone-series-a", title: "Postpone Series A" },
      { slug: "2026-04-30-keep-team-onsite", title: "Keep Team Onsite" },
    ],
  },
  {
    question: "Who is Linh Park and how does she work with Avery?",
    fallbackAnswer:
      "Linh Park is the CEO and cofounder of Strand Bio. Biologist by training (PhD from MIT, postdoc at the Broad). She spun Strand Bio out of an unfunded side-project during the last six months of her postdoc, then recruited Avery directly off a cold email in late 2025.\n\n" +
      "The working model is clean: **Linh owns *what to build*, Avery owns *how it ships***, with overlap arbitrated on Demo Friday. Disagreements so far have all been about pace, not direction. Linh wants to wait for evidence before hiring; Avery wants to hire one role ahead of pain.\n\n" +
      "The compromise has held: the Mia Patel hire moved at Avery's pace, the Series A timing moved at Linh's. Same operating principle (*Provenance Over Recall*) underwrites how both of them treat un-cited claims. Linh learned it on the wrong end of PhD defenses; Avery treats it as a hiring filter.",
    fallbackCitations: [
      { slug: "linh-park", title: "Linh Park" },
      { slug: "avery-chen", title: "Avery Chen" },
      { slug: "demo-friday", title: "Demo Friday" },
      { slug: "provenance-over-recall", title: "Provenance over recall" },
    ],
  },
  {
    question: "Why did Avery pick Postgres over Mongo at Strand Bio?",
    fallbackAnswer:
      "In April 2026, Avery chose Postgres for Strand Bio's primary store, over an early proposal to use MongoDB. The decision log captures three reasons in order of weight:\n\n" +
      "- **Provenance over recall.** Every inventory row needs to cite its source: the lab notebook entry, the receiving doc, the wet-lab run. Joining on a foreign key in Postgres is trivial; reconstructing provenance across a document store is materially harder.\n" +
      "- **Boring stack first.** Postgres has 28 years of production shipping; Mongo has 16. Every team member had shipped Postgres before; nobody had shipped Mongo at the scale needed.\n" +
      "- **Query flexibility.** *\"Find every plate with a sample from supplier X used in any run between dates Y and Z\"* is hostile to a document model and trivial in SQL.\n\n" +
      "Six weeks in: schema has evolved twice, no regrets.",
    fallbackCitations: [
      { slug: "2026-04-12-postgres-over-mongo", title: "Postgres over Mongo" },
      { slug: "boring-stack-first", title: "Boring stack first" },
      { slug: "provenance-over-recall", title: "Provenance over recall" },
    ],
  },
  {
    question: "What are Avery's operating principles?",
    fallbackAnswer:
      "Avery operates by five principles, each documented as its own concept page:\n\n" +
      "- **Boring Stack First.** The first version of any system uses the most boring technology that could plausibly work: ≥7 years old, ≥1M production deployments. Novelty in the *product* compounds; novelty in the *stack* mostly costs.\n" +
      "- **Provenance Over Recall.** Every claim cites its source. A smaller wiki that doesn't lie beats a sprawling one that hallucinates.\n" +
      "- **Small Teams Compounding.** At 9 people, the compounding asset is unblocked Slack-to-whiteboard latency. Each hire should multiply the team, not just add to it.\n" +
      "- **Working Memory.** This wiki itself isn't an archive. It's a working memory shaped for an LLM to read. Short, opinionated, link-rich pages.\n" +
      "- **Demo Friday.** Every Friday, every team member demos one thing they shipped. \"Demo or skip, no updates.\" The forcing function for shippable work.",
    fallbackCitations: [
      { slug: "boring-stack-first", title: "Boring stack first" },
      { slug: "provenance-over-recall", title: "Provenance over recall" },
      { slug: "small-teams-compounding", title: "Small teams compounding" },
      { slug: "working-memory", title: "Working memory" },
      { slug: "demo-friday", title: "Demo Friday" },
    ],
  },
];

const TYPE_SPEED_MS = 38;

type Phase = "typing" | "streaming" | "done";

export function HeroStream({
  tenant,
  wikiShareUrl,
  wikiQrUrl,
  wikiOwnerLabel,
}: {
  tenant?: string;
  /** The /llm endpoint URL. Surfaced in the URL pill + "Copy URL"
   * button beside the QR — this is the link a HUMAN copies to paste
   * into ChatGPT/Claude. The /llm endpoint returns the self-describing
   * markdown handshake. */
  wikiShareUrl?: string;
  /** The HUMAN-facing landing URL. Encoded in the QR so phone scans
   * open the rendered wiki landing page (which itself has a prominent
   * "Paste this URL into any LLM" widget) instead of raw markdown.
   * When omitted, falls back to wikiShareUrl for backward compat with
   * older callers that haven't split the two URLs yet. */
  wikiQrUrl?: string;
  /** Display label for whose wiki the embedded QR points to ("Avery's
   * wiki", or "@professorpalmer"). Drives the prompt copy under the QR.
   * Defaults to "this wiki" when omitted. */
  wikiOwnerLabel?: string;
} = {}) {
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [typedQ, setTypedQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<{ slug: string; title: string }[]>(
    [],
  );
  const [usedFallback, setUsedFallback] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState<"url" | "qr" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guards against React 18 StrictMode double-invoking the streaming effect
  // (which would fire two SSE requests and double-render tokens).
  const streamStartedFor = useRef<number>(-1);

  const current = PROMPTS[idx];

  // The QR encodes the HUMAN-facing landing URL (wikiQrUrl) so phone
  // scans open the rendered wiki — not the raw /llm markdown handshake.
  // Falls back to wikiShareUrl for callers that haven't split the two
  // URLs yet (the fallback preserves the old behavior rather than
  // silently rendering nothing). Same color + sizing as /share so a
  // visitor who eventually mints their own wiki sees a familiar
  // artifact.
  const qrEncodedUrl = wikiQrUrl ?? wikiShareUrl;
  useEffect(() => {
    if (!qrEncodedUrl) {
      setQrDataUrl(null);
      return;
    }
    // Encode the URL only (no wrapper prompt). Phone cameras only
    // offer a one-tap "Open in browser" action when the entire decoded
    // payload is a URL — wrapping it in a sentence broke that. See
    // frontend/lib/llmPrompts.ts:buildQrPayload for the full rationale.
    QRCode.toDataURL(buildQrPayload(qrEncodedUrl), {
      width: 256,
      margin: 1,
      color: { dark: "#0e0e10", light: "#fafaf7" },
      errorCorrectionLevel: "M",
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [qrEncodedUrl]);

  const handleCopyShareUrl = () => {
    if (!wikiShareUrl) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(wikiShareUrl);
      setShareCopied("url");
      setTimeout(() => setShareCopied(null), 1500);
    }
  };

  const handleDownloadQR = () => {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    // Filename signals "this is the artifact" — date-stamped so multiple
    // versions don't overwrite when the user shares incrementally.
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `portable-llm-wiki-${tenant || "share"}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setShareCopied("qr");
    setTimeout(() => setShareCopied(null), 1500);
  };

  // Phase 1 — type the question into the screen, char by char.
  useEffect(() => {
    abortRef.current?.abort();
    setTypedQ("");
    setAnswer("");
    setCitations([]);
    setUsedFallback(false);
    setPhase("typing");

    const q = current.question;
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setTypedQ(q.slice(0, i));
      if (i >= q.length) {
        clearInterval(t);
        setPhase("streaming");
      }
    }, TYPE_SPEED_MS);

    return () => clearInterval(t);
  }, [idx, current.question]);

  // Phase 2 — once typing is done, fire the real SSE stream.
  useEffect(() => {
    if (phase !== "streaming") return;
    if (streamStartedFor.current === idx) return;
    streamStartedFor.current = idx;

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = "";
    let gotAnyToken = false;
    let errored = false;

    (async () => {
      try {
        await streamChatWithWiki(
          current.question,
          [],
          (evt: ChatStreamEvent) => {
            if (evt.type === "start") {
              setCitations(evt.citations);
            } else if (evt.type === "token") {
              gotAnyToken = true;
              accumulated += evt.text;
              setAnswer(accumulated);
            } else if (evt.type === "error") {
              errored = true;
            }
          },
          controller.signal,
          tenant,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        errored = true;
      }

      // The showcase MUST always look working. If anything went sideways
      // (backend down, OPENAI/ANTHROPIC key missing, network blip), swap
      // in the hand-crafted fallback so the visitor never sees a broken
      // demo on first paint.
      if (errored || !gotAnyToken) {
        setUsedFallback(true);
        setAnswer(current.fallbackAnswer);
        setCitations(current.fallbackCitations);
      }
      setPhase("done");
    })();

    return () => {
      controller.abort();
    };
  }, [phase, idx, current, tenant]);

  const nextPrompt = () => {
    streamStartedFor.current = -1;
    setIdx((i) => (i + 1) % PROMPTS.length);
  };

  const jumpToPrompt = (target: number) => {
    if (target === idx) return;
    streamStartedFor.current = -1;
    setIdx(target);
  };

  return (
    <div className="border border-ink/15 rounded-2xl bg-white shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(14,14,16,0.18)] overflow-hidden">
      {/* Demo "chrome" — a faux terminal/browser bar to signal this is live. */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2.5 border-b border-paper-soft bg-paper-soft/60">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <div className="text-[11px] font-mono text-ink-muted truncate">
          POST /wiki/chat/stream
        </div>
        <div className="text-[11px] uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              phase === "streaming"
                ? "bg-accent animate-pulse"
                : phase === "done"
                  ? usedFallback
                    ? "bg-amber-400"
                    : "bg-emerald-500"
                  : "bg-ink-muted/50"
            }`}
          />
          <span className="hidden sm:inline">
            {phase === "typing"
              ? "asking"
              : phase === "streaming"
                ? "streaming"
                : usedFallback
                  ? "cached"
                  : "done"}
          </span>
        </div>
      </div>

      <div className="p-5 sm:p-7">
        {/* Question + QR side-by-side. The QR is the *artifact* a user
            shares; the question is what an LLM asks itself when it
            receives that artifact. Pairing them visually communicates
            the entire "portable DB of you" thesis before the answer
            has even finished streaming.

            On mobile the QR drops below the question; on desktop it
            anchors the right edge of the card. The block is rendered
            UNCONDITIONALLY (not gated on phase) so first-paint shows
            the QR alongside the typed question — same frame the user
            forms the mental model "scan this → ask 'who am I?' → get
            this answer." */}
        <div className="flex flex-col sm:flex-row gap-5 sm:gap-6 items-stretch">
          {/* Left: question + (later) answer. */}
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
              Question
            </div>
            <div className="mt-1.5 text-lg sm:text-xl text-ink font-medium leading-snug min-h-[3.5rem] sm:min-h-[3rem]">
              {typedQ}
              {phase === "typing" && (
                <span className="inline-block w-[3px] h-[1em] -mb-[0.15em] ml-0.5 bg-accent animate-pulse align-middle" />
              )}
            </div>
          </div>

          {/* Right: the QR + share affordances. Always visible. */}
          {wikiShareUrl && (
            <aside className="shrink-0 sm:w-[240px] rounded-xl border-2 border-accent/30 bg-accent/5 p-3 sm:p-3.5 self-start">
              <div className="text-[10px] uppercase tracking-[0.18em] text-accent font-semibold">
                The artifact
              </div>
              <div className="mt-1 text-[11px] text-ink-muted leading-snug">
                Scan or copy — any LLM, any phone.
              </div>
              <div className="mt-2.5 flex justify-center">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrDataUrl}
                    alt={`QR code for ${wikiOwnerLabel ?? "this wiki"} — scan with any phone, paste into any LLM`}
                    className="w-32 h-32 sm:w-36 sm:h-36 rounded bg-white p-1.5 border border-paper-soft"
                  />
                ) : (
                  <div className="w-32 h-32 sm:w-36 sm:h-36 rounded bg-paper-soft animate-pulse" />
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyShareUrl}
                  className="flex-1 min-w-0 px-2 py-1 rounded bg-ink text-paper text-[11px] font-medium hover:bg-ink-soft inline-flex items-center justify-center gap-1"
                >
                  {shareCopied === "url" ? (
                    <>
                      <span>Copied</span>
                      <span aria-hidden>✓</span>
                    </>
                  ) : (
                    <>
                      <span>Copy URL</span>
                      <span aria-hidden>↗</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadQR}
                  disabled={!qrDataUrl}
                  className="flex-1 min-w-0 px-2 py-1 rounded border border-ink/20 bg-white text-ink text-[11px] font-medium hover:border-ink disabled:opacity-50 inline-flex items-center justify-center gap-1"
                >
                  {shareCopied === "qr" ? (
                    <>
                      <span>Saved</span>
                      <span aria-hidden>✓</span>
                    </>
                  ) : (
                    <>
                      <span>Save QR</span>
                      <span aria-hidden>↓</span>
                    </>
                  )}
                </button>
              </div>
              <code className="mt-2 block font-mono text-[9px] text-ink-muted break-all leading-tight">
                {wikiShareUrl}
              </code>
            </aside>
          )}
        </div>

        {/* The streamed answer. */}
        <div className="mt-5 sm:mt-6 text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
          Answer
        </div>
        <div className="mt-2 min-h-[12rem] sm:min-h-[14rem]">
          {phase === "typing" || (phase === "streaming" && !answer) ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <ThinkingDots />
              <span>retrieving from the wiki…</span>
            </div>
          ) : (
            <div className="relative">
              <Markdown tenant={tenant}>{answer}</Markdown>
              {phase === "streaming" && (
                <span className="inline-block w-[3px] h-[1.1em] -mb-[0.2em] ml-0.5 bg-accent animate-pulse align-middle" />
              )}
            </div>
          )}
        </div>

        {/* Citations + actions only appear once the stream ends. */}
        {phase === "done" && (
          <div className="mt-6 pt-5 border-t border-paper-soft">
            {citations.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
                  Cited
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {citations.map((c) => (
                    <Link
                      key={c.slug}
                      href={
                        tenant
                          ? `/${tenant}/page/${encodeURIComponent(c.slug)}`
                          : `/page/${encodeURIComponent(c.slug)}`
                      }
                      className="text-xs border border-paper-soft bg-paper-soft/70 hover:bg-white hover:border-accent rounded-full px-2.5 py-1 text-ink hover:text-accent font-mono"
                    >
                      [[{c.title}]]
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* QR moved up — see the question/QR pair at the top of
                this card. We keep a one-line summary + "open full share
                page" link here so the share affordance is reachable
                from the bottom of the demo too. */}
            {wikiShareUrl && (
              <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span>
                  <span className="text-ink font-medium">URL</span> for code
                  agents (Cursor, Claude Code, Codex, system prompts).{" "}
                  <span className="text-ink font-medium">QR</span> for phones
                  and multimodal chats (ChatGPT, Claude, Gemini).
                </span>
                <Link
                  href={tenant ? `/${tenant}/share` : "/share"}
                  className="text-ink-muted hover:text-ink underline"
                >
                  open full share page →
                </Link>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={nextPrompt}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft inline-flex items-center gap-2"
              >
                <span>Ask another</span>
                <span aria-hidden>→</span>
              </button>
              <Link
                href="/ask"
                className="px-4 py-2 rounded-lg border border-ink/15 text-ink text-sm font-medium hover:border-ink"
              >
                Open full chat
              </Link>
              <span className="text-[11px] text-ink-muted ml-auto">
                {usedFallback
                  ? "showing cached answer (backend unreachable)"
                  : `${idx + 1} of ${PROMPTS.length}`}
              </span>
            </div>

            {/* Other questions — let the visitor see the breadth of what
                this wiki can answer about Avery without clicking through. */}
            <div className="mt-5 pt-4 border-t border-paper-soft">
              <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
                Or try
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROMPTS.map((p, i) =>
                  i === idx ? null : (
                    <button
                      key={i}
                      onClick={() => jumpToPrompt(i)}
                      className="text-xs border border-paper-soft bg-paper-soft/40 hover:bg-white hover:border-accent rounded-full px-3 py-1.5 text-ink-muted hover:text-ink text-left max-w-full truncate"
                      title={p.question}
                    >
                      {p.question}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse" />
      <span
        className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-pulse"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}
