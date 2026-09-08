import type { GraphNode } from "@/lib/api";
import type { GraphPosition, GraphPositions } from "@/lib/graphLayout";
import { mainMassNodeFilter } from "@/lib/graphCamera";

export type Camera = Readonly<{ x: number; y: number; scale: number }>;
export type Viewport = Readonly<{ width: number; height: number }>;

export function nodeRadius(degree: number): number {
  return Math.max(4, Math.min(14, 4 + Math.sqrt(Math.max(1, degree)) * 1.6));
}

export function fitCamera(
  nodes: ReadonlyArray<Pick<GraphNode, "slug" | "degree">>,
  positions: GraphPositions,
  viewport: Viewport,
  padding = 40,
): Camera {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const positioned = nodes.map((node) => ({ ...node, ...positions.get(node.slug) }));
  const mainMass = positioned.filter(mainMassNodeFilter(positioned));
  const fittedNodes = mainMass.length > 0 ? mainMass : nodes;
  for (const node of fittedNodes) {
    const position = positions.get(node.slug);
    if (!position) continue;
    const radius = nodeRadius(node.degree);
    minX = Math.min(minX, position.x - radius);
    maxX = Math.max(maxX, position.x + radius);
    minY = Math.min(minY, position.y - radius);
    maxY = Math.max(maxY, position.y + radius);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, scale: 1 };
  const worldWidth = Math.max(32, maxX - minX);
  const worldHeight = Math.max(32, maxY - minY);
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = Math.max(0.04, Math.min(4, usableWidth / worldWidth, usableHeight / worldHeight));
  return {
    x: viewport.width / 2 - ((minX + maxX) / 2) * scale,
    y: viewport.height / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
}

export function screenToWorld(point: GraphPosition, camera: Camera): GraphPosition {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

export function zoomAroundPoint(
  camera: Camera,
  point: GraphPosition,
  scale: number,
): Camera {
  const boundedScale = Math.max(0.03, Math.min(8, scale));
  const world = screenToWorld(point, camera);
  return {
    x: point.x - world.x * boundedScale,
    y: point.y - world.y * boundedScale,
    scale: boundedScale,
  };
}

const GRID_CELL = 48;
export type SpatialGrid = ReadonlyMap<string, ReadonlyArray<string>>;

export function buildSpatialGrid(nodeIds: ReadonlyArray<string>, positions: GraphPositions): SpatialGrid {
  const mutable = new Map<string, string[]>();
  for (const id of nodeIds) {
    const position = positions.get(id);
    if (!position) continue;
    const key = `${Math.floor(position.x / GRID_CELL)},${Math.floor(position.y / GRID_CELL)}`;
    const entries = mutable.get(key);
    if (entries) entries.push(id);
    else mutable.set(key, [id]);
  }
  return mutable;
}

export function hitTestSpatialGrid(
  grid: SpatialGrid,
  positions: GraphPositions,
  nodesById: ReadonlyMap<string, Pick<GraphNode, "degree">>,
  point: GraphPosition,
  worldTolerance: number,
): string | null {
  const reach = Math.max(1, Math.ceil(worldTolerance / GRID_CELL));
  const centerX = Math.floor(point.x / GRID_CELL);
  const centerY = Math.floor(point.y / GRID_CELL);
  let winner: string | null = null;
  let winnerDistance = Infinity;
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (const id of grid.get(`${centerX + dx},${centerY + dy}`) ?? []) {
        const position = positions.get(id);
        const node = nodesById.get(id);
        if (!position || !node) continue;
        const distance = Math.hypot(point.x - position.x, point.y - position.y);
        const hitRadius = Math.max(nodeRadius(node.degree), worldTolerance);
        if (distance <= hitRadius && distance < winnerDistance) {
          winner = id;
          winnerDistance = distance;
        }
      }
    }
  }
  return winner;
}

export function interpolatePositions(
  from: GraphPositions,
  to: GraphPositions,
  progress: number,
): Map<string, GraphPosition> {
  const bounded = Math.max(0, Math.min(1, progress));
  const eased = 1 - Math.pow(1 - bounded, 3);
  return new Map(
    Array.from(to, ([id, target]) => {
      const start = from.get(id) ?? target;
      return [id, {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      }];
    }),
  );
}
