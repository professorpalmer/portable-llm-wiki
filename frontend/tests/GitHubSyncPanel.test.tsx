/**
 * GitHubSyncPanel tests. This is the owner-console panel that surfaces
 * the per-tenant GitHub push-back state. Three branches matter:
 *   - loading state on first render
 *   - "not connected" → renders the connect CTA
 *   - "connected, healthy" → renders repo link + sync now button
 *   - "connected, errored" → renders the last-error block
 *   - Sync Now button → calls ownerSyncNow + refreshes status
 *
 * Regression context: the previous HostedStorageNote was an inert info
 * card. This new panel is the user-facing surface for the whole "your
 * data lives in your own GitHub" feature, so the rendering and the
 * sync-now action both need test coverage.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  ownerSyncStatus: vi.fn(),
  ownerSyncNow: vi.fn(),
  ownerSyncPull: vi.fn(),
}));

import { ownerSyncStatus, ownerSyncNow, ownerSyncPull } from "@/lib/api";
import { GitHubSyncPanel } from "@/app/owner/page";

const mockedStatus = vi.mocked(ownerSyncStatus);
const mockedSyncNow = vi.mocked(ownerSyncNow);
const mockedSyncPull = vi.mocked(ownerSyncPull);

const NOT_CONNECTED = {
  connected: false,
  repo: "",
  branch: "main",
  html_url: "",
  last_synced_at: 0,
  last_error: "",
  pushes_made: 0,
};

const HEALTHY_CONNECTED = {
  connected: true,
  repo: "alice/portable-llm-wiki",
  branch: "main",
  html_url: "https://github.com/alice/portable-llm-wiki",
  last_synced_at: 1700000000,
  last_error: "",
  pushes_made: 5,
  pending_message_count: 0,
  timer_scheduled: false,
};

const ERRORED_CONNECTED = {
  ...HEALTHY_CONNECTED,
  last_error: "git push failed: HTTP 403 (token rejected)",
};

describe("GitHubSyncPanel", () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    mockedSyncNow.mockReset();
    mockedSyncPull.mockReset();
  });

  it("renders loading state on first render", async () => {
    mockedStatus.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<GitHubSyncPanel tenantId="alice" />);
    expect(screen.getByText(/Loading sync status/i)).toBeInTheDocument();
  });

  it("renders connect CTA when tenant is not connected", async () => {
    mockedStatus.mockResolvedValue(NOT_CONNECTED);
    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(
        screen.getByText(/GitHub sync · not connected/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: /Connect a GitHub repo/i }),
    ).toBeInTheDocument();
  });

  it("renders connected + repo link when connected", async () => {
    mockedStatus.mockResolvedValue(HEALTHY_CONNECTED);
    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() => {
      const repoLinks = screen.getAllByRole("link", {
        name: /alice\/portable-llm-wiki/,
      });
      // Two links: the header reference + the footer summary.
      expect(repoLinks.length).toBeGreaterThan(0);
      expect(repoLinks[0]).toHaveAttribute(
        "href",
        "https://github.com/alice/portable-llm-wiki",
      );
    });
  });

  it("renders last-error block when sync has failed", async () => {
    mockedStatus.mockResolvedValue(ERRORED_CONNECTED);
    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(screen.getByText(/Last sync error/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/git push failed: HTTP 403/),
    ).toBeInTheDocument();
  });

  it("clicking Sync now calls ownerSyncNow and refreshes status", async () => {
    const user = userEvent.setup();
    mockedStatus.mockResolvedValue(HEALTHY_CONNECTED);
    mockedSyncNow.mockResolvedValue({
      ok: true,
      result: {
        committed: true,
        pushed: true,
        messages: ["manual sync"],
        commit_summary: "wiki: manual sync",
      },
      status: { ...HEALTHY_CONNECTED, pushes_made: 6 },
    });

    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sync now/i }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Sync now/i }));

    await waitFor(() => {
      expect(mockedSyncNow).toHaveBeenCalledTimes(1);
    });
    // The success summary should appear next to the button.
    expect(screen.getByText(/pushed:/i)).toBeInTheDocument();
  });

  it("clicking Pull from GitHub calls ownerSyncPull and shows pulled count", async () => {
    // Regression: this button is the only owner-console way to fetch
    // edits made directly on GitHub. If it stops calling the API or
    // stops showing the result, users lose visibility into whether
    // their remote-side edits actually came through.
    const user = userEvent.setup();
    mockedStatus.mockResolvedValue(HEALTHY_CONNECTED);
    mockedSyncPull.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        action: "pulled",
        behind: 3,
        ahead: 0,
        dirty: false,
      },
      status: { ...HEALTHY_CONNECTED, last_synced_at: 1700000100 },
    });

    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Pull from GitHub/i }),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /Pull from GitHub/i }),
    );

    await waitFor(() => {
      expect(mockedSyncPull).toHaveBeenCalledTimes(1);
    });
    // "pulled 3 commits from GitHub" — exact pluralization matters
    // because we want it to read naturally for both behind=1 and behind=3.
    expect(
      screen.getByText(/pulled 3 commits from GitHub/i),
    ).toBeInTheDocument();
  });

  it("renders diverged-branch warning when pull is blocked", async () => {
    // The most subtle case: both sides have changes. Users see an
    // amber callout explaining why we won't pull, plus a force-pull
    // button that requires confirmation.
    const user = userEvent.setup();
    mockedStatus.mockResolvedValue(HEALTHY_CONNECTED);
    mockedSyncPull.mockResolvedValue({
      ok: false,
      result: {
        ok: false,
        action: "diverged",
        behind: 2,
        ahead: 1,
        dirty: false,
        error: "Branches have diverged (1 local, 2 remote). Resolve...",
      },
      status: HEALTHY_CONNECTED,
    });

    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Pull from GitHub/i }),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /Pull from GitHub/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Pull blocked/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Branches have diverged/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Force pull/i }),
    ).toBeInTheDocument();
  });

  it("surfaces error messages from a failed sync attempt", async () => {
    const user = userEvent.setup();
    mockedStatus.mockResolvedValue(HEALTHY_CONNECTED);
    mockedSyncNow.mockResolvedValue({
      ok: false,
      result: {
        committed: false,
        pushed: false,
        messages: ["manual sync"],
        error: "remote rejected: branch protected",
      },
      status: HEALTHY_CONNECTED,
    });

    render(<GitHubSyncPanel tenantId="alice" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sync now/i }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Sync now/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/error: remote rejected: branch protected/),
      ).toBeInTheDocument(),
    );
  });
});
