import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { LayoutFinal, LayoutProgress, LayoutResponse, LayoutStart } from "@/lib/graphLayout";

type WorkerNode = SimulationNodeDatum & { id: string; degree: number };
type WorkerLink = SimulationLinkDatum<WorkerNode>;
const WARMUP_TICKS = 72;
const BATCH_TICKS = 3;
const BATCH_INTERVAL_MS = 50;
const MAX_ITERATIONS = 372;
const MAX_RUNTIME_MS = 5_000;

function snapshot(
  kind: LayoutProgress["kind"] | LayoutFinal["kind"],
  generation: number,
  sequence: number,
  nodes: WorkerNode[],
): LayoutProgress | LayoutFinal {
  return {
    kind,
    generation,
    sequence,
    positions: nodes.map((node) => ({
      id: node.id,
      x: Number.isFinite(node.x) ? node.x ?? 0 : 0,
      y: Number.isFinite(node.y) ? node.y ?? 0 : 0,
    })),
  };
}

function addRelaxImpulse(nodes: WorkerNode[]): void {
  for (const node of nodes) {
    let hash = 2166136261;
    for (let index = 0; index < node.id.length; index += 1) {
      hash = Math.imul(hash ^ node.id.charCodeAt(index), 16777619);
    }
    const angle = ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
    node.vx = Math.cos(angle) * 0.18;
    node.vy = Math.sin(angle) * 0.18;
  }
}

self.onmessage = (event: MessageEvent<LayoutStart>) => {
  const message = event.data;
  if (message.kind !== "start") return;
  try {
    const nodes: WorkerNode[] = message.nodes.map((node) => ({ ...node }));
    const links: WorkerLink[] = message.links.map((link) => ({ source: link.source, target: link.target }));
    if (message.mode === "relax") addRelaxImpulse(nodes);
    const simulation = forceSimulation(nodes)
      // Match the original renderer's initial layout: degree-weighted links
      // keep global index pages from flattening the community structure.
      .force("link", forceLink<WorkerNode, WorkerLink>(links).id((node) => node.id))
      .force("charge", forceManyBody())
      .force("center", forceCenter())
      .alpha(message.mode === "relax" ? 0.8 : 1)
      .alphaDecay(0.018)
      .velocityDecay(0.35)
      .stop();
    const startedAt = performance.now();
    let iterations = 0;
    let sequence = 0;
    const warmupTicks = message.mode === "initial" ? WARMUP_TICKS : 0;
    while (iterations < warmupTicks) {
      simulation.tick();
      iterations += 1;
    }
    if (message.delivery === "final-only") {
      while (iterations < MAX_ITERATIONS && performance.now() - startedAt < MAX_RUNTIME_MS) {
        simulation.tick();
        iterations += 1;
      }
      simulation.stop();
      self.postMessage(snapshot("final", message.generation, sequence, nodes));
      return;
    }
    self.postMessage(snapshot("progress", message.generation, sequence, nodes));
    const runBatch = () => {
      try {
        for (let tick = 0; tick < BATCH_TICKS && iterations < MAX_ITERATIONS; tick += 1) {
          simulation.tick();
          iterations += 1;
        }
        sequence += 1;
        if (iterations >= MAX_ITERATIONS || performance.now() - startedAt >= MAX_RUNTIME_MS) {
          simulation.stop();
          self.postMessage(snapshot("final", message.generation, sequence, nodes));
          return;
        }
        self.postMessage(snapshot("progress", message.generation, sequence, nodes));
        setTimeout(runBatch, BATCH_INTERVAL_MS);
      } catch (error) {
        simulation.stop();
        const response: LayoutResponse = {
          kind: "error",
          generation: message.generation,
          message: error instanceof Error ? error.message : "layout failed",
        };
        self.postMessage(response);
      }
    };
    setTimeout(runBatch, BATCH_INTERVAL_MS);
  } catch (error) {
    const response: LayoutResponse = {
      kind: "error",
      generation: message.generation,
      message: error instanceof Error ? error.message : "layout failed",
    };
    self.postMessage(response);
  }
};
