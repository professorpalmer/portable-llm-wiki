import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { PageFull } from "@/lib/api";

vi.mock("@/lib/useTenant", () => ({
  useTenant: vi.fn(() => undefined),
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

const sealing = {
  status: "locked" as "locked" | "unlocked" | "not_enabled",
  tiers: ["private"],
  dek: new Uint8Array(32) as Uint8Array | null,
  titles: new Map<string, string>([["s-abc", "Hidden Notes"]]),
  sealedCount: 1,
  unlock: vi.fn(),
  lock: vi.fn(),
  decryptPage: vi.fn(),
  refresh: vi.fn(),
  searchLocal: vi.fn(() => []),
};

vi.mock("@/lib/useSealing", () => ({
  useSealing: () => sealing,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "s-abc" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/page/s-abc",
  useSearchParams: () => new URLSearchParams(),
}));

import PageView from "@/app/page/[slug]/page";

const SEALED_PAGE: PageFull = {
  slug: "s-abc",
  title: "Sealed page",
  section: "concepts",
  tier: "private",
  type: "concept",
  body: "",
  rendered_body: "",
  tags: [],
  excerpt: "",
  links_out: [],
  links_in: [],
  links_out_resolved: [],
  links_in_resolved: [],
  sources: [],
  word_count: 0,
  rel_path: "wiki/concepts/s-abc.md",
  created: "2026-09-12",
  updated: "2026-09-12",
  sealed: true,
  envelope: "dGVzdA==",
};

describe("PageView sealed", () => {
  beforeEach(() => {
    mockFetchPage.mockReset();
    mockFetchPage.mockResolvedValue(SEALED_PAGE);
    sealing.status = "locked";
    sealing.decryptPage.mockReset();
    sealing.decryptPage.mockResolvedValue({
      v: 1,
      title: "Hidden Notes",
      tags: ["secret"],
      sources: ["raw/x.md"],
      body: "See [[Other Secret]] inside.",
    });
  });

  it("renders the locked sealed-page state with an unlock control", async () => {
    render(<PageView />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Sealed page" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/unlock to read/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();
    expect(screen.queryByText("Hidden Notes")).not.toBeInTheDocument();
  });

  it("decrypts and renders title, tags, and body when unlocked", async () => {
    sealing.status = "unlocked";
    render(<PageView />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Hidden Notes" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("#secret")).toBeInTheDocument();
    expect(screen.getByText(/inside/)).toBeInTheDocument();
    expect(sealing.decryptPage).toHaveBeenCalledWith("s-abc", "dGVzdA==");
  });
});
