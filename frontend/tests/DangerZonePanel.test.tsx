/**
 * Tests for DangerZonePanel — the self-service "leave portablellm.wiki"
 * surface in the owner console.
 *
 * The behaviors locked here cover the modes that would either trap a
 * user inside the service or, worse, let them delete by accident:
 *
 *   1. The panel is hidden entirely in OSS / single-tenant mode (there
 *      is no "hosted tenant" to delete).
 *   2. The delete button is disabled until the user has typed their
 *      tenant id verbatim. Anti-fat-finger.
 *   3. A second-stage ``window.confirm`` must accept before any network
 *      call goes out. Two clicks > one regret.
 *   4. Cancelling the confirm dialog cleanly leaves state alone (no
 *      ghost "deleting…" spinner, no api call).
 *   5. On success, the goodbye view names the user's GitHub repo by
 *      its full ``owner/repo`` so they can verify their content
 *      survived the wipe.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    ownerDeleteAccount: vi.fn(),
  };
});

import { ownerDeleteAccount } from "@/lib/api";
import { DangerZonePanel } from "@/components/DangerZonePanel";

describe("DangerZonePanel", () => {
  const originalConfirm = window.confirm;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    // The component calls window.location.assign — replace just that
    // method so the test doesn't actually navigate.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: vi.fn() },
    });
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("renders nothing in OSS / single-tenant mode", () => {
    const { container } = render(
      <DangerZonePanel tenant="alice" hosted={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no tenant is resolved", () => {
    const { container } = render(<DangerZonePanel hosted={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps delete disabled until the user types the tenant id", () => {
    render(<DangerZonePanel tenant="alice" hosted={true} />);
    const button = screen.getByTestId(
      "danger-zone-delete-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("danger-zone-confirm-input");
    fireEvent.change(input, { target: { value: "ali" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "alice" } });
    expect(button.disabled).toBe(false);
  });

  it("cancels cleanly when the user backs out of confirm()", async () => {
    window.confirm = vi.fn().mockReturnValue(false);
    render(<DangerZonePanel tenant="alice" hosted={true} />);
    fireEvent.change(screen.getByTestId("danger-zone-confirm-input"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByTestId("danger-zone-delete-button"));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(ownerDeleteAccount).not.toHaveBeenCalled();
    // Panel stays interactive — no goodbye view, button still ready.
    expect(
      screen.getByTestId("danger-zone-delete-button"),
    ).not.toBeDisabled();
  });

  it("posts the delete and renders a goodbye card naming the GitHub repo", async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    (ownerDeleteAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      tenant_id: "alice",
      github_token_revoked: true,
      tenant_deleted_on_disk: true,
      github_repo: "alice/alice-wiki",
    });

    render(<DangerZonePanel tenant="alice" hosted={true} />);
    fireEvent.change(screen.getByTestId("danger-zone-confirm-input"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByTestId("danger-zone-delete-button"));

    await waitFor(() =>
      expect(ownerDeleteAccount).toHaveBeenCalledTimes(1),
    );

    // Goodbye copy mentions the user's repo so they know exactly
    // where their portable content lives now.
    expect(await screen.findByText(/Goodbye/i)).toBeInTheDocument();
    expect(
      screen.getByText(/alice\/alice-wiki/),
    ).toBeInTheDocument();
  });

  it("surfaces a delete-failed error inline without redirecting", async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    (ownerDeleteAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("backend down"),
    );

    render(<DangerZonePanel tenant="alice" hosted={true} />);
    fireEvent.change(screen.getByTestId("danger-zone-confirm-input"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByTestId("danger-zone-delete-button"));

    expect(await screen.findByText(/backend down/i)).toBeInTheDocument();
    // No navigation kicked off.
    expect(window.location.assign).not.toHaveBeenCalled();
    // Button is re-enabled so the user can retry.
    await waitFor(() =>
      expect(
        screen.getByTestId("danger-zone-delete-button"),
      ).not.toBeDisabled(),
    );
  });
});
