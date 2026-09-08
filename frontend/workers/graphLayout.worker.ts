import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { LayoutResponse, LayoutStart } from "@/lib/graphLayout";

type WorkerNode = SimulationNodeDatum & { id: string; degree: number };
type WorkerLink = SimulationLinkDatum<WorkerNode>;
const MAX_ITERATIONS = 380;
const MAX_RUNTIME_MS = 3_500;

self.onmessage = (event: MessageEvent<LayoutStart>) => {
  const message = event.data;
  if (message.kind !== "start") return;
  try {
    const nodes: WorkerNode[] = message.nodes.map((node) => ({ ...node }));
    const links: WorkerLink[] = message.links.map((link) => ({ source: link.source, target: link.target }));
    const simulation = forceSimulation(nodes)
      // Match the original renderer's initial layout: degree-weighted links
      // keep global index pages from flattening the community structure.
      .force("link", forceLink<WorkerNode, WorkerLink>(links).id((node) => node.id))
      .force("charge", forceManyBody())
      .force("center", forceCenter())
      .alpha(1)
      .alphaDecay(0.018)
      .velocityDecay(0.35)
      .stop();
    const startedAt = performance.now();
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      simulation.tick();
      if (performance.now() - startedAt >= MAX_RUNTIME_MS) break;
    }
    simulation.stop();
    const response: LayoutResponse = {
      kind: "positions",
      generation: message.generation,
      positions: nodes.map((node) => ({
        id: node.id,
        x: Number.isFinite(node.x) ? node.x ?? 0 : 0,
        y: Number.isFinite(node.y) ? node.y ?? 0 : 0,
      })),
    };
    self.postMessage(response);
  } catch (error) {
    const response: LayoutResponse = {
      kind: "error",
      generation: message.generation,
      message: error instanceof Error ? error.message : "layout failed",
    };
    self.postMessage(response);
  }
};
