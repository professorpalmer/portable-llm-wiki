import { describe, expect, it, vi } from "vitest";
import {
  boundsAreSpread,
  collectNodeBounds,
  graphLayoutProfile,
  labelBox,
  linkEndpointId,
  neighborSlugSet,
  nodeRadius,
  pickLabelAnchor,
  rectsOverlap,
  shouldPaintLink,
  paintFocusEdges,
  requestGraphRedraw,
  sparsifyEdges,
  tryZoomToFit,
} from "@/lib/graphView";

describe("graphLayoutProfile", () => {
  it("keeps collision and arrows on a small sparse graph", () => {
    const profile = graphLayoutProfile(40, 80);
    expect(profile.useCollision).toBe(true);
    expect(profile.showArrows).toBe(true);
    expect(profile.maxIdleEdges).toBe(Number.POSITIVE_INFINITY);
  });

  it("drops arrows and collision on a dense wiki-scale graph", () => {
    const profile = graphLayoutProfile(1854, 23739);
    expect(profile.useCollision).toBe(false);
    expect(profile.showArrows).toBe(false);
    expect(profile.maxIdleEdges).toBeLessThan(1200);
    expect(profile.maxLayoutEdges).toBeLessThanOrEqual(800);
    expect(profile.warmupTicks).toBeLessThan(8);
    expect(profile.cooldownTicks).toBeLessThanOrEqual(32);
    expect(profile.alphaDecay).toBeGreaterThan(0.08);
    expect(profile.chargeTheta).toBeGreaterThan(1);
  });

  it("caps idle edges once the graph crosses the large threshold", () => {
    const profile = graphLayoutProfile(700, 5000);
    expect(profile.useCollision).toBe(false);
    expect(profile.showArrows).toBe(false);
    expect(profile.maxIdleEdges).toBeLessThan(graphLayoutProfile(40, 80).maxIdleEdges);
    expect(profile.maxLayoutEdges).toBeLessThan(graphLayoutProfile(40, 80).maxLayoutEdges);
  });
});

describe("sparsifyEdges", () => {
  it("returns a copy when the graph is already under the cap", () => {
    const edges = [{ source: "a", target: "b" }];
    const kept = sparsifyEdges([{ slug: "a", degree: 1 }, { slug: "b", degree: 1 }], edges, 10);
    expect(kept).toEqual(edges);
    expect(kept).not.toBe(edges);
  });

  it("keeps a hub backbone and stays at the cap on a wiki-scale hairball", () => {
    const nodes = [
      { slug: "hub", degree: 50 },
      { slug: "spoke", degree: 40 },
      { slug: "leaf", degree: 1 },
      { slug: "other", degree: 1 },
    ];
    const edges = [
      { source: "leaf", target: "other" },
      { source: "hub", target: "spoke" },
      { source: "hub", target: "leaf" },
    ];
    expect(sparsifyEdges(nodes, edges, 1)).toEqual([{ source: "hub", target: "spoke" }]);
    expect(sparsifyEdges(nodes, edges, 2)).toHaveLength(2);
  });

  it("covers a leftover node before filling with more hub edges", () => {
    const nodes = [
      { slug: "h1", degree: 20 },
      { slug: "h2", degree: 20 },
      { slug: "h3", degree: 18 },
      { slug: "leaf", degree: 1 },
    ];
    const edges = [
      { source: "h1", target: "h2" },
      { source: "h1", target: "h3" },
      { source: "h2", target: "h3" },
      { source: "h1", target: "leaf" },
    ];
    const kept = sparsifyEdges(nodes, edges, 3);
    expect(kept).toHaveLength(3);
    expect(kept.some((edge) => edge.source === "leaf" || edge.target === "leaf")).toBe(true);
  });
});

describe("paintFocusEdges", () => {
  it("strokes only edges incident to the focus node", () => {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
      lineWidth: 0,
    };
    const nodes = new Map([
      ["hub", { x: 0, y: 0 }],
      ["a", { x: 10, y: 0 }],
      ["b", { x: 0, y: 10 }],
      ["c", { x: 20, y: 20 }],
    ]);
    const drawn = paintFocusEdges(
      ctx as unknown as CanvasRenderingContext2D,
      nodes,
      [
        { source: "hub", target: "a" },
        { source: "b", target: "hub" },
        { source: "a", target: "c" },
      ],
      "hub",
      { color: "orange", width: 1.5 },
    );
    expect(drawn).toBe(2);
    expect(ctx.moveTo).toHaveBeenCalledTimes(2);
    expect(ctx.strokeStyle).toBe("orange");
  });
});

describe("collectNodeBounds / boundsAreSpread", () => {
  it("rejects missing or non-finite coordinates", () => {
    expect(
      collectNodeBounds([{ x: Number.NaN, y: 0 }, { x: 1, y: undefined }]),
    ).toBeNull();
  });

  it("rejects a collapsed origin cluster so zoomToFit cannot lock a corner", () => {
    const bounds = collectNodeBounds([
      { x: 0, y: 0 },
      { x: 0.4, y: -0.2 },
      { x: -0.3, y: 0.1 },
    ]);
    expect(bounds).not.toBeNull();
    expect(boundsAreSpread(bounds!)).toBe(false);
  });

  it("accepts a spread layout", () => {
    const bounds = collectNodeBounds([
      { x: -80, y: -40 },
      { x: 120, y: 90 },
      { x: 10, y: 15 },
    ]);
    expect(boundsAreSpread(bounds!)).toBe(true);
  });
});

describe("tryZoomToFit", () => {
  it("does not call zoomToFit until nodes have a real span", () => {
    const zoomToFit = vi.fn();
    const clustered = Array.from({ length: 20 }, () => ({ x: 1, y: 1 }));
    expect(tryZoomToFit({ zoomToFit }, clustered)).toBe(false);
    expect(zoomToFit).not.toHaveBeenCalled();
  });

  it("fits once the bounding box is usable", () => {
    const zoomToFit = vi.fn();
    const nodes = [
      { x: -100, y: -80 },
      { x: 140, y: 90 },
    ];
    expect(tryZoomToFit({ zoomToFit }, nodes, 80, 200)).toBe(true);
    expect(zoomToFit).toHaveBeenCalledWith(200, 80);
  });

  it("no-ops when the canvas instance is missing", () => {
    expect(tryZoomToFit(null, [{ x: 0, y: 0 }, { x: 80, y: 80 }])).toBe(false);
  });
});

describe("requestGraphRedraw", () => {
  it("reapplies the current center so a settled canvas will paint", () => {
    const centerAt = vi.fn() as ReturnType<typeof vi.fn> & {
      (): { x: number; y: number };
    };
    centerAt.mockReturnValue({ x: 12, y: -4 });
    expect(requestGraphRedraw({ centerAt })).toBe(true);
    expect(centerAt).toHaveBeenLastCalledWith(12, -4);
  });

  it("no-ops without a usable camera", () => {
    expect(requestGraphRedraw(null)).toBe(false);
    expect(requestGraphRedraw({ centerAt: () => ({ x: Number.NaN, y: 0 }) })).toBe(
      false,
    );
  });
});

describe("shouldPaintLink", () => {
  it("keeps every idle edge on a small graph", () => {
    expect(
      shouldPaintLink("a", "b", {
        edgeCount: 10,
        focusSlug: null,
        maxIdleEdges: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
  });

  it("when a node is focused, paints only its incident edges", () => {
    const opts = { edgeCount: 23739, focusSlug: "catalog-residual", maxIdleEdges: 2200 };
    expect(shouldPaintLink("catalog-residual", "marionette", opts)).toBe(true);
    expect(shouldPaintLink("other", "unrelated", opts)).toBe(false);
  });

  it("samples idle edges deterministically under the cap", () => {
    const opts = { edgeCount: 20000, focusSlug: null, maxIdleEdges: 2000 };
    const kept = Array.from({ length: 400 }, (_, i) =>
      shouldPaintLink(`s${i}`, `t${i}`, opts),
    ).filter(Boolean).length;
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(120);
    expect(shouldPaintLink("s0", "t0", opts)).toBe(shouldPaintLink("s0", "t0", opts));
  });
});

describe("link and neighbor helpers", () => {
  it("reads slugs from either string or object endpoints", () => {
    expect(linkEndpointId("alpha")).toBe("alpha");
    expect(linkEndpointId({ slug: "beta", id: "ignored" })).toBe("beta");
    expect(linkEndpointId({ id: "gamma" })).toBe("gamma");
    expect(linkEndpointId(null)).toBe("");
  });

  it("builds an O(1) neighbor set", () => {
    const neighbors = neighborSlugSet(
      [
        { source: "hub", target: "a" },
        { source: "b", target: "hub" },
        { source: "c", target: "d" },
      ],
      "hub",
    );
    expect([...neighbors].sort()).toEqual(["a", "b"]);
  });

  it("grows node radius with degree but stays capped", () => {
    expect(nodeRadius(1)).toBeGreaterThanOrEqual(4);
    expect(nodeRadius(100)).toBeLessThanOrEqual(14);
    expect(nodeRadius(100)).toBeGreaterThan(nodeRadius(4));
  });
});

describe("label collision", () => {
  it("picks the first non-overlapping anchor and skips the rest when unforced", () => {
    const occupied = [labelBox({ x: 0, y: 10, ax: "center", ay: "top" }, 40, 10, 2, 1)];
    const chosen = pickLabelAnchor(
      [
        { x: 0, y: 10, ax: "center", ay: "top" },
        { x: 80, y: 0, ax: "left", ay: "middle" },
      ],
      40,
      10,
      2,
      1,
      occupied,
      false,
    );
    expect(chosen?.anchor.x).toBe(80);
  });

  it("forces the first anchor when every slot collides", () => {
    const box = labelBox({ x: 0, y: 0, ax: "center", ay: "top" }, 20, 8, 1, 1);
    const chosen = pickLabelAnchor(
      [{ x: 0, y: 0, ax: "center", ay: "top" }],
      20,
      8,
      1,
      1,
      [box],
      true,
    );
    expect(chosen?.anchor.x).toBe(0);
    expect(rectsOverlap(box, chosen!.rect)).toBe(true);
  });
});
