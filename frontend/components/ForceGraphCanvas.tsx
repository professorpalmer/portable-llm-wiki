"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GraphEdge, GraphNode, GraphResponse } from "@/lib/api";
import {
  buildSpatialGrid,
  fitCamera,
  hitTestSpatialGrid,
  interpolatePositions,
  nodeRadius,
  screenToWorld,
  zoomAroundPoint,
  type Camera,
  type SpatialGrid,
  type Viewport,
} from "@/lib/graphGeometry";
import {
  initialGraphPositions,
  layoutNodes,
  positionsFromResponse,
  readCachedLayout,
  topologyFingerprint,
  visibleLinks,
  writeCachedLayout,
  type GraphPosition,
  type LayoutResponse,
  type LayoutStart,
} from "@/lib/graphLayout";

export type GraphLabelMode = "hubs" | "all" | "off";
export type ForceGraphCanvasHandle = Readonly<{
  recenter(): void;
  relax(): void;
}>;

type ForceGraphCanvasProps = Readonly<{
  graph: GraphResponse;
  tenant?: string;
  sectionFilter: string;
  selectedSlug: string | null;
  labelMode: GraphLabelMode;
  onSelect(slug: string | null): void;
}>;

type PointerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  camera: Camera;
  nodeId: string | null;
  moved: boolean;
};

const SECTION_COLORS: Readonly<Record<string, string>> = {
  entities: "#3b82f6",
  concepts: "#8b5cf6",
  decisions: "#10b981",
  sources: "#94a3b8",
  queries: "#f59e0b",
  projects: "#ff6a00",
  root: "#0e0e10",
  other: "#6b7280",
};

const TIER_RING: Readonly<Record<string, string>> = {
  public: "#10b981",
  recruiter: "#3b82f6",
  friend: "#8b5cf6",
  private: "#ef4444",
};

const LAYOUT_MOTION_MS = 220;
const CAMERA_MOTION_MS = 220;
const TEXT_CACHE_LIMIT = 512;

function edgePath(edges: ReadonlyArray<GraphEdge>, positions: ReadonlyMap<string, GraphPosition>): Path2D {
  const path = new Path2D();
  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    path.moveTo(source.x, source.y);
    path.lineTo(target.x, target.y);
  }
  return path;
}

function pointInCanvas(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  canvas: HTMLCanvasElement,
): GraphPosition {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function rectanglesOverlap(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

const ForceGraphCanvas = forwardRef<ForceGraphCanvasHandle, ForceGraphCanvasProps>(
  function ForceGraphCanvas(
    { graph, tenant, sectionFilter, selectedSlug, labelMode, onSelect },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const viewportRef = useRef<Viewport>({ width: 1, height: 1 });
    const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
    const positionsRef = useRef<Map<string, GraphPosition>>(new Map());
    const spatialGridRef = useRef<SpatialGrid>(new Map());
    const baselinePathRef = useRef<Path2D | null>(null);
    const focusedPathRef = useRef<Path2D | null>(null);
    const visibleNodesRef = useRef<GraphNode[]>([]);
    const rankedNodesRef = useRef<GraphNode[]>([]);
    const visibleEdgesRef = useRef<GraphEdge[]>([]);
    const nodesByIdRef = useRef<Map<string, GraphNode>>(new Map());
    const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
    const selectedSlugRef = useRef(selectedSlug);
    const labelModeRef = useRef(labelMode);
    const hoverRef = useRef<string | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const generationRef = useRef(0);
    const drawFrameRef = useRef<number | null>(null);
    const positionIndexesDirtyRef = useRef(false);
    const motionFrameRef = useRef<number | null>(null);
    const cameraFrameRef = useRef<number | null>(null);
    const pointerRef = useRef<PointerGesture | null>(null);
    const textWidthsRef = useRef<Map<string, number>>(new Map());
    const reducedMotionRef = useRef(false);
    const userNavigatedRef = useRef(false);
    const layoutReadyRef = useRef(false);
    const topologyRef = useRef("");
    const tenantRef = useRef(tenant);
    const drawRef = useRef<() => void>(() => undefined);
    const startLayoutRef = useRef<() => void>(() => undefined);

    const fingerprint = useMemo(() => topologyFingerprint(graph), [graph]);
    const nodesById = useMemo(
      () => new Map(graph.nodes.map((node) => [node.slug, node])),
      [graph],
    );
    const adjacency = useMemo(() => {
      const result = new Map<string, Set<string>>();
      for (const edge of graph.edges) {
        const source = result.get(edge.source) ?? new Set<string>();
        source.add(edge.target);
        result.set(edge.source, source);
        const target = result.get(edge.target) ?? new Set<string>();
        target.add(edge.source);
        result.set(edge.target, target);
      }
      return result;
    }, [graph]);
    const visibleNodes = useMemo(
      () => sectionFilter
        ? graph.nodes.filter((node) => node.section === sectionFilter)
        : graph.nodes,
      [graph, sectionFilter],
    );
    const visibleNodeIds = useMemo(
      () => new Set(visibleNodes.map((node) => node.slug)),
      [visibleNodes],
    );
    const rankedNodes = useMemo(
      () => [...visibleNodes].sort((left, right) => right.degree - left.degree),
      [visibleNodes],
    );
    const visibleEdges = useMemo(
      () => visibleLinks(graph.edges, visibleNodeIds),
      [graph, visibleNodeIds],
    );

    const rebuildPositionIndexes = useCallback(() => {
      positionIndexesDirtyRef.current = false;
      const nodeIds = visibleNodesRef.current.map((node) => node.slug);
      spatialGridRef.current = buildSpatialGrid(nodeIds, positionsRef.current);
      baselinePathRef.current = edgePath(visibleEdgesRef.current, positionsRef.current);
      const selected = selectedSlugRef.current;
      focusedPathRef.current = selected
        ? edgePath(
            visibleEdgesRef.current.filter(
              (edge) => edge.source === selected || edge.target === selected,
            ),
            positionsRef.current,
          )
        : null;
    }, []);

    const requestDraw = useCallback(() => {
      if (drawFrameRef.current !== null) return;
      drawFrameRef.current = window.requestAnimationFrame(() => {
        drawFrameRef.current = null;
        if (positionIndexesDirtyRef.current) rebuildPositionIndexes();
        drawRef.current();
      });
    }, [rebuildPositionIndexes]);

    const measureText = useCallback((context: CanvasRenderingContext2D, key: string, text: string) => {
      const cache = textWidthsRef.current;
      const cached = cache.get(key);
      if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const width = context.measureText(text).width;
      cache.set(key, width);
      if (cache.size > TEXT_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (typeof oldest === "string") cache.delete(oldest);
      }
      return width;
    }, []);

    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const viewport = viewportRef.current;
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const camera = cameraRef.current;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      context.fillStyle = "#fafaf7";
      context.fillRect(0, 0, viewport.width, viewport.height);
      context.save();
      context.translate(camera.x, camera.y);
      context.scale(camera.scale, camera.scale);
      if (baselinePathRef.current) {
        context.strokeStyle = "rgba(14,14,16,0.12)";
        context.lineWidth = 0.7 / camera.scale;
        context.stroke(baselinePathRef.current);
      }
      if (focusedPathRef.current) {
        context.strokeStyle = "rgba(255,106,0,0.65)";
        context.lineWidth = 1.8 / camera.scale;
        context.stroke(focusedPathRef.current);
      }
      const selected = selectedSlugRef.current;
      const hovered = hoverRef.current;
      const neighbors = selected ? adjacencyRef.current.get(selected) ?? new Set<string>() : new Set<string>();
      for (const node of visibleNodesRef.current) {
        const position = positionsRef.current.get(node.slug);
        if (!position) continue;
        const isSelected = node.slug === selected;
        const isHovered = node.slug === hovered;
        const isNeighbor = neighbors.has(node.slug);
        context.globalAlpha = selected && !isSelected && !isNeighbor ? 0.2 : 1;
        context.beginPath();
        context.arc(position.x, position.y, nodeRadius(node.degree), 0, Math.PI * 2);
        context.fillStyle = SECTION_COLORS[node.section] ?? SECTION_COLORS.other;
        context.fill();
        context.lineWidth = isSelected ? 3 : isHovered ? 2 : 1.5;
        context.strokeStyle = isSelected ? "#0e0e10" : TIER_RING[node.tier] ?? "#999999";
        context.stroke();
      }
      context.globalAlpha = 1;
      context.restore();

      const forcedIds = [selected, hovered].filter((id): id is string => id !== null);
      const maxLabels = Math.max(1, Math.min(180, Math.floor((viewport.width * viewport.height) / 4_000)));
      const mode = labelModeRef.current;
      const onScreen = mode === "off" ? [] : rankedNodesRef.current.filter((node) => {
        const position = positionsRef.current.get(node.slug);
        if (!position) return false;
        const x = camera.x + position.x * camera.scale;
        const y = camera.y + position.y * camera.scale;
        return x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height;
      });
      const ordinary = mode === "hubs" ? onScreen.slice(0, 12) : onScreen.slice(0, maxLabels * 2);
      const candidateIds = [...new Set([...forcedIds, ...ordinary.map((node) => node.slug)])];
      const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
      let painted = 0;
      for (const id of candidateIds) {
        const forced = forcedIds.includes(id);
        if (!forced && painted >= maxLabels) break;
        const node = nodesByIdRef.current.get(id);
        const position = positionsRef.current.get(id);
        if (!node || !position) continue;
        const title = forced || camera.scale > 2 || node.title.length <= 28
          ? node.title
          : `${node.title.slice(0, 26)}…`;
        const font = forced ? "600 12px ui-sans-serif" : "11px ui-sans-serif";
        context.font = font;
        const width = measureText(context, `${forced ? "600" : "400"}\u0000${title}`, title);
        const screenX = camera.x + position.x * camera.scale;
        const screenY = camera.y + position.y * camera.scale;
        const radius = nodeRadius(node.degree) * camera.scale;
        const rect = { x: screenX - width / 2 - 4, y: screenY + radius + 4, width: width + 8, height: 17 };
        if (!forced && occupied.some((other) => rectanglesOverlap(rect, other))) continue;
        context.fillStyle = forced ? "rgba(250,250,247,0.96)" : "rgba(250,250,247,0.86)";
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
        context.fillStyle = forced ? "#0e0e10" : "#525258";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillText(title, screenX, rect.y + 2);
        occupied.push(rect);
        painted += 1;
      }
    };

    const cancelCameraMotion = useCallback(() => {
      if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }, []);

    const animateCamera = useCallback((target: Camera) => {
      cancelCameraMotion();
      if (reducedMotionRef.current) {
        cameraRef.current = target;
        requestDraw();
        return;
      }
      const start = cameraRef.current;
      const startedAt = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / CAMERA_MOTION_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        cameraRef.current = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          scale: start.scale + (target.scale - start.scale) * eased,
        };
        requestDraw();
        if (progress < 1) cameraFrameRef.current = window.requestAnimationFrame(step);
        else cameraFrameRef.current = null;
      };
      cameraFrameRef.current = window.requestAnimationFrame(step);
    }, [cancelCameraMotion, requestDraw]);

    const recenter = useCallback((animate = true) => {
      const target = fitCamera(
        visibleNodesRef.current,
        positionsRef.current,
        viewportRef.current,
      );
      if (animate) animateCamera(target);
      else {
        cameraRef.current = target;
        requestDraw();
      }
    }, [animateCamera, requestDraw]);

    const finishLayout = useCallback((response: LayoutResponse) => {
      if (response.generation !== generationRef.current) return;
      generationRef.current += 1;
      workerRef.current?.terminate();
      workerRef.current = null;
      layoutReadyRef.current = true;
      if (response.kind === "error") {
        if (!userNavigatedRef.current) recenter(false);
        requestDraw();
        return;
      }
      const target = positionsFromResponse(response);
      if (target.size !== graph.nodes.length || graph.nodes.some((node) => !target.has(node.slug))) {
        if (!userNavigatedRef.current) recenter(false);
        return;
      }
      writeCachedLayout(tenantRef.current, topologyRef.current, target);
      const start = new Map(positionsRef.current);
      const applyFinal = () => {
        positionsRef.current = target;
        rebuildPositionIndexes();
        requestDraw();
        if (!userNavigatedRef.current) recenter(false);
      };
      if (reducedMotionRef.current) {
        applyFinal();
        return;
      }
      if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
      const startedAt = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / LAYOUT_MOTION_MS);
        positionsRef.current = interpolatePositions(start, target, progress);
        rebuildPositionIndexes();
        requestDraw();
        if (progress < 1) motionFrameRef.current = window.requestAnimationFrame(step);
        else {
          motionFrameRef.current = null;
          applyFinal();
        }
      };
      motionFrameRef.current = window.requestAnimationFrame(step);
    }, [graph.nodes, rebuildPositionIndexes, recenter, requestDraw]);

    const startLayout = useCallback(() => {
      if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
      motionFrameRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      generationRef.current += 1;
      const generation = generationRef.current;
      if (typeof Worker === "undefined") {
        layoutReadyRef.current = true;
        if (!userNavigatedRef.current) recenter(false);
        requestDraw();
        return;
      }
      try {
        const worker = new Worker(new URL("../workers/graphLayout.worker.ts", import.meta.url), { type: "module" });
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<LayoutResponse>) => finishLayout(event.data);
        worker.onerror = () => finishLayout({ kind: "error", generation, message: "layout worker failed" });
        const message: LayoutStart = {
          kind: "start",
          generation,
          nodes: layoutNodes(graph, positionsRef.current),
          links: graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
        };
        worker.postMessage(message);
      } catch {
        finishLayout({ kind: "error", generation, message: "layout worker unavailable" });
      }
    }, [finishLayout, graph, recenter, requestDraw]);
    startLayoutRef.current = startLayout;

    useImperativeHandle(ref, () => ({
      recenter: () => {
        userNavigatedRef.current = true;
        recenter(true);
      },
      relax: () => startLayoutRef.current(),
    }), [recenter]);

    useEffect(() => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => { reducedMotionRef.current = query.matches; };
      update();
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }, []);

    useEffect(() => {
      nodesByIdRef.current = nodesById;
      adjacencyRef.current = adjacency;
    }, [adjacency, nodesById]);

    useEffect(() => {
      selectedSlugRef.current = selectedSlug;
      focusedPathRef.current = selectedSlug
        ? edgePath(
            visibleEdgesRef.current.filter(
              (edge) => edge.source === selectedSlug || edge.target === selectedSlug,
            ),
            positionsRef.current,
          )
        : null;
      requestDraw();
    }, [requestDraw, selectedSlug]);

    useEffect(() => {
      labelModeRef.current = labelMode;
      requestDraw();
    }, [labelMode, requestDraw]);

    useEffect(() => {
      visibleNodesRef.current = visibleNodes;
      rankedNodesRef.current = rankedNodes;
      visibleEdgesRef.current = visibleEdges;
      rebuildPositionIndexes();
      if (layoutReadyRef.current) recenter(true);
      else requestDraw();
    }, [rankedNodes, rebuildPositionIndexes, recenter, requestDraw, visibleEdges, visibleNodes]);

    useEffect(() => {
      topologyRef.current = fingerprint;
      tenantRef.current = tenant;
      userNavigatedRef.current = false;
      const cached = readCachedLayout(tenant, fingerprint);
      positionsRef.current = cached ?? initialGraphPositions(graph);
      layoutReadyRef.current = cached !== null;
      rebuildPositionIndexes();
      if (cached) recenter(false);
      else startLayout();
      return () => {
        generationRef.current += 1;
        workerRef.current?.terminate();
        workerRef.current = null;
        if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
        motionFrameRef.current = null;
      };
    }, [fingerprint, graph, rebuildPositionIndexes, recenter, startLayout, tenant]);

    useEffect(() => {
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (!host || !canvas) return;
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        const previous = viewportRef.current;
        const viewport = {
          width: Math.max(1, Math.floor(rect.width)),
          height: Math.max(1, Math.floor(rect.height)),
        };
        viewportRef.current = viewport;
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        if (previous.width <= 1 && layoutReadyRef.current && !userNavigatedRef.current) recenter(false);
        else {
          cameraRef.current = {
            ...cameraRef.current,
            x: cameraRef.current.x + (viewport.width - previous.width) / 2,
            y: cameraRef.current.y + (viewport.height - previous.height) / 2,
          };
          requestDraw();
        }
      });
      observer.observe(host);
      return () => observer.disconnect();
    }, [recenter, requestDraw]);

    useEffect(() => () => {
      if (drawFrameRef.current !== null) window.cancelAnimationFrame(drawFrameRef.current);
      if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
      drawFrameRef.current = null;
      cameraFrameRef.current = null;
      workerRef.current?.terminate();
    }, []);

    const hitTest = useCallback((point: GraphPosition) => {
      const world = screenToWorld(point, cameraRef.current);
      return hitTestSpatialGrid(
        spatialGridRef.current,
        positionsRef.current,
        nodesByIdRef.current,
        world,
        9 / cameraRef.current.scale,
      );
    }, []);

    const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0 || pointerRef.current) return;
      cancelCameraMotion();
      const point = pointInCanvas(event.nativeEvent, event.currentTarget);
      pointerRef.current = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        camera: cameraRef.current,
        nodeId: hitTest(point),
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = pointInCanvas(event.nativeEvent, event.currentTarget);
      const gesture = pointerRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        const hovered = hitTest(point);
        if (hovered !== hoverRef.current) {
          hoverRef.current = hovered;
          event.currentTarget.style.cursor = hovered ? "pointer" : "grab";
          requestDraw();
        }
        return;
      }
      const dx = point.x - gesture.startX;
      const dy = point.y - gesture.startY;
      if (Math.hypot(dx, dy) > 3) gesture.moved = true;
      if (!gesture.moved) return;
      if (gesture.nodeId) {
        if (gesture.moved && workerRef.current) {
          generationRef.current += 1;
          workerRef.current.terminate();
          workerRef.current = null;
          layoutReadyRef.current = true;
        }
        if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
        motionFrameRef.current = null;
        userNavigatedRef.current = true;
        positionsRef.current.set(gesture.nodeId, screenToWorld(point, cameraRef.current));
        positionIndexesDirtyRef.current = true;
      } else {
        userNavigatedRef.current = true;
        cameraRef.current = { ...gesture.camera, x: gesture.camera.x + dx, y: gesture.camera.y + dy };
      }
      event.currentTarget.style.cursor = "grabbing";
      requestDraw();
    };

    const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
      const gesture = pointerRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      pointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.currentTarget.style.cursor = "grab";
      if (cancelled) return;
      if (gesture.nodeId) {
        if (!gesture.moved) onSelect(gesture.nodeId);
        else writeCachedLayout(tenantRef.current, topologyRef.current, positionsRef.current);
      } else if (!gesture.moved) onSelect(null);
    };

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const handleWheel = (event: WheelEvent) => {
        event.preventDefault();
        cancelCameraMotion();
        userNavigatedRef.current = true;
        const point = pointInCanvas(event, canvas);
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current.height : 1);
        cameraRef.current = zoomAroundPoint(
          cameraRef.current,
          point,
          cameraRef.current.scale * Math.exp(-delta * 0.0015),
        );
        requestDraw();
      };
      canvas.addEventListener("wheel", handleWheel, { passive: false });
      return () => canvas.removeEventListener("wheel", handleWheel);
    }, [cancelCameraMotion, requestDraw]);

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      cancelCameraMotion();
      const camera = cameraRef.current;
      const pan = 36;
      if (event.key === "Escape") onSelect(null);
      else if (event.key === "0") {
        userNavigatedRef.current = true;
        recenter(false);
      }
      else if (event.key === "+" || event.key === "=") {
        userNavigatedRef.current = true;
        cameraRef.current = zoomAroundPoint(camera, { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 }, camera.scale * 1.2);
      } else if (event.key === "-" || event.key === "_") {
        userNavigatedRef.current = true;
        cameraRef.current = zoomAroundPoint(camera, { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 }, camera.scale / 1.2);
      } else if (event.key === "ArrowLeft") {
        userNavigatedRef.current = true;
        cameraRef.current = { ...camera, x: camera.x + pan };
      } else if (event.key === "ArrowRight") {
        userNavigatedRef.current = true;
        cameraRef.current = { ...camera, x: camera.x - pan };
      } else if (event.key === "ArrowUp") {
        userNavigatedRef.current = true;
        cameraRef.current = { ...camera, y: camera.y + pan };
      } else if (event.key === "ArrowDown") {
        userNavigatedRef.current = true;
        cameraRef.current = { ...camera, y: camera.y - pan };
      } else return;
      event.preventDefault();
      requestDraw();
    };

    return (
      <div ref={hostRef} className="h-full w-full min-w-0 bg-[#fafaf7]">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          role="application"
          tabIndex={0}
          aria-label="Knowledge graph. Drag to pan or move nodes. Scroll to zoom. Arrow keys pan, plus and minus zoom, zero recenters, and Escape clears selection."
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishPointer(event, false)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onLostPointerCapture={() => { pointerRef.current = null; }}
          onKeyDown={handleKeyDown}
        />
      </div>
    );
  },
);

export default ForceGraphCanvas;
