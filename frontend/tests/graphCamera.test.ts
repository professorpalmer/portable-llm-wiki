import { describe, expect, it, vi } from "vitest";
import {
  collectNodeBounds,
  fitForceGraphCamera,
  libraryNodeCountZoom,
  mainMassNodeFilter,
  tryZoomToFit,
  undoLibraryAutoZoom,
} from "@/lib/graphCamera";

function grid(count: number, degree = 2): Array<{ degree: number; x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => ({
    degree,
    x: (i % 10) * 20,
    y: Math.floor(i / 10) * 20,
  }));
}

describe("mainMassNodeFilter", () => {
  it("excludes degree-zero nodes without moving anything", () => {
    const nodes = [
      ...grid(12),
      { degree: 0, x: -8000, y: 9000 },
    ];
    const snapshot = nodes.map((n) => ({ ...n }));
    const filter = mainMassNodeFilter(nodes);
    expect(filter(nodes[nodes.length - 1])).toBe(false);
    expect(nodes.filter(filter)).toHaveLength(12);
    expect(nodes).toEqual(snapshot);
  });

  it("excludes far outliers while keeping the dense cluster", () => {
    const nodes = [
      ...grid(20),
      { degree: 4, x: 12000, y: -11000 },
    ];
    const filter = mainMassNodeFilter(nodes);
    expect(filter(nodes[nodes.length - 1])).toBe(false);
    expect(nodes.filter(filter).length).toBe(20);
    const bounds = collectNodeBounds(nodes.filter(filter))!;
    expect(bounds.width).toBeLessThan(250);
    expect(bounds.height).toBeLessThan(250);
  });

  it("keeps elongated cluster arms inside the camera mass", () => {
    const nodes = [
      ...grid(20),
      { degree: 3, x: 200, y: 20 },
      { degree: 3, x: 20, y: 30 },
    ];
    const filter = mainMassNodeFilter(nodes);
    expect(filter(nodes[nodes.length - 2])).toBe(true);
    expect(filter(nodes[nodes.length - 1])).toBe(true);
  });
});

describe("tryZoomToFit", () => {
  it("fits the main mass with a zero-duration camera move", () => {
    const nodes = [
      ...grid(12),
      { degree: 0, x: 9000, y: -8000 },
    ];
    const zoomToFit = vi.fn();
    expect(tryZoomToFit({ zoomToFit }, nodes, 60, 0)).toBe(true);
    expect(zoomToFit).toHaveBeenCalledTimes(1);
    expect(zoomToFit.mock.calls[0][0]).toBe(0);
    expect(zoomToFit.mock.calls[0][1]).toBe(60);
    const filter = zoomToFit.mock.calls[0][2] as (n: (typeof nodes)[number]) => boolean;
    expect(nodes.filter(filter)).toHaveLength(12);
    expect(nodes[nodes.length - 1].x).toBe(9000);
  });

  it("does not zoom until the cluster has a real span", () => {
    const zoomToFit = vi.fn();
    expect(tryZoomToFit({ zoomToFit }, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBe(
      false,
    );
    expect(zoomToFit).not.toHaveBeenCalled();
  });
});

describe("fitForceGraphCamera", () => {
  it("reads live nodes from graphData and does not mutate them", () => {
    const nodes = [
      ...grid(12),
      { degree: 0, x: 9000, y: -8000 },
    ];
    const snapshot = nodes.map((n) => ({ ...n }));
    const zoomToFit = vi.fn();
    expect(
      fitForceGraphCamera({ zoomToFit, graphData: () => ({ nodes }) }, 60, 0),
    ).toBe(true);
    expect(zoomToFit).toHaveBeenCalledWith(0, 60, expect.any(Function));
    expect(nodes).toEqual(snapshot);
  });
});

describe("undoLibraryAutoZoom", () => {
  it("resets force-graph's 4/cbrt(n) heuristic back to the default camera", () => {
    const nodeCount = 1878;
    const heuristic = libraryNodeCountZoom(nodeCount);
    expect(heuristic).toBeCloseTo(4 / Math.cbrt(1878), 8);
    let k = heuristic;
    const fg = {
      zoom: Object.assign(
        (next?: number) => {
          if (next === undefined) return k;
          k = next;
          return k;
        },
        {},
      ),
      centerAt: vi.fn(),
    };
    expect(undoLibraryAutoZoom(fg, nodeCount)).toBe(true);
    expect(k).toBe(1);
    expect(fg.centerAt).toHaveBeenCalledWith(0, 0, 0);
  });

  it("restores a saved fitted pose instead of k=1 when one is provided", () => {
    const nodeCount = 1878;
    let k = libraryNodeCountZoom(nodeCount);
    let x = 0;
    let y = 0;
    const fg = {
      zoom: (next?: number) => {
        if (next === undefined) return k;
        k = next;
        return k;
      },
      centerAt: (nx?: number, ny?: number) => {
        if (nx === undefined && ny === undefined) return { x, y };
        if (nx !== undefined) x = nx;
        if (ny !== undefined) y = ny;
        return { x, y };
      },
    };
    expect(
      undoLibraryAutoZoom(fg, nodeCount, { k: 0.72, x: 12, y: -8 }),
    ).toBe(true);
    expect(k).toBe(0.72);
    expect(x).toBe(12);
    expect(y).toBe(-8);
  });

  it("leaves a non-heuristic camera alone", () => {
    let k = 0.72;
    const fg = {
      zoom: (next?: number) => {
        if (next === undefined) return k;
        k = next;
        return k;
      },
      centerAt: vi.fn(),
    };
    expect(undoLibraryAutoZoom(fg, 1878, { k: 0.72, x: 0, y: 0 })).toBe(false);
    expect(k).toBe(0.72);
    expect(fg.centerAt).not.toHaveBeenCalled();
  });
});
