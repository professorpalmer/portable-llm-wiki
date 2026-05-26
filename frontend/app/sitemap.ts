// Sitemap for the hosted service.
//
// Like app/robots.ts, this exists so LLM-side crawlers (GPTBot,
// ClaudeBot, etc.) can find the public surface of the site. Without
// it, /sitemap.xml hits the [tenant] dynamic segment and 200s with
// an HTML wrapper titled "@sitemap.xml · Portable LLM Wiki" — fine
// for humans, useless to indexers.
//
// We intentionally keep the listing small (landing + demo tenant
// surface) instead of trying to enumerate every signed-up tenant.
// Crawlers find per-tenant pages via the canonical link rel from
// each tenant's landing page, and per-tenant content is the owner's
// to publicize via QR / direct link — not ours to advertise without
// their say-so.

import type { MetadataRoute } from "next";

const SITE = "https://portablellm.wiki";
const DEMO_TENANT = "avery";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: SITE,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      // Public LLM-handshake endpoint for the apex; bots that
      // follow llm:handshake meta tags land here. Plain markdown,
      // text/markdown content-type.
      url: `${SITE}/llm`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE}/${DEMO_TENANT}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE}/${DEMO_TENANT}/llm`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];
}
