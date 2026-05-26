// Server-side layout for /[tenant]/* routes. Its only job is to inject
// per-tenant metadata into the page <head> so:
//
//   1. LLMs that fetch the tenant landing URL (e.g. an LLM that someone
//      pasted ``https://portablellm.wiki/<tenant>`` into instead of the
//      ``/llm`` handshake URL) can DISCOVER the markdown handshake via
//      ``<link rel="alternate" type="text/markdown" href="…/llm">``.
//      Without this hint an HTML-parsing LLM would scrape the React
//      landing page's text content and miss the structured API spec
//      it's supposed to be using.
//
//   2. Social-card unfurls (Slack/Discord/iMessage/Twitter) get a
//      tenant-specific title + description + share-targeted OG image.
//      Otherwise every tenant URL unfurls with the generic site title.
//
// We split this off from page.tsx (which is "use client" — required for
// the useState/useEffect-heavy interactive landing) because Next.js
// app-router metadata exports only work in server components. The
// layout sits in the same route segment and runs server-side; the
// child page renders client-side as before.
//
// `<head>` placement: Next.js merges per-segment metadata exports, so
// the root layout's site-wide metadata is kept, and these per-tenant
// values override title/description/openGraph/alternates for any URL
// under /[tenant]/*.

import type { Metadata } from "next";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
  "http://localhost:3000";


export async function generateMetadata({
  params,
}: {
  params: { tenant: string };
}): Promise<Metadata> {
  const tenant = params.tenant;
  // We don't fetch the tenant's display name here on purpose: that
  // would block first paint on a backend round-trip. The handle alone
  // ("@cary") is enough for the unfurl preview, and the live landing
  // page (which DOES fetch) updates the visible chrome once mounted.
  const landingUrl = `${SITE_URL.replace(/\/+$/, "")}/${tenant}`;
  const llmUrl = `${landingUrl}/llm`;
  const llmsTxtUrl = `${landingUrl}/llms.txt`;
  const title = `@${tenant} · Portable LLM Wiki`;
  const description =
    `@${tenant}'s portable LLM wiki — markdown-based personal context ` +
    `that any LLM can read. Paste ${llmUrl} into ChatGPT, Claude, ` +
    `Cursor, or Gemini to chat with this wiki.`;

  return {
    title,
    description,
    // Canonical URL for the landing page — keeps duplicate-content
    // signals tidy if someone links the page with a tracking query
    // string.
    alternates: {
      canonical: landingUrl,
      // The KEY contribution of this metadata block: tell LLMs +
      // crawlers that there's a machine-readable markdown alternate
      // at /<tenant>/llm. An LLM that fetches the landing URL and
      // parses HTML will see this link in the head and can switch
      // to the structured handshake instead of scraping React-
      // rendered text.
      types: {
        "text/markdown": llmUrl,
      },
    },
    openGraph: {
      type: "profile",
      title,
      description,
      url: landingUrl,
      siteName: "Portable LLM Wiki",
      // /og is a dynamic OG image generator (frontend/app/og/route.tsx)
      // that takes ?tenant=<id> and renders a tenant-branded card.
      images: [
        {
          url: `/og?tenant=${encodeURIComponent(tenant)}`,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`/og?tenant=${encodeURIComponent(tenant)}`],
    },
    // The `other` bucket is escape hatch for tags Next.js's typed
    // metadata schema doesn't model. Two specifically for LLM-aware
    // tools: the llms.txt convention (a one-liner pointer to a
    // root-level index of LLM-relevant URLs on this site) and an
    // explicit "ai:" prefix that some agents key off when deciding
    // which alternate representation to fetch.
    other: {
      "llm:handshake": llmUrl,
      "llms-txt": llmsTxtUrl,
    },
  };
}


export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
