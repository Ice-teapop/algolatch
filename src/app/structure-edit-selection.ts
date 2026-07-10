import type {
  BlockIndexEntry,
  CAnalysisSnapshot,
  StatementEditTarget,
  SymbolRecord,
} from "../core/index.js";
import { symbolAt } from "../core/index.js";
import type {
  StructureEditSelection,
  StructureEditStatementSelection,
} from "../ui/structure-edit-panel.js";
import type { SourceProjectionMode } from "./source-sync-controller.js";

/** Selection is safe only when CodeMirror and the displayed analysis share one source. */
export function canSelectAnalyzedSource(
  mode: SourceProjectionMode,
  currentSource: string,
  analyzedSource: string,
): boolean {
  return (mode === "synced" || mode === "recovery") && currentSource === analyzedSource;
}

/** Maps a code cursor to the narrowest statement and an eligible local variable. */
export function structureEditSelectionAtOffset(
  analysis: CAnalysisSnapshot,
  offset: number,
): StructureEditSelection | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > analysis.document.source.length) {
    throw new RangeError("结构编辑 offset 超出当前源码范围");
  }
  const point = offset === analysis.document.source.length && offset > 0 ? offset - 1 : offset;
  const statement = narrowestStatementAtOffset(analysis.statementEdits.statements, point);
  const symbol = symbolAt(analysis.document.symbols, point);
  return buildSelection(analysis, statement, symbol);
}

/** Maps a visible block card to the exact statement represented by that card. */
export function structureEditSelectionForBlock(
  analysis: CAnalysisSnapshot,
  entry: BlockIndexEntry | null,
): StructureEditSelection | null {
  const block = entry?.block;
  if (block?.kind !== "syntax") return null;
  const statement = analysis.statementEdits.statements.find(
    (candidate) =>
      candidate.nodeType === block.nodeType &&
      candidate.range.from === block.range.from &&
      candidate.range.to === block.range.to,
  );
  return buildSelection(analysis, statement, null);
}

function buildSelection(
  analysis: CAnalysisSnapshot,
  statement: StatementEditTarget | undefined,
  symbol: SymbolRecord | null,
): StructureEditSelection | null {
  const statementSelection =
    statement === undefined ? undefined : toStatementSelection(analysis, statement);
  const localVariable =
    symbol?.kind === "local-variable"
      ? Object.freeze({ symbolId: symbol.id, name: symbol.name })
      : undefined;
  if (statementSelection === undefined && localVariable === undefined) return null;
  return Object.freeze({
    revision: analysis.statementEdits.revision,
    ...(statementSelection === undefined ? {} : { statement: statementSelection }),
    ...(localVariable === undefined ? {} : { localVariable }),
  });
}

function toStatementSelection(
  analysis: CAnalysisSnapshot,
  target: StatementEditTarget,
): StructureEditStatementSelection {
  return Object.freeze({
    id: target.id,
    text: sourceText(analysis, target),
    parentMode: target.parentMode,
    blocker: target.blocker,
    previous: neighborSelection(analysis, target.previousSiblingId),
    next: neighborSelection(analysis, target.nextSiblingId),
  });
}

function neighborSelection(
  analysis: CAnalysisSnapshot,
  targetId: string | null,
): { readonly id: string; readonly text: string } | null {
  if (targetId === null) return null;
  const target = analysis.statementEdits.statements.find((candidate) => candidate.id === targetId);
  if (target === undefined) {
    throw new Error("语句邻接引用不属于当前分析快照");
  }
  return Object.freeze({ id: target.id, text: sourceText(analysis, target) });
}

function sourceText(analysis: CAnalysisSnapshot, target: StatementEditTarget): string {
  return analysis.document.source.slice(target.range.from, target.range.to);
}

function narrowestStatementAtOffset(
  statements: readonly StatementEditTarget[],
  offset: number,
): StatementEditTarget | undefined {
  return statements
    .filter((target) => target.range.from <= offset && offset < target.range.to)
    .sort(
      (left, right) =>
        left.range.to - left.range.from - (right.range.to - right.range.from) ||
        right.range.from - left.range.from,
    )[0];
}
