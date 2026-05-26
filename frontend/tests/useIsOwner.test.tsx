/**
 * useIsOwnerOf tests. This hook is the single source of truth for whether
 * the current viewer can mutate a given tenant. Three branches matter:
 *   - OSS mode + bearer token in localStorage → isOwner=true synchronously
 *   - Hosted mode + matching session tenant_id → isOwner=true after authMe resolves
 *   - Hosted mode + mismatched/anonymous session → isOwner=false
 *
 * Regression context: the /capture, /owner/import, and /page/[slug] pages
 * previously only checked localStorage, which always reads as empty in
 * hosted mode (GitHub OAuth uses a session cookie). That bounced session
 * owners into the demo preview / "paste owner token" prompts even though
 * the backend accepted their cookie. This hook prevents that drift.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  isHostedMode: vi.fn(),
  getOwnerToken: vi.fn(),
  authMe: vi.fn(),
}));

import { isHostedMode, getOwnerToken, authMe } from "@/lib/api";
import { useIsOwnerOf } from "@/lib/useIsOwner";

const mockedHosted = vi.mocked(isHostedMode);
const mockedToken = vi.mocked(getOwnerToken);
const mockedAuthMe = vi.mocked(authMe);

function Probe({ tenant }: { tenant: string | undefined }) {
  const a = useIsOwnerOf(tenant);
  return (
    <div data-testid="probe">
      {a.ready ? (a.isOwner ? "owner" : "viewer") : "loading"}
    </div>
  );
}

describe("useIsOwnerOf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OSS mode: returns isOwner=true synchronously when bearer token exists", () => {
    mockedHosted.mockReturnValue(false);
    mockedToken.mockReturnValue("some-bearer");
    render(<Probe tenant={undefined} />);
    // No async work in OSS mode — first render must already be "owner".
    expect(screen.getByTestId("probe").textContent).toBe("owner");
    expect(mockedAuthMe).not.toHaveBeenCalled();
  });

  it("OSS mode: returns isOwner=false when no bearer token", () => {
    mockedHosted.mockReturnValue(false);
    mockedToken.mockReturnValue(null);
    render(<Probe tenant={undefined} />);
    expect(screen.getByTestId("probe").textContent).toBe("viewer");
    expect(mockedAuthMe).not.toHaveBeenCalled();
  });

  it("hosted mode: isOwner=true when session tenant matches", async () => {
    mockedHosted.mockReturnValue(true);
    mockedAuthMe.mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "alice",
        login: "alice",
        name: "Alice",
        avatar_url: "",
      },
      tenant: null,
      fresh_signup: false,
    });
    render(<Probe tenant="alice" />);
    // First render shows loading while authMe is pending.
    expect(screen.getByTestId("probe").textContent).toBe("loading");
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("owner"),
    );
    expect(mockedAuthMe).toHaveBeenCalledTimes(1);
  });

  it("hosted mode: isOwner=false when session tenant doesn't match URL tenant", async () => {
    mockedHosted.mockReturnValue(true);
    mockedAuthMe.mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "someoneelse",
        login: "someoneelse",
        name: "Someone",
        avatar_url: "",
      },
      tenant: null,
      fresh_signup: false,
    });
    render(<Probe tenant="alice" />);
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("viewer"),
    );
  });

  it("hosted mode: isOwner=false when anonymous (no session)", async () => {
    mockedHosted.mockReturnValue(true);
    mockedAuthMe.mockResolvedValue({
      authenticated: false,
      user: null,
      tenant: null,
      fresh_signup: false,
    });
    render(<Probe tenant="alice" />);
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("viewer"),
    );
  });

  it("hosted mode: isOwner=false on authMe failure (fails closed)", async () => {
    mockedHosted.mockReturnValue(true);
    mockedAuthMe.mockRejectedValue(new Error("network down"));
    render(<Probe tenant="alice" />);
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("viewer"),
    );
  });
});
