/**
 * ConnectMarionettePage login return_to is pathname only — no share/t/return/nonce.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    authMe: vi.fn(),
    apiBase: () => "https://api.portablellm.wiki",
  };
});

import { authMe } from "@/lib/api";
import ConnectMarionettePage from "@/app/connect/marionette/page";

describe("ConnectMarionettePage return_to", () => {
  beforeEach(() => {
    vi.mocked(authMe).mockReset();
    vi.mocked(authMe).mockResolvedValue({
      authenticated: false,
      user: null,
      tenant: null,
      fresh_signup: false,
    });
    window.history.pushState(
      {},
      "",
      "/connect/marionette?client=marionette&share=abc&t=secret&return=http://127.0.0.1:9/api/wiki/connect&nonce=n1",
    );
  });

  it("sign-in href is pathname-only return_to", async () => {
    render(<ConnectMarionettePage />);
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    await waitFor(() => {
      expect(link.getAttribute("href")).toContain("return_to=");
    });
    const href = link.getAttribute("href") || "";
    const returnTo = decodeURIComponent(href.split("return_to=")[1] || "");
    expect(returnTo).toBe("/connect/marionette");
    expect(href).not.toContain("share=");
    expect(href).not.toContain("secret");
    expect(href).not.toContain("nonce=");
    expect(href).not.toContain("127.0.0.1");
  });
});
