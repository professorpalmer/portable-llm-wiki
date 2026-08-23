export type CameraNode = {
  degree?: number;
  x?: number;
  y?: number;
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

export function collectNodeBounds(
  nodes: ReadonlyArray<{ x?: number; y?: number }>,
): NodeBounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const node of nodes) {
    if (typeof node.x !== "number" || typeof node.y !== "number") continue;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
    count += 1;
  }
  if (count === 0) return null;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, count };
}

export function boundsAreSpread(bounds: NodeBounds | null): boolean {
  if (!bounds || bounds.count < 2) return false;
  return bounds.width > 8 || bounds.height > 8;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))),
  );
  return sorted[idx];
}

function bulkFence(sorted: number[]): { lo: number; hi: number } {
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  const span = Math.max(40, p90 - p10);
  return { lo: p10 - 0.5 * span, hi: p90 + 0.5 * span };
}

/**
 * Camera-only: ignore isolates and far-flung outliers when fitting.
 * Does not move any nodes.
 */
export function mainMassNodeFilter(
  nodes: ReadonlyArray<CameraNode>,
): (node: CameraNode) => boolean {
  const connected = nodes.filter((node) => {
    if ((node.degree ?? 0) <= 0) return false;
    if (typeof node.x !== "number" || typeof node.y !== "number") return false;
    return Number.isFinite(node.x) && Number.isFinite(node.y);
  });

  if (connected.length < 8) {
    return (node) => (node.degree ?? 0) > 0;
  }

  const xs = connected.map((node) => node.x as number).sort((a, b) => a - b);
  const ys = connected.map((node) => node.y as number).sort((a, b) => a - b);
  const xFence = bulkFence(xs);
  const yFence = bulkFence(ys);

  return (node) => {
    if ((node.degree ?? 0) <= 0) return false;
    if (typeof node.x !== "number" || typeof node.y !== "number") return false;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
    return (
      node.x >= xFence.lo &&
      node.x <= xFence.hi &&
      node.y >= yFence.lo &&
      node.y <= yFence.hi
    );
  };
}

export function tryZoomToFit(
  fg: {
    graphData?: () => { nodes?: CameraNode[] };
    zoomToFit?: (
      ms?: number,
      px?: number,
      nodeFilter?: (node: CameraNode) => boolean,
    ) => void;
  } | null,
  nodes: ReadonlyArray<CameraNode>,
  padding = 60,
  duration = 0,
): boolean {
  if (!fg?.zoomToFit) return false;
  const filter = mainMassNodeFilter(nodes);
  const included = nodes.filter(filter);
  if (!boundsAreSpread(collectNodeBounds(included))) return false;
  fg.zoomToFit(duration, padding, filter);
  return true;
}

export function fitForceGraphCamera(
  fg: {
    graphData?: () => { nodes?: CameraNode[] };
    zoom?: (k?: number, ms?: number) => number | unknown;
    centerAt?: (x?: number, y?: number, ms?: number) => unknown;
    zoomToFit?: (
      ms?: number,
      px?: number,
      nodeFilter?: (node: CameraNode) => boolean,
    ) => void;
  } | null,
  padding = 60,
  duration = 0,
): boolean {
  const nodes = fg?.graphData?.()?.nodes ?? [];
  return tryZoomToFit(fg, nodes, padding, duration);
}

export type CameraPose = { k: number; x: number; y: number };

export function captureCamera(
  fg: {
    zoom?: (k?: number, ms?: number) => number | unknown;
    centerAt?: (x?: number, y?: number, ms?: number) => unknown;
  } | null,
): CameraPose | null {
  if (!fg?.zoom || !fg.centerAt) return null;
  const k = fg.zoom();
  const center = fg.centerAt();
  if (typeof k !== "number" || !Number.isFinite(k)) return null;
  if (
    !center ||
    typeof center !== "object" ||
    typeof (center as { x?: number }).x !== "number" ||
    typeof (center as { y?: number }).y !== "number"
  ) {
    return null;
  }
  return { k, x: (center as { x: number }).x, y: (center as { y: number }).y };
}

export function applyCamera(
  fg: {
    zoom?: (k?: number, ms?: number) => number | unknown;
    centerAt?: (x?: number, y?: number, ms?: number) => unknown;
  } | null,
  pose: CameraPose,
): boolean {
  if (!fg?.zoom || !fg.centerAt) return false;
  fg.zoom(pose.k, 0);
  fg.centerAt(pose.x, pose.y, 0);
  return true;
}

/** force-graph's built-in onFinishUpdate heuristic: `4 / cbrt(nodeCount)`. */
export const LIBRARY_ZOOM2NODES_FACTOR = 4;

export function libraryNodeCountZoom(nodeCount: number): number {
  if (nodeCount <= 0) return 1;
  return LIBRARY_ZOOM2NODES_FACTOR / Math.cbrt(nodeCount);
}

export function isLibraryNodeCountZoom(
  k: number | null | undefined,
  nodeCount: number,
  epsilon = 0.03,
): boolean {
  if (typeof k !== "number" || !Number.isFinite(k) || nodeCount <= 0) {
    return false;
  }
  return Math.abs(k - libraryNodeCountZoom(nodeCount)) <= epsilon;
}

type ZoomableGraph = {
  zoom?: (k?: number, ms?: number) => number | unknown;
  centerAt?: (x?: number, y?: number, ms?: number) => void;
};

export function restoreDefaultCamera(fg: ZoomableGraph | null): boolean {
  if (!fg || typeof fg.zoom !== "function" || typeof fg.centerAt !== "function") {
    return false;
  }
  fg.zoom(1, 0);
  fg.centerAt(0, 0, 0);
  return true;
}

/**
 * Undo force-graph's node-count auto-zoom without touching layout.
 * Returns true when the heuristic zoom was detected and reset.
 */
export function undoLibraryAutoZoom(
  fg: ZoomableGraph | null,
  nodeCount: number,
  restore: CameraPose | null = null,
): boolean {
  if (!fg?.zoom) return false;
  const k = fg.zoom();
  if (typeof k !== "number") return false;
  if (!isLibraryNodeCountZoom(k, nodeCount)) return false;
  if (restore) return applyCamera(fg, restore);
  return restoreDefaultCamera(fg);
}
