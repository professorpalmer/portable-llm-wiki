/**
 * Hosted NavBar: Sign out is POST /auth/logout (not a CSRF-able GET).
 * Switch-account is not a GET that clears the session. Sign-in return_to
 * is pathname only.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    isHostedMode: vi.fn(() => true),
    authMe: vi.fn(),
    authLogout: vi.fn(),
    apiBase: () => "https://api.portablellm.wiki",
  };
});

import { authLogout, authMe } from "@/lib/api";
import { NavBar } from "@/components/NavBar";

describe("NavBar hosted logout / return_to", () => {
  beforeEach(() => {
    vi.mocked(authMe).mockReset();
    vi.mocked(authLogout).mockReset();
    vi.mocked(authLogout).mockResolvedValue({ ok: true });
    window.history.pushState({}, "", "/cary?share=abc&t=secret");
  });

  it("anonymous sign-in uses pathname-only return_to", async () => {
    vi.mocked(authMe).mockResolvedValue({
      authenticated: false,
      user: null,
      tenant: null,
      fresh_signup: false,
    });
    render(<NavBar />);
    const link = await screen.findByRole("link", { name: /sign in/i });
    const href = link.getAttribute("href") || "";
    const returnTo = decodeURIComponent(href.split("return_to=")[1] || "");
    expect(returnTo).toBe("/cary");
    expect(returnTo).not.toContain("share=");
    expect(returnTo).not.toContain("t=");
  });

  it("Sign out POSTs /auth/logout and is not an <a href> GET", async () => {
    vi.mocked(authMe).mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "cary",
        login: "cary",
        name: "Cary",
        avatar_url: "",
      },
      tenant: { id: "cary" } as never,
      fresh_signup: false,
    });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<NavBar />);
    const chip = await screen.findByRole("button", { name: /@cary/i });
    fireEvent.click(chip);

    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(signOut.tagName).toBe("BUTTON");
    expect(screen.queryByRole("link", { name: /sign out/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /switch github account/i })).toBeNull();

    fireEvent.click(signOut);
    await waitFor(() => {
      expect(authLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("Switch account POSTs logout then goes to GitHub login, not GET switch-account", async () => {
    vi.mocked(authMe).mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "cary",
        login: "cary",
        name: "Cary",
        avatar_url: "",
      },
      tenant: { id: "cary" } as never,
      fresh_signup: false,
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        assign,
        href: "https://portablellm.wiki/cary?share=abc&t=secret",
        pathname: "/cary",
        origin: "https://portablellm.wiki",
        search: "?share=abc&t=secret",
      },
    });

    render(<NavBar />);
    fireEvent.click(await screen.findByRole("button", { name: /@cary/i }));
    fireEvent.click(screen.getByRole("button", { name: /switch github account/i }));

    await waitFor(() => {
      expect(authLogout).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    const dest = String(assign.mock.calls[0][0]);
    expect(dest).toContain("/auth/github/login?return_to=");
    expect(dest).not.toContain("/auth/switch-account");
    expect(dest).not.toContain("share=");
    expect(dest).not.toContain("t=secret");
  });
});
