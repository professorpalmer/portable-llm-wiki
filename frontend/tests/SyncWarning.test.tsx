/**
 * Tests for SyncWarning — the UI half of the "no silent no-op" guarantee.
 *
 * The backend stamps every content-create response with a sync verdict.
 * These lock the behavior that prevents a green "Saved" from implying a
 * durability it doesn't have:
 *   1. Durable writes render nothing (no nagging on the happy path).
 *   2. A local-only write (self-host, no remote) surfaces the actionable
 *      detail loudly.
 *   3. A connected-repo-missing tenant write surfaces the detail AND a
 *      link to the owner console to connect a repo.
 *   4. A missing verdict renders nothing (back-compat with older backends).
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { SyncWarning } from "@/components/SyncWarning";
import type { SyncVerdict } from "@/lib/api";

describe("SyncWarning", () => {
  it("renders nothing when the write is durable", () => {
    const sync: SyncVerdict = {
      will_sync: true,
      mode: "global",
      remote: "https://github.com/acme/wiki.git",
      detail: "Saved and auto-pushing to the configured git remote.",
    };
    const { container } = render(<SyncWarning sync={sync} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no verdict is present (older backend)", () => {
    const { container } = render(<SyncWarning sync={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("warns loudly for a local-only write", () => {
    const sync: SyncVerdict = {
      will_sync: false,
      mode: "local_only",
      remote: null,
      reason: "no_remote_configured",
      detail: "Saved to local disk only. Git persistence is OFF.",
    };
    render(<SyncWarning sync={sync} />);
    expect(screen.getByTestId("sync-warning")).toBeInTheDocument();
    expect(screen.getByText(/Saved to local disk only/i)).toBeInTheDocument();
    // local_only mode does NOT show the tenant "connect a repo" CTA.
    expect(
      screen.queryByText(/Connect a GitHub repo/i)
    ).not.toBeInTheDocument();
  });

  it("offers the connect-repo CTA for a tenant with no repo", () => {
    const sync: SyncVerdict = {
      will_sync: false,
      mode: "tenant",
      remote: null,
      reason: "no_repo_connected",
      detail: "This wiki isn't connected to a GitHub repo yet.",
    };
    render(<SyncWarning sync={sync} />);
    expect(screen.getByTestId("sync-warning")).toBeInTheDocument();
    const cta = screen.getByText(/Connect a GitHub repo/i);
    expect(cta).toBeInTheDocument();
    expect(cta.closest("a")).toHaveAttribute("href", "/owner");
  });

  it("does NOT tell a connected tenant to connect a repo (autopush off)", () => {
    // The contradiction we shipped before: a tenant WITH a connected repo
    // saw "A GitHub repo is connected, but autopush is OFF" *and* a
    // "Connect a GitHub repo" link in the same box. When a repo is present,
    // the CTA must steer to syncing, not connecting.
    const sync: SyncVerdict = {
      will_sync: false,
      mode: "tenant",
      remote: "acme/wiki",
      reason: "autopush_disabled",
      detail:
        "Saved on the server. Your GitHub repo (acme/wiki) is connected, but tenant autopush is OFF.",
    };
    render(<SyncWarning sync={sync} />);
    expect(screen.getByTestId("sync-warning")).toBeInTheDocument();
    // No misleading "Connect a GitHub repo" wording.
    expect(screen.queryByText(/Connect a GitHub repo/i)).not.toBeInTheDocument();
    // Instead, a sync-oriented CTA that still lands in the owner console.
    const cta = screen.getByText(/Open the owner console to sync/i);
    expect(cta.closest("a")).toHaveAttribute("href", "/owner");
    // Tenant writes are safe on the server — headline must not imply local-only.
    expect(
      screen.getByText(/Saved on the server — not yet on GitHub/i),
    ).toBeInTheDocument();
  });
});
