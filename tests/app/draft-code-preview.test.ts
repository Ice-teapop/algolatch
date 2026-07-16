import { describe, expect, it } from "vitest";

import { draftCodePreviewsFor } from "../../src/app/draft-code-preview.js";
import type { FlowCanvasDraftNode } from "../../src/ui/flow-canvas.js";

describe("draft code preview adapter", () => {
  it("maps only detached or invalid source-backed drafts without changing their source", () => {
    const nodes: readonly FlowCanvasDraftNode[] = [
      draftNode({ id: "detached", sourceText: "  int value = 1;\n", status: "detached" }),
      draftNode({ id: "invalid", sourceText: "return missing;", status: "invalid" }),
      draftNode({ id: "valid", sourceText: "return 0;", status: "valid" }),
      draftNode({ id: "blank", sourceText: " \n\t", status: "detached" }),
      draftNode({ id: "missing-source", status: "detached" }),
      draftNode({
        id: "virtual",
        sourceText: "pause();",
        status: "detached",
        blockKind: "virtual",
      }),
    ];

    const previews = draftCodePreviewsFor(nodes);

    expect(previews).toEqual([
      {
        id: "detached",
        label: "detached label",
        sourceText: "  int value = 1;\n",
        status: "detached",
      },
      {
        id: "invalid",
        label: "invalid label",
        sourceText: "return missing;",
        status: "invalid",
      },
    ]);
    expect(previews.every(Object.isFrozen)).toBe(true);
  });
});

function draftNode(
  overrides: Pick<FlowCanvasDraftNode, "id" | "status"> &
    Partial<Pick<FlowCanvasDraftNode, "blockKind" | "sourceText">>,
): FlowCanvasDraftNode {
  return Object.freeze({
    id: overrides.id,
    label: `${overrides.id} label`,
    position: Object.freeze({ x: 0, y: 0 }),
    status: overrides.status,
    blockKind: overrides.blockKind,
    sourceText: overrides.sourceText,
  });
}
