"use client";

// Landing page — has two modes:
//
//   1. Single-tenant (OSS self-host): the protocol showcase. This is the
//      original landing page, kept verbatim so the OSS deploy keeps its
//      voice and CTAs. Selected when NEXT_PUBLIC_HOSTED_MODE != "1".
//
//   2. Hosted multi-tenant: the public landing for portablellm.wiki, with
//      a "Sign in with GitHub" CTA, a live demo against the Avery tenant,
//      and a "how it works" block. Selected when NEXT_PUBLIC_HOSTED_MODE
//      == "1" (see next.config.mjs).
//
// The split is intentional: the OSS landing reads "this is the showcase;
// host your own"; the hosted landing reads "sign in, get your own". Same
// HeroStream component powers both demos.

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiBase, fetchPublicConfig, isHostedMode } from "@/lib/api";
import { HeroStream } from "@/components/HeroStream";

const GITHUB_URL = "https://github.com/professorpalmer/portable-llm-wiki";
const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https://github.com/professorpalmer/portable-llm-wiki";

export default function Home() {
  if (isHostedMode()) return <HostedLanding />;
  return <SingleTenantLanding />;
}

function SingleTenantLanding() {
  const [shareUrl, setShareUrl] = useState("");

  useEffect(() => {
    fetchPublicConfig()
      .then((c) => setShareUrl(c.public_base_url || window.location.origin))
      .catch(() => setShareUrl(window.location.origin));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-5 py-10 sm:py-14">
      {/* ============================================================== */}
      {/* HERO — the 5-second pitch                                       */}
      {/* ============================================================== */}
      <section>
        <div className="text-[11px] sm:text-xs uppercase tracking-[0.22em] text-accent font-semibold">
          The open protocol
        </div>
        <h1 className="mt-3 text-[2.6rem] leading-[0.98] sm:text-6xl md:text-7xl font-semibold tracking-tight text-ink">
          Your LLM doesn&apos;t
          <br />
          know&nbsp;you.
        </h1>
        <p className="mt-5 text-xl sm:text-2xl text-ink-muted leading-snug max-w-2xl">
          One markdown folder. Every model knows you. Claude, ChatGPT, Cursor,
          Gemini, all of it.
        </p>
        <p className="mt-3 text-sm sm:text-base text-ink-muted leading-relaxed max-w-2xl">
          Stop re-explaining yourself every conversation. The portable LLM
          wiki is a vendor-neutral personal context store: your decisions,
          relationships, and operating principles in plain markdown, in your
          git, queryable over HTTP or MCP.{" "}
          <span className="text-ink">Watch it work below. The answer is streaming live from the wiki.</span>
        </p>
      </section>

      {/* ============================================================== */}
      {/* LIVE STREAMING DEMO — the proof, with embedded share QR        */}
      {/* The QR shows the /llm artifact this deploy serves — the same   */}
      {/* shape a self-host gets after deploying their own.               */}
      {/* ============================================================== */}
      <section className="mt-10 sm:mt-12">
        <HeroStream
          wikiShareUrl={shareUrl ? `${shareUrl}/llm` : undefined}
          wikiQrUrl={shareUrl || undefined}
          wikiOwnerLabel="this demo wiki"
        />
      </section>

      {/* ============================================================== */}
      {/* PRIMARY CTAs — deploy / star                                    */}
      {/* ============================================================== */}
      <section className="mt-8 sm:mt-10 grid sm:grid-cols-2 gap-4">
        <a
          href={RENDER_DEPLOY_URL}
          target="_blank"
          rel="noreferrer"
          className="group relative overflow-hidden rounded-2xl border border-ink bg-ink text-paper p-6 hover:bg-ink-soft transition-colors"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent">
              Recommended
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-paper/60">
              free tier
            </div>
          </div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            Deploy to Render →
          </div>
          <div className="mt-1.5 text-sm text-paper/70 leading-relaxed">
            Your own private wiki, live in ~60 seconds. Render auto-generates
            a secure owner token; bring your own markdown.
          </div>
          <div className="mt-4 inline-flex items-center gap-2 text-xs font-mono text-paper/60 group-hover:text-paper">
            one-click Blueprint → render.yaml
          </div>
        </a>

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="group rounded-2xl border border-ink/15 bg-white p-6 hover:border-ink transition-colors"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink-muted">
              Read the spec
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              MIT
            </div>
          </div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-ink">
            Star on GitHub →
          </div>
          <div className="mt-1.5 text-sm text-ink-muted leading-relaxed">
            One repo. Backend, frontend, MCP server, demo wiki. Fork the
            protocol or run it as-is.
          </div>
          <div className="mt-4 inline-flex items-center gap-2 text-xs font-mono text-ink-muted group-hover:text-ink">
            github.com/professorpalmer/portable-llm-wiki
          </div>
        </a>
      </section>

      {/* ============================================================== */}
      {/* THREE OPERATIONS — the protocol surface                         */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            Three operations.
            <br className="sm:hidden" />
            <span className="text-ink-muted"> That&apos;s the whole protocol.</span>
          </h2>
          <Link
            href="/connect"
            className="text-sm text-accent hover:underline font-medium"
          >
            see the spec →
          </Link>
        </div>
        <div className="mt-7 grid md:grid-cols-3 gap-4">
          <OpCard
            verb="Ingest"
            tagline="Anything in."
            body="Slack thread, screenshot, voice memo, PDF, raw note. An LLM digests it, extracts entities, cross-references with [[wikilinks]], and never loses provenance back to the source."
            endpoint="POST /owner/ingest"
          />
          <OpCard
            verb="Query"
            tagline="Cited answers out."
            body="Natural-language Q&A grounded in your markdown. Graph-aware retrieval expands by wikilinks. Every answer carries the pages it cited, like the box above."
            endpoint="POST /wiki/chat/stream"
          />
          <OpCard
            verb="Lint"
            tagline="Self-maintaining."
            body="Four Puppetmaster agents run in parallel: contradictions, stale claims, missing pages, public-tier leaks. They surface issues for review. Never silently rewrite."
            endpoint="POST /owner/lint/swarm"
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* CONNECT FROM ANY LLM — the QR-paste pitch + MCP                */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20 border-t border-paper-soft pt-12">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-start">
          <div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
              Plug it into any LLM.
            </h2>
            <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
              The wiki is vendor-neutral by design. Cursor, Claude, ChatGPT,
              Gemini, a local Llama: anything that can fetch a URL or speak
              MCP gets your context for free.
            </p>
          </div>
          <Link
            href="/connect"
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 whitespace-nowrap self-start"
          >
            connection guide →
          </Link>
        </div>

        {/* The killer mechanism: paste-this-URL flow. */}
        <PasteUrlCard baseUrl={shareUrl} />

        {/* MCP for power users — typed tool calls in Cursor / Claude Desktop. */}
        <div className="mt-6">
          <ConfigBlock
            title="Power-user path: MCP"
            subtitle="One config block for Cursor or Claude Desktop. Typed tool calls in every conversation, forever."
            body={<MCPSnippet baseUrl={shareUrl} />}
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* INSTALL PATHS — three ways to host your own                     */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20 border-t border-paper-soft pt-12">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            Host your own.
          </h2>
          <span className="text-sm text-ink-muted">three paths, pick yours</span>
        </div>
        <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
          The whole protocol fits in one repo. No accounts, no hosted plan.
          Your markdown, your token, your URL.
        </p>

        <div className="mt-7 grid md:grid-cols-3 gap-4">
          <InstallCard
            badge="Recommended"
            badgeTone="accent"
            title="Cloud"
            tagline="One-click on Render's free tier."
            command="render.yaml → Blueprint"
            body="Render provisions backend + Postgres-grade disk, auto-generates an owner token, and exposes a public URL. Pair with Vercel for the frontend."
            cta={{ label: "Deploy →", href: RENDER_DEPLOY_URL }}
            ctaPrimary
          />
          <InstallCard
            badge="For tinkerers"
            badgeTone="muted"
            title="Local"
            tagline="One command, no Docker."
            command="npx create-portable-llm-wiki"
            body="Spins up the backend, frontend, and a fresh wiki folder on your laptop. Hot-reload, demo data optional. Best way to fork the protocol."
            cta={{ label: "On GitHub →", href: GITHUB_URL }}
          />
          <InstallCard
            badge="For self-hosters"
            badgeTone="muted"
            title="Docker"
            tagline="Compose up on your own box."
            command="docker compose up"
            body="A pinned image of the backend + frontend, ready for a homelab, Tailscale VPS, or whatever you already host. Mount your wiki folder; you own the data."
            cta={{ label: "Compose file →", href: GITHUB_URL }}
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* ABOUT THE DEMO DATA — the small footer card                     */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20 border-t border-paper-soft pt-10 pb-4">
        <div className="rounded-2xl border border-paper-soft bg-paper-soft/40 p-5 sm:p-6">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-sm uppercase tracking-[0.18em] font-semibold text-ink">
              About this demo
            </h2>
            <span className="text-xs text-ink-muted">
              you&apos;re seeing the <code className="font-mono">wiki-demo/</code> seed
            </span>
          </div>
          <p className="mt-3 text-sm sm:text-base text-ink-muted leading-relaxed max-w-3xl">
            This deployed instance is seeded with{" "}
            <Link href="/page/avery-chen" className="text-ink underline">
              Avery Chen
            </Link>
            , a fictional founding engineer at{" "}
            <Link href="/page/strand-bio" className="text-ink underline">
              Strand Bio
            </Link>
            , a synthetic-biology startup. Twenty-five pages across her
            entities, operating principles, career decisions (leaving grad
            school, joining Strand, postponing the Series A), saved
            deliberations, and source digests. Avery is here so the wiki
            has something real to talk about. When you host your own, you
            replace the folder with your own markdown.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link
              href="/browse"
              className="text-accent hover:underline font-medium"
            >
              browse the demo pages →
            </Link>
            <Link
              href="/graph"
              className="text-accent hover:underline font-medium"
            >
              see the graph →
            </Link>
            <Link href="/ask" className="text-accent hover:underline font-medium">
              open the full chat →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ====================================================================
// Hosted-mode landing (portablellm.wiki)
// ====================================================================
//
// Goal: a first-time visitor decides in ~5 seconds whether to sign in.
//
//   1. Hero pitch                  → "Your LLM doesn't know you."
//   2. Sign in with GitHub CTA      → /api/backend/auth/github/login
//   3. Live demo against Avery      → HeroStream tenant="avery"
//   4. How it works (3 steps)
//   5. Reused protocol sections     → "Three operations", "Plug it into any LLM"
//   6. About the Avery demo

const AVERY_TENANT = "avery";

function HostedLanding() {
  const [shareUrl, setShareUrl] = useState("");
  const [signinHref, setSigninHref] = useState(
    "/api/backend/auth/github/login?return_to=/welcome",
  );

  useEffect(() => {
    fetchPublicConfig()
      .then((c) => setShareUrl(c.public_base_url || window.location.origin))
      .catch(() => setShareUrl(window.location.origin));
    // Build the OAuth href on the client so we can use the absolute
    // backend URL when in hosted mode (so the session cookie set by the
    // callback is scoped to api.portablellm.wiki, where subsequent
    // /auth/me calls land — see HOSTED_DEPLOYMENT.md for the full
    // cookie-domain explanation).
    if (typeof window !== "undefined") {
      const returnTo = `${window.location.origin}/welcome`;
      setSigninHref(
        `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(returnTo)}`,
      );
    }
  }, []);
  const HOSTED_SIGNIN_HREF = signinHref;

  return (
    <div className="max-w-5xl mx-auto px-5 py-10 sm:py-14">
      {/* ============================================================== */}
      {/* HERO — the 5-second pitch + sign-in                             */}
      {/* ============================================================== */}
      <section>
        <div className="text-[11px] sm:text-xs uppercase tracking-[0.22em] text-accent font-semibold">
          Portable LLM Wiki
        </div>
        <h1 className="mt-3 text-[2.6rem] leading-[0.98] sm:text-6xl md:text-7xl font-semibold tracking-tight text-ink">
          Your LLM doesn&apos;t
          <br />
          know&nbsp;you.
        </h1>
        <p className="mt-5 text-2xl sm:text-3xl text-ink leading-snug max-w-2xl">
          It will in 60 seconds.
        </p>
        <p className="mt-4 text-sm sm:text-base text-ink-muted leading-relaxed max-w-2xl">
          A portable database of you. Sign in, paste a bio or import
          your notes, get a{" "}
          <span className="text-ink font-medium">URL</span> and a{" "}
          <span className="text-ink font-medium">QR</span>. Drop the URL
          into Cursor, Claude Code, or ChatGPT. Scan the QR onto a phone,
          a résumé, or any multimodal chat. Same artifact, two formats.
          Whoever opens it gets cited answers about you.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-4">
          <a
            href={HOSTED_SIGNIN_HREF}
            className="inline-flex items-center gap-2 rounded-2xl bg-ink text-paper px-6 py-3.5 text-base font-semibold hover:bg-ink-soft transition-colors shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(14,14,16,0.35)]"
          >
            <GithubMark />
            <span>Sign in with GitHub</span>
            <span aria-hidden>→</span>
          </a>
          <Link
            href="/avery"
            className="text-sm text-accent hover:underline font-medium"
          >
            or see it in action →
          </Link>
        </div>
      </section>

      {/* ============================================================== */}
      {/* LIVE STREAMING DEMO — Avery tenant                              */}
      {/* The demo embeds a "share this wiki" QR right inside the chat,  */}
      {/* visually wiring question→answer→artifact in one panel. The QR  */}
      {/* points at Avery's /llm endpoint — the same shape every signed- */}
      {/* in user gets for their own tenant.                              */}
      {/* ============================================================== */}
      <section className="mt-10 sm:mt-12">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
            Live demo · the Avery Chen wiki
          </div>
          <div className="text-[11px] text-ink-muted">
            QR is real. Scan it with any phone, paste into any LLM, then
            ask &ldquo;who am I?&rdquo;
          </div>
        </div>
        <HeroStream
          tenant={AVERY_TENANT}
          wikiShareUrl={
            shareUrl ? `${shareUrl}/${AVERY_TENANT}/llm` : undefined
          }
          wikiQrUrl={shareUrl ? `${shareUrl}/${AVERY_TENANT}` : undefined}
          wikiOwnerLabel="Avery's wiki"
        />
      </section>

      {/* ============================================================== */}
      {/* HOW IT WORKS — three steps                                      */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20">
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
          How it works.
        </h2>
        <div className="mt-7 grid md:grid-cols-3 gap-4">
          <StepCard
            n={1}
            title="Sign in with GitHub"
            body="Your GitHub login becomes your handle. No password, no email confirmation, no dashboard to set up."
          />
          <StepCard
            n={2}
            title="Paste your bio, resume, or profile URL"
            body="Drop in a paragraph about yourself, paste a resume, or hand us a LinkedIn / personal-site URL. A model digests it into a starter wiki."
          />
          <StepCard
            n={3}
            title="Share the URL or QR"
            body={
              <>
                Live at{" "}
                <code className="font-mono text-ink">
                  portablellm.wiki/&lt;you&gt;/llm
                </code>
                . Paste the URL into Cursor, Claude Code, ChatGPT, or
                any system prompt. Hand someone the QR for a phone scan
                or image upload to ChatGPT, Claude, or Gemini. Either
                way they get cited answers about you.
              </>
            }
          />
        </div>
        <div className="mt-7">
          <a
            href={HOSTED_SIGNIN_HREF}
            className="inline-flex items-center gap-2 rounded-xl bg-ink text-paper px-5 py-3 text-sm font-semibold hover:bg-ink-soft transition-colors"
          >
            <GithubMark />
            <span>Sign in with GitHub</span>
            <span aria-hidden>→</span>
          </a>
        </div>
      </section>

      {/* ============================================================== */}
      {/* THREE OPERATIONS — protocol surface (reused from OSS landing)   */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
            Three operations.
            <br className="sm:hidden" />
            <span className="text-ink-muted"> That&apos;s the whole protocol.</span>
          </h2>
          <Link
            href="/connect"
            className="text-sm text-accent hover:underline font-medium"
          >
            see the spec →
          </Link>
        </div>
        <div className="mt-7 grid md:grid-cols-3 gap-4">
          <OpCard
            verb="Ingest"
            tagline="Anything in."
            body="Slack thread, screenshot, voice memo, PDF, raw note. An LLM digests it, extracts entities, cross-references with [[wikilinks]], and never loses provenance back to the source."
            endpoint="POST /owner/ingest"
          />
          <OpCard
            verb="Query"
            tagline="Cited answers out."
            body="Natural-language Q&A grounded in your markdown. Graph-aware retrieval expands by wikilinks. Every answer carries the pages it cited, like the box above."
            endpoint="POST /wiki/chat/stream"
          />
          <OpCard
            verb="Lint"
            tagline="Self-maintaining."
            body="Four Puppetmaster agents run in parallel: contradictions, stale claims, missing pages, public-tier leaks. They surface issues for review. Never silently rewrite."
            endpoint="POST /owner/lint/swarm"
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* PLUG IT INTO ANY LLM (reused from OSS landing)                  */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20 border-t border-paper-soft pt-12">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-start">
          <div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
              Plug it into any LLM.
            </h2>
            <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
              The wiki is vendor-neutral by design. Cursor, Claude, ChatGPT,
              Gemini, a local Llama: anything that can fetch a URL or speak
              MCP gets your context for free.
            </p>
          </div>
          <Link
            href="/connect"
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 whitespace-nowrap self-start"
          >
            connection guide →
          </Link>
        </div>

        <PasteUrlCard baseUrl={shareUrl} />

        <div className="mt-6">
          <ConfigBlock
            title="Power-user path: MCP"
            subtitle="One config block for Cursor or Claude Desktop. Typed tool calls in every conversation, forever."
            body={<MCPSnippet baseUrl={shareUrl} />}
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* ABOUT THIS DEMO — Avery footer card                             */}
      {/* ============================================================== */}
      <section className="mt-16 sm:mt-20 border-t border-paper-soft pt-10 pb-4">
        <div className="rounded-2xl border border-paper-soft bg-paper-soft/40 p-5 sm:p-6">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-sm uppercase tracking-[0.18em] font-semibold text-ink">
              About this demo
            </h2>
            <span className="text-xs text-ink-muted">
              hosted at{" "}
              <code className="font-mono">portablellm.wiki/avery</code>
            </span>
          </div>
          <p className="mt-3 text-sm sm:text-base text-ink-muted leading-relaxed max-w-3xl">
            This is the{" "}
            <Link href="/avery" className="text-ink underline">
              Avery Chen demo wiki
            </Link>
            , a fictional founding engineer at Strand Bio. Twenty-five
            pages across her entities, operating principles, career
            decisions (leaving grad school, joining Strand, postponing the
            Series A), saved deliberations, and source digests. Avery is
            here so the wiki has something real to talk about. When you
            sign in, you get your own.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link
              href="/avery"
              className="text-accent hover:underline font-medium"
            >
              open the Avery wiki →
            </Link>
            <a
              href={HOSTED_SIGNIN_HREF}
              className="text-accent hover:underline font-medium"
            >
              start your own →
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function StepCard({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="border border-paper-soft rounded-2xl p-5 bg-white flex flex-col">
      <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent">
        Step {n}
      </div>
      <div className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
        {title}
      </div>
      <div className="mt-2 text-sm text-ink-muted leading-relaxed">
        {body}
      </div>
    </div>
  );
}

function GithubMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="w-5 h-5"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.678.92.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
  );
}

// ====================================================================
// Section helpers (kept local; not big enough to live in landing/).
// Shared by both SingleTenantLanding and HostedLanding.
// ====================================================================

function OpCard({
  verb,
  tagline,
  body,
  endpoint,
}: {
  verb: string;
  tagline: string;
  body: string;
  endpoint: string;
}) {
  return (
    <div className="border border-paper-soft rounded-2xl p-5 bg-white flex flex-col">
      <div className="text-xs text-accent uppercase tracking-[0.18em] font-semibold">
        {tagline}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">
        {verb}
      </div>
      <div className="mt-2 text-sm text-ink-muted leading-relaxed flex-1">
        {body}
      </div>
      <div className="mt-4 pt-3 border-t border-paper-soft">
        <code className="font-mono text-[11px] text-ink-muted block break-all">
          {endpoint}
        </code>
      </div>
    </div>
  );
}

function ConfigBlock({
  title,
  subtitle,
  body,
}: {
  title: string;
  subtitle: string;
  body: React.ReactNode;
}) {
  return (
    <div className="border border-paper-soft rounded-2xl p-4 sm:p-5 bg-white">
      <div className="text-xs uppercase tracking-[0.18em] text-ink-muted font-semibold">
        {title}
      </div>
      <div className="mt-1 text-sm text-ink-muted">{subtitle}</div>
      <div className="mt-3">{body}</div>
    </div>
  );
}

function InstallCard({
  badge,
  badgeTone,
  title,
  tagline,
  command,
  body,
  cta,
  ctaPrimary,
}: {
  badge: string;
  badgeTone: "accent" | "muted";
  title: string;
  tagline: string;
  command: string;
  body: string;
  cta: { label: string; href: string };
  ctaPrimary?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-5 flex flex-col ${
        ctaPrimary
          ? "border-2 border-ink bg-white"
          : "border border-paper-soft bg-white"
      }`}
    >
      <div
        className={`text-[10px] uppercase tracking-[0.18em] font-semibold inline-flex ${
          badgeTone === "accent" ? "text-accent" : "text-ink-muted"
        }`}
      >
        {badge}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-ink">
        {title}
      </div>
      <div className="text-sm text-ink-muted">{tagline}</div>
      <div className="mt-3 bg-paper-soft/70 rounded px-2.5 py-1.5">
        <code className="font-mono text-[12px] text-ink break-all">
          {command}
        </code>
      </div>
      <div className="mt-3 text-sm text-ink-muted leading-relaxed flex-1">
        {body}
      </div>
      <a
        href={cta.href}
        target="_blank"
        rel="noreferrer"
        className={`mt-4 inline-flex items-center gap-2 text-sm font-medium ${
          ctaPrimary ? "text-ink hover:text-accent" : "text-accent hover:underline"
        }`}
      >
        {cta.label}
      </a>
    </div>
  );
}

function PasteUrlCard({ baseUrl }: { baseUrl: string }) {
  const llmUrl = baseUrl ? `${baseUrl}/llm` : "https://portablellm.wiki/llm";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(llmUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="mt-6 border-2 border-ink rounded-2xl bg-white p-5 sm:p-6 shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(14,14,16,0.18)]">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent">
            Recommended for everyone
          </div>
          <div className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-ink">
            Paste this URL into ChatGPT, Claude, or anywhere.
          </div>
        </div>
        <div className="text-[11px] text-ink-muted">
          works on phones too. no install.
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed max-w-2xl">
        The URL returns a self-describing markdown briefing. The LLM reads it,
        learns the API, and answers questions about the wiki for the rest of
        the conversation. No plugin, no MCP setup, no auth dance.
      </p>

      <div className="mt-4 flex items-center gap-2 bg-paper-soft/70 rounded-lg p-2 pr-2.5">
        <code className="flex-1 font-mono text-sm text-ink truncate px-2 py-1.5">
          {llmUrl}
        </code>
        <button
          onClick={handleCopy}
          className="shrink-0 px-3 py-1.5 rounded-md bg-ink text-paper text-xs font-medium hover:bg-ink-soft inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {copied ? (
            <>
              <span>Copied</span>
              <span aria-hidden>✓</span>
            </>
          ) : (
            <>
              <span>Copy</span>
              <span aria-hidden>↗</span>
            </>
          )}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <a
          href={llmUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          preview what an LLM sees →
        </a>
        <span className="text-ink-muted">·</span>
        <Link href="/share" className="text-accent hover:underline">
          QR code for sharing
        </Link>
        <span className="text-ink-muted">·</span>
        <a
          href={llmUrl.replace("/llm", "/llms.txt")}
          target="_blank"
          rel="noreferrer"
          className="text-ink-muted hover:text-ink"
        >
          llms.txt
        </a>
      </div>
    </div>
  );
}

function MCPSnippet({ baseUrl }: { baseUrl: string }) {
  const url = baseUrl || "https://your-wiki.example.com";
  const cfg = `{
  "mcpServers": {
    "portable-llm-wiki": {
      "command": "npx",
      "args": ["-y", "portable-llm-wiki-mcp"],
      "env": { "WIKI_BASE_URL": "${url}" }
    }
  }
}`;
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <Link
          href="/connect"
          className="text-[11px] text-accent hover:underline font-medium"
        >
          full instructions →
        </Link>
        <button
          onClick={() => {
            navigator.clipboard.writeText(cfg);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-[11px] text-ink-muted hover:text-ink underline"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="text-[11px] font-mono bg-paper-soft/60 p-2.5 rounded overflow-x-auto leading-snug">
        {cfg}
      </pre>
    </div>
  );
}
