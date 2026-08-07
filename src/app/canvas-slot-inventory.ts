import type { CAnalysisSnapshot, StatementEditTarget, TextRange } from "../core/index.js";
import type { PresetSyntaxAncestorCapability, PresetSyntaxSlotKind } from "../learning/index.js";
import type { StructureInsertStatementRequest } from "../ui/structure-edit-panel.js";
import { ancestorCapabilityForNodeType, syntaxSlotForParent } from "./syntax-slots.js";

export interface CanvasSlot {
  readonly id: string;
  readonly anchorStatementId: string;
  readonly anchorRange: TextRange;
  readonly position: "before" | "after";
  readonly slotKind: PresetSyntaxSlotKind;
  readonly parentRange: TextRange;
  readonly ancestorCapabilities: readonly PresetSyntaxAncestorCapability[];
}

export interface CanvasSlotPlacement {
  readonly acceptedSyntaxSlots: readonly PresetSyntaxSlotKind[];
  readonly requiredAnyAncestorCapabilities: readonly PresetSyntaxAncestorCapability[];
}

export type CanvasSlotInsertRequest = StructureInsertStatementRequest;

/** Enumerates safe statement-list gaps without inventing anchors for empty bodies. */
export function canvasSlotInventory(analysis: CAnalysisSnapshot | null): readonly CanvasSlot[] {
  if (analysis === null) return Object.freeze([]);
  const statements = analysis.statementEdits.statements;
  const eligible = statements.filter(isEligible);
  const byId = new Map(eligible.map((statement) => [statement.id, statement]));
  const slots: CanvasSlot[] = [];
  for (const statement of eligible) {
    const slotKind = slotKindFor(statements, statement);
    const ancestors = ancestorCapabilities(statements, statement);
    if (!statement.beforeBoundaryUnsafe) {
      slots.push(slot(statement, "before", slotKind, ancestors));
    } else {
      const previous =
        statement.previousSiblingId === null ? undefined : byId.get(statement.previousSiblingId);
      if (previous !== undefined && !previous.afterBoundaryUnsafe) {
        slots.push(
          slot(
            previous,
            "after",
            slotKindFor(statements, previous),
            ancestorCapabilities(statements, previous),
          ),
        );
      }
    }
    if (statement.nextSiblingId === null && !statement.afterBoundaryUnsafe) {
      slots.push(slot(statement, "after", slotKind, ancestors));
    }
  }
  return Object.freeze(dedupe(slots));
}

export function slotAcceptsPlacement(slot: CanvasSlot, placement: CanvasSlotPlacement): boolean {
  if (!placement.acceptedSyntaxSlots.includes(slot.slotKind)) return false;
  if (placement.requiredAnyAncestorCapabilities.length === 0) return true;
  return placement.requiredAnyAncestorCapabilities.some((capability) =>
    slot.ancestorCapabilities.includes(capability),
  );
}

export function canvasSlotInsertRequest(
  analysis: CAnalysisSnapshot,
  slotValue: CanvasSlot,
  statementText: string,
): CanvasSlotInsertRequest | null {
  const statement = analysis.statementEdits.statements.find(
    (candidate) => candidate.id === slotValue.anchorStatementId,
  );
  if (statement === undefined) return null;
  const normalized = statementText.trim();
  if (normalized.length === 0) return null;
  return Object.freeze({
    kind: "insert-statement",
    baseRevision: analysis.statementEdits.revision,
    targetId: statement.id,
    expectedTargetText: analysis.document.source.slice(statement.range.from, statement.range.to),
    position: slotValue.position,
    statementText: normalized,
  });
}

function isEligible(statement: StatementEditTarget): boolean {
  return statement.parentMode === "statement-list" && statement.blocker === null;
}

function slot(
  statement: StatementEditTarget,
  position: CanvasSlot["position"],
  slotKind: PresetSyntaxSlotKind,
  ancestorCapabilities: readonly PresetSyntaxAncestorCapability[],
): CanvasSlot {
  return Object.freeze({
    id: `slot:${statement.id}:${position}`,
    anchorStatementId: statement.id,
    anchorRange: statement.range,
    position,
    slotKind,
    parentRange: statement.parentRange,
    ancestorCapabilities,
  });
}

function slotKindFor(
  statements: readonly StatementEditTarget[],
  statement: StatementEditTarget,
): PresetSyntaxSlotKind {
  const owner = innermostContaining(statements, statement.parentRange);
  if (owner === undefined) return "function-body";
  return syntaxSlotForParent(owner.nodeType) ?? "compound-body";
}

function innermostContaining(
  statements: readonly StatementEditTarget[],
  range: TextRange,
): StatementEditTarget | undefined {
  let best: StatementEditTarget | undefined;
  for (const candidate of statements) {
    if (!containsRange(candidate.range, range)) continue;
    if (best === undefined || rangeWidth(candidate.range) < rangeWidth(best.range))
      best = candidate;
  }
  return best;
}

function rangeWidth(range: TextRange): number {
  return range.to - range.from;
}

function ancestorCapabilities(
  statements: readonly StatementEditTarget[],
  statement: StatementEditTarget,
): readonly PresetSyntaxAncestorCapability[] {
  const capabilities = new Set<PresetSyntaxAncestorCapability>();
  for (const candidate of statements) {
    if (candidate.id === statement.id || !containsRange(candidate.range, statement.range)) continue;
    const capability = ancestorCapabilityForNodeType(candidate.nodeType);
    if (capability !== null) capabilities.add(capability);
  }
  return Object.freeze([...capabilities].sort());
}

function containsRange(outer: TextRange, inner: TextRange): boolean {
  return outer.from <= inner.from && outer.to >= inner.to && !sameRange(outer, inner);
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function dedupe(slots: readonly CanvasSlot[]): CanvasSlot[] {
  const seen = new Map<string, CanvasSlot>();
  for (const candidate of slots) if (!seen.has(candidate.id)) seen.set(candidate.id, candidate);
  return [...seen.values()].sort(compareSlots);
}

function compareSlots(left: CanvasSlot, right: CanvasSlot): number {
  if (left.anchorRange.from !== right.anchorRange.from) {
    return left.anchorRange.from - right.anchorRange.from;
  }
  if (left.position !== right.position) return left.position === "before" ? -1 : 1;
  return left.id.localeCompare(right.id);
}
