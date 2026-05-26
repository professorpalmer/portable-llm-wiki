/**
 * Tests for the verbatim tab on /capture. This is the trusted-input
 * cousin of the from-LLM tab: paste a markdown file with YAML
 * frontmatter, get it written verbatim to wiki/<section>/<slug>.md
 * with no LLM in the loop and (critically) the tier from frontmatter
 * preserved.
 *
 * We lock down the behaviors that distinguish verbatim from the other
 * capture tabs:
 *   - tab is visible alongside paste / url / from LLM
 *   - live preview shows derived path + tier based on pasted content
 *   - submit blocked until frontmatter parses
 *   - server tier wins (verbatim does NOT clamp to private)
 *   - conflict response renders a clear "saved under suffix" hint
 *   - errors surface inline
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// We render the full CapturePage to verify the tab is wired up. Stub
// out the OSS-mode token check so OwnerGate renders children and
// useIsOwnerOf reports ready+isOwner immediately. The `from-llm`
// machinery hits a few extra api helpers we don't care about here, so
// we stub the whole module surface.
vi.mock("@/lib/api", () => ({
  isHostedMode: vi.fn(() => false), // OSS path: OwnerGate is a no-op
  getOwnerToken: vi.fn(() => "fake-test-token"),
  authMe: vi.fn(() => Promise.resolve({ authenticated: false, user: null, tenant: null })),
  ownerCaptureConfig: vi.fn(() =>
    Promise.resolve({
      image: { available: false, backend: null, model: null },
      audio: { available: false, backend: null, model: null },
    }),
  ),
  ownerCapturePaste: vi.fn(),
  ownerCaptureStructured: vi.fn(),
  ownerCaptureImage: vi.fn(),
  ownerCaptureAudio: vi.fn(),
  onboardingImportUrl: vi.fn(),
  ownerCaptureVerbatim: vi.fn(),
  llmWritebackSpecUrl: vi.fn(() => "https://example.test/llm-writeback-spec"),
}));

import { ownerCaptureVerbatim } from "@/lib/api";
import CapturePage from "@/app/capture/page";

const mockedVerbatim = vi.mocked(ownerCaptureVerbatim);

const VALID_MARKDOWN = `---
type: source
title: 2025 Performance Review
tier: private
tags: [foreflight, performance-review, 2025]
---

# 2025 Performance Review

Body content. Cross-references like [[ForeFlight ML Systems]] survive.
`;

async function switchToVerbatimTab() {
  const user = userEvent.setup();
  const tab = await screen.findByRole("button", { name: "verbatim" });
  await user.click(tab);
  return user;
}

describe("Capture page — verbatim tab", () => {
  beforeEach(() => {
    mockedVerbatim.mockReset();
    window.localStorage.setItem("llmwiki:ownerToken", "fake-test-token");
  });

  it("renders the verbatim tab alongside paste / url / from LLM", async () => {
    render(<CapturePage />);
    // All four hosted-mode tabs are visible. Image + voice are hidden
    // in OSS mock above because cfg.image/audio.available=false has no
    // effect on tab visibility — that's keyed on isHostedMode. We
    // forced isHostedMode=false so all five tabs render (verbatim is
    // present in both hosted + self-host lists).
    expect(await screen.findByRole("button", { name: "paste" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "url" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "verbatim" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "from LLM" })).toBeInTheDocument();
  });

  it("starts on paste tab and switches to verbatim when clicked", async () => {
    render(<CapturePage />);
    // Default tab is paste — verbatim panel content not yet rendered.
    expect(screen.queryByTestId("verbatim-content-input")).not.toBeInTheDocument();

    await switchToVerbatimTab();
    // Now the verbatim textarea is visible.
    expect(screen.getByTestId("verbatim-content-input")).toBeInTheDocument();
  });

  it("disables submit until valid frontmatter is pasted", async () => {
    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    const submit = screen.getByTestId("verbatim-submit");
    expect(submit).toBeDisabled();

    // Pasting body-only text (no frontmatter) shows the amber warning
    // and keeps submit disabled.
    await user.type(
      screen.getByTestId("verbatim-content-input"),
      "Just a plain paragraph, no frontmatter.",
    );
    expect(screen.getByTestId("verbatim-no-preview")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("shows live preview of target path + tier when frontmatter parses", async () => {
    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    const textarea = screen.getByTestId("verbatim-content-input");
    // userEvent.type is O(N) per char; paste is closer to what the
    // user actually does and ~50x faster on this 200-char fixture.
    await user.click(textarea);
    await user.paste(VALID_MARKDOWN);

    const preview = await screen.findByTestId("verbatim-preview");
    expect(preview).toHaveTextContent("wiki/sources/2025-performance-review.md");
    expect(preview).toHaveTextContent("2025 Performance Review");
    expect(preview).toHaveTextContent("type source");
    // Tier badge is on its own data-testid so we can colour-check it.
    expect(screen.getByTestId("verbatim-preview-tier")).toHaveTextContent(
      "private",
    );
    // Submit unblocks the moment preview parses.
    expect(screen.getByTestId("verbatim-submit")).not.toBeDisabled();
  });

  it("highlights public-tier frontmatter with a warning hint", async () => {
    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(
      `---
type: entity
title: Public Tier Entity
tier: public
---

body
`,
    );

    const preview = await screen.findByTestId("verbatim-preview");
    // The "visible to anyone" hint only renders for public tier.
    expect(preview).toHaveTextContent(/visible to anyone/i);
    expect(screen.getByTestId("verbatim-preview-tier")).toHaveTextContent(
      "public",
    );
  });

  it("rewrites the preview path when a slug override is typed", async () => {
    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(VALID_MARKDOWN);

    // Initial preview uses title-derived slug.
    expect(await screen.findByTestId("verbatim-preview")).toHaveTextContent(
      "wiki/sources/2025-performance-review.md",
    );

    await user.type(
      screen.getByTestId("verbatim-slug-input"),
      "perf-review-2025",
    );

    // Preview updates to use the override.
    await waitFor(() => {
      expect(screen.getByTestId("verbatim-preview")).toHaveTextContent(
        "wiki/sources/perf-review-2025.md",
      );
    });
  });

  it("submits markdown verbatim and renders the success card with tier from server", async () => {
    mockedVerbatim.mockResolvedValueOnce({
      ok: true,
      written: {
        rel_path: "wiki/sources/2025-performance-review.md",
        title: "2025 Performance Review",
        section: "sources",
        slug: "2025-performance-review",
        tier: "private",
        page_type: "source",
      },
      conflict: null,
      overwrote_existing: false,
    });

    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(VALID_MARKDOWN);
    await user.click(screen.getByTestId("verbatim-submit"));

    await waitFor(() => {
      expect(mockedVerbatim).toHaveBeenCalledTimes(1);
    });
    const [args] = mockedVerbatim.mock.calls[0];
    expect(args.content).toBe(VALID_MARKDOWN);
    expect(args.slug).toBeUndefined();
    expect(args.force_overwrite).toBe(false);

    const result = await screen.findByTestId("verbatim-result");
    expect(result).toHaveTextContent("Saved");
    expect(result).toHaveTextContent("wiki/sources/2025-performance-review.md");
    // The server-returned tier wins in the result card. Critical: this
    // path does NOT clamp to private, so if the server returned
    // public/recruiter/friend we'd render that here. The fixture above
    // returns private — same value, different code path.
    expect(result).toHaveTextContent(/tier\s+private/i);
  });

  it("forwards public-tier results from the server (no client-side clamp)", async () => {
    // The contract: if the user marks tier: public in frontmatter and
    // the server respects it, the UI reflects that — no silent
    // override. This is the explicit behavior verbatim provides over
    // the from-LLM and paste tabs.
    mockedVerbatim.mockResolvedValueOnce({
      ok: true,
      written: {
        rel_path: "wiki/entities/my-public-page.md",
        title: "My Public Page",
        section: "entities",
        slug: "my-public-page",
        tier: "public",
        page_type: "entity",
      },
      conflict: null,
      overwrote_existing: false,
    });

    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(
      `---
type: entity
title: My Public Page
tier: public
---

body
`,
    );
    await user.click(screen.getByTestId("verbatim-submit"));

    const result = await screen.findByTestId("verbatim-result");
    expect(result).toHaveTextContent(/tier\s+public/i);
  });

  it("renders the conflict notice when the server returned a -verbatim-<date> suffix", async () => {
    mockedVerbatim.mockResolvedValueOnce({
      ok: true,
      written: {
        rel_path: "wiki/concepts/calibrated-honesty-verbatim-2026-05-26.md",
        title: "Calibrated Honesty",
        section: "concepts",
        slug: "calibrated-honesty",
        tier: "private",
        page_type: "concept",
      },
      conflict: { wrote_as: "calibrated-honesty-verbatim-2026-05-26.md" },
      overwrote_existing: false,
    });

    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(
      `---
type: concept
title: Calibrated Honesty
tier: private
---

resubmission
`,
    );
    await user.click(screen.getByTestId("verbatim-submit"));

    const result = await screen.findByTestId("verbatim-result");
    expect(result).toHaveTextContent(/saved \(existing page preserved\)/i);
    expect(result).toHaveTextContent(
      "calibrated-honesty-verbatim-2026-05-26.md",
    );
    // Hint about re-submitting with force_overwrite is shown.
    expect(within(result).getByText(/overwrite/i)).toBeInTheDocument();
  });

  it("forwards force_overwrite when the checkbox is set, and reports replacement", async () => {
    mockedVerbatim.mockResolvedValueOnce({
      ok: true,
      written: {
        rel_path: "wiki/entities/iter-test.md",
        title: "Iter Test",
        section: "entities",
        slug: "iter-test",
        tier: "private",
        page_type: "entity",
      },
      conflict: null,
      overwrote_existing: true,
    });

    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(
      `---
type: entity
title: Iter Test
tier: private
---

v2
`,
    );
    await user.click(screen.getByTestId("verbatim-force-overwrite"));
    await user.click(screen.getByTestId("verbatim-submit"));

    await waitFor(() => {
      expect(mockedVerbatim).toHaveBeenCalledTimes(1);
    });
    expect(mockedVerbatim.mock.calls[0][0].force_overwrite).toBe(true);

    const result = await screen.findByTestId("verbatim-result");
    expect(result).toHaveTextContent(/replaced existing page/i);
  });

  it("surfaces server error messages inline", async () => {
    mockedVerbatim.mockRejectedValueOnce(
      new Error("invalid type 'rumor'. Must be one of: concept, decision, …"),
    );

    render(<CapturePage />);
    const user = await switchToVerbatimTab();

    await user.click(screen.getByTestId("verbatim-content-input"));
    await user.paste(
      `---
type: concept
title: Submit Me
tier: private
---

body
`,
    );
    await user.click(screen.getByTestId("verbatim-submit"));

    const err = await screen.findByTestId("verbatim-error");
    expect(err).toHaveTextContent(/invalid type/i);
  });
});
