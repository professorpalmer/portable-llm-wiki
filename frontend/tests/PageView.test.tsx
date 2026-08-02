/**
 * PageView regression: hosted wiki pages must thread tenant into Markdown
 * so [[wikilinks]] resolve under /<tenant>/page/<slug>, not bare /page/<slug>.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { PageFull } from "@/lib/api";
import PageView from "@/app/page/[slug]/page";

vi.mock("@/lib/useTenant", () => ({
  useTenant: vi.fn(),
}));

vi.mock("@/lib/useIsOwner", () => ({
  useIsOwnerOf: vi.fn(() => ({ ready: true, isOwner: false })),
}));

const mockFetchPage = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPage: (...args: unknown[]) => mockFetchPage(...args),
    ownerSetTier: vi.fn(),
    ownerGetPageRaw: vi.fn(),
    ownerReplacePage: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "about-me" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/avery/page/about-me",
  useSearchParams: () => new URLSearchParams(),
}));

import { useTenant } from "@/lib/useTenant";

const SAMPLE_PAGE: PageFull = {
  slug: "about-me",
  title: "About Me",
  section: "entities",
  tier: "public",
  type: "entity",
  body: "See [[Strand Bio]] for more.",
  rendered_body: "",
  tags: [],
  excerpt: "",
  links_out: [],
  links_in: [],
  links_out_resolved: [],
  links_in_resolved: [],
  sources: [],
  word_count: 10,
  rel_path: "wiki/entities/about-me.md",
  created: null,
  updated: null,
};

describe("PageView tenant-aware Markdown", () => {
  beforeEach(() => {
    vi.mocked(useTenant).mockReturnValue("avery");
    mockFetchPage.mockResolvedValue(SAMPLE_PAGE);
  });

  it("renders wikilinks under /<tenant>/page/<slug> when tenant is in scope", async () => {
    render(<PageView />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "About Me" })).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: "Strand Bio" });
    expect(link.getAttribute("href")).toBe("/avery/page/strand-bio");
  });
});
