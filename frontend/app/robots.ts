// Real /robots.txt for the hosted service.
//
// Before this file existed, Next.js's app-router [tenant] dynamic
// segment in app/[tenant]/page.tsx greedily matched the path
// /robots.txt and rendered the tenant-landing HTML shell (title
// "@robots.txt · Portable LLM Wiki"). That broke a couple of real
// flows:
//
//   * ChatGPT-User (the agent that fetches URLs a user pastes into
//     a ChatGPT conversation) probes /robots.txt before fetching;
//     getting back HTML when expecting a text policy can cause some
//     fetch tools to bail or downgrade to a web-search fallback.
//     The "I tried but can't access" hallucination some users see
//     from ChatGPT on /llm?t=<token> URLs traces back to this.
//   * OAI-SearchBot / GPTBot index the public surface so that the
//     wiki's public landing pages show up in ChatGPT's search
//     results. Without a real robots.txt they get an HTML page
//     where they expect a policy and skip indexing the site.
//
// Next.js looks for app/robots.ts (or .js) by convention and
// generates /robots.txt from the default export at build time,
// taking precedence over any dynamic-segment match. So the existence
// of this file is itself the fix; no rewrite or middleware change
// is required.
//
// Policy:
//   * Allow every well-behaved bot to crawl the public surface
//     (landing pages, public-tier pages, /llm and /llms.txt
//     handshakes without the ?t= token).
//   * Disallow /owner/* (UI shell) and /api/backend/owner/* (auth-
//     gated endpoints) — they 401 anyway, but pointing crawlers
//     away from them is just hygiene.
//   * Explicit allow blocks for GPTBot, ChatGPT-User, OAI-SearchBot,
//     ClaudeBot, Anthropic-AI, Google-Extended, PerplexityBot — the
//     LLM-side bots are the entire point of the product, so we
//     un-ambiguously opt them in. (Several allow these by default
//     anyway, but explicit-allow blocks make audits trivial.)

import type { MetadataRoute } from "next";

const SITE = "https://portablellm.wiki";

const LLM_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "Anthropic-AI",
  "anthropic-ai",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "CCBot",
  "cohere-ai",
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Catch-all baseline. The owner console is auth-gated, but
      // disallowing crawl is still polite.
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/owner", "/api/backend/owner"],
      },
      // Explicit, named opt-in for every LLM-side fetcher we know
      // about. Same policy, different audit trail.
      ...LLM_BOTS.map((bot) => ({
        userAgent: bot,
        allow: "/",
        disallow: ["/owner", "/api/backend/owner"],
      })),
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
