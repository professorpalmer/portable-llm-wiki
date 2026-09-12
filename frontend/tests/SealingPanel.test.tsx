import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Manifest, PageSummary } from "@/lib/api";

const unlock = vi.fn();
const lock = vi.fn();
const refresh = vi.fn();
const sealing = {
  status: "not_enabled" as "not_enabled" | "locked" | "unlocked",
  tiers: [] as string[],
  dek: null as Uint8Array | null,
  titles: null as Map<string, string> | null,
  sealedCount: 0,
  unlock,
  lock,
  decryptPage: vi.fn(),
  refresh,
  searchLocal: vi.fn(() => []),
};

vi.mock("@/lib/useSealing", () => ({
  useSealing: () => sealing,
}));

vi.mock("@/lib/sealing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sealing")>(
    "@/lib/sealing",
  );
  return {
    ...actual,
    generateKeyring: vi.fn(async (_p: string, tiers: string[]) => ({
      v: 1 as const,
      tiers,
      kdf: "pbkdf2-sha256" as const,
      iterations: 600000,
      salt: "c2FsdA==",
      wrapped_dek: "d3JhcA==",
      check: "Y2hlY2s=",
      created: "2026-09-12T00:00:00.000Z",
    })),
    sealMarkdown: vi.fn(async () => "---\nsealed: v1\n---\nenvelope"),
  };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchManifest: vi.fn(),
    ownerPutSealing: vi.fn(),
    ownerDeleteSealing: vi.fn(),
    ownerGetPageRaw: vi.fn(),
    ownerReplacePage: vi.fn(),
  };
});

import {
  fetchManifest,
  ownerGetPageRaw,
  ownerPutSealing,
  ownerReplacePage,
} from "@/lib/api";
import { generateKeyring } from "@/lib/sealing";
import { SealingPanel } from "@/components/SealingPanel";

const ACK =
  "If I lose this passphrase, nobody, including the site operator, can recover these pages.";

function page(slug: string, sealed?: true): PageSummary {
  return {
    slug,
    title: sealed ? "Sealed page" : slug,
    section: "concepts",
    type: "concept",
    tier: "private",
    created: "2026-01-01",
    updated: "2026-01-02",
    tags: [],
    excerpt: "",
    word_count: 10,
    rel_path: `wiki/concepts/${slug}.md`,
    sealed,
  };
}

const BASE_MANIFEST: Manifest = {
  wiki_title: "Test",
  generated_at: "2026-09-12T00:00:00Z",
  viewer_tier: "private",
  viewer_is_owner: true,
  page_count: 2,
  sections: { concepts: 2 },
  pages: [page("alpha"), page("beta")],
};

describe("SealingPanel", () => {
  beforeEach(() => {
    sealing.status = "not_enabled";
    sealing.tiers = [];
    sealing.dek = null;
    unlock.mockReset().mockResolvedValue(undefined);
    lock.mockReset();
    refresh.mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchManifest).mockReset();
    vi.mocked(ownerPutSealing).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(ownerGetPageRaw).mockReset();
    vi.mocked(ownerReplacePage).mockReset();
    vi.mocked(fetchManifest).mockResolvedValue(BASE_MANIFEST);
  });

  it("does not enable without matching confirm and acknowledgement", async () => {
    const user = userEvent.setup();
    render(<SealingPanel />);

    await user.type(screen.getByPlaceholderText("passphrase"), "secret");
    await user.click(screen.getByRole("button", { name: /enable sealing/i }));
    expect(ownerPutSealing).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /confirm do not match/i,
    );

    await user.type(screen.getByPlaceholderText("confirm passphrase"), "secret");
    await user.click(screen.getByRole("button", { name: /enable sealing/i }));
    expect(ownerPutSealing).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /acknowledgement is required/i,
    );
  });

  it("enables after confirm + acknowledgement and unlocks", async () => {
    const user = userEvent.setup();
    render(<SealingPanel />);

    await user.type(screen.getByPlaceholderText("passphrase"), "secret");
    await user.type(screen.getByPlaceholderText("confirm passphrase"), "secret");
    await user.click(screen.getByLabelText(ACK));
    await user.click(screen.getByRole("button", { name: /enable sealing/i }));

    await waitFor(() => {
      expect(generateKeyring).toHaveBeenCalledWith("secret", ["private"]);
    });
    await waitFor(() => {
      expect(ownerPutSealing).toHaveBeenCalledWith(
        expect.objectContaining({
          force: false,
          keyring: expect.objectContaining({ tiers: ["private"] }),
        }),
        undefined,
      );
    });
    expect(unlock).toHaveBeenCalledWith("secret");
  });

  it("migrates plaintext pages sequentially and reports failures", async () => {
    sealing.status = "unlocked";
    sealing.tiers = ["private"];
    sealing.dek = new Uint8Array(32);
    vi.mocked(fetchManifest).mockResolvedValue({
      ...BASE_MANIFEST,
      sealing: {
        enabled: true,
        tiers: ["private"],
        keyring_url: "/wiki/sealing",
        bundle_url: "/wiki/sealed/bundle",
      },
    });

    const order: string[] = [];
    vi.mocked(ownerGetPageRaw).mockImplementation(async (slug) => {
      order.push(`raw:${slug}`);
      return {
        slug,
        rel_path: `wiki/concepts/${slug}.md`,
        title: slug,
        section: "concepts",
        tier: "private",
        markdown: `---\ntype: concept\ntier: private\ncreated: 2026-01-01\nupdated: 2026-01-02\ntitle: ${slug}\ntags: [x]\nsources: []\n---\nbody of ${slug}\n`,
      };
    });
    vi.mocked(ownerReplacePage).mockImplementation(async (slug) => {
      order.push(`put:${slug}`);
      if (slug === "beta") throw new Error("disk full");
      return {
        ok: true,
        slug,
        rel_path: `wiki/concepts/${slug}.md`,
        tier: "private",
        title: "Sealed page",
        size: 10,
      };
    });

    const user = userEvent.setup();
    render(<SealingPanel />);

    await waitFor(() => {
      expect(screen.getByText(/alpha · private/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /seal existing pages/i }));

    await waitFor(() => {
      expect(screen.getByText(/beta: disk full/)).toBeInTheDocument();
    });
    expect(order).toEqual(["raw:alpha", "put:alpha", "raw:beta", "put:beta"]);
    expect(screen.getByRole("status")).toHaveTextContent(/sealed 2 of 2/);
  });
});
