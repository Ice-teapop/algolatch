import type { FlowNode, FlowPoint } from "../flow/index.js";
import type { CanvasSlot } from "./canvas-slot-inventory.js";

export interface CanvasSlotMetrics {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly stripHeight: number;
  readonly gap: number;
}

export interface CanvasSlotRect {
  readonly slotId: string;
  readonly anchorNodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_CANVAS_SLOT_METRICS: CanvasSlotMetrics = Object.freeze({
  nodeWidth: 160,
  nodeHeight: 32,
  stripHeight: 12,
  gap: 2,
});

export function canvasSlotRects(
  slots: readonly CanvasSlot[],
  nodes: readonly FlowNode[],
  positionOf: (node: FlowNode) => FlowPoint,
  metrics: CanvasSlotMetrics = DEFAULT_CANVAS_SLOT_METRICS,
): readonly CanvasSlotRect[] {
  const byRange = new Map<string, FlowNode>();
  for (const node of nodes) {
    const key = rangeKey(node.range.from, node.range.to);
    if (!byRange.has(key)) byRange.set(key, node);
  }
  const rects: CanvasSlotRect[] = [];
  for (const slot of slots) {
    const anchor = byRange.get(rangeKey(slot.anchorRange.from, slot.anchorRange.to));
    if (anchor === undefined) continue;
    const position = positionOf(anchor);
    const y =
      slot.position === "before"
        ? position.y - metrics.gap - metrics.stripHeight
        : position.y + metrics.nodeHeight + metrics.gap;
    rects.push(
      Object.freeze({
        slotId: slot.id,
        anchorNodeId: anchor.id,
        x: position.x,
        y,
        width: metrics.nodeWidth,
        height: metrics.stripHeight,
      }),
    );
  }
  return Object.freeze(rects);
}

export function canvasSlotRectAtPoint(
  rects: readonly CanvasSlotRect[],
  worldX: number,
  worldY: number,
  tolerance = 0,
): CanvasSlotRect | null {
  let best: CanvasSlotRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (worldX < rect.x - tolerance || worldX > rect.x + rect.width + tolerance) continue;
    if (worldY < rect.y - tolerance || worldY > rect.y + rect.height + tolerance) continue;
    const distance = Math.abs(worldY - (rect.y + rect.height / 2));
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}

function rangeKey(from: number, to: number): string {
  return `${String(from)}:${String(to)}`;
}
