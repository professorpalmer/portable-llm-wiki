/** @type {import('next').NextConfig} */
const backend = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const hosted = process.env.NEXT_PUBLIC_HOSTED_MODE === "1";

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_HOSTED_MODE: hosted ? "1" : "0",
  },
  async rewrites() {
    const baseRewrites = [
      // Frontend proxy for browser code (auth headers, etc.)
      { source: "/api/backend/:path*", destination: `${backend}/:path*` },
      { source: "/healthz", destination: `${backend}/healthz` },
      { source: "/.well-known/:path*", destination: `${backend}/.well-known/:path*` },
    ];

    // In single-tenant mode (default, OSS), the backend's wiki/owner/llm
    // routes live at the apex of the backend and we surface them at the
    // same path on the frontend so curl/MCP clients can use the Vercel
    // URL as their WIKI_BASE_URL.
    const singleTenantRewrites = [
      { source: "/wiki/:path*", destination: `${backend}/wiki/:path*` },
      { source: "/owner/:path*", destination: `${backend}/owner/:path*` },
      { source: "/llm", destination: `${backend}/llm` },
      { source: "/llms.txt", destination: `${backend}/llms.txt` },
    ];

    // In hosted multi-tenant mode, every API call is prefixed with
    // /t/<tenant>/ on the backend. We mirror the vanity URL shape so
    // that `portablellm.wiki/<tenant>/llm` and `/<tenant>/llms.txt` work
    // for LLMs that fetch URLs — that's the viral hook ("paste this URL
    // into ChatGPT"). The frontend page route /[tenant]/page.tsx still
    // serves the HTML landing because Next.js matches rewrites in order
    // and rewrites are not used for pages that exist in the app router.
    //
    // The /[tenant]/llm and /[tenant]/llms.txt paths don't have
    // corresponding app-router pages, so rewrites win and proxy them.
    const hostedRewrites = [
      { source: "/:tenant/llm", destination: `${backend}/t/:tenant/llm` },
      { source: "/:tenant/llms.txt", destination: `${backend}/t/:tenant/llms.txt` },
      // Per-tenant manifests + chat APIs that LLMs may follow up with
      // after reading the handshake. Keep the same shape so the
      // handshake markdown points to "real" URLs that work.
      {
        source: "/:tenant/wiki/:path*",
        destination: `${backend}/t/:tenant/wiki/:path*`,
      },
      {
        source: "/:tenant/.well-known/:path*",
        destination: `${backend}/t/:tenant/.well-known/:path*`,
      },
    ];

    return [...baseRewrites, ...(hosted ? hostedRewrites : singleTenantRewrites)];
  },
};

export default nextConfig;
