import { describe, expect, it } from "vitest";
import type { GraphResponse } from "@/lib/api";
import { forceSimulation, type SimulationNodeDatum } from "d3-force";
import {
  activateLayoutCacheTenant,
  clearLayoutCacheForTests,
  initialGraphPositions,
  readCachedLayout,
  stableInitialPosition,
  topologyFingerprint,
  visibleLinks,
  writeCachedLayout,
} from "@/lib/graphLayout";

function graph(edges: GraphResponse["edges"]): GraphResponse {
  return {
    nodes: ["a", "b", "c"].map((slug, index) => ({
      slug,
      title: slug,
      section: index < 2 ? "one" : "two",
      tier: "public",
      is_anchor: false,
      degree: 1,
    })),
    edges,
    anchors: [],
  };
}

describe("graph layout invariants", () => {
  it("retains the original renderer's deterministic D3 seed positions", () => {
    const first = graph([]);
    const reference: SimulationNodeDatum[] = first.nodes.map(() => ({}));
    forceSimulation(reference).stop();
    const positions = initialGraphPositions(first);
    first.nodes.forEach((node, index) => {
      expect(positions.get(node.slug)?.x).toBeCloseTo(reference[index].x ?? 0);
      expect(positions.get(node.slug)?.y).toBeCloseTo(reference[index].y ?? 0);
    });
    expect(stableInitialPosition(0)).toEqual(stableInitialPosition(0));
  });

  it("fingerprints the full topology independent of API order", () => {
    const first = graph([{ source: "a", target: "b" }, { source: "b", target: "c" }]);
    const reordered = {
      ...first,
      nodes: [...first.nodes].reverse(),
      edges: [...first.edges].reverse(),
    };
    expect(topologyFingerprint(first)).toBe(topologyFingerprint(reordered));
    expect(topologyFingerprint(graph([{ source: "a", target: "b" }]))).not.toBe(
      topologyFingerprint(first),
    );
  });

  it("returns fresh edge objects and every edge whose endpoints are visible", () => {
    const links = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ];
    const visible = visibleLinks(links, new Set(["a", "b", "c"]));
    expect(visible).toEqual(links);
    expect(visible[0]).not.toBe(links[0]);
    expect(visibleLinks(links, new Set(["a", "b"]))).toEqual([
      { source: "a", target: "b" },
    ]);
  });

  it("reuses cache across same-tenant remounts and clears it on tenant change", () => {
    clearLayoutCacheForTests();
    const positions = new Map([["a", { x: 12, y: -4 }]]);
    writeCachedLayout("tenant-a", "topology", positions);
    expect(readCachedLayout("tenant-a", "topology")).toEqual(positions);
    activateLayoutCacheTenant("tenant-b");
    expect(readCachedLayout("tenant-a", "topology")).toBeNull();
  });
});
