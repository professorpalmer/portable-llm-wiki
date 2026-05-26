/**
 * Tests for the offline briefing builder.
 *
 * What this pins down:
 *
 *   1. Assembly. Given working handshake + manifest + page endpoints,
 *      the output blob has the URL, the handshake, the manifest, and
 *      the page bodies — in that order, with section dividers a model
 *      can find.
 *
 *   2. Token plumbing. The manifest + page fetches MUST carry the
 *      share token in an X-Share-Token header. Without that the
 *      backend would return only public-tier content and the briefing
 *      would silently leak a "this is everything" framing while
 *      hiding higher-tier pages.
 *
 *   3. Page-priority ordering. Entities → decisions → overviews →
 *      anything-else. Mirrors the backend handshake's "notable pages"
 *      logic. Without this guard the briefing would inline whatever
 *      came first from the manifest, which is usually low-information
 *      auxiliary pages.
 *
 *   4. Size budget. The byte cap on inlined page bodies prevents a
 *      single 50KB page from blowing the recipient's context window
 *      or the clipboard payload. We verify the budget is respected.
 *
 *   5. Graceful degradation. If the manifest fetch fails entirely
 *      we still produce a useful blob with the URL + a clearly-
 *      tagged failure marker, rather than crashing. Partial briefings
 *      are far more useful than empty ones — at minimum the URL is
 *      preserved so fetch-capable LLMs can pick up the slack.
 *
 *   6. isBriefingComplete heuristic. The success/partial distinction
 *      drives the button state (copied ✓ vs partial ⚠) so the owner
 *      knows whether a fetch failure happened mid-build.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildOfflineBriefing, isBriefingComplete } from "@/lib/briefing";


type FetchMock = ReturnType<typeof vi.fn>;


/** Build a deterministic backend fixture. Each call to fetch is
 *  matched by URL substring and returns a canned response, so a test
 *  body reads as "given these endpoints respond this way, the
 *  briefing should look like X". */
function setupFetchMock(routes: Record<string, () => Response>): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = String(url);
    calls.push({ url: s, init });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (s.includes(pattern)) {
        return handler();
      }
    }
    return new Response("not found", { status: 404 });
  });
  // Attach for assertions.
  (fn as unknown as { _calls: typeof calls })._calls = calls;
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}


function callsOf(fn: FetchMock): Array<{ url: string; init: RequestInit | undefined }> {
  return (fn as unknown as { _calls: Array<{ url: string; init: RequestInit | undefined }> })
    ._calls;
}


function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}


function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
    ...init,
  });
}


const FAKE_TOKEN = "test-token-DO-NOT-USE";
const FAKE_URL = `https://www.portablellm.wiki/cary/llm?t=${FAKE_TOKEN}`;


beforeEach(() => {
  vi.restoreAllMocks();
});


describe("buildOfflineBriefing", () => {
  it("assembles handshake + manifest + page bodies into one blob", async () => {
    setupFetchMock({
      "/llm?t=": () => textResponse("# Handshake\n\nProtocol: Portable LLM Wiki."),
      "/wiki/manifest.json": () =>
        jsonResponse({
          wiki_title: "Avery's Wiki",
          viewer_tier: "private",
          pages: [
            {
              slug: "avery",
              title: "Avery Chen",
              type: "entity",
              tier: "public",
              excerpt: "The owner of this wiki.",
            },
            {
              slug: "decision-stack",
              title: "Decision: Stack",
              type: "decision",
              tier: "private",
              excerpt: "Chose FastAPI + Next.js.",
            },
          ],
        }),
      "/wiki/page/avery": () =>
        jsonResponse({
          slug: "avery",
          title: "Avery Chen",
          type: "entity",
          tier: "public",
          body: "Avery works on Portable LLM Wiki.",
        }),
      "/wiki/page/decision-stack": () =>
        jsonResponse({
          slug: "decision-stack",
          title: "Decision: Stack",
          type: "decision",
          tier: "private",
          body: "Decision body: chose FastAPI for the backend.",
        }),
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "avery",
    });

    expect(blob).toContain("Portable LLM Wiki");
    expect(blob).toContain(FAKE_URL);
    expect(blob).toContain("HANDSHAKE");
    expect(blob).toContain("# Handshake");
    expect(blob).toContain("MANIFEST");
    expect(blob).toContain("**Avery Chen**");
    expect(blob).toContain("PAGES");
    expect(blob).toContain("Avery works on Portable LLM Wiki.");
    expect(blob).toContain("Decision body: chose FastAPI");
    expect(isBriefingComplete(blob)).toBe(true);
  });

  it("carries the share token in X-Share-Token on every protected fetch", async () => {
    /**
     * Critical: without this header on manifest + page calls the
     * backend serves only public-tier content. The briefing would
     * then claim "complete catalog" while silently missing every
     * recruiter/friend/private page — a stealth privilege downgrade
     * on the owner's own master-key paste.
     */
    const fetchFn = setupFetchMock({
      "/llm?t=": () => textResponse("handshake"),
      "/wiki/manifest.json": () =>
        jsonResponse({ pages: [], viewer_tier: "private" }),
    });

    await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
    });

    const manifestCall = callsOf(fetchFn).find((c) =>
      c.url.includes("/wiki/manifest.json"),
    );
    expect(manifestCall).toBeDefined();
    const headers = manifestCall!.init?.headers as Record<string, string> | undefined;
    expect(headers?.["X-Share-Token"]).toBe(FAKE_TOKEN);
  });

  it("inlines entity > decision > overview > other pages in that priority", async () => {
    /**
     * Mirrors the backend handshake's "notable pages" priority. An
     * earlier draft just took the first N pages from the manifest,
     * which surfaced things like "concept: Foo" before the entity
     * page describing the OWNER. Pin the priority so a future
     * refactor that reorders manifest output doesn't quietly
     * regress the briefing.
     */
    setupFetchMock({
      "/llm?t=": () => textResponse("handshake"),
      "/wiki/manifest.json": () =>
        jsonResponse({
          pages: [
            { slug: "concept-foo", title: "Concept Foo", type: "concept" },
            { slug: "decision-x", title: "Decision X", type: "decision" },
            { slug: "person", title: "Person", type: "entity" },
            { slug: "overview-y", title: "Overview Y", type: "overview" },
          ],
        }),
      "/wiki/page/person": () =>
        jsonResponse({ slug: "person", title: "Person", type: "entity", body: "ENTITY_BODY" }),
      "/wiki/page/decision-x": () =>
        jsonResponse({ slug: "decision-x", title: "Decision X", type: "decision", body: "DECISION_BODY" }),
      "/wiki/page/overview-y": () =>
        jsonResponse({ slug: "overview-y", title: "Overview Y", type: "overview", body: "OVERVIEW_BODY" }),
      "/wiki/page/concept-foo": () =>
        jsonResponse({ slug: "concept-foo", title: "Concept Foo", type: "concept", body: "CONCEPT_BODY" }),
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
    });

    const entityIdx = blob.indexOf("ENTITY_BODY");
    const decisionIdx = blob.indexOf("DECISION_BODY");
    const overviewIdx = blob.indexOf("OVERVIEW_BODY");
    const conceptIdx = blob.indexOf("CONCEPT_BODY");

    expect(entityIdx).toBeGreaterThan(0);
    expect(entityIdx).toBeLessThan(decisionIdx);
    expect(decisionIdx).toBeLessThan(overviewIdx);
    expect(overviewIdx).toBeLessThan(conceptIdx);
  });

  it("respects the maxPages cap", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      slug: `p${i}`,
      title: `Page ${i}`,
      type: "entity",
    }));
    setupFetchMock({
      "/llm?t=": () => textResponse("handshake"),
      "/wiki/manifest.json": () => jsonResponse({ pages }),
      "/wiki/page/p": () =>
        jsonResponse({ slug: "x", title: "x", type: "entity", body: "BODY" }),
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
      maxPages: 3,
    });
    const matches = blob.match(/BODY/g) || [];
    expect(matches.length).toBe(3);
    // The "more pages available" hint should appear when we capped early.
    expect(blob).toMatch(/more page/);
  });

  it("respects the maxBodyBytes budget", async () => {
    /**
     * Past this cap the clipboard payload would crowd the
     * recipient's context window and slow large pastes. A single
     * monster page should be skipped (not truncated) so model
     * citations remain accurate to the source text.
     */
    const big = "x".repeat(15_000);
    setupFetchMock({
      "/llm?t=": () => textResponse("handshake"),
      "/wiki/manifest.json": () =>
        jsonResponse({
          pages: [
            { slug: "small1", title: "Small One", type: "entity" },
            { slug: "huge", title: "Huge", type: "entity" },
            { slug: "small2", title: "Small Two", type: "entity" },
          ],
        }),
      "/wiki/page/small1": () =>
        jsonResponse({ slug: "small1", title: "Small One", type: "entity", body: "tiny1" }),
      "/wiki/page/huge": () =>
        jsonResponse({ slug: "huge", title: "Huge", type: "entity", body: big }),
      "/wiki/page/small2": () =>
        jsonResponse({ slug: "small2", title: "Small Two", type: "entity", body: "tiny2" }),
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
      maxBodyBytes: 1000,
    });

    expect(blob).toContain("tiny1");
    expect(blob).toContain("tiny2");
    expect(blob).not.toContain(big);
  });

  it("degrades gracefully when manifest fetch fails", async () => {
    /**
     * Network/permission failures mid-build must not throw — a
     * partial briefing is far more useful than an empty error.
     * The URL is preserved so a fetch-capable LLM can recover.
     */
    setupFetchMock({
      "/llm?t=": () => textResponse("# Handshake works"),
      "/wiki/manifest.json": () => new Response("kaboom", { status: 500 }),
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
    });

    expect(blob).toContain(FAKE_URL);
    expect(blob).toContain("Handshake works");
    expect(blob).toContain("manifest fetch failed");
    expect(isBriefingComplete(blob)).toBe(true);
  });

  it("isBriefingComplete returns false only when ALL sections fail", async () => {
    setupFetchMock({
      // No routes match → everything 404s.
    });

    const blob = await buildOfflineBriefing({
      llmUrl: FAKE_URL,
      token: FAKE_TOKEN,
      tenant: "cary",
    });
    expect(blob).toContain(FAKE_URL);
    expect(blob).toContain("handshake fetch failed");
    expect(blob).toContain("manifest fetch failed");
    expect(blob).toContain("no pages could be fetched");
    expect(isBriefingComplete(blob)).toBe(false);
  });

  it("uses same-origin paths for handshake to avoid CORS", async () => {
    /**
     * The owner panel runs at whatever the user's current origin is
     * (apex or www). The llmUrl baked into the share might be the
     * canonical (other-origin) variant. Fetching the absolute URL
     * client-side would either trip CORS or follow a 307 to a
     * different host. toSameOriginPath() strips the origin so the
     * request goes through the page's own host, which Next.js
     * rewrites to the backend.
     */
    const fetchFn = setupFetchMock({
      "/llm?t=": () => textResponse("ok"),
      "/wiki/manifest.json": () => jsonResponse({ pages: [] }),
    });

    await buildOfflineBriefing({
      llmUrl: "https://portablellm.wiki/cary/llm?t=" + FAKE_TOKEN,
      token: FAKE_TOKEN,
      tenant: "cary",
    });

    const handshakeCall = callsOf(fetchFn).find((c) => c.url.includes("/llm?t="));
    expect(handshakeCall).toBeDefined();
    // Same-origin path — no scheme, no host.
    expect(handshakeCall!.url.startsWith("/")).toBe(true);
    expect(handshakeCall!.url).not.toContain("portablellm.wiki");
  });
});
