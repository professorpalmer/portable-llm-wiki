"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  fetchGraph,
  fetchManifest,
  type GraphResponse,
  type GraphNode,
} from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import {
  graphLayoutProfile,
  linkEndpointId,
  neighborSlugSet,
  nodeRadius,
  paintFocusEdges,
  pickLabelAnchor,
  requestGraphRedraw,
  shouldPaintLink,
  sparsifyEdges,
  tryZoomToFit,
  type LabelRect,
} from "@/lib/graphView";

// react-force-graph-2d is canvas-based, so it must be loaded client-side
// only. ``next/dynamic`` returns a ``LoadableComponent`` HOC that does
// NOT forward refs to the wrapped component — which silently breaks the
// "recenter" / "relax" buttons (``fgRef.current`` never gets
// ``zoomToFit`` / ``d3ReheatSimulation``). Wrapping the dynamic import in
// ``forwardRef`` does not help because the ref still lands on the
// LoadableComponent wrapper. Instead we dynamically import
// ``ForceGraphCanvas``, a thin client component that statically imports
// ForceGraph2D and accepts ``graphRef`` as a regular prop.
//
// See https://nextjs.org/docs/app/api-reference/functions/dynamic-imports
// — "ref attribute" caveat.
const ForceGraphCanvas = dynamic(
  () => import("@/components/ForceGraphCanvas"),
  {
    ssr: false,
    loading: () => (
      <div className="text-sm text-ink-muted p-4">loading graph…</div>
    ),
  },
);

const SECTION_COLORS: Record<string, string> = {
  entities: "#3b82f6",
  concepts: "#8b5cf6",
  decisions: "#10b981",
  sources: "#94a3b8",
  queries: "#f59e0b",
  projects: "#ff6a00",
  root: "#0e0e10",
  other: "#6b7280",
};

const TIER_RING: Record<string, string> = {
  public: "#10b981",
  recruiter: "#3b82f6",
  friend: "#8b5cf6",
  private: "#ef4444",
};

// How permanent (always-painted) labels are chosen. Cycles in this order so a
// single button can reach every state:
//   hubs — top-degree nodes + current selection (the calm default)
//   all  — every node labelled (busy, but complete)
//   off  — no permanent labels at all; only hover/selection reveal a name
type LabelMode = "hubs" | "all" | "off";

const LABEL_MODE_ORDER: LabelMode[] = ["hubs", "all", "off"];
const LABEL_MODE_TEXT: Record<LabelMode, string> = {
  hubs: "labels: hubs only",
  all: "labels: all",
  off: "labels: off",
};

export default function GraphPage() {
  const tenant = useTenant();
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [viewerTier, setViewerTier] = useState<string>("public");
  const [isOwner, setIsOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [sectionFilter, setSectionFilter] = useState<string>("");
  const [labelMode, setLabelMode] = useState<LabelMode>("off");
  const [layoutPhase, setLayoutPhase] = useState<"running" | "settled">("running");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The ForceGraph2D instance exposes d3Force(...) and zoomToFit() — keep a ref.
  // The library's exported type is loose; using `any` here is intentional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  // Per-frame accumulator for painted label rectangles so collision avoidance
  // can skip labels that would overlap already-painted ones. Reset every frame
  // in onRenderFramePre.
  const labelRectsRef = useRef<LabelRect[]>([]);
  // Hover stays off the React render path so moving across 1k+ nodes does not
  // rebuild canvas callbacks every frame. ForceGraph.refresh() redraws.
  const hoveredSlugRef = useRef<string | null>(null);
  const nodesRef = useRef<Array<{ slug?: string; x?: number; y?: number }>>(
    [],
  );
  // null until ResizeObserver reports the real pane — mounting at 800x600 and
  // then growing the canvas is what parks the cluster in the top-left corner.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    fetchGraph(tenant)
      .then(setGraph)
      .catch((e) => setError((e as Error).message));
    fetchManifest(tenant)
      .then((m) => {
        setViewerTier(m.viewer_tier);
        setIsOwner(m.viewer_is_owner);
      })
      .catch(() => {
        /* badge already surfaces this */
      });
  }, [tenant]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 8 || r.height < 8) return;
      setSize({ w: r.width, h: Math.max(500, r.height) });
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  const filtered = useMemo(() => {
    if (!graph) return null;
    if (!sectionFilter) return graph;
    const allowed = new Set(
      graph.nodes.filter((n) => n.section === sectionFilter).map((n) => n.slug)
    );
    return {
      nodes: graph.nodes.filter((n) => allowed.has(n.slug)),
      edges: graph.edges.filter((e) => allowed.has(e.source) && allowed.has(e.target)),
      anchors: graph.anchors,
    };
  }, [graph, sectionFilter]);

  const profile = useMemo(
    () =>
      graphLayoutProfile(
        filtered?.nodes.length ?? 0,
        filtered?.edges.length ?? 0,
      ),
    [filtered?.nodes.length, filtered?.edges.length],
  );

  const layoutEdges = useMemo(() => {
    if (!filtered) return [];
    return sparsifyEdges(filtered.nodes, filtered.edges, profile.maxLayoutEdges);
  }, [filtered, profile.maxLayoutEdges]);

  const data = useMemo(() => {
    if (!filtered) return { nodes: [], links: [] };
    return {
      nodes: filtered.nodes.map((n) => ({ ...n, id: n.slug })) as Array<
        GraphNode & { id: string; x?: number; y?: number }
      >,
      links: layoutEdges,
    };
  }, [filtered, layoutEdges]);
  nodesRef.current = data.nodes;

  const graphKey = `${sectionFilter}:${data.nodes.length}:${data.links.length}`;
  const nodesBySlug = useMemo(() => {
    const map = new Map<string, { x?: number; y?: number }>();
    for (const node of data.nodes) map.set(node.slug, node);
    return map;
  }, [data.nodes]);
  const fullEdgesRef = useRef(filtered?.edges ?? []);
  fullEdgesRef.current = filtered?.edges ?? [];

  useEffect(() => {
    setLayoutPhase("running");
  }, [graphKey]);

  const selectedNode = useMemo(
    () => filtered?.nodes.find((n) => n.slug === selectedSlug) ?? null,
    [filtered, selectedSlug]
  );

  const selectedNeighborSlugs = useMemo(() => {
    if (!filtered || !selectedSlug) return new Set<string>();
    return neighborSlugSet(filtered.edges, selectedSlug);
  }, [filtered, selectedSlug]);

  const selectedNeighbors = useMemo(() => {
    if (!filtered || selectedNeighborSlugs.size === 0) return [];
    return filtered.nodes.filter((n) => selectedNeighborSlugs.has(n.slug));
  }, [filtered, selectedNeighborSlugs]);

  const sectionCounts = useMemo(() => {
    if (!graph) return {} as Record<string, number>;
    const out: Record<string, number> = {};
    for (const n of graph.nodes) out[n.section] = (out[n.section] || 0) + 1;
    return out;
  }, [graph]);

  // Decide which nodes get a permanent label vs. hover-only.
  //   off  — nothing permanent; hover/selection still reveal a name.
  //   all  — every node labelled.
  //   hubs — top-degree nodes plus the current selection's neighborhood.
  // The hubs default avoids the "labels piled on top of each other" problem on
  // dense graphs while keeping the view readable.
  const labelSet = useMemo(() => {
    if (!filtered || labelMode === "off") return new Set<string>();
    if (labelMode === "all") return new Set(filtered.nodes.map((n) => n.slug));
    const set = new Set<string>();
    const sorted = [...filtered.nodes].sort((a, b) => b.degree - a.degree);
    // Show top 6 by degree as permanent labels.
    for (const n of sorted.slice(0, 6)) set.add(n.slug);
    if (selectedSlug) {
      set.add(selectedSlug);
      for (const n of selectedNeighbors) set.add(n.slug);
    }
    return set;
  }, [filtered, selectedSlug, selectedNeighbors, labelMode]);

  // Tune the d3-force layout when graph data changes. Small wikis still get
  // collision; dense graphs skip it (O(n^2)) and do not reheat — reheating
  // plus a timed zoomToFit was both the jank and the random corner-zoom.
  useEffect(() => {
    if (!fgRef.current || !filtered || filtered.nodes.length === 0) return;
    const fg = fgRef.current;
    const linkF = fg.d3Force("link");
    if (linkF) linkF.distance(profile.linkDistance).strength(profile.linkStrength);
    const chargeF = fg.d3Force("charge");
    if (chargeF) {
      chargeF.strength(profile.chargeStrength).distanceMax(profile.chargeDistanceMax);
      if (typeof chargeF.theta === "function") chargeF.theta(profile.chargeTheta);
    }
    if (!profile.useCollision) {
      fg.d3Force("collision", null);
      // Reheat even without collision: on the huge/large tiers useCollision is
      // false, and without d3ReheatSimulation() the tuned charge/link forces
      // are never applied and the simulation stays as a tight default clump.
      // This is what made "first load" look like an overlapping blob until the
      // user clicked Relax (which reheats). Now the layout spreads on mount.
      fg.d3ReheatSimulation();
      return;
    }
    let cancelled = false;
    import("d3-force").then(({ forceCollide }) => {
      if (cancelled || fgRef.current !== fg) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fg.d3Force("collision", forceCollide((d: any) => {
        return nodeRadius(d.degree || 1) + 14;
      }).strength(0.7));
      fg.d3ReheatSimulation();
    });
    return () => {
      cancelled = true;
    };
  }, [filtered, profile, size]);

  useEffect(() => {
    if (!size || data.nodes.length === 0) return;
    const t = window.setTimeout(() => {
      tryZoomToFit(fgRef.current, nodesRef.current, 60);
    }, 80);
    return () => window.clearTimeout(t);
  }, [size?.w, size?.h, data.nodes.length, data.links.length]);

  return (
    <div className="max-w-7xl mx-auto px-5 py-6">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge graph</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every visible page is a node. Every <code>[[wikilink]]</code> is an edge.
            Click a node to see its connections. The query engine uses this graph for
            retrieval: anchors come from keyword scoring, then expand 1 hop along
            wikilinks.
          </p>
        </div>
        {graph && (
          <div className="flex gap-3 text-xs text-ink-muted">
            <span>
              <span className="font-semibold text-ink">{graph.nodes.length}</span> nodes
            </span>
            <span>
              <span className="font-semibold text-ink">{graph.edges.length}</span> edges
            </span>
            <span>
              avg degree{" "}
              <span className="font-semibold text-ink">
                {graph.nodes.length
                  ? ((graph.edges.length * 2) / graph.nodes.length).toFixed(1)
                  : "0"}
              </span>
            </span>
            {layoutEdges.length < graph.edges.length && (
              <span title="The force layout uses a hub backbone so the animation stays responsive. Select a node to see its real neighborhood.">
                layout {layoutEdges.length} edges
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!isOwner && graph && (
        <div className="mt-4 p-3 rounded border border-paper-soft bg-paper-soft/50 text-ink text-sm flex items-baseline gap-3 flex-wrap">
          <span className="font-semibold">Public view.</span>
          <span className="text-ink-muted leading-relaxed">
            You&apos;re seeing the {graph.nodes.length} pages tagged{" "}
            <code className="font-mono text-[12px]">tier: public</code>. Pages
            tagged <code className="font-mono text-[12px]">recruiter</code>,{" "}
            <code className="font-mono text-[12px]">friend</code>, or{" "}
            <code className="font-mono text-[12px]">private</code> are gated
            behind a share token or owner auth. They exist in this demo
            instance but are hidden from anonymous visitors. On your own
            instance you&apos;d see everything.{" "}
            <Link
              href={`${tenant ? `/${tenant}` : ""}/owner`}
              className="underline font-medium text-ink hover:text-accent"
            >
              owner authentication →
            </Link>
          </span>
        </div>
      )}

      <div className="mt-4 flex gap-2 flex-wrap items-center">
        <span className="text-xs text-ink-muted uppercase tracking-wider">Filter:</span>
        <button
          onClick={() => setSectionFilter("")}
          className={`text-xs px-2 py-1 rounded border ${
            sectionFilter === ""
              ? "border-ink text-ink"
              : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
          }`}
        >
          all ({graph?.nodes.length ?? 0})
        </button>
        {Object.entries(sectionCounts).map(([s, n]) => (
          <button
            key={s}
            onClick={() => setSectionFilter(s)}
            className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${
              sectionFilter === s
                ? "border-ink text-ink"
                : "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
            }`}
          >
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: SECTION_COLORS[s] || SECTION_COLORS.other }}
            />
            {s} ({n})
          </button>
        ))}

        <span className="ml-auto flex gap-2">
          <button
            onClick={() =>
              setLabelMode(
                (m) =>
                  LABEL_MODE_ORDER[
                    (LABEL_MODE_ORDER.indexOf(m) + 1) % LABEL_MODE_ORDER.length
                  ],
              )
            }
            className={`text-xs px-2 py-1 rounded border ${
              labelMode === "off"
                ? "border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
                : "border-accent text-accent"
            }`}
            title="Cycle labels: hubs only → all → off"
          >
            {LABEL_MODE_TEXT[labelMode]}
          </button>
          <button
            onClick={() => tryZoomToFit(fgRef.current, nodesRef.current, 80, 500)}
            className="text-xs px-2 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
            title="Fit graph to view"
          >
            recenter
          </button>
          <button
            onClick={() => {
              setLayoutPhase("running");
              fgRef.current?.d3ReheatSimulation?.();
            }}
            className="text-xs px-2 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
            title="Re-run layout simulation"
          >
            relax
          </button>
        </span>
      </div>

      <div className="mt-4 grid lg:grid-cols-[1fr_320px] gap-5">
        <div
          ref={wrapperRef}
          className="bg-white border border-paper-soft rounded-xl overflow-hidden"
          style={{ height: "78vh", minHeight: 600 }}
        >
          {!size || data.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-ink-muted">
              {graph && data.nodes.length === 0
                ? "no pages match the current filter"
                : "loading…"}
            </div>
          ) : (
            <ForceGraphCanvas
              graphRef={fgRef}
              width={size.w}
              height={size.h}
              graphData={data}
              backgroundColor="#fafaf7"
              nodeRelSize={6}
              cooldownTicks={profile.cooldownTicks}
              cooldownTime={profile.cooldownTime}
              warmupTicks={profile.warmupTicks}
              d3AlphaDecay={profile.alphaDecay}
              d3AlphaMin={profile.alphaMin}
              d3VelocityDecay={profile.velocityDecay}
              autoPauseRedraw
              enablePointerInteraction={layoutPhase === "settled"}
              onEngineStop={() => {
                setLayoutPhase("settled");
                tryZoomToFit(fgRef.current, nodesRef.current, 60, 500);
                labelRectsRef.current = [];
              }}
              onRenderFramePre={() => {
                labelRectsRef.current = [];
              }}
              onRenderFramePost={(ctx: CanvasRenderingContext2D) => {
                if (layoutPhase !== "settled") return;
                const focus = selectedSlug ?? hoveredSlugRef.current;
                if (!focus) return;
                paintFocusEdges(ctx, nodesBySlug, fullEdgesRef.current, focus, {
                  color: selectedSlug
                    ? "rgba(255,106,0,0.55)"
                    : "rgba(14,14,16,0.28)",
                  width: selectedSlug ? 1.6 : 1,
                });
              }}
              linkVisibility={(link: unknown) => {
                if (layoutPhase !== "settled") return false;
                if (selectedSlug || hoveredSlugRef.current) return false;
                const typed = link as { source?: unknown; target?: unknown };
                const s = linkEndpointId(typed.source);
                const tId = linkEndpointId(typed.target);
                return shouldPaintLink(s, tId, {
                  edgeCount: fullEdgesRef.current.length,
                  focusSlug: null,
                  maxIdleEdges: profile.maxIdleEdges,
                });
              }}
              linkColor={() => "rgba(14,14,16,0.12)"}
              linkWidth={0.6}
              linkDirectionalArrowLength={0}
              onNodeHover={(node: unknown) => {
                const n = node as { slug?: string } | null;
                const slug = n?.slug ?? null;
                if (hoveredSlugRef.current === slug) return;
                hoveredSlugRef.current = slug;
                if (wrapperRef.current) {
                  wrapperRef.current.style.cursor = slug ? "pointer" : "default";
                }
                requestGraphRedraw(fgRef.current);
              }}
              onNodeClick={(node: unknown) => {
                const n = node as { slug?: string } | null;
                if (n?.slug) setSelectedSlug(n.slug);
              }}
              onBackgroundClick={() => setSelectedSlug(null)}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
                const radius = nodeRadius(node.degree || 1);
                const fill = SECTION_COLORS[node.section] || SECTION_COLORS.other;
                if (layoutPhase !== "settled") {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                  ctx.fillStyle = fill;
                  ctx.fill();
                  return;
                }

                const isSelected = node.slug === selectedSlug;
                const isHovered = node.slug === hoveredSlugRef.current;
                const isNeighbor = selectedNeighborSlugs.has(node.slug);
                const ring = TIER_RING[node.tier] || "#999";

                ctx.beginPath();
                ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                ctx.fillStyle = fill;
                ctx.globalAlpha =
                  selectedSlug && !(isSelected || isNeighbor) ? 0.18 : 1.0;
                ctx.fill();
                ctx.globalAlpha = 1.0;
                // Suppress confetti rings on huge graphs: only paint rings for
                // focused / neighbor nodes or when the node is large enough on
                // screen. Ring width scales with 1/scale like labels do.
                const isHugeTier = profile.maxIdleEdges <= 900;
                const shouldPaintRing =
                  isSelected || isHovered || isNeighbor || !isHugeTier;
                if (shouldPaintRing) {
                  const baseWidth = isSelected ? 3 : isHovered ? 2 : 1.5;
                  const scaledWidth = baseWidth / Math.max(0.85, scale);
                  // On huge tier at low zoom, skip faint background rings when
                  // the node itself is sub-pixel small.
                  if (!isHugeTier || isSelected || isHovered || isNeighbor || radius * scale >= 2.4) {
                    ctx.lineWidth = scaledWidth;
                    ctx.strokeStyle = isSelected ? "#0e0e10" : ring;
                    ctx.stroke();
                  }
                }

                const shouldLabel =
                  isSelected ||
                  isHovered ||
                  labelSet.has(node.slug) ||
                  (labelMode !== "off" && scale > 1.6);
                if (!shouldLabel) return;

                const fullTitle = node.title as string;
                const label =
                  isSelected || isHovered || scale > 2 || fullTitle.length <= 26
                    ? fullTitle
                    : fullTitle.slice(0, 24) + "…";
                const fontSize = Math.max(9, 11 / Math.max(0.6, scale));
                ctx.font = `${isSelected || isHovered ? "600 " : ""}${fontSize}px ui-sans-serif`;
                const padX = 4 / scale;
                const padY = 2 / scale;
                const textW = ctx.measureText(label).width;
                const gap = 4 / scale;
                const chosen = pickLabelAnchor(
                  [
                    { x: node.x, y: node.y + radius + gap, ax: "center", ay: "top" },
                    { x: node.x, y: node.y - radius - gap, ax: "center", ay: "bottom" },
                    { x: node.x + radius + gap, y: node.y, ax: "left", ay: "middle" },
                    { x: node.x - radius - gap, y: node.y, ax: "right", ay: "middle" },
                  ],
                  textW,
                  fontSize,
                  padX,
                  padY,
                  labelRectsRef.current,
                  isSelected || isHovered,
                );
                if (!chosen) return;

                const { rect, anchor } = chosen;
                ctx.fillStyle =
                  isSelected || isHovered
                    ? "rgba(250,250,247,0.95)"
                    : "rgba(250,250,247,0.85)";
                ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
                ctx.fillStyle = isSelected || isHovered ? "#0e0e10" : "#525258";
                ctx.textAlign = anchor.ax;
                ctx.textBaseline = anchor.ay;
                ctx.fillText(label, anchor.x, anchor.y);
                labelRectsRef.current.push(rect);
              }}
              // Increase the painted hit-area so clicks/hovers are forgiving.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                if (layoutPhase !== "settled") return;
                const radius = Math.max(8, nodeRadius(node.degree || 1) + 2);
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                ctx.fill();
              }}
            />
          )}
        </div>

        <aside className="bg-white border border-paper-soft rounded-xl p-4 h-fit">
          {selectedNode ? (
            <SelectedPanel
              node={selectedNode}
              neighbors={selectedNeighbors}
              onClear={() => setSelectedSlug(null)}
              tenant={tenant}
            />
          ) : (
            <Legend />
          )}
        </aside>
      </div>

      <section className="mt-6 bg-white border border-paper-soft rounded-xl p-4">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
          Hubs (most-connected pages)
        </h2>
        {graph ? (
          <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {[...graph.nodes]
              .sort((a, b) => b.degree - a.degree)
              .slice(0, 10)
              .map((n, i) => (
                <li key={n.slug} className="flex items-baseline gap-2">
                  <span className="text-ink-muted text-xs w-5 tabular-nums">{i + 1}.</span>
                  <Link
                    href={`${tenant ? `/${tenant}` : ""}/page/${encodeURIComponent(n.slug)}`}
                    className="text-ink hover:text-accent flex-1 truncate"
                  >
                    {n.title}
                  </Link>
                  <span className="text-xs text-ink-muted tabular-nums">{n.degree}</span>
                </li>
              ))}
          </ol>
        ) : (
          <div className="text-sm text-ink-muted">…</div>
        )}
      </section>
    </div>
  );
}

function Legend() {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-ink-muted mb-2">Legend</h3>
      <div className="text-sm space-y-1">
        <p className="text-ink-muted text-xs leading-relaxed">
          Fill color shows section. Ring color shows tier. Node size grows with degree.
        </p>
      </div>
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">Sections</div>
        <div className="space-y-1">
          {Object.entries(SECTION_COLORS).map(([s, c]) => (
            <div key={s} className="flex items-center gap-2 text-xs">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: c }} />
              <span>{s}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">Tiers</div>
        <div className="space-y-1">
          {Object.entries(TIER_RING).map(([t, c]) => (
            <div key={t} className="flex items-center gap-2 text-xs">
              <span
                className="inline-block w-3 h-3 rounded-full border-2"
                style={{ borderColor: c, background: "transparent" }}
              />
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 pt-3 border-t border-paper-soft text-xs text-ink-muted">
        Click any node to inspect its neighborhood.
      </div>
    </div>
  );
}

function SelectedPanel({
  node,
  neighbors,
  onClear,
  tenant,
}: {
  node: GraphNode;
  neighbors: GraphNode[];
  onClear: () => void;
  tenant?: string;
}) {
  const prefix = tenant ? `/${tenant}` : "";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-ink leading-tight">{node.title}</h3>
        <button
          onClick={onClear}
          className="text-xs text-ink-muted hover:text-ink"
        >
          clear
        </button>
      </div>
      <div className="mt-1 flex gap-2 text-xs text-ink-muted">
        <span>{node.section}</span>
        <span>·</span>
        <span>{node.tier}</span>
        <span>·</span>
        <span>degree {node.degree}</span>
      </div>
      <Link
        href={`${prefix}/page/${encodeURIComponent(node.slug)}`}
        className="mt-3 inline-block text-xs text-accent hover:underline"
      >
        open page →
      </Link>
      <h4 className="mt-5 text-[10px] uppercase tracking-wider text-ink-muted mb-1">
        Neighbors ({neighbors.length})
      </h4>
      <ul className="text-sm space-y-1 max-h-64 overflow-y-auto">
        {neighbors.map((n) => (
          <li key={n.slug}>
            <Link
              href={`${prefix}/page/${encodeURIComponent(n.slug)}`}
              className="text-ink hover:text-accent text-xs"
            >
              · {n.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
