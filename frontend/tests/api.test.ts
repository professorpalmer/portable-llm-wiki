/**
 * Unit tests for lib/api.ts — focused on the token + headers contract,
 * which is the most regression-prone part of the API client (auth bugs
 * are the most expensive class of mistake here).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getOwnerToken,
  setOwnerToken,
  getPreviewAs,
  setPreviewAs,
  fetchManifest,
  fetchSealedBundle,
  fetchSealingKeyring,
  ownerDeleteSealing,
  ownerGetPageRaw,
  ownerLint,
  ownerPutSealing,
  ownerReplacePage,
} from "@/lib/api";
import { setShareToken } from "@/lib/shareToken";

describe("owner token roundtrip", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when no token is set", () => {
    expect(getOwnerToken()).toBeNull();
  });

  it("persists a token across calls", () => {
    setOwnerToken("secret-token");
    expect(getOwnerToken()).toBe("secret-token");
  });

  it("clears a token when set to null", () => {
    setOwnerToken("secret-token");
    expect(getOwnerToken()).toBe("secret-token");
    setOwnerToken(null);
    expect(getOwnerToken()).toBeNull();
  });
});

describe("preview-as", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to owner when nothing stored", () => {
    expect(getPreviewAs()).toBe("owner");
  });

  it("sets and reads back lower tiers", () => {
    setPreviewAs("public");
    expect(getPreviewAs()).toBe("public");
    setPreviewAs("recruiter");
    expect(getPreviewAs()).toBe("recruiter");
    setPreviewAs("friend");
    expect(getPreviewAs()).toBe("friend");
  });

  it("clears localStorage entry when set to owner", () => {
    setPreviewAs("public");
    expect(window.localStorage.getItem("wiki.preview_as")).toBe("public");
    setPreviewAs("owner");
    expect(window.localStorage.getItem("wiki.preview_as")).toBeNull();
  });

  it("ignores garbage values and falls back to owner", () => {
    window.localStorage.setItem("wiki.preview_as", "not-a-real-tier");
    expect(getPreviewAs()).toBe("owner");
  });
});

describe("preview-as vs owner bootstrap headers", () => {
  const ownerManifest = {
    wiki_title: "Test",
    generated_at: "2026-01-01T00:00:00Z",
    viewer_tier: "private",
    viewer_is_owner: true,
    page_count: 3,
    sections: {},
    pages: [],
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("owner verify path succeeds with wiki.preview_as=public (no X-Preview-As)", async () => {
    // Regression: Preview-as used to ride on every headers() call, so
    // /owner verify saw viewer_is_owner:false and treated it as auth
    // failure — locking owners out of the panel that clears preview.
    setPreviewAs("public");
    setOwnerToken("owner-secret");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ownerManifest,
    });
    vi.stubGlobal("fetch", fetchMock);

    const m = await fetchManifest(undefined, { asOwner: true });
    expect(m.viewer_is_owner).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Preview-As"]).toBeUndefined();
  });

  it("browse fetchManifest still sends X-Preview-As when previewing", async () => {
    setPreviewAs("public");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...ownerManifest,
        viewer_tier: "public",
        viewer_is_owner: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const m = await fetchManifest();
    expect(m.viewer_is_owner).toBe(false);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["X-Preview-As"]).toBe("public");
  });

  it("owner endpoints never send X-Preview-As", async () => {
    setPreviewAs("recruiter");
    setOwnerToken("owner-secret");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totals: { pages: 0, by_section: {}, by_tier: {} },
        orphans: [],
        stale: [],
        missing_pages: [],
        broken_provenance: [],
        missing_index_entries: [],
        generated_at: "2026-01-01T00:00:00Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerLint();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Preview-As"]).toBeUndefined();
  });

  it("browse sends X-Share-Token and does not put the share token in Authorization", async () => {
    setShareToken("recruiter-share", "cary");
    setOwnerToken("real-owner-secret");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...ownerManifest,
        viewer_tier: "recruiter",
        viewer_is_owner: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchManifest("cary");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["X-Share-Token"]).toBe("recruiter-share");
    expect(hdrs["Authorization"]).toBe("Bearer real-owner-secret");
  });

  it("owner endpoints never send X-Share-Token as Authorization substitute", async () => {
    setShareToken("recruiter-share");
    setOwnerToken("owner-secret");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totals: { pages: 0, by_section: {}, by_tier: {} },
        orphans: [],
        stale: [],
        missing_pages: [],
        broken_provenance: [],
        missing_index_entries: [],
        generated_at: "2026-01-01T00:00:00Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerLint();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Share-Token"]).toBeUndefined();
  });
});

describe("sealing fetchers", () => {
  const keyring = {
    v: 1 as const,
    tiers: ["private"],
    kdf: "pbkdf2-sha256" as const,
    iterations: 600000,
    salt: "c2FsdHNhbHRzYWx0c2FsdA==",
    wrapped_dek: "d3JhcHBlZGRla3dyYXBwZWRkZWs=",
    check: "Y2hlY2tjaGVja2NoZWNrY2hlY2s=",
    created: "2026-09-12T00:00:00.000Z",
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchSealingKeyring hits /wiki/sealing with browse headers", async () => {
    setPreviewAs("friend");
    setOwnerToken("owner-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => keyring,
    });
    vi.stubGlobal("fetch", fetchMock);

    const got = await fetchSealingKeyring();
    expect(got.tiers).toEqual(["private"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/wiki/sealing");
    const hdrs = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(hdrs["X-Preview-As"]).toBe("friend");
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
  });

  it("fetchSealedBundle hits /wiki/sealed/bundle with browse headers", async () => {
    setPreviewAs("recruiter");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        count: 1,
        pages: [
          {
            slug: "s-abc",
            section: "concepts",
            tier: "private",
            updated: "2026-09-12",
            envelope: "ZW52",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const got = await fetchSealedBundle();
    expect(got.count).toBe(1);
    expect(got.pages[0].slug).toBe("s-abc");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/wiki/sealed/bundle");
    const hdrs = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(hdrs["X-Preview-As"]).toBe("recruiter");
  });

  it("ownerPutSealing PUTs /owner/sealing without preview headers", async () => {
    setPreviewAs("public");
    setOwnerToken("owner-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerPutSealing({ keyring, force: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/owner/sealing");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Preview-As"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ keyring, force: true });
  });

  it("ownerDeleteSealing DELETEs /owner/sealing with owner headers", async () => {
    setPreviewAs("friend");
    setOwnerToken("owner-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerDeleteSealing();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/owner/sealing");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Preview-As"]).toBeUndefined();
  });

  it("ownerGetPageRaw GETs /owner/page/{slug}/raw with owner headers", async () => {
    setPreviewAs("public");
    setOwnerToken("owner-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slug: "alpha",
        rel_path: "wiki/concepts/alpha.md",
        title: "Alpha",
        section: "concepts",
        tier: "private",
        markdown: "---\n---\n",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerGetPageRaw("alpha");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/owner/page/alpha/raw");
    const hdrs = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(hdrs["Authorization"]).toBe("Bearer owner-secret");
    expect(hdrs["X-Preview-As"]).toBeUndefined();
  });

  it("ownerReplacePage PUTs /owner/page/{slug} with owner headers", async () => {
    setPreviewAs("friend");
    setOwnerToken("owner-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        slug: "alpha",
        rel_path: "wiki/concepts/alpha.md",
        tier: "private",
        title: "Alpha",
        size: 12,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ownerReplacePage("alpha", "---\n---\nbody");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/owner/page/alpha");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ markdown: "---\n---\nbody" });
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["X-Preview-As"]).toBeUndefined();
  });
});
