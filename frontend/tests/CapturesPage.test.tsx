/**
 * CapturesPage tests. /owner/captures is the audit surface for everything
 * dropped into the wiki via paste, voice, vision, or import. The shape of
 * this page (filter bar + row list + side preview) is easy to break with
 * styling refactors, so we lock the four branches that matter:
 *   - loading
 *   - empty state CTA
 *   - row list rendering
 *   - filter narrowing
 *   - row click → side-panel preview
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  ownerListRaw: vi.fn(),
  ownerReadRaw: vi.fn(),
  ownerDeleteRaw: vi.fn(),
  ownerReingestRaw: vi.fn(),
}));

import { ownerListRaw, ownerReadRaw } from "@/lib/api";
import CapturesPage from "@/app/owner/captures/page";

const mockedList = vi.mocked(ownerListRaw);
const mockedRead = vi.mocked(ownerReadRaw);

const SAMPLE_ROWS = [
  {
    rel_path: "raw/conversations/2024-01-01-paste.md",
    kind: "conversations",
    size: 2048,
    mtime: 1_700_000_000,
    excerpt: "First paste excerpt",
  },
  {
    rel_path: "raw/imports/2024-01-02-resume.md",
    kind: "imports",
    size: 4096,
    mtime: 1_700_000_100,
    excerpt: "Imported resume",
  },
  {
    rel_path: "raw/voice/2024-01-03-meeting.md",
    kind: "voice",
    size: 6144,
    mtime: 1_700_000_200,
    excerpt: "Voice note",
  },
];

describe("CapturesPage", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRead.mockReset();
    window.localStorage.setItem("llmwiki:ownerToken", "fake-test-token");
  });

  it("shows the loading state while the API is pending", async () => {
    // A never-resolving promise keeps the component in its loading branch
    // long enough for the assertion to land.
    mockedList.mockReturnValue(new Promise(() => {}));

    render(<CapturesPage />);

    await waitFor(() => {
      expect(screen.getByText(/^loading…$/)).toBeInTheDocument();
    });
  });

  it("renders an empty-state CTA when there are no captures", async () => {
    mockedList.mockResolvedValue([]);

    render(<CapturesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/no captures yet\. go to \/capture/i),
      ).toBeInTheDocument();
    });
  });

  it("renders one row per capture when the API returns three entries", async () => {
    mockedList.mockResolvedValue(SAMPLE_ROWS);

    render(<CapturesPage />);

    await waitFor(() => {
      expect(screen.getByText("2024-01-01-paste")).toBeInTheDocument();
    });
    expect(screen.getByText("2024-01-02-resume")).toBeInTheDocument();
    expect(screen.getByText("2024-01-03-meeting")).toBeInTheDocument();
    // Each row also shows its excerpt.
    expect(screen.getByText(/first paste excerpt/i)).toBeInTheDocument();
    expect(screen.getByText(/imported resume/i)).toBeInTheDocument();
    expect(screen.getByText(/voice note/i)).toBeInTheDocument();
  });

  it("filter buttons narrow which rows render", async () => {
    mockedList.mockResolvedValue(SAMPLE_ROWS);
    const user = userEvent.setup();

    render(<CapturesPage />);

    await waitFor(() => {
      expect(screen.getByText("2024-01-01-paste")).toBeInTheDocument();
    });

    // Click the "voice" filter button — it's the only filter button with
    // "voice" in its accessible name (kind tags are spans, not buttons).
    await user.click(screen.getByRole("button", { name: /voice/i }));

    expect(screen.getByText("2024-01-03-meeting")).toBeInTheDocument();
    expect(screen.queryByText("2024-01-01-paste")).not.toBeInTheDocument();
    expect(screen.queryByText("2024-01-02-resume")).not.toBeInTheDocument();
  });

  it("clicking a capture row loads its content and shows the side panel", async () => {
    mockedList.mockResolvedValue(SAMPLE_ROWS);
    mockedRead.mockResolvedValue("hello capture contents");
    const user = userEvent.setup();

    render(<CapturesPage />);

    const rowFilename = await screen.findByText("2024-01-01-paste");
    // Clicks on the inner text bubble up to the row's onClick handler.
    await user.click(rowFilename);

    await waitFor(() => {
      expect(mockedRead).toHaveBeenCalledWith(
        "raw/conversations/2024-01-01-paste.md",
      );
    });
    await waitFor(() => {
      expect(screen.getByText("hello capture contents")).toBeInTheDocument();
    });
    // Side panel header shows the rel_path of the opened file.
    expect(
      screen.getByText("raw/conversations/2024-01-01-paste.md"),
    ).toBeInTheDocument();
  });
});
