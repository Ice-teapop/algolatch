import { offsetToBlock, type BlockIndex, type BlockIndexEntry } from "../core/block-index.js";
import type { TextRange } from "../core/model.js";
import type { StructuredEditRequest } from "../core/editing/engine.js";
import type { EditTarget, EditTargetSnapshot } from "../core/editing/targets.js";
import type { EditPanelRequest } from "../ui/edit-panel.js";

/** The target-mapping subset supplied by a validated structured edit plan. */
export interface CandidateTargetPlan {
  readonly targetId: string;
  readonly diffs: readonly {
    readonly beforeRange: TextRange;
    readonly afterRange: TextRange;
  }[];
  readonly candidateAnalysis: {
    readonly editTargets: EditTargetSnapshot;
  };
}

/** Adds the exact live target text required by the stale-safe M3a engine request. */
export function toStructuredEditRequest(
  request: EditPanelRequest,
  target: EditTarget,
): StructuredEditRequest {
  const base = {
    baseRevision: request.baseRevision,
    targetId: request.targetId,
    expectedTargetText: target.text,
  };
  switch (request.kind) {
    case "replace-literal":
      return { ...base, kind: "literal", newText: request.newText };
    case "replace-binary-operator":
      return { ...base, kind: "binary-operator", newOperator: request.newOperator };
    case "replace-for-fields":
      return {
        ...base,
        kind: "for-fields",
        newInitializer: request.initializerText,
        newCondition: request.conditionText,
        newUpdate: request.updateText,
      };
    case "replace-if-condition":
      return { ...base, kind: "if-condition", newCondition: request.conditionText };
  }
}

/** Returns all snapshot targets in deterministic UI priority order. */
export function allEditTargets(snapshot: EditTargetSnapshot): readonly EditTarget[] {
  return [
    ...snapshot.literals,
    ...snapshot.binaryExpressions,
    ...snapshot.forStatements,
    ...snapshot.ifStatements,
  ];
}

/** Half-open containment, with an exact cursor hit for an empty edit slot. */
export function rangeContainsOffset(range: TextRange, offset: number): boolean {
  return range.from === range.to
    ? offset === range.from
    : range.from <= offset && offset < range.to;
}

/** Selects the narrowest target, using source order for equal widths. */
export function smallestTarget(targets: readonly EditTarget[]): EditTarget {
  const sorted = [...targets].sort(
    (left, right) =>
      left.range.to - left.range.from - (right.range.to - right.range.from) ||
      left.range.from - right.range.from,
  );
  const first = sorted[0];
  if (first === undefined) throw new Error("缺少可编辑目标");
  return first;
}

/**
 * Resolves a code click to an editable target.
 *
 * Literal tokens and binary operators outrank enclosing for/if headers. A
 * control statement is selected only inside its editable header fields, never
 * inside its body or on a delimiter.
 */
export function editTargetAtOffset(
  snapshot: EditTargetSnapshot,
  offset: number,
): EditTarget | null {
  const direct: EditTarget[] = [
    ...snapshot.literals.filter((target) => rangeContainsOffset(target.range, offset)),
    ...snapshot.binaryExpressions.filter((target) =>
      rangeContainsOffset(target.operatorRange, offset),
    ),
  ];
  if (direct.length > 0) return smallestTarget(direct);

  const controls: EditTarget[] = [
    ...snapshot.forStatements.filter(
      (target) =>
        rangeContainsOffset(target.initializerRange, offset) ||
        rangeContainsOffset(target.conditionRange, offset) ||
        rangeContainsOffset(target.updateRange, offset),
    ),
    ...snapshot.ifStatements.filter((target) => rangeContainsOffset(target.conditionRange, offset)),
  ];
  return controls.length === 0 ? null : smallestTarget(controls);
}

/** Resolves a visible statement block to its exact for/if edit target. */
export function editTargetForBlock(
  snapshot: EditTargetSnapshot,
  entry: BlockIndexEntry,
): EditTarget | null {
  const block = entry.block;
  if (block?.kind !== "syntax") return null;
  const candidates =
    block.nodeType === "for_statement"
      ? snapshot.forStatements
      : block.nodeType === "if_statement"
        ? snapshot.ifStatements
        : [];
  return (
    candidates.find(
      (target) => target.range.from === block.range.from && target.range.to === block.range.to,
    ) ?? null
  );
}

/** Finds the exact owning block, falling back to the deepest block at its start. */
export function blockEntryForTarget(index: BlockIndex, target: EditTarget): BlockIndexEntry | null {
  const exact = index.entries.find(
    (entry) =>
      entry.block?.kind === "syntax" &&
      entry.block.range.from === target.range.from &&
      entry.block.range.to === target.range.to &&
      entry.block.nodeType === target.nodeType,
  );
  return exact ?? offsetToBlock(index, target.range.from);
}

/** Maps a base target to the equivalent target in a validated candidate snapshot. */
export function candidateTargetForPlan(
  baseTargets: EditTargetSnapshot,
  plan: CandidateTargetPlan,
): EditTarget | null {
  const baseTarget = allEditTargets(baseTargets).find((target) => target.id === plan.targetId);
  if (baseTarget === undefined) return null;
  const candidateTargets = plan.candidateAnalysis.editTargets;

  if (baseTarget.kind === "literal") {
    const diff = plan.diffs.find(
      (item) =>
        item.beforeRange.from === baseTarget.range.from &&
        item.beforeRange.to === baseTarget.range.to,
    );
    return (
      candidateTargets.literals.find(
        (target) =>
          diff !== undefined &&
          target.range.from === diff.afterRange.from &&
          target.range.to === diff.afterRange.to,
      ) ?? null
    );
  }
  if (baseTarget.kind === "binary-expression") {
    const diff = plan.diffs.find(
      (item) =>
        item.beforeRange.from === baseTarget.operatorRange.from &&
        item.beforeRange.to === baseTarget.operatorRange.to,
    );
    return (
      candidateTargets.binaryExpressions.find(
        (target) =>
          diff !== undefined &&
          target.operatorRange.from === diff.afterRange.from &&
          target.operatorRange.to === diff.afterRange.to,
      ) ?? null
    );
  }
  if (baseTarget.kind === "for-statement") {
    return (
      candidateTargets.forStatements.find(
        (target) => target.range.from === baseTarget.range.from,
      ) ?? null
    );
  }
  return (
    candidateTargets.ifStatements.find((target) => target.range.from === baseTarget.range.from) ??
    null
  );
}
