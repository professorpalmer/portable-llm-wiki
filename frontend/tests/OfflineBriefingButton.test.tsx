/**
 * Tests for OfflineBriefingButton — the no-fetch-required share artifact
 * on the PUBLIC /share page.
 *
 * Why this exists: the three URL-based prompt buttons all depend on the
 * recipient's LLM actually fetching the URL. ChatGPT "search" mode (and
 * some Gemini/Perplexity configs) don't fetch — they web-search the URL
 * string, find nothing for a freshly-deployed wiki, and fabricate. This
 * button is the bulletproof escape hatch: it inlines real page content
 * so even a zero-fetch model answers correctly.
 *
 * The behaviors locked here are the ones that would silently break that
 * promise:
 *   1. Disabled until ready (no token/URL yet) — never produces a blob
 *      built from an empty token that would 401/leak.
 *   2. On click, calls buildOfflineBriefing with the live token + tenant
 *      (tier-correctness) and writes the result to the clipboard.
 *   3. Complete vs partial blob drives the success vs warning label.
 *   4. A build/clipboard failure degrades to an error label, never an
 *      unhandled rejection.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the briefing lib so these tests assert WIRING (props in, clipboard
// out, state transitions) — the assembly logic itself is covered
// exhaustively in briefing.test.ts.
vi.mock("@/lib/briefing", () => ({
  buildOfflineBriefing: vi.fn(),
  isBriefingComplete: vi.fn(),
}));

import { buildOfflineBriefing, isBriefingComplete } from "@/lib/briefing";
import { OfflineBriefingButton } from "@/app/share/page";


const writeText = vi.fn();

beforeEach(() => {
  vi.mocked(buildOfflineBriefing).mockReset();
  vi.mocked(isBriefingComplete).mockReset();
  writeText.mockReset();
  Object.assign(navigator, { clipboard: { writeText } });
});


describe("OfflineBriefingButton", () => {
  it("is disabled until ready (no usable URL/token yet)", () => {
    render(
      <OfflineBriefingButton llmUrl="" token="" tenant="cary" ready={false} />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("builds the briefing with the live token + tenant and copies it", async () => {
    vi.mocked(buildOfflineBriefing).mockResolvedValue("THE BLOB");
    vi.mocked(isBriefingComplete).mockReturnValue(true);

    render(
      <OfflineBriefingButton
        llmUrl="https://portablellm.wiki/cary/llm?t=tok123"
        token="tok123"
        tenant="cary"
        ready={true}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(buildOfflineBriefing).toHaveBeenCalledWith({
        llmUrl: "https://portablellm.wiki/cary/llm?t=tok123",
        token: "tok123",
        tenant: "cary",
      });
    });
    // The assembled blob goes to the clipboard verbatim.
    expect(writeText).toHaveBeenCalledWith("THE BLOB");
    // Success state surfaces.
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent(/briefing copied/i),
    );
  });

  it("shows the PARTIAL warning when the blob is incomplete", async () => {
    vi.mocked(buildOfflineBriefing).mockResolvedValue("PARTIAL BLOB");
    vi.mocked(isBriefingComplete).mockReturnValue(false);

    render(
      <OfflineBriefingButton
        llmUrl="https://portablellm.wiki/cary/llm"
        token=""
        tenant="cary"
        ready={true}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    // Even a partial blob is copied (better than nothing — the URL is in it).
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("PARTIAL BLOB"));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent(/partial briefing/i),
    );
  });

  it("degrades to an error label when the build throws (no unhandled rejection)", async () => {
    vi.mocked(buildOfflineBriefing).mockRejectedValue(new Error("network down"));

    render(
      <OfflineBriefingButton
        llmUrl="https://portablellm.wiki/cary/llm?t=tok123"
        token="tok123"
        tenant="cary"
        ready={true}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent(/briefing failed/i),
    );
    // Nothing was copied on failure.
    expect(writeText).not.toHaveBeenCalled();
  });

  it("works at the PUBLIC tier with an empty token (public-scoped blob)", async () => {
    // The whole point of surfacing this on the public /share page: a
    // recipient with no token still gets a usable, public-scoped blob.
    vi.mocked(buildOfflineBriefing).mockResolvedValue("PUBLIC BLOB");
    vi.mocked(isBriefingComplete).mockReturnValue(true);

    render(
      <OfflineBriefingButton
        llmUrl="https://portablellm.wiki/cary/llm"
        token=""
        tenant="cary"
        ready={true}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(buildOfflineBriefing).toHaveBeenCalledWith({
        llmUrl: "https://portablellm.wiki/cary/llm",
        token: "",
        tenant: "cary",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("PUBLIC BLOB");
  });
});
