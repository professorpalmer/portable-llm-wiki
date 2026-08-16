/**
 * OwnerGate login links must pass pathname-only return_to — never
 * ?share= or ?t= from the current page.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    isHostedMode: vi.fn(() => true),
    authMe: vi.fn(),
    apiBase: () => "https://api.portablellm.wiki",
  };
});

import { authMe } from "@/lib/api";
import { OwnerGate } from "@/components/OwnerGate";

describe("OwnerGate return_to", () => {
  beforeEach(() => {
    vi.mocked(authMe).mockReset();
    window.history.pushState(
      {},
      "",
      "/cary/owner?share=leaked&t=also-leaked&nonce=n1",
    );
  });

  it("anonymous sign-in link uses pathname only", async () => {
    vi.mocked(authMe).mockResolvedValue({
      authenticated: false,
      user: null,
      tenant: null,
      fresh_signup: false,
    });
    render(
      <OwnerGate tenant="cary">
        <div>secret owner ui</div>
      </OwnerGate>,
    );
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    const href = link.getAttribute("href") || "";
    expect(href).toContain("/auth/github/login?return_to=");
    const returnTo = decodeURIComponent(href.split("return_to=")[1] || "");
    expect(returnTo).toBe("/cary/owner");
    expect(returnTo).not.toContain("share=");
    expect(returnTo).not.toContain("t=");
    expect(returnTo).not.toContain("nonce=");
  });

  it("tenant-missing re-sign-in link also strips secrets", async () => {
    vi.mocked(authMe).mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "cary",
        login: "cary",
        name: "Cary",
        avatar_url: "",
      },
      tenant: null,
      fresh_signup: false,
    });
    render(
      <OwnerGate tenant="cary">
        <div>secret owner ui</div>
      </OwnerGate>,
    );
    const link = await screen.findByRole("link", {
      name: /re-sign in with github/i,
    });
    const href = link.getAttribute("href") || "";
    const returnTo = decodeURIComponent(href.split("return_to=")[1] || "");
    expect(returnTo).toBe("/cary/owner");
    expect(href).not.toContain("share=");
    expect(href).not.toContain("also-leaked");
  });
});
