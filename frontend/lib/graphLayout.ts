import type { GraphEdge, GraphResponse } from "@/lib/api";

export type GraphPosition = Readonly<{ x: number; y: number }>;
export type GraphPositions = ReadonlyMap<string, GraphPosition>;
export type LayoutNode = Readonly<{ id: string; degree: number; x: number; y: number }>;
export type LayoutMode = "initial" | "relax";
export type LayoutDelivery = "stream" | "final-only";
export type LayoutStart = Readonly<{
  kind: "start";
  generation: number;
  mode: LayoutMode;
  delivery: LayoutDelivery;
  nodes: LayoutNode[];
  links: GraphEdge[];
}>;
type LayoutPositions = Readonly<{
  generation: number;
  sequence: number;
  positions: Array<Readonly<{ id: string; x: number; y: number }>>;
}>;
export type LayoutProgress = LayoutPositions & Readonly<{ kind: "progress" }>;
export type LayoutFinal = LayoutPositions & Readonly<{ kind: "final" }>;
export type LayoutFailure = Readonly<{
  kind: "error";
  generation: number;
  message: string;
}>;
export type LayoutResponse = LayoutProgress | LayoutFinal | LayoutFailure;

const CACHE_LIMIT = 4;
const SINGLE_TENANT_SCOPE = "single-tenant";
const layoutCache = new Map<string, Map<string, GraphPosition>>();
let activeTenantScope: string | null = null;

function tenantScope(tenant?: string): string {
  return tenant || SINGLE_TENANT_SCOPE;
}

function cacheKey(tenant: string | undefined, fingerprint: string): string {
  return `${tenantScope(tenant)}\u0000${fingerprint}`;
}

export function activateLayoutCacheTenant(tenant?: string): void {
  const nextScope = tenantScope(tenant);
  if (activeTenantScope === nextScope) return;
  activeTenantScope = nextScope;
  for (const key of layoutCache.keys()) {
    if (!key.startsWith(`${nextScope}\u0000`)) layoutCache.delete(key);
  }
}

export function readCachedLayout(
  tenant: string | undefined,
  fingerprint: string,
): Map<string, GraphPosition> | null {
  activateLayoutCacheTenant(tenant);
  const key = cacheKey(tenant, fingerprint);
  const cached = layoutCache.get(key);
  if (!cached) return null;
  layoutCache.delete(key);
  layoutCache.set(key, cached);
  return new Map(cached);
}

export function writeCachedLayout(
  tenant: string | undefined,
  fingerprint: string,
  positions: GraphPositions,
): void {
  activateLayoutCacheTenant(tenant);
  const key = cacheKey(tenant, fingerprint);
  layoutCache.delete(key);
  layoutCache.set(key, new Map(positions));
  while (layoutCache.size > CACHE_LIMIT) {
    const oldest = layoutCache.keys().next().value;
    if (typeof oldest !== "string") break;
    layoutCache.delete(oldest);
  }
}

export function clearLayoutCacheForTests(): void {
  layoutCache.clear();
  activeTenantScope = null;
}

function hashText(text: string, seed = 2166136261): number {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function topologyFingerprint(graph: GraphResponse): string {
  const nodes = graph.nodes.map((node) => node.slug).sort();
  const edges = graph.edges.map((edge) => `${edge.source}\u0001${edge.target}`).sort();
  let hash = hashText(`${nodes.length}:${edges.length}`);
  for (const node of nodes) hash = hashText(node, hash);
  for (const edge of edges) hash = hashText(edge, hash);
  return `${nodes.length}-${edges.length}-${hash.toString(36)}`;
}

export function stableInitialPosition(rank = 0): GraphPosition {
  const angle = rank * Math.PI * (3 - Math.sqrt(5));
  const radius = 10 * Math.sqrt(0.5 + rank);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function initialGraphPositions(graph: GraphResponse): Map<string, GraphPosition> {
  return new Map(graph.nodes.map((node, rank) => [node.slug, stableInitialPosition(rank)]));
}

export function layoutNodes(graph: GraphResponse, positions: GraphPositions): LayoutNode[] {
  return graph.nodes.map((node, rank) => {
    const position = positions.get(node.slug) ?? stableInitialPosition(rank);
    return { id: node.slug, degree: node.degree, x: position.x, y: position.y };
  });
}

export function positionsFromResponse(response: LayoutProgress | LayoutFinal): Map<string, GraphPosition> {
  return new Map(
    response.positions
      .filter((position) => Number.isFinite(position.x) && Number.isFinite(position.y))
      .map((position) => [position.id, { x: position.x, y: position.y }]),
  );
}

export function visibleLinks(
  links: ReadonlyArray<GraphEdge>,
  visibleIds: ReadonlySet<string>,
): GraphEdge[] {
  return links
    .filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))
    .map((link) => ({ source: link.source, target: link.target }));
}
