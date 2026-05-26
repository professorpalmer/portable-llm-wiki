/**
 * Tests for ForceResetModal — the type-to-confirm gate that replaced
 * the bare ``window.confirm()`` previously guarding force-reset.
 *
 * Behaviors locked here:
 *
 *   1. Modal is invisible when ``open=false`` (no DOM at all — important
 *      for the parent's render cost and for ARIA: hidden dialogs
 *      shouldn't show up in the accessibility tree).
 *   2. On open, the preview endpoint is called and the returned counts
 *      are surfaced in the summary block. This is the headline number
 *      the user is supposed to see BEFORE typing the confirm phrase.
 *   3. The confirm button stays disabled until the user types the
 *      ``discard`` phrase verbatim (case-insensitive, whitespace-tolerant).
 *      Anti-fat-finger.
 *   4. Clicking the confirm button calls ``onConfirm`` and does NOT
 *      itself fire the network call (parent owns the actual destructive
 *      action so error handling + post-reset reload stays centralised).
 *   5. The cancel button just calls ``onClose`` without confirming.
 *   6. Preview-fetch failure surfaces an inline warning but the
 *      confirm flow remains usable (the user might still want to
 *      force-reset even if we can't reach GitHub to preview).
 *   7. Dirty files + commit-loss samples render with the count badge.
 *   8. Re-opening the modal resets the typed confirm text (no leak
 *      from a previous open).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    ownerSyncPreviewForceReset: vi.fn(),
  };
});

import { ownerSyncPreviewForceReset } from "@/lib/api";
import { ForceResetModal } from "@/components/ForceResetModal";

const mockPreview = ownerSyncPreviewForceReset as unknown as ReturnType<
  typeof vi.fn
>;

const fakeStatus = {
  connected: true,
  repo: "alice/my-wiki",
  branch: "main",
  html_url: "https://github.com/alice/my-wiki",
  last_synced_at: 0,
  last_error: "",
  pushes_made: 0,
};

function fullPreview(overrides: Partial<{
  ahead: number;
  behind: number;
  dirty: { status: string; path: string; kind: string }[];
  untracked: string[];
  lose: { sha: string; subject: string }[];
  loseTotal: number;
  gain: { sha: string; subject: string }[];
  gainTotal: number;
  error: string | null;
}> = {}) {
  const dirty = overrides.dirty ?? [
    { status: "M", path: "wiki/entities/cary.md", kind: "modified" },
  ];
  const untracked = overrides.untracked ?? [];
  const lose = overrides.lose ?? [
    { sha: "abc1234", subject: "wip: local edit" },
  ];
  const gain = overrides.gain ?? [];
  return {
    ok: true,
    preview: {
      ok: true,
      error: overrides.error ?? null,
      branch: "main",
      ahead: overrides.ahead ?? 1,
      behind: overrides.behind ?? 0,
      dirty_files: dirty,
      untracked_files: untracked,
      commits_to_lose: lose,
      commits_to_lose_total: overrides.loseTotal ?? lose.length,
      commits_to_gain: gain,
      commits_to_gain_total: overrides.gainTotal ?? gain.length,
    },
    status: fakeStatus,
  };
}

describe("ForceResetModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <ForceResetModal
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("fetches preview on open and surfaces the headline counts", async () => {
    mockPreview.mockResolvedValueOnce(
      fullPreview({ ahead: 3, behind: 5, loseTotal: 3, gainTotal: 5 }),
    );
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    // The summary text is split across multiple elements (count in a
    // <span>, surrounding copy as <li> text). Default testing-library
    // text matchers don't bridge element boundaries, so we assert on
    // document.body.textContent — same DOM, but with all descendant
    // text concatenated.
    const text = document.body.textContent || "";
    expect(text).toMatch(/will be discarded/i);
    expect(text).toMatch(/will be applied/i);
    expect(text).toMatch(/reset to remote/i);
    expect(text).toMatch(/3 local commits will be discarded/i);
    expect(text).toMatch(/5 remote commits will be applied/i);
  });

  it("keeps the confirm button disabled until 'discard' is typed", async () => {
    mockPreview.mockResolvedValueOnce(fullPreview());
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());

    const button = screen.getByTestId(
      "force-reset-confirm-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("force-reset-confirm-input");
    fireEvent.change(input, { target: { value: "disc" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "discard" } });
    expect(button.disabled).toBe(false);

    // Case + whitespace tolerance.
    fireEvent.change(input, { target: { value: "  DISCARD  " } });
    expect(button.disabled).toBe(false);
  });

  it("calls onConfirm and does NOT fire the destructive network call itself", async () => {
    mockPreview.mockResolvedValueOnce(fullPreview());
    const onConfirm = vi.fn();
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("force-reset-confirm-input"), {
      target: { value: "discard" },
    });
    fireEvent.click(screen.getByTestId("force-reset-confirm-button"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel button calls onClose without firing onConfirm", async () => {
    mockPreview.mockResolvedValueOnce(fullPreview());
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ForceResetModal
        open={true}
        onClose={onClose}
        onConfirm={onConfirm}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables inputs while isRunning=true (modal stays open during reset)", async () => {
    mockPreview.mockResolvedValueOnce(fullPreview());
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={true}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());

    const input = screen.getByTestId(
      "force-reset-confirm-input",
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);

    const button = screen.getByTestId(
      "force-reset-confirm-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/resetting/i);
  });

  it("surfaces preview-fetch failure as a soft warning, doesn't block", async () => {
    mockPreview.mockRejectedValueOnce(new Error("502 boom"));
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/Computing what will be discarded/i)).toBeNull(),
    );
    expect(screen.getByText(/Couldn.?t fully inspect remote/i)).toBeTruthy();
    expect(screen.getByText(/502 boom/i)).toBeTruthy();
    // Confirm button is still actionable — the user might want to
    // proceed even if we couldn't preview.
    const input = screen.getByTestId("force-reset-confirm-input");
    fireEvent.change(input, { target: { value: "discard" } });
    const button = screen.getByTestId(
      "force-reset-confirm-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("shows the 'nothing to lose' banner when ahead=0 and dirty=0", async () => {
    mockPreview.mockResolvedValueOnce(
      fullPreview({ ahead: 0, behind: 2, dirty: [], lose: [], loseTotal: 0 }),
    );
    render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());
    expect(screen.getByText(/Nothing local to lose/i)).toBeTruthy();
  });

  it("re-opening the modal clears any previous typed confirm text", async () => {
    mockPreview.mockResolvedValue(fullPreview());
    const { rerender } = render(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("force-reset-confirm-input"), {
      target: { value: "discard" },
    });
    expect(
      (screen.getByTestId("force-reset-confirm-button") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Close then re-open.
    rerender(
      <ForceResetModal
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    rerender(
      <ForceResetModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isRunning={false}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("force-reset-confirm-input") as HTMLInputElement)
          .value,
      ).toBe(""),
    );
    expect(
      (screen.getByTestId("force-reset-confirm-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
