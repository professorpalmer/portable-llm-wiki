/**
 * Layout, camera, and paint helpers for the knowledge-graph canvas.
 *
 * The wiki graph is dense (thousands of nodes, tens of thousands of edges).
 * react-force-graph-2d will paint and simulate every edge every tick unless
 * we scale forces and skip work. Camera fits must wait for a measured canvas
 * and a non-degenerate node bounding box — otherwise zoomToFit locks onto a
 * few pixels near the origin and the cluster sits in a corner.
 */

export type GraphEdgeRef = {
  source: string | Record<string, unknown>;
  target: string | Record<string, unknown>;
};

export type GraphLayoutProfile = {
  warmupTicks: number;
  cooldownTicks: number;
  cooldownTime: number;
  alphaDecay: number;
  alphaMin: number;
  velocityDecay: number;
  linkDistance: number;
  linkStrength: number;
  chargeStrength: number;
  chargeDistanceMax: number;
  chargeTheta: number;
  useCollision: boolean;
  showArrows: boolean;
  maxIdleEdges: number;
  maxLayoutEdges: number;
};

export type NodeBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  count: number;
};

export type TextAnchor = {
  x: number;
  y: number;
  ax: "center" | "left" | "right";
  ay: "top" | "middle" | "bottom";
};

export type LabelRect = { x: number; y: number; w: number; h: number };

const HUGE_NODES = 1200;
const HUGE_EDGES = 12000;
const LARGE_NODES = 600;
const LARGE_EDGES = 4000;

export function graphLayoutProfile(
  nodeCount: number,
  edgeCount: number,
): GraphLayoutProfile {
  const huge = nodeCount >= HUGE_NODES || edgeCount >= HUGE_EDGES;
  const large = nodeCount >= LARGE_NODES || edgeCount >= LARGE_EDGES;

  // warmupTicks run synchronously before the first paint. On a dense graph
  // that blocks the main thread, so keep warmup small and make live ticks cheap.
  if (huge) {
    return {
      warmupTicks: 4,
      cooldownTicks: 300,
      cooldownTime: 12000,
      // Slow alpha decay so the simulation keeps ticking long enough to fully
      // separate nodes. With a fast decay alpha hits alphaMin after ~100 ticks
      // and the layout stops while still a clump — that is the first-load
      // clump. d3's default alphaDecay (~0.023) reaches alphaMin over ~300 ticks.
      alphaDecay: 0.023,
      alphaMin: 0.001,
      velocityDecay: 0.4,
      linkDistance: 82,
      linkStrength: 0.34,
      chargeStrength: -420,
      chargeDistanceMax: 600,
      chargeTheta: 0.81,
      // collision is what separates nodes into the spread "brain" shape; without
      // it degree-90 hubs (radius 14) overlap into a clump. It is O(n) per tick
      // via quadtree, so it does not regress responsiveness. keep it ON here.
      useCollision: true,
      showArrows: false,
      maxIdleEdges: 850,
      // Lay out over the FULL edge set. Sparsifying to a hub backbone is what
      // produced the hollow donut: ~1k degree-1 leaves got no layout link and
      // pure repulsion ejected them into a ring. The force layout needs to see
      // every edge to converge into a compact web; painting stays sampled
      // (maxIdleEdges) so frames remain cheap.
      maxLayoutEdges: Number.POSITIVE_INFINITY,
    };
  }
  if (large) {
    return {
      warmupTicks: 6,
      cooldownTicks: 280,
      cooldownTime: 11000,
      alphaDecay: 0.026,
      alphaMin: 0.001,
      velocityDecay: 0.38,
      linkDistance: 74,
      linkStrength: 0.32,
      chargeStrength: -380,
      chargeDistanceMax: 580,
      chargeTheta: 0.84,
      useCollision: true,
      showArrows: false,
      maxIdleEdges: 1500,
      maxLayoutEdges: Number.POSITIVE_INFINITY,
    };
  }
  return {
    warmupTicks: 40,
    cooldownTicks: 160,
    cooldownTime: 8000,
    alphaDecay: 0.022,
    alphaMin: 0.008,
    velocityDecay: 0.35,
    linkDistance: 90,
    linkStrength: 0.4,
    chargeStrength: -420,
    chargeDistanceMax: 600,
    chargeTheta: 0.81,
    useCollision: true,
    showArrows: true,
    maxIdleEdges: Number.POSITIVE_INFINITY,
    maxLayoutEdges: Number.POSITIVE_INFINITY,
  };
}

export function nodeRadius(degree: number): number {
  return Math.max(4, Math.min(14, 4 + Math.sqrt(Math.max(degree, 1)) * 1.6));
}

export function linkEndpointId(end: unknown): string {
  if (typeof end === "string") return end;
  if (end && typeof end === "object") {
    const record = end as { slug?: unknown; id?: unknown };
    if (typeof record.slug === "string") return record.slug;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}

/**
 * Pick a force-engine backbone. Visibility sampling is not enough:
 * react-force-graph still steps every graphData link each tick. Keep
 * high-degree structure and cover leftover nodes, then fill to the cap.
 */
export function sparsifyEdges(
  nodes: ReadonlyArray<{ slug: string; degree: number }>,
  edges: ReadonlyArray<GraphEdgeRef>,
  maxEdges: number,
): GraphEdgeRef[] {
  if (!Number.isFinite(maxEdges) || edges.length <= maxEdges) {
    return edges.slice();
  }

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.slug, node.degree);

  const ranked = edges.map((edge, index) => {
    const s = linkEndpointId(edge.source);
    const t = linkEndpointId(edge.target);
    return {
      edge,
      index,
      key: `${s}\0${t}`,
      sourceId: s,
      targetId: t,
      score: (degree.get(s) ?? 0) + (degree.get(t) ?? 0),
    };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = new Set<string>();
  const kept: GraphEdgeRef[] = [];

  function take(item: (typeof ranked)[number]): boolean {
    if (selected.has(item.key)) return false;
    selected.add(item.key);
    kept.push(item.edge);
    return true;
  }

  const covered = new Set<string>();
  for (const item of ranked) {
    if (kept.length >= maxEdges) return kept;
    if (covered.has(item.sourceId) && covered.has(item.targetId)) continue;
    if (take(item)) {
      covered.add(item.sourceId);
      covered.add(item.targetId);
    }
  }
  for (const item of ranked) {
    if (kept.length >= maxEdges) break;
    take(item);
  }
  return kept;
}

export function paintFocusEdges(
  ctx: CanvasRenderingContext2D,
  nodesBySlug: Map<string, { x?: number; y?: number }>,
  edges: ReadonlyArray<GraphEdgeRef>,
  focusSlug: string,
  style: { color: string; width: number },
): number {
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.beginPath();
  let drawn = 0;
  for (const edge of edges) {
    const s = linkEndpointId(edge.source as unknown);
    const t = linkEndpointId(edge.target as unknown);
    if (s !== focusSlug && t !== focusSlug) continue;
    const from = nodesBySlug.get(s);
    const to = nodesBySlug.get(t);
    if (
      !from ||
      !to ||
      typeof from.x !== "number" ||
      typeof from.y !== "number" ||
      typeof to.x !== "number" ||
      typeof to.y !== "number"
    ) {
      continue;
    }
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    drawn += 1;
  }
  ctx.stroke();
  ctx.restore();
  return drawn;
}

export function neighborSlugSet(
  edges: ReadonlyArray<GraphEdgeRef>,
  slug: string,
): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    const s = linkEndpointId(edge.source as unknown);
    const t = linkEndpointId(edge.target as unknown);
    if (s === slug) out.add(t);
    if (t === slug) out.add(s);
  }
  return out;
}

export function collectNodeBounds(
  nodes: ReadonlyArray<{ x?: number; y?: number }>,
): NodeBounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const node of nodes) {
    const x = node.x;
    const y = node.y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    count += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count === 0) return null;
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    count,
  };
}

export function boundsAreSpread(bounds: NodeBounds): boolean {
  if (bounds.count <= 1) return false;
  if (bounds.count <= 3) return bounds.width + bounds.height > 1;
  const minSpan = bounds.count < 50 ? 16 : 32;
  return (
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    Math.max(bounds.width, bounds.height) >= minSpan
  );
}

export function tryZoomToFit(
  fg: { zoomToFit?: (ms?: number, px?: number) => void } | null,
  nodes: ReadonlyArray<{ x?: number; y?: number }>,
  padding = 60,
  duration = 400,
): boolean {
  if (!fg?.zoomToFit) return false;
  const bounds = collectNodeBounds(nodes);
  if (!bounds || !boundsAreSpread(bounds)) return false;
  fg.zoomToFit(duration, padding);
  return true;
}

/**
 * Force-graph has no public refresh(). Re-applying the current camera
 * center sets ``needsRedraw`` so a settled canvas paints hover/selection.
 */
export function requestGraphRedraw(
  fg: {
    centerAt?: {
      (): { x: number; y: number } | null | undefined;
      (x: number, y: number): unknown;
    };
  } | null,
): boolean {
  if (!fg?.centerAt) return false;
  const center = fg.centerAt();
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    return false;
  }
  fg.centerAt(center.x, center.y);
  return true;
}

export function shouldPaintLink(
  sourceId: string,
  targetId: string,
  opts: {
    edgeCount: number;
    focusSlug: string | null;
    maxIdleEdges: number;
  },
): boolean {
  if (!sourceId || !targetId) return false;
  if (opts.focusSlug) {
    return sourceId === opts.focusSlug || targetId === opts.focusSlug;
  }
  if (opts.edgeCount <= opts.maxIdleEdges) return true;
  const keep = opts.maxIdleEdges / opts.edgeCount;
  return hash32(`${sourceId}\0${targetId}`) / 0x1_0000_0000 < keep;
}

export function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}

export function labelBox(
  anchor: TextAnchor,
  textW: number,
  textH: number,
  padX: number,
  padY: number,
): LabelRect {
  let rx = anchor.x;
  let ry = anchor.y;
  if (anchor.ax === "center") rx -= textW / 2;
  else if (anchor.ax === "right") rx -= textW;
  if (anchor.ay === "middle") ry -= textH / 2;
  else if (anchor.ay === "bottom") ry -= textH;
  return {
    x: rx - padX,
    y: ry - padY,
    w: textW + padX * 2,
    h: textH + padY * 2,
  };
}

export function pickLabelAnchor(
  candidates: TextAnchor[],
  textW: number,
  textH: number,
  padX: number,
  padY: number,
  occupied: ReadonlyArray<LabelRect>,
  forced: boolean,
): { anchor: TextAnchor; rect: LabelRect } | null {
  for (const candidate of candidates) {
    const rect = labelBox(candidate, textW, textH, padX, padY);
    if (!occupied.some((other) => rectsOverlap(rect, other))) {
      return { anchor: candidate, rect };
    }
  }
  if (forced && candidates[0]) {
    return {
      anchor: candidates[0],
      rect: labelBox(candidates[0], textW, textH, padX, padY),
    };
  }
  return null;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
