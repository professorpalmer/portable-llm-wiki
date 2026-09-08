"use client";

import ForceGraph2D from "react-force-graph-2d";
import type { MutableRefObject } from "react";

// Thin client wrapper so the graph page can dynamic-import canvas code while
// still reaching the real ForceGraph2D instance. next/dynamic's
// LoadableComponent does not forward refs; graphRef is a regular prop instead.
type ForceGraphCanvasProps = {
  graphRef: MutableRefObject<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;

export default function ForceGraphCanvas({
  graphRef,
  ...props
}: ForceGraphCanvasProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <ForceGraph2D ref={graphRef as any} {...props} />;
}
