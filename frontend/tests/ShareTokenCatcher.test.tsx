/**
 * ShareTokenCatcher: when the URL contains ?share=<token>, we store the
 * token as the owner token and scrub the query string so it doesn't
 * accidentally end up in logs or screenshots.
 *
 * This is the single most security-sensitive client-side component, so
 * we test:
 *  - happy path: ?share=X writes localStorage and cleans URL
 *  - empty share param doesn't break or write garbage
 *  - non-share URLs don't touch localStorage
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { ShareTokenCatcher } from "@/components/ShareTokenCatcher";

function setUrl(search: string) {
  // jsdom doesn't let us assign window.location directly, but it does support
  // history.pushState to rewrite the URL within the same origin.
  window.history.pushState({}, "", `/${search ? "?" + search : ""}`);
}

describe("ShareTokenCatcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUrl("");
  });

  it("stores the token from ?share=… and scrubs the URL", async () => {
    setUrl("share=abc123tok");
    expect(window.location.search).toContain("share=abc123tok");

    render(<ShareTokenCatcher />);

    await waitFor(() => {
      // Token persisted under the api.ts owner-token key
      expect(window.localStorage.getItem("llmwiki:ownerToken")).toBe(
        "abc123tok",
      );
    });
    // URL was rewritten to drop the share param
    expect(window.location.search).not.toContain("share=");
  });

  it("does nothing when there is no share param", async () => {
    setUrl("foo=bar");
    render(<ShareTokenCatcher />);
    // Give the effect a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
    expect(window.location.search).toContain("foo=bar");
  });

  it("ignores an empty share param", async () => {
    setUrl("share=");
    render(<ShareTokenCatcher />);
    await new Promise((r) => setTimeout(r, 5));
    expect(window.localStorage.getItem("llmwiki:ownerToken")).toBeNull();
  });
});
