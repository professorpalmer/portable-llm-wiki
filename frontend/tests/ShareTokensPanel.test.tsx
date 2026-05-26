/**
 * ShareTokensPanel tests.
 *
 * Locks the contract that private-tier tokens DO NOT appear in this
 * panel's list — they're owned by PersonalLlmUrlPanel which has its
 * own master-key warnings. Without this filter both panels would
 * double-list the same rows AND the private tokens would lose their
 * distinct danger-level visual treatment when interspersed with
 * recruiter/friend tokens.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    ownerListShareTokens: vi.fn(),
    ownerMintShareToken: vi.fn(),
    ownerRevokeShareToken: vi.fn(),
  };
});

import {
  ownerListShareTokens,
  type ShareTokenInfo,
} from "@/lib/api";
import { ShareTokensPanel } from "@/components/ShareTokensPanel";


const NOW = new Date().toISOString();
const TOKENS: ShareTokenInfo[] = [
  {
    id: "rec1",
    label: "Recruiter at Acme",
    tier: "recruiter",
    created_at: NOW,
    expires_at: null,
    hits: 3,
    last_used_at: NOW,
    revoked: false,
    revoked_at: null,
  },
  {
    id: "fri1",
    label: "Bestie",
    tier: "friend",
    created_at: NOW,
    expires_at: null,
    hits: 1,
    last_used_at: NOW,
    revoked: false,
    revoked_at: null,
  },
  {
    id: "priv1",
    // Should NOT appear here — it belongs in PersonalLlmUrlPanel.
    label: "ChatGPT desktop",
    tier: "private",
    created_at: NOW,
    expires_at: null,
    hits: 12,
    last_used_at: NOW,
    revoked: false,
    revoked_at: null,
  },
];

beforeEach(() => {
  vi.mocked(ownerListShareTokens).mockReset();
  vi.mocked(ownerListShareTokens).mockResolvedValue({ tokens: TOKENS });
});


describe("ShareTokensPanel", () => {
  it("lists recruiter + friend tokens but filters out private", async () => {
    render(
      <ShareTokensPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Recruiter at Acme")).toBeInTheDocument();
    });
    expect(screen.getByText("Bestie")).toBeInTheDocument();
    // The crucial assertion — private-tier rows MUST NOT appear here.
    expect(screen.queryByText("ChatGPT desktop")).toBeNull();
  });

  it("the mint dropdown does NOT offer 'private' as an option", async () => {
    render(
      <ShareTokensPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Recruiter at Acme")).toBeInTheDocument();
    });
    // The tier <select> only carries the share-with-others tiers. The
    // private-tier mint flow lives in PersonalLlmUrlPanel and has its
    // own distinct UI; offering 'private' here would let users
    // accidentally mint master keys from the wrong surface.
    const options = screen
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    expect(options).toEqual(["public", "recruiter", "friend"]);
  });
});
