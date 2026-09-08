import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutFinal, LayoutProgress, LayoutResponse, LayoutStart } from "@/lib/graphLayout";

type WorkerScope = {
  onmessage: ((event: MessageEvent<LayoutStart>) => void) | null;
  postMessage: ReturnType<typeof vi.fn<(response: LayoutResponse) => void>>;
};

function start(delivery: LayoutStart["delivery"]): LayoutStart {
  return {
    kind: "start",
    generation: 7,
    mode: "initial",
    delivery,
    nodes: [
      { id: "a", degree: 1, x: -20, y: 0 },
      { id: "b", degree: 1, x: 20, y: 0 },
    ],
    links: [{ source: "a", target: "b" }],
  };
}

function isProgress(response: LayoutResponse): response is LayoutProgress {
  return response.kind === "progress";
}

function isFinal(response: LayoutResponse): response is LayoutFinal {
  return response.kind === "final";
}

describe("graph layout worker", () => {
  let scope: WorkerScope;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    scope = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    await import("@/workers/graphLayout.worker");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts a warmup snapshot first, then progressive positions and one bounded final", () => {
    scope.onmessage?.(new MessageEvent("message", { data: start("stream") }));
    const first = scope.postMessage.mock.calls[0]?.[0];
    expect(first && isProgress(first)).toBe(true);
    expect(first?.generation).toBe(7);
    vi.advanceTimersByTime(100);
    const progress = scope.postMessage.mock.calls.map(([response]) => response).filter(isProgress);
    expect(progress.length).toBeGreaterThan(1);
    vi.runAllTimers();
    const responses = scope.postMessage.mock.calls.map(([response]) => response);
    expect(responses.filter(isFinal)).toHaveLength(1);
    expect(responses.at(-1)?.kind).toBe("final");
  });

  it("starts relax at the displayed positions instead of skipping its first motion", () => {
    const message = { ...start("stream"), mode: "relax" as const };
    scope.onmessage?.(new MessageEvent("message", { data: message }));
    const first = scope.postMessage.mock.calls[0]?.[0];
    expect(first && isProgress(first) && first.positions).toEqual(
      message.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
    vi.advanceTimersByTime(100);
    const next = scope.postMessage.mock.calls.at(-1)?.[0];
    expect(next && isProgress(next) && next.positions).not.toEqual(
      message.nodes.map(({ id, x, y }) => ({ id, x, y })),
    );
    vi.runAllTimers();
  });

  it("emits only the final layout for reduced-motion delivery", () => {
    scope.onmessage?.(new MessageEvent("message", { data: start("final-only") }));
    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    expect(scope.postMessage.mock.calls[0]?.[0].kind).toBe("final");
  });
});
