import type { Node } from "web-tree-sitter";
import {
  textRange,
  type Block,
  type SourceDoc,
  type SymbolRecord,
  type TextRange,
} from "../core/model.js";
import { collectFunctionEffects } from "./def-use-effects.js";
import type {
  DefUseDisabledReasonCode,
  DefUseTrackingMode,
  DefUseVariable,
  DefUseVariableKind,
  DefUseVariableStorage,
  FunctionDefUse,
  FunctionCfg,
} from "./model.js";

/** @internal Constructed only inside analyzeProgramCst's borrowed CST scope. */
export interface FunctionVariableInput {
  readonly functionNode: Node;
  readonly cfg: FunctionCfg;
  readonly document: SourceDoc;
}

interface DeclarationClassification {
  readonly storage: DefUseVariableStorage;
  readonly trackable: boolean;
}

const DISABLED_REASON_ORDER_MAP = Object.freeze({
  "cfg-partial": 0,
  "invalid-function-cst": 1,
  "parse-error": 2,
  preprocessor: 3,
  "projection-issue": 4,
  "parse-concern": 5,
  "raw-block": 6,
  "missing-function-projection": 7,
  "effect-cst-mismatch": 8,
  "unsequenced-conflict": 9,
  "unsupported-effect-order": 10,
  "opaque-alias-effect": 11,
} as const satisfies Readonly<Record<DefUseDisabledReasonCode, number>>);
const DISABLED_REASON_ORDER = Object.freeze(
  Object.keys(DISABLED_REASON_ORDER_MAP) as DefUseDisabledReasonCode[],
);
const KNOWN_SYSTEM_HEADERS = new Set([
  "<assert.h>",
  "<complex.h>",
  "<ctype.h>",
  "<errno.h>",
  "<fenv.h>",
  "<float.h>",
  "<inttypes.h>",
  "<iso646.h>",
  "<limits.h>",
  "<locale.h>",
  "<math.h>",
  "<setjmp.h>",
  "<signal.h>",
  "<stdalign.h>",
  "<stdarg.h>",
  "<stdatomic.h>",
  "<stdbool.h>",
  "<stddef.h>",
  "<stdint.h>",
  "<stdio.h>",
  "<stdlib.h>",
  "<stdnoreturn.h>",
  "<string.h>",
  "<tgmath.h>",
  "<threads.h>",
  "<time.h>",
  "<uchar.h>",
  "<wchar.h>",
  "<wctype.h>",
]);

export function collectFunctionDefUse(input: FunctionVariableInput): FunctionDefUse {
  const sourceLength = input.document.source.length;
  const functionRange = checkedNodeRange(input.functionNode, sourceLength);
  assertMatchingFunction(input.cfg, functionRange);
  const identifierNodes = new Map(
    input.functionNode
      .descendantsOfType("identifier")
      .filter((node) => isUsableNode(node, sourceLength))
      .map((node) => [rangeKey(checkedNodeRange(node, sourceLength)), node]),
  );
  const initialDisabledReasons = collectDisabledReasons(input, functionRange);
  const variables = input.document.symbols.symbols
    .filter(
      (symbol) =>
        (symbol.kind === "parameter" || symbol.kind === "local-variable") &&
        symbol.declarationRanges.some((range) => containsRange(functionRange, range)),
    )
    .map((symbol) =>
      buildVariable(
        symbol,
        functionRange,
        identifierNodes,
        input.document,
        initialDisabledReasons.length === 0,
      ),
    )
    .sort(
      (left, right) =>
        (left.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) -
          (right.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) ||
        left.name.localeCompare(right.name),
    );
  const effectCollection =
    initialDisabledReasons.length === 0
      ? collectFunctionEffects({
          functionNode: input.functionNode,
          cfg: input.cfg,
          document: input.document,
          variables,
        })
      : Object.freeze({ facts: Object.freeze([]), disabledReasons: Object.freeze([]) });
  const disabledReasonSet = new Set<DefUseDisabledReasonCode>(initialDisabledReasons);
  effectCollection.disabledReasons.forEach((reason) => disabledReasonSet.add(reason));
  const disabledReasons = Object.freeze(
    DISABLED_REASON_ORDER.filter((reason) => disabledReasonSet.has(reason)),
  );
  const status = disabledReasons.length === 0 ? "complete" : "disabled";
  const outputVariables =
    status === "complete" || initialDisabledReasons.length > 0
      ? variables
      : variables.map((variable) => Object.freeze({ ...variable, tracking: "untracked" as const }));
  return Object.freeze({
    functionId: input.cfg.id,
    functionRange,
    status,
    disabledReasons,
    variables: Object.freeze(outputVariables),
    facts: status === "complete" ? effectCollection.facts : Object.freeze([]),
  });
}

function buildVariable(
  symbol: SymbolRecord,
  functionRange: TextRange,
  declarationNodes: ReadonlyMap<string, Node>,
  document: SourceDoc,
  functionIsTrackable: boolean,
): DefUseVariable {
  const declarationRanges = symbol.declarationRanges
    .filter((range) => containsRange(functionRange, range))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const first = declarationRanges[0];
  if (first === undefined) throw new Error("函数变量缺少声明 range");
  const classifications = declarationRanges.map((range) =>
    classifyStorage(declarationNodes.get(rangeKey(range))),
  );
  const storage = classifications.every(
    (candidate) => candidate.storage === classifications[0]?.storage,
  )
    ? (classifications[0]?.storage ?? "unknown")
    : "unknown";
  const occurrences = document.symbols.occurrences.filter(
    (occurrence) => occurrence.symbolId === symbol.id,
  );
  const bindingIsLocal = occurrences.every(
    (occurrence) =>
      occurrence.resolution === "local" && containsRange(functionRange, occurrence.range),
  );
  const declarationIsTrackable =
    functionIsTrackable &&
    declarationRanges.length === 1 &&
    classifications.every((classification) => classification.trackable) &&
    bindingIsLocal;
  const kind: DefUseVariableKind = symbol.kind === "parameter" ? "parameter" : "local";
  return Object.freeze({
    id: `variable:${kind}:${first.from}:${first.to}`,
    name: symbol.name,
    kind,
    storage,
    tracking: trackingMode(storage, symbol.confidence, declarationIsTrackable),
    declarationRanges: Object.freeze(declarationRanges),
    confidence: symbol.confidence,
  });
}

function classifyStorage(nameNode: Node | undefined): DeclarationClassification {
  if (nameNode === undefined) return Object.freeze({ storage: "unknown", trackable: false });
  let current = nameNode.parent;
  let sawArray = false;
  let sawPointer = false;
  let sawFunction = false;
  while (current !== null) {
    sawArray ||= current.type === "array_declarator";
    sawPointer ||= current.type === "pointer_declarator";
    sawFunction ||= current.type === "function_declarator";
    if (current.type === "parameter_declaration" || current.type === "declaration") {
      const baseStorage = storageFromType(current.childForFieldName("type"));
      const storage =
        sawFunction || (sawArray && sawPointer)
          ? "unknown"
          : sawArray
            ? baseStorage === "scalar"
              ? "array"
              : "unknown"
            : sawPointer
              ? "pointer"
              : baseStorage;
      return Object.freeze({ storage, trackable: declarationSyntaxIsTrackable(current) });
    }
    if (current.type === "function_definition") break;
    current = current.parent;
  }
  return Object.freeze({ storage: "unknown", trackable: false });
}

function collectDisabledReasons(
  input: FunctionVariableInput,
  functionRange: TextRange,
): readonly DefUseDisabledReasonCode[] {
  const reasons = new Set<DefUseDisabledReasonCode>();
  if (input.cfg.partial) reasons.add("cfg-partial");
  if (input.functionNode.type !== "function_definition") reasons.add("invalid-function-cst");
  if (
    input.functionNode.isError ||
    input.functionNode.hasError ||
    input.functionNode.descendantsOfType("ERROR").length > 0 ||
    input.document.parse.errorRanges.some((range) => rangesOverlap(functionRange, range)) ||
    input.document.parse.missingOffsets.some(
      (offset) => offset >= functionRange.from && offset <= functionRange.to,
    )
  ) {
    reasons.add("parse-error");
  }
  if (
    hasPreprocessorNode(input.functionNode) ||
    hasPriorUnknownInclude(input.functionNode) ||
    usesDefinedMacro(input.functionNode)
  ) {
    reasons.add("preprocessor");
  }
  if (input.document.issues.some((issue) => rangesOverlap(functionRange, issue.range))) {
    reasons.add("projection-issue");
  }
  if (
    input.document.concerns.some(
      (concern) =>
        rangesOverlap(functionRange, concern.blockRange) ||
        rangesOverlap(functionRange, concern.evidenceRange),
    )
  ) {
    reasons.add("parse-concern");
  }
  const functionBlock = findFunctionBlock(input.document.blocks, functionRange);
  if (functionBlock === null) {
    reasons.add("missing-function-projection");
  } else {
    collectBlockDisabledReasons(functionBlock, reasons);
  }
  return Object.freeze(DISABLED_REASON_ORDER.filter((reason) => reasons.has(reason)));
}

function hasPriorUnknownInclude(functionNode: Node): boolean {
  let root = functionNode;
  while (root.parent !== null) root = root.parent;
  return root
    .descendantsOfType("preproc_include")
    .some(
      (include) =>
        include.startIndex < functionNode.startIndex &&
        !KNOWN_SYSTEM_HEADERS.has(include.childForFieldName("path")?.text ?? ""),
    );
}

function hasPreprocessorNode(node: Node): boolean {
  return node.namedChildren.some(
    (child) => child.type.startsWith("preproc_") || hasPreprocessorNode(child),
  );
}

function usesDefinedMacro(functionNode: Node): boolean {
  let root = functionNode;
  while (root.parent !== null) root = root.parent;
  const events = [
    ...root.descendantsOfType("preproc_def").map((node) => ({ node, action: "define" as const })),
    ...root
      .descendantsOfType("preproc_function_def")
      .map((node) => ({ node, action: "define" as const })),
    ...root
      .descendantsOfType("preproc_call")
      .filter((node) => node.childForFieldName("directive")?.text.replace(/\s/g, "") === "#undef")
      .map((node) => ({ node, action: "undef" as const })),
    ...root
      .descendantsOfType("preproc_include")
      .filter((node) => node.childForFieldName("path")?.text === "<assert.h>")
      .map((node) => ({ node, action: "assert-include" as const })),
  ]
    .filter((event) => event.node.startIndex < functionNode.startIndex)
    .sort((left, right) => left.node.startIndex - right.node.startIndex);
  const activeMacros = new Set<string>();
  const uncertainMacros = new Set<string>();
  let assertContractUncertain = false;
  for (const event of events) {
    if (event.action === "assert-include") {
      assertContractUncertain ||=
        hasConditionalPreprocessorAncestor(event.node) ||
        activeMacros.has("NDEBUG") ||
        uncertainMacros.has("NDEBUG");
      continue;
    }
    const name =
      event.action === "define"
        ? event.node.childForFieldName("name")?.text
        : event.node.childForFieldName("argument")?.text.trim().split(/\s/)[0];
    if (name === undefined || name.length === 0) continue;
    if (hasConditionalPreprocessorAncestor(event.node)) {
      uncertainMacros.add(name);
      continue;
    }
    uncertainMacros.delete(name);
    if (event.action === "define") activeMacros.add(name);
    else activeMacros.delete(name);
  }
  if (assertContractUncertain && containsMacroToken(functionNode, new Set(["assert"]))) {
    return true;
  }
  const possibleMacros = new Set([...activeMacros, ...uncertainMacros]);
  return possibleMacros.size > 0 && containsMacroToken(functionNode, possibleMacros);
}

function hasConditionalPreprocessorAncestor(node: Node): boolean {
  let current = node.parent;
  while (current !== null) {
    if (
      current.type === "preproc_if" ||
      current.type === "preproc_ifdef" ||
      current.type === "preproc_ifndef"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function containsMacroToken(node: Node, activeMacros: ReadonlySet<string>): boolean {
  if (node.childCount === 0) return activeMacros.has(node.text);
  return node.children.some((child) => containsMacroToken(child, activeMacros));
}

function findFunctionBlock(blocks: readonly Block[], range: TextRange): Block | null {
  for (const block of blocks) {
    if (
      block.kind === "syntax" &&
      block.role === "function" &&
      rangeKey(block.range) === rangeKey(range)
    ) {
      return block;
    }
    const nested = findFunctionBlock(block.children, range);
    if (nested !== null) return nested;
  }
  return null;
}

function collectBlockDisabledReasons(block: Block, reasons: Set<DefUseDisabledReasonCode>): void {
  if (block.kind === "raw") reasons.add("raw-block");
  if (block.kind === "syntax" && block.role === "preprocessor") reasons.add("preprocessor");
  block.children.forEach((child) => collectBlockDisabledReasons(child, reasons));
}

function assertMatchingFunction(cfg: FunctionCfg, range: TextRange): void {
  if (rangeKey(cfg.range) !== rangeKey(range)) {
    throw new TypeError("def-use functionNode 与 CFG 不属于同一函数");
  }
}

function declarationSyntaxIsTrackable(owner: Node): boolean {
  const disallowedQualifier = owner
    .descendantsOfType("type_qualifier")
    .some((qualifier) => qualifier.text === "volatile" || qualifier.text === "_Atomic");
  const disallowedStorage = owner
    .descendantsOfType("storage_class_specifier")
    .some((specifier) => specifier.text !== "auto" && specifier.text !== "register");
  const type = owner.childForFieldName("type");
  const atomicType =
    type?.type.includes("atomic") === true || type?.text.startsWith("_Atomic") === true;
  return !disallowedQualifier && !disallowedStorage && !atomicType;
}

function storageFromType(typeNode: Node | null): DefUseVariableStorage {
  if (typeNode === null) return "unknown";
  if (typeNode.type === "primitive_type" && typeNode.text === "void") return "unknown";
  if (typeNode.type === "struct_specifier" || typeNode.type === "union_specifier") {
    return "aggregate";
  }
  if (typeNode.type === "type_identifier") return "unknown";
  if (
    typeNode.type === "primitive_type" ||
    typeNode.type === "sized_type_specifier" ||
    typeNode.type === "enum_specifier"
  ) {
    return "scalar";
  }
  return "unknown";
}

function trackingMode(
  storage: DefUseVariableStorage,
  confidence: SymbolRecord["confidence"],
  declarationIsTrackable: boolean,
): DefUseTrackingMode {
  if (confidence !== "certain" || !declarationIsTrackable) return "untracked";
  if (storage === "scalar") return "precise";
  if (storage === "array") return "weak";
  return "untracked";
}

function checkedNodeRange(node: Node, sourceLength: number): TextRange {
  if (!isUsableNode(node, sourceLength)) {
    throw new RangeError(`def-use 节点 range 非法：[${node.startIndex}, ${node.endIndex})`);
  }
  return textRange(node.startIndex, node.endIndex);
}

function isUsableNode(node: Node, sourceLength: number): boolean {
  return (
    !node.isMissing &&
    Number.isSafeInteger(node.startIndex) &&
    Number.isSafeInteger(node.endIndex) &&
    node.startIndex >= 0 &&
    node.endIndex > node.startIndex &&
    node.endIndex <= sourceLength
  );
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function rangeKey(range: TextRange): string {
  return `${range.from}:${range.to}`;
}
