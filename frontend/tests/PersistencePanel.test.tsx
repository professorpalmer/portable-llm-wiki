/**
 * PersistencePanel tests. The panel is the owner-console badge that tells
 * the owner whether their wiki writes are surviving container restarts.
 * If the disabled-state UX regresses, owners silently lose data — so we
 * lock the three branches: loading, disabled, enabled, plus the force
 * sync button and the error path.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  ownerPersistenceStatus: vi.fn(),
  ownerPersistenceFlush: vi.fn(),
}));

import { ownerPersistenceStatus, ownerPersistenceFlush } from "@/lib/api";
import { PersistencePanel } from "@/components/PersistencePanel";

const mockedStatus = vi.mocked(ownerPersistenceStatus);
const mockedFlush = vi.mocked(ownerPersistenceFlush);

// Realistic-looking enabled-state status. Matches the PersistenceStatus
// shape in lib/api.ts.
const ENABLED_STATUS = {
  enabled: true as const,
  remote: "https://github.com/me/my-wiki.git",
  branch: "main",
  push_delay_s: 5,
  user_name: "Owner",
  user_email: "owner@example.com",
  commits_made: 42,
  pushes_made: 17,
  last_flush_attempt: null,
  last_flush_ok: null,
  last_error: null,
  pending_message_count: 0,
  timer_scheduled: false,
};

const DISABLED_STATUS = {
  enabled: false as const,
  remote: null,
  branch: "main",
  push_delay_s: 5,
  user_name: "Owner",
  user_email: "owner@example.com",
  commits_made: 0,
  pushes_made: 0,
  last_flush_attempt: null,
  last_flush_ok: null,
  last_error: null,
  pending_message_count: 0,
  timer_scheduled: false,
};

describe("PersistencePanel", () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    mockedFlush.mockReset();
    // The component doesn't gate on auth itself (the API would return 401
    // if the token were missing), but most owner-console pages do; keep the
    // token primed so behavior matches a real session.
    window.localStorage.setItem("llmwiki:ownerToken", "fake-test-token");
  });

  it("renders the disabled-state UI when persistence is not configured", async () => {
    mockedStatus.mockResolvedValue(DISABLED_STATUS);

    render(<PersistencePanel />);

    // The "no git remote configured" label is the unique disabled-state tell.
    await waitFor(() => {
      expect(
        screen.getByText(/no git remote configured/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/disabled/i)).toBeInTheDocument();
    // The instructions <details> should also render.
    expect(screen.getByText("WIKI_GIT_REMOTE")).toBeInTheDocument();
    // Force sync button MUST NOT exist in the disabled branch.
    expect(
      screen.queryByRole("button", { name: /force sync/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the enabled-state UI with commits and pushes counts", async () => {
    mockedStatus.mockResolvedValue(ENABLED_STATUS);

    render(<PersistencePanel />);

    // "· synced" is the enabled-state header decoration.
    await waitFor(() => {
      expect(screen.getByText(/synced/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/commits made/i)).toBeInTheDocument();
    expect(screen.getByText(/pushes made/i)).toBeInTheDocument();
    // The actual counts render as their own text nodes inside a Cell.
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    // Force sync button is visible in enabled state.
    expect(
      screen.getByRole("button", { name: /force sync/i }),
    ).toBeInTheDocument();
  });

  it("calls ownerPersistenceFlush when 'force sync now' is clicked", async () => {
    mockedStatus.mockResolvedValue(ENABLED_STATUS);
    mockedFlush.mockResolvedValue({
      committed: true,
      pushed: true,
      messages: ["pushed 1 commit"],
      commit_summary: "wip: capture from frontend",
    });
    const user = userEvent.setup();

    render(<PersistencePanel />);
    const btn = await screen.findByRole("button", { name: /force sync/i });
    await user.click(btn);

    await waitFor(() => {
      expect(mockedFlush).toHaveBeenCalledTimes(1);
    });
    // After a successful flush, the component shows the result banner.
    await waitFor(() => {
      expect(screen.getByText(/force sync pushed/i)).toBeInTheDocument();
    });
  });

  it("shows an error message when ownerPersistenceStatus rejects", async () => {
    mockedStatus.mockRejectedValue(new Error("network is down"));

    render(<PersistencePanel />);

    await waitFor(() => {
      expect(screen.getByText(/network is down/i)).toBeInTheDocument();
    });
    // Loading text should be replaced by the error message.
    expect(screen.queryByText(/loading…/i)).not.toBeInTheDocument();
  });
});
