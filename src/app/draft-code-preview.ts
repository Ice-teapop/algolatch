import type { CodeDraftPreview } from "../ui/code-pane.js";
import type { FlowCanvasDraftNode } from "../ui/flow-canvas.js";

export function draftCodePreviewsFor(
  nodes: readonly FlowCanvasDraftNode[],
): readonly CodeDraftPreview[] {
  return nodes.flatMap((node) => {
    const sourceText = node.sourceText ?? "";
    if (
      node.blockKind === "virtual" ||
      sourceText.trim().length === 0 ||
      (node.status !== "detached" && node.status !== "invalid")
    ) {
      return [];
    }
    return [
      Object.freeze({
        id: node.id,
        label: node.label,
        sourceText,
        status: node.status,
      }),
    ];
  });
}
