/**
 * ImportWizard tests. /owner/import is the cold-start surface — paste a
 * resume / LinkedIn / bio / freeform blob and the orchestrator drafts
 * starter pages. The form has a few subtle invariants worth pinning:
 *   - all four kind tabs render
 *   - switching kind swaps the textarea placeholder so the user knows
 *     what shape of paste is expected
 *   - submit is disabled until content >= 20 chars (mirrors the backend)
 *   - submit fires ownerImport with the right shape
 *
 * v0.97 also adds the multi-PDF batch flow on the same page. We lock the
 * shape of that surface (button copy, queue visibility, sequential
 * concatenation) here so future refactors don't quietly drop a marker or
 * regress the queue summary.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  getOwnerToken: vi.fn(() => "fake-test-token"),
  ownerImport: vi.fn(),
  ownerExtractPdf: vi.fn(),
  ownerGetJob: vi.fn(),
  fetchManifest: vi.fn(),
  // OwnerImportPage now uses useTenant() (which calls isHostedMode())
  // and renders inside an OwnerGate (which calls authMe()). Stub both so
  // single-tenant test rendering hits the no-op code paths.
  isHostedMode: vi.fn(() => false),
  authMe: vi.fn(() =>
    Promise.resolve({ authenticated: false, user: null, tenant: null, fresh_signup: false }),
  ),
  apiBase: vi.fn(() => "/api/backend"),
}));

import {
  getOwnerToken,
  ownerImport,
  ownerGetJob,
  ownerExtractPdf,
} from "@/lib/api";
import OwnerImportPage from "@/app/owner/import/page";

const mockedGetToken = vi.mocked(getOwnerToken);
const mockedImport = vi.mocked(ownerImport);
const mockedGetJob = vi.mocked(ownerGetJob);
const mockedExtract = vi.mocked(ownerExtractPdf);

describe("ImportWizard", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
    mockedGetToken.mockReturnValue("fake-test-token");
    mockedImport.mockReset();
    mockedGetJob.mockReset();
    mockedExtract.mockReset();
    // Default: polling never resolves to a terminal state, so we never
    // transition out of "running" during a test.
    mockedGetJob.mockReturnValue(new Promise(() => {}));
    window.localStorage.setItem("llmwiki:ownerToken", "fake-test-token");
  });

  it("renders the form with all four kind tabs", async () => {
    render(<OwnerImportPage />);

    // The form only renders after the first useEffect promotes authed→true,
    // so we wait for the first kind tab to appear.
    expect(
      await screen.findByRole("button", { name: /^resume$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^linkedin$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^bio$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^freeform$/i }),
    ).toBeInTheDocument();
  });

  it("updates the textarea placeholder when a different kind is selected", async () => {
    const user = userEvent.setup();
    render(<OwnerImportPage />);

    // Default kind is resume — placeholder starts with "Jane Doe".
    expect(await screen.findByPlaceholderText(/Jane Doe/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^bio$/i }));

    expect(
      screen.getByPlaceholderText(/engineer at a small biotech/i),
    ).toBeInTheDocument();
    // And the resume placeholder is gone (same textarea, new placeholder).
    expect(screen.queryByPlaceholderText(/Jane Doe/)).not.toBeInTheDocument();
  });

  it("disables the submit button until content is at least 20 characters", async () => {
    render(<OwnerImportPage />);

    const submit = await screen.findByRole("button", { name: /draft pages/i });
    expect(submit).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/Jane Doe/);

    // 19 chars — still below threshold.
    fireEvent.change(textarea, { target: { value: "x".repeat(19) } });
    expect(submit).toBeDisabled();

    // 20 chars — should flip enabled.
    fireEvent.change(textarea, { target: { value: "x".repeat(20) } });
    expect(submit).toBeEnabled();
  });

  it("calls ownerImport with the right shape when submit is clicked", async () => {
    mockedImport.mockResolvedValue({
      ok: true,
      rel_path: "raw/profile/2026-05-24-resume.md",
      size: 1234,
      pages_before: [],
      orchestrator: {
        tracking_id: "track-123",
        status: "running",
        started_at: "2026-05-24T00:00:00Z",
      },
    });
    const user = userEvent.setup();
    render(<OwnerImportPage />);

    const textarea = await screen.findByPlaceholderText(/Jane Doe/);
    const longInput =
      "This is a long enough resume paste to enable submission.";
    // fireEvent.change is faster + more reliable than user.type for the
    // ~60-char string we need to push past the 20-char threshold.
    fireEvent.change(textarea, { target: { value: longInput } });

    const submit = screen.getByRole("button", { name: /draft pages/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(mockedImport).toHaveBeenCalledTimes(1);
    });
    // Second arg is the tenant id — undefined in single-tenant test mode.
    expect(mockedImport).toHaveBeenCalledWith(
      {
        kind: "resume",
        content: longInput,
        label: undefined,
      },
      undefined,
    );
  });

  // --- v0.97: multi-PDF batch ---------------------------------------------

  it("renders the multi-PDF trigger button (plural copy)", async () => {
    render(<OwnerImportPage />);

    expect(
      await screen.findByRole("button", { name: /\+ extract from pdfs/i }),
    ).toBeInTheDocument();
  });

  it("keeps the PDF queue summary hidden until at least one file is added", async () => {
    render(<OwnerImportPage />);

    // The form has finished mounting.
    await screen.findByRole("button", { name: /^resume$/i });

    // No queue list and no "N PDF queued" summary should be on screen.
    expect(screen.queryByTestId("pdf-queue")).not.toBeInTheDocument();
    expect(screen.queryByText(/pdfs? queued/i)).not.toBeInTheDocument();
    // The "extract all" / "extract N remaining" CTA only appears with a
    // populated queue.
    expect(
      screen.queryByRole("button", { name: /^extract (all|\d+)/i }),
    ).not.toBeInTheDocument();
  });

  it("sequentially extracts two queued PDFs and concatenates them with BEGIN/END markers", async () => {
    mockedExtract.mockResolvedValueOnce({
      ok: true,
      text: "ALPHA BODY TEXT",
      page_count: 2,
      word_count: 5,
      source_filename: "alpha.pdf",
    });
    mockedExtract.mockResolvedValueOnce({
      ok: true,
      text: "BETA BODY TEXT",
      page_count: 1,
      word_count: 3,
      source_filename: "beta.pdf",
    });

    const user = userEvent.setup();
    const { container } = render(<OwnerImportPage />);

    // Wait for the form to mount.
    await screen.findByRole("button", { name: /^resume$/i });

    // The file input is type=file (hidden via CSS but present in the DOM).
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const alpha = new File(["%PDF-1.4 alpha dummy"], "alpha.pdf", {
      type: "application/pdf",
    });
    const beta = new File(["%PDF-1.4 beta dummy"], "beta.pdf", {
      type: "application/pdf",
    });

    // fireEvent.change populates `target.files` reliably in jsdom; this
    // mirrors what the browser does when a user picks N files.
    fireEvent.change(fileInput!, { target: { files: [alpha, beta] } });

    // Both files are now queued.
    expect(await screen.findByText("alpha.pdf")).toBeInTheDocument();
    expect(screen.getByText("beta.pdf")).toBeInTheDocument();
    expect(screen.getByText(/2 PDFs queued/i)).toBeInTheDocument();

    // Kick off sequential extraction.
    const extractAll = screen.getByRole("button", {
      name: /^extract all/i,
    });
    await user.click(extractAll);

    // Wait until both files have been processed.
    await waitFor(() => {
      expect(mockedExtract).toHaveBeenCalledTimes(2);
    });

    const textarea = screen.getByPlaceholderText(
      /Jane Doe/,
    ) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(textarea.value).toContain("ALPHA BODY TEXT");
      expect(textarea.value).toContain("BETA BODY TEXT");
    });

    // BEGIN/END markers include the source filename and the page/word
    // counts so the owner can audit the corpus before submitting.
    expect(textarea.value).toMatch(
      /--- BEGIN: alpha\.pdf \(2 pages, 5 words\) ---/,
    );
    expect(textarea.value).toMatch(/--- END: alpha\.pdf ---/);
    expect(textarea.value).toMatch(
      /--- BEGIN: beta\.pdf \(1 page, 3 words\) ---/,
    );
    expect(textarea.value).toMatch(/--- END: beta\.pdf ---/);

    // Alpha must precede beta — sequential, not interleaved.
    expect(textarea.value.indexOf("ALPHA BODY TEXT")).toBeLessThan(
      textarea.value.indexOf("BETA BODY TEXT"),
    );

    // Label auto-fills to a batch summary because >1 file and no label
    // was set by the owner.
    const labelInput = screen.getByPlaceholderText(
      /Updated resume 2026-05/i,
    ) as HTMLInputElement;
    expect(labelInput.value).toBe("PDF batch: 2 files");
  });
});
