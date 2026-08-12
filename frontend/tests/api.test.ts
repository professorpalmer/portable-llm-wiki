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
  ownerLint,
} from "@/lib/api";

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
});
