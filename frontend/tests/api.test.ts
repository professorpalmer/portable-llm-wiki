/**
 * Unit tests for lib/api.ts — focused on the token + headers contract,
 * which is the most regression-prone part of the API client (auth bugs
 * are the most expensive class of mistake here).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getOwnerToken,
  setOwnerToken,
  getPreviewAs,
  setPreviewAs,
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
