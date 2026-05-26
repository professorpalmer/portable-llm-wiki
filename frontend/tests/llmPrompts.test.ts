import { describe, it, expect } from "vitest";

import {
  buildFullFetchPrompt,
  buildHumanShareUrl,
  buildLlmUrlForTier,
  buildQrPayload,
  buildWhoAmIPrompt,
  PROMPT_TEMPLATES,
  TIER_BADGE_CLASSES,
  TIER_DESCRIPTION,
  TIER_LABEL,
  toSameOriginPath,
} from "@/lib/llmPrompts";

// The QR payload is the highest-stakes string in the codebase: a single
// character drift breaks scannability (over the byte threshold) or
// fetch reliability. These tests pin the contract down so regressions
// surface in CI instead of in someone's broken LinkedIn banner.

const SAMPLE_URL = "https://portablellm.wiki/professorpalmer/llm";

describe("buildQrPayload", () => {
  // CRITICAL: the QR payload must be EXACTLY the URL — no prefix, no
  // suffix, no wrapping prompt. A previous iteration wrapped the URL
  // in a fetch-forcing prompt for vision-AI decoders, but that broke
  // the dominant use case: phone cameras stopped recognizing the
  // payload as a URL and stopped offering a one-tap "Open" action.
  // These tests pin URL-only behavior so we don't reintroduce the bug.

  it("returns the URL verbatim with nothing prepended or appended", () => {
    expect(buildQrPayload(SAMPLE_URL)).toBe(SAMPLE_URL);
  });

  it("starts with the URL scheme so phone scanners offer 'Open in browser'", () => {
    // iOS Camera, Android Lens, and Google Camera all check whether the
    // FIRST characters form a valid URL scheme. Any prefix (even a
    // single space, let alone "GET ") demotes the payload to plain
    // text and forces the user to tap a chip to copy it. The first
    // char must be the protocol.
    const payload = buildQrPayload(SAMPLE_URL);
    expect(payload.startsWith("https://")).toBe(true);
  });

  it("does NOT contain wrapper words like GET/fetch/follow that broke phone scans", () => {
    // Regression guard: if someone "helpfully" re-adds the LLM-prompt
    // wrapper, these substrings will reappear and this test fires
    // before the bug ships.
    const payload = buildQrPayload(SAMPLE_URL);
    expect(payload).not.toMatch(/\b(GET|fetch|follow|spec|response)\b/);
  });

  it("preserves tier-token query strings (recruiter/friend share URLs)", () => {
    const tokenUrl = `${SAMPLE_URL}?t=abc123`;
    expect(buildQrPayload(tokenUrl)).toBe(tokenUrl);
  });

  it("stays well under 134 bytes even for a generously long tenant slug", () => {
    // Even with a 32-char tenant id (GitHub login max is 39, most <20)
    // we're comfortably inside QR version 4 (78 bytes at EC M), which
    // scans at very small print sizes. Test pins the upper bound.
    const longTenant = "a".repeat(32);
    const longUrl = `https://portablellm.wiki/${longTenant}/llm`;
    const bytes = new TextEncoder().encode(buildQrPayload(longUrl)).length;
    expect(bytes).toBeLessThanOrEqual(134);
  });
});


describe("buildWhoAmIPrompt", () => {
  it("includes the URL on its own line so users can edit either half", () => {
    const prompt = buildWhoAmIPrompt(SAMPLE_URL);
    expect(prompt).toContain(SAMPLE_URL);
    // URL is at the end after a blank-line separator — keeps it easy
    // to swap the question wording without breaking the link.
    expect(prompt.endsWith(SAMPLE_URL)).toBe(true);
  });

  it("explicitly tells the LLM to use its browse tool", () => {
    expect(buildWhoAmIPrompt(SAMPLE_URL).toLowerCase()).toMatch(
      /browse|web tool|fetch/,
    );
  });
});


describe("buildFullFetchPrompt", () => {
  it("uses MUST wording to override LLM laziness", () => {
    // "MUST" + "BEFORE" is the strongest force-fetch phrasing we
    // tested against ChatGPT/Claude that doesn't trip safety filters.
    const prompt = buildFullFetchPrompt(SAMPLE_URL);
    expect(prompt).toMatch(/MUST/);
    expect(prompt.toLowerCase()).toContain("before answering");
  });

  it("gives the LLM a concrete first task so it doesn't just confirm receipt", () => {
    // Without a task, some LLMs respond with "OK, fetched the URL.
    // What's your question?" and the user has to ask twice. Including
    // a default task gets a real answer on the first turn.
    const prompt = buildFullFetchPrompt(SAMPLE_URL);
    expect(prompt.toLowerCase()).toContain("first task");
  });
});


describe("buildLlmUrlForTier", () => {
  const ORIGIN = "https://portablellm.wiki";

  it("public tier returns bare /llm path with no query string", () => {
    expect(
      buildLlmUrlForTier({ origin: ORIGIN, tenant: "cary", tier: "public" }),
    ).toBe("https://portablellm.wiki/cary/llm");
  });

  it("OSS mode (no tenant) returns /llm at the root", () => {
    expect(buildLlmUrlForTier({ origin: ORIGIN, tier: "public" })).toBe(
      "https://portablellm.wiki/llm",
    );
  });

  it("recruiter tier with a token returns /llm?t=<token>", () => {
    expect(
      buildLlmUrlForTier({
        origin: ORIGIN,
        tenant: "cary",
        tier: "recruiter",
        token: "ABC123",
      }),
    ).toBe("https://portablellm.wiki/cary/llm?t=ABC123");
  });

  it("URL-encodes share tokens that contain reserved characters", () => {
    // Share tokens are url-safe base64 by default, but tests still pin
    // the encoding contract so a future format change can't silently
    // break URLs.
    const url = buildLlmUrlForTier({
      origin: ORIGIN,
      tenant: "cary",
      tier: "recruiter",
      token: "a/b+c=",
    });
    expect(url).toContain("?t=a%2Fb%2Bc%3D");
  });

  it("non-public tier WITHOUT a token degrades to bare /llm (not /llm?t=)", () => {
    // Defensive: if a caller forgets to pass `token` we should NOT emit
    // "?t=undefined" or "?t=null". The toggle UI is expected to show a
    // "minting…" indicator while the token resolves and use this fallback
    // URL in the meantime.
    expect(
      buildLlmUrlForTier({
        origin: ORIGIN,
        tenant: "cary",
        tier: "friend",
        token: null,
      }),
    ).toBe("https://portablellm.wiki/cary/llm");
  });

  it("strips trailing slashes from the origin so we never produce //llm", () => {
    expect(
      buildLlmUrlForTier({
        origin: "https://portablellm.wiki///",
        tenant: "cary",
        tier: "public",
      }),
    ).toBe("https://portablellm.wiki/cary/llm");
  });

  it("composes cleanly with buildQrPayload (no double protocol, no whitespace)", () => {
    const url = buildLlmUrlForTier({
      origin: ORIGIN,
      tenant: "cary",
      tier: "recruiter",
      token: "ABC",
    });
    const payload = buildQrPayload(url);
    // Payload must contain the URL verbatim — phone scanners look for
    // an https:// substring to offer "open in browser".
    expect(payload).toContain(url);
    expect(payload).not.toContain("  "); // no accidental doubled spaces
  });
});


describe("buildHumanShareUrl", () => {
  // Pinning the URL split that fixes the phone-scan UX bug. The QR
  // encodes a humanShareUrl (landing page) so scans open the rendered
  // wiki; the /llm URL is reserved for the "Paste into ChatGPT" copy
  // buttons. If these two collapse back into a single URL we'd
  // regress to "scan → raw markdown soup" behavior.
  const ORIGIN = "https://portablellm.wiki";

  it("public tier returns the bare landing URL (no query string)", () => {
    expect(
      buildHumanShareUrl({ origin: ORIGIN, tenant: "cary", tier: "public" }),
    ).toBe("https://portablellm.wiki/cary");
  });

  it("public tier with no tenant returns the apex (for OSS single-tenant)", () => {
    expect(buildHumanShareUrl({ origin: ORIGIN, tier: "public" })).toBe(
      "https://portablellm.wiki",
    );
  });

  it("recruiter tier with a token returns landing + ?share=<token>", () => {
    // CRITICAL: this is ?share=, NOT ?t=. The two use different
    // catchers — ?share= goes through ShareTokenCatcher (localStorage
    // + URL strip) and is meant for human browsing; ?t= is the
    // backend's LLM-facing token. Conflating them would silently
    // break tier elevation in one direction or the other.
    expect(
      buildHumanShareUrl({
        origin: ORIGIN,
        tenant: "cary",
        tier: "recruiter",
        token: "abc123",
      }),
    ).toBe("https://portablellm.wiki/cary?share=abc123");
  });

  it("URL-encodes share tokens that contain special characters", () => {
    const url = buildHumanShareUrl({
      origin: ORIGIN,
      tenant: "cary",
      tier: "friend",
      token: "a+b/c=d",
    });
    expect(url).toBe("https://portablellm.wiki/cary?share=a%2Bb%2Fc%3Dd");
  });

  it("falls back to the bare landing URL if a non-public tier has no token", () => {
    // Token still being minted: render SOMETHING usable rather than a
    // broken URL with empty query value. The toggle UI is expected to
    // surface a "minting…" indicator next to the badge.
    expect(
      buildHumanShareUrl({
        origin: ORIGIN,
        tenant: "cary",
        tier: "recruiter",
      }),
    ).toBe("https://portablellm.wiki/cary");
  });

  it("strips trailing slashes from the origin so we never produce //tenant", () => {
    expect(
      buildHumanShareUrl({
        origin: "https://portablellm.wiki///",
        tenant: "cary",
        tier: "public",
      }),
    ).toBe("https://portablellm.wiki/cary");
  });

  it("does NOT include /llm in the path — that's the LLM URL's job", () => {
    // Regression guard: the whole reason this helper exists is to
    // produce a URL that DOESN'T point at /llm. If someone accidentally
    // appends it the QR-scan UX breaks again.
    const url = buildHumanShareUrl({
      origin: ORIGIN,
      tenant: "cary",
      tier: "public",
    });
    expect(url).not.toContain("/llm");
  });
});


describe("toSameOriginPath", () => {
  // Pinning down the contract: the /share preview fetch routes through
  // this helper specifically to avoid a CORS class of bug when
  // public_base_url (apex) differs from the browser's current host
  // (www subdomain or a temp tunnel). A regression here surfaces as
  // "Network error fetching the preview" in production.

  it("strips the protocol + host from an absolute https URL", () => {
    expect(
      toSameOriginPath("https://portablellm.wiki/professorpalmer/llm"),
    ).toBe("/professorpalmer/llm");
  });

  it("preserves query strings (critical for tier-gated ?t=<token> URLs)", () => {
    expect(
      toSameOriginPath(
        "https://portablellm.wiki/professorpalmer/llm?t=abc123",
      ),
    ).toBe("/professorpalmer/llm?t=abc123");
  });

  it("preserves URL fragments if present", () => {
    expect(
      toSameOriginPath("https://example.com/path?q=1#section"),
    ).toBe("/path?q=1#section");
  });

  it("collapses the apex root path correctly (OSS single-tenant)", () => {
    expect(toSameOriginPath("https://wiki.example.com/llm")).toBe("/llm");
  });

  it("returns the input verbatim when given a relative path", () => {
    // URL() throws on unparseable strings; we treat that as "already
    // relative" so the caller can fetch it as-is.
    expect(toSameOriginPath("/already/relative")).toBe("/already/relative");
  });

  it("returns the input verbatim when given garbage instead of crashing", () => {
    expect(toSameOriginPath("not a url")).toBe("not a url");
    expect(toSameOriginPath("")).toBe("");
  });

  it("strips the host even when www and apex variants differ", () => {
    // The bug this exists to prevent: www.host vs apex host being
    // treated as different origins by the browser. After stripping,
    // both yield the same same-origin path.
    const apex = toSameOriginPath("https://portablellm.wiki/cary/llm");
    const www = toSameOriginPath("https://www.portablellm.wiki/cary/llm");
    expect(apex).toBe("/cary/llm");
    expect(www).toBe("/cary/llm");
    expect(apex).toBe(www);
  });
});


describe("tier metadata constants", () => {
  it("exports a label and description for every shareable tier", () => {
    for (const tier of ["public", "recruiter", "friend"] as const) {
      expect(TIER_LABEL[tier]).toBeTruthy();
      expect(TIER_DESCRIPTION[tier]).toBeTruthy();
      expect(TIER_BADGE_CLASSES[tier]).toBeTruthy();
    }
  });

  it("does NOT expose `private` as a shareable tier (footgun guard)", () => {
    // Catching a future change that adds `private` to the toggle:
    // sharing private-tier content via QR is never the intended UX.
    expect(TIER_LABEL).not.toHaveProperty("private");
    expect(TIER_DESCRIPTION).not.toHaveProperty("private");
  });
});


describe("PROMPT_TEMPLATES", () => {
  it("orders variants from least to most aggressive (lowest commitment first)", () => {
    expect(PROMPT_TEMPLATES.map((t) => t.id)).toEqual([
      "url-only",
      "who-am-i",
      "full-fetch",
    ]);
  });

  it("all templates produce something that includes the URL", () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(t.build(SAMPLE_URL)).toContain(SAMPLE_URL);
    }
  });

  it("each template has a non-empty short label and description", () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.label.length).toBeLessThan(40);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
