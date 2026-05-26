// Server-side metadata for individual wiki pages. The page itself (page.tsx)
// is a client component, so we add a thin server-component layout here to
// provide per-page <title> and OpenGraph data. Link previews on iMessage,
// Slack, Twitter, etc. will now render the page title + excerpt instead of
// the site default.

import type { Metadata } from "next";

type PageSummary = {
  slug: string;
  title: string;
  section: string;
  type: string;
  tier: string;
  excerpt: string;
};

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

async function fetchPublicPage(slug: string): Promise<PageSummary | null> {
  try {
    const r = await fetch(`${BACKEND}/wiki/page/${encodeURIComponent(slug)}`, {
      // The metadata route runs server-side, so we don't carry the
      // owner token. We only get the public view.
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    return (await r.json()) as PageSummary;
  } catch {
    return null;
  }
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const page = await fetchPublicPage(slug);

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
    "http://localhost:3000";

  if (!page) {
    // Either the slug doesn't exist OR it's gated above public. Don't
    // leak any signal — generic title (slug strings like "my-divorce-2026"
    // would otherwise show up in the browser tab + share previews) and
    // aggressive robots flags so Google, Twitter, etc. don't cache the
    // URL existence.
    //
    // We deliberately *don't* set openGraph here. The parent layout's
    // generic site card wins, which is fine: a link to a private page
    // previews as "Portable LLM Wiki" with the site description, not as
    // anything resembling the slug.
    return {
      title: "Portable LLM Wiki",
      robots: {
        index: false,
        follow: false,
        nocache: true,
        noimageindex: true,
        googleBot: {
          index: false,
          follow: false,
          noimageindex: true,
          "max-snippet": 0,
          "max-image-preview": "none",
        },
      },
    };
  }

  const title = page.title || slug;
  const subtitle = page.excerpt?.slice(0, 140) || page.section;
  const ogParams = new URLSearchParams({ title, subtitle });
  if (page.section) ogParams.set("section", page.section);
  if (page.tier) ogParams.set("tier", page.tier);
  const ogImage = `/og?${ogParams.toString()}`;
  const pageUrl = `${siteUrl}/page/${encodeURIComponent(slug)}`;

  // Public-tier pages get the full OG treatment. We don't reach this
  // branch for higher tiers because fetchPublicPage uses no auth token,
  // so the backend filters them to a 404 -> null branch above.
  return {
    title,
    description: page.excerpt || `${page.section} page in the Portable LLM Wiki.`,
    alternates: { canonical: pageUrl },
    openGraph: {
      type: "article",
      title,
      description: page.excerpt || `${page.section} · Portable LLM Wiki`,
      url: pageUrl,
      siteName: "Portable LLM Wiki",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: page.excerpt || subtitle,
      images: [ogImage],
    },
  };
}

export default function PageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
