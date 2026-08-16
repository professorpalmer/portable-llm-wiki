/**
 * ShareTokenCatcher: when the URL contains ?share=<token>, we store the
 * token in a tenant-scoped share-token key (never llmwiki:ownerToken)
 * and scrub the query string so it doesn't end up in logs or screenshots.
 *
 * This is the single most security-sensitive client-side component, so
 * we test:
 *  - happy path: ?share=X writes the share-token key and cleans URL
 *  - does not overwrite a real OSS OWNER_TOKEN
 *  - empty share param doesn't break or write garbage
 *  - non-share URLs don't touch localStorage
 */
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { ShareTokenCatcher } from "@/components/ShareTokenCatcher";
import { setOwnerToken } from "@/lib/api";
import { getShareToken, shareTokenStorageKey } from "@/lib/shareToken";

function setUrl(pathAndSearch: string) {
  // jsdom doesn't let us assign window.location directly, but it does support
  // history.pushState to rewrite the URL within the same origin.
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch ? "?" + pathAndSearch : ""}`;
  window.history.pushState({}, "", path);
}

describe("ShareTokenCatcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUrl("");
  });

  it("stores the token from ?share=… in the share-token key and scrubs the URL", async () => {
    setUrl("share=abc123tok");
    expect(window.location.search).toContain("share=abc123tok");

    render(<ShareTokenCatcher />);

    await waitFor(() => {
      expect(getShareToken()).toBe("abc123tok");
    });
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
    expect(window.location.search).not.toContain("share=");
  });

  it("scopes the share token to the hosted tenant path", async () => {
    setUrl("/cary?share=recruiter-tok");
    render(<ShareTokenCatcher />);

    await waitFor(() => {
      expect(window.localStorage.getItem(shareTokenStorageKey("cary"))).toBe(
        "recruiter-tok",
      );
    });
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
    expect(window.localStorage.getItem(shareTokenStorageKey("other"))).toBeNull();
  });

  it("does not overwrite a real OSS owner token", async () => {
    setOwnerToken("real-owner-secret");
    setUrl("/cary?share=friend-share");
    render(<ShareTokenCatcher />);

    await waitFor(() => {
      expect(getShareToken("cary")).toBe("friend-share");
    });
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBe(
      "real-owner-secret",
    );
  });

  it("does nothing when there is no share param", async () => {
    setUrl("foo=bar");
    render(<ShareTokenCatcher />);
    await new Promise((r) => setTimeout(r, 5));
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
    expect(getShareToken()).toBeNull();
    expect(window.location.search).toContain("foo=bar");
  });

  it("ignores an empty share param", async () => {
    setUrl("share=");
    render(<ShareTokenCatcher />);
    await new Promise((r) => setTimeout(r, 5));
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
    expect(getShareToken()).toBeNull();
  });
});
