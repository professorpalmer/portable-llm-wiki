import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    authMe: vi.fn(),
    ownerSetTenantVisibility: vi.fn(),
  };
});

import { authMe, ownerSetTenantVisibility } from "@/lib/api";
import { WikiVisibilityPanel } from "@/app/owner/page";

describe("WikiVisibilityPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMe).mockResolvedValue({
      authenticated: true,
      user: {
        tenant_id: "alice",
        login: "alice",
        name: "Alice",
        avatar_url: null,
      },
      tenant: {
        id: "alice",
        github_login: "alice",
        display_name: "Alice",
        avatar_url: null,
        created_at: "",
        is_public: false,
        visibility: "unlisted",
      },
      fresh_signup: false,
    });
    vi.mocked(ownerSetTenantVisibility).mockResolvedValue({
      ok: true,
      id: "alice",
      visibility: "public",
    });
  });

  it("loads current visibility and posts a change", async () => {
    render(<WikiVisibilityPanel tenantId="alice" />);
    const unlisted = await screen.findByDisplayValue("unlisted");
    expect(unlisted).toBeChecked();

    fireEvent.click(screen.getByDisplayValue("public"));
    await waitFor(() => {
      expect(ownerSetTenantVisibility).toHaveBeenCalledWith("public", "alice");
    });
  });
});
