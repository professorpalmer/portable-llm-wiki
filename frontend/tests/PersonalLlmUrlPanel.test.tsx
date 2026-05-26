/**
 * Tests for PersonalLlmUrlPanel — the "portability across every LLM"
 * surface where the owner mints private-tier tokens to paste into
 * ChatGPT / Claude / Cursor / etc.
 *
 * The behaviors locked here cover the failure modes that would
 * silently break the entire portability story:
 *   1. Mint requires a label (we nudge users toward per-device labels
 *      so revocation can be device-specific).
 *   2. Mint POSTs with tier="private" — NOT recruiter or friend. A
 *      regression here would mean "personal URL" buttons actually
 *      issue lower-privilege tokens and ChatGPT would silently miss
 *      private content.
 *   3. The minted URL contains "/llm?t=<token>" so any LLM that
 *      fetches it hits the markdown handshake AND elevates to
 *      private tier via the ?t= query param.
 *   4. The list of "Active personal URLs" filters to private-tier
 *      only — public/recruiter/friend tokens belong to the OTHER
 *      panel and would dilute the danger-level signal if mixed in.
 *   5. Revoke confirms with the user (private tokens are the master
 *      key; an accidental click should not detonate the LLM tools
 *      they're pasted into).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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
  ownerMintShareToken,
  ownerRevokeShareToken,
  type ShareTokenInfo,
} from "@/lib/api";
import { PersonalLlmUrlPanel } from "@/components/PersonalLlmUrlPanel";


const SAMPLE_TOKENS: ShareTokenInfo[] = [
  {
    id: "abc123",
    label: "ChatGPT desktop",
    tier: "private",
    created_at: new Date().toISOString(),
    expires_at: null,
    hits: 7,
    last_used_at: new Date().toISOString(),
    revoked: false,
    revoked_at: null,
  },
  {
    // Should NOT appear in this panel — different tier.
    id: "def456",
    label: "Recruiter at Acme",
    tier: "recruiter",
    created_at: new Date().toISOString(),
    expires_at: null,
    hits: 0,
    last_used_at: null,
    revoked: false,
    revoked_at: null,
  },
];

beforeEach(() => {
  vi.mocked(ownerListShareTokens).mockReset();
  vi.mocked(ownerMintShareToken).mockReset();
  vi.mocked(ownerRevokeShareToken).mockReset();
  vi.mocked(ownerListShareTokens).mockResolvedValue({ tokens: SAMPLE_TOKENS });
});


describe("PersonalLlmUrlPanel", () => {
  it("shows the danger-level header copy on mount", async () => {
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    // The exact warning copy is part of the contract — if a future
    // refactor accidentally softens it, this test catches it.
    expect(
      screen.getByText(/private tier · master key/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/full wiki including private pages/i),
    ).toBeInTheDocument();
  });

  it("requires a label before minting", async () => {
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    // Wait for the initial mount-time refresh to finish before clicking.
    // Otherwise the refresh's async setTokens() update can interleave
    // with the click in jsdom and we end up asserting on a transient
    // intermediate render.
    await waitFor(() => {
      expect(ownerListShareTokens).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: /mint personal url/i }));
    expect(await screen.findByText(/label is required/i)).toBeInTheDocument();
    expect(ownerMintShareToken).not.toHaveBeenCalled();
  });

  it("mints with tier='private' and builds an /llm?t=… URL", async () => {
    vi.mocked(ownerMintShareToken).mockResolvedValueOnce({
      id: "newlymintedId",
      label: "Cursor MBP",
      tier: "private",
      created_at: new Date().toISOString(),
      expires_at: null,
      hits: 0,
      last_used_at: null,
      revoked: false,
      revoked_at: null,
      token: "PLAINTEXT_TOKEN_VALUE",
    });
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    fireEvent.change(
      screen.getByLabelText(/personal llm url label/i),
      { target: { value: "Cursor MBP" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /mint personal url/i }));

    await waitFor(() => {
      // The KEY assertion: tier MUST be "private" (the whole feature).
      expect(ownerMintShareToken).toHaveBeenCalledWith(
        { label: "Cursor MBP", tier: "private" },
        "cary",
      );
    });

    // The minted URL surfaces in a readonly <input>; check it points
    // at the LLM handshake endpoint with the token in the ?t= query.
    const minted = (await screen.findByLabelText(
      /newly minted personal llm url/i,
    )) as HTMLInputElement;
    expect(minted.value).toBe(
      "https://portablellm.wiki/cary/llm?t=PLAINTEXT_TOKEN_VALUE",
    );
  });

  it("URL-encodes special characters in tokens", async () => {
    // A future change to share_tokens.py might switch the encoding
    // alphabet; verifying we encodeURIComponent guards against any
    // token-shape change breaking the URL.
    vi.mocked(ownerMintShareToken).mockResolvedValueOnce({
      id: "id",
      label: "x",
      tier: "private",
      created_at: new Date().toISOString(),
      expires_at: null,
      hits: 0,
      last_used_at: null,
      revoked: false,
      revoked_at: null,
      token: "a+b/c=d",
    });
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    fireEvent.change(
      screen.getByLabelText(/personal llm url label/i),
      { target: { value: "x" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /mint personal url/i }));
    const minted = (await screen.findByLabelText(
      /newly minted personal llm url/i,
    )) as HTMLInputElement;
    expect(minted.value).toBe(
      "https://portablellm.wiki/cary/llm?t=a%2Bb%2Fc%3Dd",
    );
  });

  it("lists ONLY private-tier tokens (recruiter tokens stay in the other panel)", async () => {
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("ChatGPT desktop")).toBeInTheDocument();
    });
    // The recruiter token (different tier) is filtered out here so
    // the danger-level signal stays loud.
    expect(screen.queryByText("Recruiter at Acme")).toBeNull();
  });

  it("revoke calls confirm() and the API on accept", async () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);
    vi.mocked(ownerRevokeShareToken).mockResolvedValue({
      ok: true,
      id: "abc123",
    });
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("ChatGPT desktop")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(ownerRevokeShareToken).toHaveBeenCalledWith("abc123", "cary");
    });
    confirmSpy.mockRestore();
  });

  it("revoke is a no-op when the user cancels the confirm dialog", async () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("ChatGPT desktop")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    expect(ownerRevokeShareToken).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("renders 'no personal URLs yet' when the filtered list is empty", async () => {
    vi.mocked(ownerListShareTokens).mockResolvedValueOnce({
      tokens: [SAMPLE_TOKENS[1]!], // recruiter only — no private rows
    });
    render(
      <PersonalLlmUrlPanel
        publicBaseUrl="https://portablellm.wiki"
        tenant="cary"
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/no personal URLs minted yet/i),
      ).toBeInTheDocument();
    });
  });
});
