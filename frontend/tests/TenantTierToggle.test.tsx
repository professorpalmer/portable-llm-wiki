/**
 * Tests for the inline tier-toggle UX on the tenant landing page.
 *
 * Background: the tenant landing page (frontend/app/[tenant]/page.tsx)
 * exposes a small <TierToggle> dropdown beside each page row when the
 * viewer owns the tenant. This is the primary surface for "I want to
 * make some pages private so recruiters don't see them" — replacing
 * what used to be "click into every page detail view one at a time".
 *
 * These tests lock the contract:
 *   1. Owner mode renders a <select> (the tier dropdown).
 *   2. Non-owner mode renders a static badge (read-only).
 *   3. Changing the select calls ownerSetTier(slug, newTier, tenantId)
 *      and then invokes onTierChanged so the parent refetches.
 *   4. A backend failure surfaces the error inline without crashing
 *      the row.
 *   5. Selecting the SAME tier is a no-op (prevents pointless PATCH
 *      requests when the user opens-then-closes the dropdown).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    ownerSetTier: vi.fn(),
  };
});

import { ownerSetTier } from "@/lib/api";
import { PageRow, TierToggle } from "@/components/TenantPageList";
import type { PageSummary } from "@/lib/api";

const samplePage: PageSummary = {
  slug: "anti-oppression-stance",
  title: "Anti-Oppression Stance",
  section: "concepts",
  type: "concept",
  tier: "public",
  created: "2026-05-01",
  updated: "2026-05-23",
  tags: [],
  excerpt: "",
  word_count: 300,
  rel_path: "concepts/anti-oppression-stance.md",
};

beforeEach(() => {
  vi.mocked(ownerSetTier).mockReset();
  vi.mocked(ownerSetTier).mockResolvedValue({
    ok: true,
    slug: samplePage.slug,
    tier: "private",
  });
});


describe("PageRow", () => {
  it("renders the tier dropdown for an owner viewer", () => {
    render(
      <PageRow
        page={samplePage}
        tenantId="cary"
        isOwnerView
        onTierChanged={() => undefined}
      />,
    );
    // The dropdown is implemented as a <select> for keyboard + mobile
    // accessibility; the aria-label is the tier-changer's stable hook.
    const select = screen.getByLabelText(/change tier for/i);
    expect(select.tagName).toBe("SELECT");
    expect((select as HTMLSelectElement).value).toBe("public");
  });

  it("renders a static badge for non-owner viewers (no dropdown)", () => {
    render(
      <PageRow
        page={samplePage}
        tenantId="cary"
        isOwnerView={false}
        onTierChanged={() => undefined}
      />,
    );
    // No interactive control should exist for a non-owner — that's the
    // whole point of the tier system. Asserting absence catches the
    // regression where we'd accidentally show the dropdown to anyone.
    expect(screen.queryByLabelText(/change tier for/i)).toBeNull();
    // The static badge still appears so recruiter/friend viewers can
    // see WHICH tier each visible page belongs to.
    expect(screen.getByText(/^public$/i)).toBeInTheDocument();
  });

  it("the page title links to the per-page detail view", () => {
    render(
      <PageRow
        page={samplePage}
        tenantId="cary"
        isOwnerView
        onTierChanged={() => undefined}
      />,
    );
    const link = screen.getByRole("link", { name: samplePage.title });
    expect(link).toHaveAttribute(
      "href",
      `/cary/page/${encodeURIComponent(samplePage.slug)}`,
    );
  });
});


describe("TierToggle", () => {
  it("PATCHes the new tier and notifies the parent on success", async () => {
    const onChanged = vi.fn();
    render(
      <TierToggle
        slug="anti-oppression-stance"
        tier="public"
        tenantId="cary"
        onTierChanged={onChanged}
      />,
    );
    const select = screen.getByLabelText(
      /change tier for anti-oppression-stance/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "private" } });

    // Wait for the awaited PATCH + onTierChanged call to flush.
    await waitFor(() => {
      expect(ownerSetTier).toHaveBeenCalledWith(
        "anti-oppression-stance",
        "private",
        "cary",
      );
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("is a no-op when the user 'selects' the same tier", async () => {
    // Native <select> onChange doesn't fire on identical-value selection
    // but we still guard against it programmatically — this also
    // prevents an extra PATCH if a future bulk-action wires the same
    // value through dispatchEvent. We assert the guard by firing the
    // change event with the SAME value and confirming no PATCH.
    const onChanged = vi.fn();
    render(
      <TierToggle
        slug="anti-oppression-stance"
        tier="public"
        tenantId="cary"
        onTierChanged={onChanged}
      />,
    );
    const select = screen.getByLabelText(/change tier for/i);
    fireEvent.change(select, { target: { value: "public" } });
    // Flush microtasks.
    await Promise.resolve();
    expect(ownerSetTier).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("surfaces a backend error inline without crashing the row", async () => {
    vi.mocked(ownerSetTier).mockRejectedValueOnce(
      new Error("401 Unauthorized"),
    );
    const onChanged = vi.fn();
    render(
      <TierToggle
        slug="anti-oppression-stance"
        tier="public"
        tenantId="cary"
        onTierChanged={onChanged}
      />,
    );
    const select = screen.getByLabelText(/change tier for/i);
    fireEvent.change(select, { target: { value: "private" } });

    // Error message renders next to the dropdown, parent is NOT told
    // the tier changed (because it didn't).
    await waitFor(() => {
      expect(screen.getByText(/401 Unauthorized/i)).toBeInTheDocument();
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
