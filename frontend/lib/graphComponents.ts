export type TetherNode = {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
};

export type TetherSimNode = {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
};

export type MassBounds = {
  cx: number;
  cy: number;
  radius: number;
};

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))),
  );
  return sorted[idx];
}

function isTetherNode(node: TetherSimNode): node is TetherSimNode & TetherNode {
  return (
    typeof node.x === "number" &&
    typeof node.y === "number" &&
    Number.isFinite(node.x) &&
    Number.isFinite(node.y)
  );
}

export function massCentroidAndRadius(
  nodes: ReadonlyArray<{ x: number; y: number }>,
  q = 0.9,
): MassBounds | null {
  if (nodes.length === 0) return null;
  // Median, not mean: the outliers this force reins in would drag a mean
  // centre (and the radius measured from it) out toward themselves.
  const cx = percentile(nodes.map((node) => node.x).sort((a, b) => a - b), 0.5);
  const cy = percentile(nodes.map((node) => node.y).sort((a, b) => a - b), 0.5);
  const distances = nodes
    .map((node) => Math.hypot(node.x - cx, node.y - cy))
    .sort((a, b) => a - b);
  return { cx, cy, radius: Math.max(40, percentile(distances, q)) };
}

export function pullOutlierTowardMass(
  node: TetherNode,
  args: { cx: number; cy: number; maxRadius: number; alpha: number },
): void {
  const dx = node.x - args.cx;
  const dy = node.y - args.cy;
  const r = Math.hypot(dx, dy);
  if (r <= args.maxRadius || r === 0) return;
  const k = ((r - args.maxRadius) / r) * args.alpha;
  node.vx = (node.vx ?? 0) - dx * k;
  node.vy = (node.vy ?? 0) - dy * k;
}

export function createOutlierTetherForce(): {
  (alpha: number): void;
  initialize: (nodes: TetherSimNode[]) => void;
} {
  let nodes: TetherSimNode[] = [];

  function force(alpha: number) {
    const placed = nodes.filter(isTetherNode);
    const mass = massCentroidAndRadius(placed);
    if (!mass) return;
    const maxRadius = mass.radius * 1.15 + 48;
    for (const node of placed) {
      pullOutlierTowardMass(node, {
        cx: mass.cx,
        cy: mass.cy,
        maxRadius,
        alpha,
      });
    }
  }

  force.initialize = (next: TetherSimNode[]) => {
    nodes = next;
  };
  return force;
}
