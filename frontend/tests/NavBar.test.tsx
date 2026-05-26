/**
 * NavBar tests. The mobile drawer is core to the UX on phones and is
 * easy to break with future styling changes, so we lock its behavior:
 *  - all 7 nav items are reachable on desktop
 *  - hamburger toggles the drawer open + closed
 *  - active-route highlighting fires
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { __setPathname } from "./setup";

// Mock the ViewerBadge so NavBar tests don't have to deal with the API call
// or its async state.
vi.mock("@/components/ViewerBadge", () => ({
  ViewerBadge: () => <div data-testid="viewer-badge">badge</div>,
}));

import { NavBar } from "@/components/NavBar";

const NAV_LINKS = [
  "browse",
  "graph",
  "ask",
  "connect",
  "capture",
  "owner",
  "share",
];

function withPath(path: string) {
  __setPathname(path);
}

describe("NavBar", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    withPath("/");
  });

  it("renders the brand and all nav links", () => {
    render(<NavBar />);
    expect(screen.getByText(/portable llm wiki/i)).toBeInTheDocument();
    for (const label of NAV_LINKS) {
      // Each link appears twice (desktop + drawer markup). Use getAllByRole.
      const items = screen.getAllByRole("link", { name: label });
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it("highlights the active route", () => {
    withPath("/owner");
    render(<NavBar />);
    const ownerLinks = screen.getAllByRole("link", { name: "owner" });
    // At least one of the rendered "owner" links should have the active class.
    const activeOwner = ownerLinks.find((a) =>
      a.className.includes("font-medium"),
    );
    expect(activeOwner).toBeDefined();

    // And a non-active link should NOT have the active class.
    const browseLinks = screen.getAllByRole("link", { name: "browse" });
    expect(browseLinks.every((a) => !a.className.includes("font-medium"))).toBe(
      true,
    );
  });

  it("toggles the mobile drawer via the hamburger button", () => {
    render(<NavBar />);
    const button = screen.getByLabelText(/open menu/i);
    expect(button).toBeInTheDocument();
    // Drawer not present yet: only the desktop "tap outside" hint should be missing.
    expect(screen.queryByText(/tap outside/i)).not.toBeInTheDocument();

    fireEvent.click(button);
    // Now drawer is present, and aria-label flips
    expect(screen.getByLabelText(/close menu/i)).toBeInTheDocument();
    expect(screen.getByText(/tap outside/i)).toBeInTheDocument();
    // Body scroll should be locked
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByLabelText(/close menu/i));
    expect(screen.queryByText(/tap outside/i)).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
