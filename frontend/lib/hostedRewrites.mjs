/**
 * Hosted-mode Next.js rewrite rules (imported by next.config.mjs).
 *
 * Kept in a small module so Vitest can assert routing boundaries without
 * parsing next.config.mjs as text.
 */

/** @param {string} backend */
export function buildHostedRewrites(backend) {
  return [
    { source: "/:tenant/llm", destination: `${backend}/t/:tenant/llm` },
    { source: "/:tenant/llms.txt", destination: `${backend}/t/:tenant/llms.txt` },
    {
      source: "/:tenant/wiki/:path*",
      destination: `${backend}/t/:tenant/wiki/:path*`,
    },
    // Owner write/API paths (ingest, capture, reload, share-tokens).
    // MCP clients set WIKI_BASE_URL=https://portablellm.wiki/<tenant>
    // and POST /owner/* — without this rewrite those hit Next.js HTML
    // 404s. Use :path+ (one or more segments) so the exact /:tenant/owner
    // URL is NOT proxied and continues to resolve to the app-router owner
    // console page at app/[tenant]/owner/page.tsx.
    {
      source: HOSTED_OWNER_API_SOURCE,
      destination: `${backend}/t/:tenant/owner/:path+`,
    },
    {
      source: "/:tenant/.well-known/:path*",
      destination: `${backend}/t/:tenant/.well-known/:path*`,
    },
  ];
}

/** Must require a subpath — :path* would also match bare /:tenant/owner. */
export const HOSTED_OWNER_API_SOURCE = "/:tenant/owner/:path+";
