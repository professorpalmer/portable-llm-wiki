import { act, createRef, StrictMode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForceGraphCanvas, { type ForceGraphCanvasHandle } from "@/components/ForceGraphCanvas";
import type { GraphResponse } from "@/lib/api";
import { clearLayoutCacheForTests, type LayoutResponse, type LayoutStart } from "@/lib/graphLayout";

const graph: GraphResponse = {
  nodes: [
    { slug: "a", title: "A", section: "one", tier: "public", is_anchor: false, degree: 2 },
    { slug: "b", title: "B", section: "one", tier: "friend", is_anchor: false, degree: 2 },
    { slug: "c", title: "C", section: "two", tier: "private", is_anchor: false, degree: 2 },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "a" },
  ],
  anchors: [],
};

class MockPath2D {
  static instances: MockPath2D[] = [];
  lineCount = 0;

  constructor() {
    MockPath2D.instances.push(this);
  }

  moveTo(): void {}

  lineTo(): void {
    this.lineCount += 1;
  }
}

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: LayoutResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }
}

let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRaf = 1;
const context = {
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn(),
  measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  restore: vi.fn(),
  save: vi.fn(),
  scale: vi.fn(),
  setTransform: vi.fn(),
  stroke: vi.fn(),
  translate: vi.fn(),
};

function flushFrames(time = performance.now() + 500): void {
  for (let pass = 0; pass < 6 && rafCallbacks.size > 0; pass += 1) {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks = new Map();
    for (const callback of callbacks) callback(time + pass * 250);
  }
}

function isLayoutStart(message: unknown): message is LayoutStart {
  return Boolean(
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "start" &&
    "generation" in message &&
    typeof message.generation === "number" &&
    "nodes" in message &&
    Array.isArray(message.nodes) &&
    "links" in message &&
    Array.isArray(message.links),
  );
}

function startMessage(worker: MockWorker): LayoutStart {
  const message = worker.posted[0];
  if (!isLayoutStart(message)) {
    throw new Error("worker did not receive a layout start message");
  }
  return message;
}

function finalPositions(generation: number, offset = 0): LayoutResponse {
  return {
    kind: "positions",
    generation,
    positions: graph.nodes.map((node, index) => ({
      id: node.slug,
      x: index * 100 + offset,
      y: index * 50 + offset,
    })),
  };
}

beforeEach(() => {
  clearLayoutCacheForTests();
  MockPath2D.instances = [];
  MockWorker.instances = [];
  rafCallbacks = new Map();
  nextRaf = 1;
  vi.clearAllMocks();
  vi.stubGlobal("Path2D", MockPath2D);
  vi.stubGlobal("Worker", MockWorker);
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: PointerEventInit) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
    }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextRaf;
    nextRaf += 1;
    rafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafCallbacks.delete(id); });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([
        {
          target,
          contentRect: new DOMRectReadOnly(0, 0, 800, 600),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ], this);
    }
    disconnect(): void {}
    unobserve(): void {}
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => context,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
});

describe("ForceGraphCanvas", () => {
  it("consumes wheel zoom instead of also scrolling the document", () => {
    const view = render(<ForceGraphCanvas graph={graph} sectionFilter="" selectedSlug={null} labelMode="off" onSelect={vi.fn()} />);
    const canvas = view.getByRole("application");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    act(() => { canvas.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("repaints after the Strict Mode effect cleanup and remount", () => {
    render(<StrictMode><ForceGraphCanvas graph={graph} sectionFilter="" selectedSlug={null} labelMode="off" onSelect={vi.fn()} /></StrictMode>);
    const active = MockWorker.instances.at(-1);
    if (!active) throw new Error("no active worker");
    act(() => { active.emit(finalPositions(startMessage(active).generation)); flushFrames(); });
    expect(context.stroke).toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(0);
  });

  it("gives a dragged node priority over pending layout and batches pointer updates into one frame", () => {
    const ref = createRef<ForceGraphCanvasHandle>();
    const view = render(<ForceGraphCanvas ref={ref} graph={graph} sectionFilter="" selectedSlug={null} labelMode="off" onSelect={vi.fn()} />);
    act(() => { flushFrames(); });
    const first = MockWorker.instances[0];
    const start = startMessage(first);
    const [cameraX, cameraY] = context.translate.mock.lastCall ?? [];
    const [scale] = context.scale.mock.lastCall ?? [];
    const node = start.nodes[0];
    const x = cameraX + node.x * scale;
    const y = cameraY + node.y * scale;
    const canvas = view.getByRole("application");
    act(() => { canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: x, clientY: y })); });
    const pathCount = MockPath2D.instances.length;
    act(() => {
      for (let offset = 10; offset <= 50; offset += 10) {
        canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: x + offset, clientY: y }));
      }
    });
    expect(first.terminated).toBe(true);
    expect(MockPath2D.instances.length).toBe(pathCount);
    act(() => {
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: x + 50, clientY: y }));
      first.emit(finalPositions(start.generation, 999));
      flushFrames();
      ref.current?.relax();
    });
    const next = startMessage(MockWorker.instances[1]).nodes.find((candidate) => candidate.id === node.id);
    expect(next?.x).toBeCloseTo(node.x + 50 / scale);
  });

  it("starts once, redraws final positions, keeps all edges, filters without a worker, and relaxes with a new generation", () => {
    const ref = createRef<ForceGraphCanvasHandle>();
    const onSelect = vi.fn();
    const view = render(
      <ForceGraphCanvas
        ref={ref}
        graph={graph}
        tenant="tenant-a"
        sectionFilter=""
        selectedSlug={null}
        labelMode="off"
        onSelect={onSelect}
      />,
    );
    expect(MockWorker.instances).toHaveLength(1);
    const first = MockWorker.instances[0];
    const firstStart = startMessage(first);
    expect(firstStart.links).toEqual(graph.edges);
    expect(firstStart.links[0]).not.toBe(graph.edges[0]);
    expect(Math.max(...MockPath2D.instances.map((path) => path.lineCount))).toBe(3);

    act(() => {
      first.emit(finalPositions(firstStart.generation));
      flushFrames();
    });
    expect(first.terminated).toBe(true);
    expect(context.stroke).toHaveBeenCalled();

    const pathsBeforeFilter = MockPath2D.instances.length;
    view.rerender(
      <ForceGraphCanvas
        ref={ref}
        graph={graph}
        tenant="tenant-a"
        sectionFilter="one"
        selectedSlug={null}
        labelMode="off"
        onSelect={onSelect}
      />,
    );
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockPath2D.instances.slice(pathsBeforeFilter).some((path) => path.lineCount === 1)).toBe(true);

    act(() => { ref.current?.relax(); });
    expect(MockWorker.instances).toHaveLength(2);
    const second = MockWorker.instances[1];
    const secondStart = startMessage(second);
    expect(secondStart.generation).toBeGreaterThan(firstStart.generation);
    act(() => { first.emit(finalPositions(firstStart.generation, 999)); });
    expect(second.terminated).toBe(false);
    act(() => {
      second.emit(finalPositions(secondStart.generation, 10));
      flushFrames();
    });
    expect(second.terminated).toBe(true);
    expect(rafCallbacks.size).toBe(0);

    view.unmount();
    render(
      <ForceGraphCanvas
        graph={graph}
        tenant="tenant-a"
        sectionFilter=""
        selectedSlug={null}
        labelMode="off"
        onSelect={onSelect}
      />,
    );
    expect(MockWorker.instances).toHaveLength(2);
  });

  it("stays usable after worker failure and terminates an active worker on unmount", () => {
    const ref = createRef<ForceGraphCanvasHandle>();
    const view = render(
      <ForceGraphCanvas
        ref={ref}
        graph={graph}
        sectionFilter=""
        selectedSlug={null}
        labelMode="hubs"
        onSelect={vi.fn()}
      />,
    );
    const failed = MockWorker.instances[0];
    act(() => { failed.onerror?.(new ErrorEvent("error")); flushFrames(); });
    expect(failed.terminated).toBe(true);
    expect(context.arc).toHaveBeenCalled();

    act(() => { ref.current?.relax(); });
    const active = MockWorker.instances[1];
    view.unmount();
    expect(active.terminated).toBe(true);
    expect(rafCallbacks.size).toBe(0);
  });
});
