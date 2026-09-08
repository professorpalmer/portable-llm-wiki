import { describe, expect, it } from "vitest";
import {
  buildSpatialGrid,
  fitCamera,
  hitTestSpatialGrid,
  screenToWorld,
  zoomAroundPoint,
} from "@/lib/graphGeometry";

describe("graph geometry", () => {
  it("fits the connected graph without letting a distant isolate shrink it", () => {
    const nodes = [{ slug: "a", degree: 1 }, { slug: "b", degree: 1 }, { slug: "isolate", degree: 0 }];
    const positions = new Map([["a", { x: -100, y: 0 }], ["b", { x: 100, y: 0 }], ["isolate", { x: 20000, y: 20000 }]]);
    expect(fitCamera(nodes, positions, { width: 800, height: 600 })).toEqual(
      fitCamera(nodes.slice(0, 2), positions, { width: 800, height: 600 }),
    );
  });

  it("fits a singleton with finite padding-aware camera values", () => {
    const camera = fitCamera(
      [{ slug: "only", degree: 0 }],
      new Map([["only", { x: 25, y: -10 }]]),
      { width: 800, height: 600 },
    );
    expect(camera).toEqual({ x: 300, y: 340, scale: 4 });
  });

  it("zooms around the pointer without changing its world coordinate", () => {
    const pointer = { x: 300, y: 220 };
    const before = { x: 20, y: 10, scale: 0.5 };
    const after = zoomAroundPoint(before, pointer, 1.5);
    expect(screenToWorld(pointer, after)).toEqual(screenToWorld(pointer, before));
  });

  it("hit-tests nearby nodes through the spatial index", () => {
    const positions = new Map([
      ["a", { x: 10, y: 10 }],
      ["b", { x: 500, y: 500 }],
    ]);
    const grid = buildSpatialGrid(["a", "b"], positions);
    const nodes = new Map([["a", { degree: 2 }], ["b", { degree: 2 }]]);
    expect(hitTestSpatialGrid(grid, positions, nodes, { x: 13, y: 12 }, 8)).toBe("a");
    expect(hitTestSpatialGrid(grid, positions, nodes, { x: 200, y: 200 }, 8)).toBeNull();
  });
});
