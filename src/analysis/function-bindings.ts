import type { Node } from "web-tree-sitter";
import { textRange, type SourceDoc, type SymbolRecord, type TextRange } from "../core/model.js";
import type { DefUseVariable } from "./model.js";

export interface FunctionVariableBindings {
  readonly variableByOccurrenceRange: ReadonlyMap<string, DefUseVariable>;
  readonly declarationNodeByRange: ReadonlyMap<string, Node>;
  readonly symbolByOccurrenceRange: ReadonlyMap<string, SymbolRecord>;
}

export function buildFunctionVariableBindings(input: {
  readonly document: SourceDoc;
  readonly functionRange: TextRange;
  readonly variables: readonly DefUseVariable[];
  readonly functionNode: Node;
}): FunctionVariableBindings {
  const variableById = new Map(input.variables.map((variable) => [variable.id, variable]));
  const symbolById = new Map(input.document.symbols.symbols.map((symbol) => [symbol.id, symbol]));
  const variableBySymbolId = new Map<string, DefUseVariable>();
  for (const symbol of input.document.symbols.symbols) {
    if (symbol.kind !== "parameter" && symbol.kind !== "local-variable") continue;
    const declarations = symbol.declarationRanges
      .filter((range) => containsRange(input.functionRange, range))
      .sort((left, right) => left.from - right.from || left.to - right.to);
    const first = declarations[0];
    if (first === undefined) continue;
    const kind = symbol.kind === "parameter" ? "parameter" : "local";
    const variable = variableById.get(`variable:${kind}:${String(first.from)}:${String(first.to)}`);
    if (variable !== undefined) variableBySymbolId.set(symbol.id, variable);
  }

  const variableByOccurrenceRange = new Map<string, DefUseVariable>();
  const symbolByOccurrenceRange = new Map<string, SymbolRecord>();
  for (const occurrence of input.document.symbols.occurrences) {
    if (!containsRange(input.functionRange, occurrence.range)) continue;
    const occurrenceRange = rangeKey(occurrence.range);
    const symbol = symbolById.get(occurrence.symbolId);
    if (symbol !== undefined) symbolByOccurrenceRange.set(occurrenceRange, symbol);
    const variable = variableBySymbolId.get(occurrence.symbolId);
    if (variable !== undefined) variableByOccurrenceRange.set(occurrenceRange, variable);
  }

  const declarationNodeByRange = new Map<string, Node>();
  for (const identifier of input.functionNode.descendantsOfType("identifier")) {
    const range = checkedNodeRange(identifier, input.document.source.length);
    if (
      input.variables.some((variable) =>
        variable.declarationRanges.some((declaration) => sameRange(declaration, range)),
      )
    ) {
      declarationNodeByRange.set(rangeKey(range), identifier);
    }
  }
  return { variableByOccurrenceRange, declarationNodeByRange, symbolByOccurrenceRange };
}

function checkedNodeRange(node: Node, sourceLength: number): TextRange {
  if (
    node.isMissing ||
    !Number.isSafeInteger(node.startIndex) ||
    !Number.isSafeInteger(node.endIndex) ||
    node.startIndex < 0 ||
    node.endIndex <= node.startIndex ||
    node.endIndex > sourceLength
  ) {
    throw new RangeError(
      `function binding 节点 range 非法：[${String(node.startIndex)}, ${String(node.endIndex)})`,
    );
  }
  return textRange(node.startIndex, node.endIndex);
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function rangeKey(range: TextRange): string {
  return `${String(range.from)}:${String(range.to)}`;
}
