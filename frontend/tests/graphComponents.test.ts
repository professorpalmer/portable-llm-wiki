import { describe, expect, it } from "vitest";
import {
  massCentroidAndRadius,
  pullOutlierTowardMass,
} from "@/lib/graphComponents";

function grid(count: number): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => ({
    x: (i % 10) * 20,
    y: Math.floor(i / 10) * 20,
  }));
}

describe("massCentroidAndRadius", () => {
  it("ignores a far outlier when measuring the mass radius", () => {
    const mass = massCentroidAndRadius([
      ...grid(20),
      { x: 0, y: 8000 },
    ]);
    expect(mass).not.toBeNull();
    expect(mass!.radius).toBeLessThan(250);
    expect(Math.abs(mass!.cy)).toBeLessThan(80);
  });
});

describe("pullOutlierTowardMass", () => {
  it("does not touch a node already inside the mass radius", () => {
    const node = { x: 10, y: 0, vx: 1, vy: 2 };
    pullOutlierTowardMass(node, {
      cx: 0,
      cy: 0,
      maxRadius: 100,
      alpha: 1,
    });
    expect(node).toEqual({ x: 10, y: 0, vx: 1, vy: 2 });
  });

  it("pulls a far leaf back toward the mass", () => {
    const node = { x: 0, y: 5000, vx: 0, vy: 0 };
    pullOutlierTowardMass(node, {
      cx: 0,
      cy: 0,
      maxRadius: 200,
      alpha: 1,
    });
    expect(node.vy).toBeLessThan(0);
    expect(node.vx).toBe(0);
  });

  it("brings a charge-exiled leaf inside the belt after several ticks", () => {
    const node = { x: 0, y: 5000, vx: 0, vy: 0 };
    for (let i = 0; i < 40; i += 1) {
      pullOutlierTowardMass(node, {
        cx: 0,
        cy: 0,
        maxRadius: 200,
        alpha: 0.3,
      });
      node.y += node.vy ?? 0;
      node.vy = (node.vy ?? 0) * 0.35;
    }
    expect(Math.abs(node.y)).toBeLessThan(400);
  });
});
