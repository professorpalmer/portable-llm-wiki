/**
 * Tests for SwitchRepoModal — the type-to-confirm gate for relocating
 * a tenant's wiki backing repo. Mirrors the ForceResetModal test layout
 * since the two modals share the same friction-layer pattern.
 *
 * Behaviors locked here:
 *   1. Modal is invisible when ``open=false`` (no DOM, no API calls).
 *   2. Current binding renders in the header so the user sees what
 *      they're about to replace.
 *   3. The confirm button stays disabled until BOTH:
 *      * the repo input parses as ``owner/name`` form, AND
 *      * the user types the ``switch`` confirm phrase.
 *      Either gate alone keeps the button disabled.
 *   4. A valid switch calls ``onboardingConnectRepo`` with the trimmed
 *      repo and ``create_new: false``, then fires ``onSwitched`` with
 *      the response and fresh status.
 *   5. A failing API call surfaces the error inline and leaves the
 *      modal open so the user can retry without re-typing everything.
 *   6. The cancel button calls ``onClose`` and does NOT fire the API.
 *   7. Re-opening the modal resets all internal state (repo input,
 *      confirm text, error) — no leak from a previous open.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    onboardingConnectRepo: vi.fn(),
  };
});

import { onboardingConnectRepo } from "@/lib/api";
import { SwitchRepoModal } from "@/components/SwitchRepoModal";

const mockConnect = onboardingConnectRepo as unknown as ReturnType<
  typeof vi.fn
>;

const successResponse = {
  ok: true,
  connected: true,
  repo: "alice/cary-wiki",
  branch: "main",
  html_url: "https://github.com/alice/cary-wiki",
  bootstrap: { ok: true, action: "synced" as const },
  status: {
    connected: true,
    repo: "alice/cary-wiki",
    branch: "main",
    html_url: "https://github.com/alice/cary-wiki",
    last_synced_at: 1700000000,
    last_error: "",
    pushes_made: 0,
  },
};

describe("SwitchRepoModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <SwitchRepoModal
        open={false}
        onClose={vi.fn()}
        currentRepo="alice/old-stuck-repo"
        onSwitched={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("renders the current binding so the user sees what gets replaced", () => {
    render(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo="alice/portable-llm-wiki"
        onSwitched={vi.fn()}
      />,
    );
    expect(
      screen.getByText("alice/portable-llm-wiki"),
    ).toBeInTheDocument();
  });

  it("keeps confirm button disabled until BOTH repo + phrase are valid", () => {
    render(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo="alice/old"
        onSwitched={vi.fn()}
      />,
    );

    const confirmBtn = screen.getByTestId(
      "switch-repo-confirm-button",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Only repo filled in → still disabled.
    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "alice/cary-wiki" },
    });
    expect(confirmBtn.disabled).toBe(true);

    // Only phrase typed (repo cleared) → still disabled.
    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("switch-repo-confirm-input"), {
      target: { value: "switch" },
    });
    expect(confirmBtn.disabled).toBe(true);

    // Both valid → enabled.
    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "alice/cary-wiki" },
    });
    expect(confirmBtn.disabled).toBe(false);
  });

  it("rejects bad repo formats (no slash, multiple slashes)", () => {
    render(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo=""
        onSwitched={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByTestId(
      "switch-repo-confirm-button",
    ) as HTMLButtonElement;

    fireEvent.change(screen.getByTestId("switch-repo-confirm-input"), {
      target: { value: "switch" },
    });

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "just-a-name" },
    });
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "owner/name/extra" },
    });
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "owner/" },
    });
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "owner/valid-name" },
    });
    expect(confirmBtn.disabled).toBe(false);
  });

  it("calls onboardingConnectRepo + onSwitched on a successful switch", async () => {
    mockConnect.mockResolvedValueOnce(successResponse);
    const onSwitched = vi.fn();
    const onClose = vi.fn();

    render(
      <SwitchRepoModal
        open={true}
        onClose={onClose}
        currentRepo="alice/old"
        onSwitched={onSwitched}
      />,
    );

    // Whitespace around the input value should be trimmed before sending.
    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "  alice/cary-wiki  " },
    });
    fireEvent.change(screen.getByTestId("switch-repo-confirm-input"), {
      target: { value: "switch" },
    });
    fireEvent.click(screen.getByTestId("switch-repo-confirm-button"));

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
    expect(mockConnect).toHaveBeenCalledWith({
      create_new: false,
      repo: "alice/cary-wiki",
    });

    await waitFor(() => {
      expect(onSwitched).toHaveBeenCalledTimes(1);
    });
    expect(onSwitched).toHaveBeenCalledWith(
      successResponse,
      successResponse.status,
    );
    // Parent owns the close behavior — modal does not auto-close.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces API errors inline and stays open", async () => {
    mockConnect.mockRejectedValueOnce(
      new Error("Repo 'alice/missing' not found or not accessible"),
    );
    const onSwitched = vi.fn();

    render(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo="alice/old"
        onSwitched={onSwitched}
      />,
    );

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "alice/missing" },
    });
    fireEvent.change(screen.getByTestId("switch-repo-confirm-input"), {
      target: { value: "switch" },
    });
    fireEvent.click(screen.getByTestId("switch-repo-confirm-button"));

    await waitFor(() => {
      expect(
        screen.getByText(/not found or not accessible/i),
      ).toBeInTheDocument();
    });
    expect(onSwitched).not.toHaveBeenCalled();
    // Modal stays visible (the dialog is still in the DOM) so the user
    // can fix the repo name and retry without re-typing the phrase.
    expect(screen.getByTestId("switch-repo-modal")).toBeInTheDocument();
  });

  it("cancel button calls onClose and does NOT fire the API", () => {
    const onClose = vi.fn();
    render(
      <SwitchRepoModal
        open={true}
        onClose={onClose}
        currentRepo="alice/old"
        onSwitched={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("re-opening the modal resets repo, confirm, and error state", async () => {
    mockConnect.mockRejectedValueOnce(new Error("boom"));
    const onSwitched = vi.fn();

    const { rerender } = render(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo="alice/old"
        onSwitched={onSwitched}
      />,
    );

    fireEvent.change(screen.getByTestId("switch-repo-input"), {
      target: { value: "alice/cary-wiki" },
    });
    fireEvent.change(screen.getByTestId("switch-repo-confirm-input"), {
      target: { value: "switch" },
    });
    fireEvent.click(screen.getByTestId("switch-repo-confirm-button"));
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeInTheDocument();
    });

    rerender(
      <SwitchRepoModal
        open={false}
        onClose={vi.fn()}
        currentRepo="alice/old"
        onSwitched={onSwitched}
      />,
    );
    rerender(
      <SwitchRepoModal
        open={true}
        onClose={vi.fn()}
        currentRepo="alice/old"
        onSwitched={onSwitched}
      />,
    );

    expect(
      (screen.getByTestId("switch-repo-input") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (
        screen.getByTestId(
          "switch-repo-confirm-input",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
    expect(
      (
        screen.getByTestId(
          "switch-repo-confirm-button",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
