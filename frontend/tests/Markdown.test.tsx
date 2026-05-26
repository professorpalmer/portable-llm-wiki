/**
 * Unit tests for the Markdown component's wikilink preprocessor.
 *
 * Critical because the HeroStream landing demo bakes ``[[X]]`` syntax
 * directly into its fallback content — if preprocessWikilinks regresses,
 * the demo's wikilinks render as literal "[[X]]" garbage and the "real
 * cited graph" promise of the landing page collapses to noise.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown, preprocessWikilinks } from "@/components/Markdown";

// Next's Link uses next/router internals that don't exist in vitest —
// stub it out as a plain anchor so we can assert on rendered href.
import { vi } from "vitest";
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("preprocessWikilinks", () => {
  it("converts [[Title]] to a /wiki/page link with the slugified title", () => {
    const out = preprocessWikilinks("Hello [[Strand Bio]] world");
    expect(out).toBe("Hello [Strand Bio](/wiki/page/strand-bio) world");
  });

  it("preserves the [[Target|display]] label form (uses display as anchor text)", () => {
    const out = preprocessWikilinks("see [[2024-08-15 Leaving Grad School|the move]]");
    expect(out).toContain("[the move](/wiki/page/2024-08-15-leaving-grad-school)");
  });

  it("handles multiple wikilinks on the same line", () => {
    const out = preprocessWikilinks("[[Avery Chen]] joined [[Strand Bio]]");
    expect(out).toBe(
      "[Avery Chen](/wiki/page/avery-chen) joined [Strand Bio](/wiki/page/strand-bio)",
    );
  });

  it("leaves text without wikilinks unchanged", () => {
    const out = preprocessWikilinks("just plain markdown **bold** and a [link](https://x)");
    expect(out).toBe("just plain markdown **bold** and a [link](https://x)");
  });

  it("preserves date-prefixed slugs (no swallowing of leading digits)", () => {
    // Decision pages follow YYYY-MM-DD-<slug>. The slugifier MUST NOT
    // strip the leading digits or the link will 404.
    const out = preprocessWikilinks("[[2026-05-20 Postpone Series A]]");
    expect(out).toContain("/wiki/page/2026-05-20-postpone-series-a");
  });

  it("drops punctuation in titles while preserving readable display text", () => {
    const out = preprocessWikilinks("[[Provenance: Citations]]");
    // Display text keeps the colon, slug drops it.
    expect(out).toContain("[Provenance: Citations](/wiki/page/provenance-citations)");
  });
});

describe("Markdown component", () => {
  it("renders wikilinks as anchor tags pointing at /page/<slug> when no tenant", () => {
    const { container } = render(
      <Markdown>{`Visit [[Strand Bio]] for context.`}</Markdown>,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/page/strand-bio");
    expect(link?.textContent).toBe("Strand Bio");
  });

  it("routes wikilinks through /<tenant>/page/<slug> when tenant prop is set", () => {
    const { container } = render(
      <Markdown tenant="avery">{`[[Strand Bio]] is a startup.`}</Markdown>,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/avery/page/strand-bio");
  });

  it("does not collide tenant routing with external links", () => {
    const { container } = render(
      <Markdown tenant="avery">{`See [docs](https://example.com/x)`}</Markdown>,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/x");
    // External links open in a new tab.
    expect(link?.getAttribute("target")).toBe("_blank");
  });
});
