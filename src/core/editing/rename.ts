import type { Node } from "web-tree-sitter";
import { findBuiltinFunction, findBuiltinObjectMacro, findBuiltinTypedef } from "../builtins.js";
import {
  textRange,
  type Block,
  type SourceDoc,
  type SymbolOccurrence,
  type SymbolRecord,
  type TextRange,
} from "../model.js";
import type { TextPatch } from "./model.js";
import { createTextPatch } from "./patch.js";

export type LocalRenameAnalysis = Pick<
  SourceDoc,
  "source" | "range" | "blocks" | "parse" | "issues" | "concerns" | "symbols"
>;

export interface ConservativeLocalRenameRequest {
  readonly source: string;
  /** Must belong to the same live Tree-sitter snapshot as `analysis`. */
  readonly rootNode: Node;
  readonly analysis: LocalRenameAnalysis;
  /** Snapshot-local symbol identity selected by the caller. */
  readonly symbolId: string;
  /** Exact symbol name shown when the request was created. */
  readonly expectedOldName: string;
  readonly newName: string;
}

export interface ConservativeLocalRenamePlan {
  readonly kind: "local-variable-rename";
  readonly symbolId: string;
  readonly oldName: string;
  readonly newName: string;
  readonly functionRange: TextRange;
  readonly patches: readonly TextPatch[];
  /** Rename is never auto-applied; the exact diff must be shown and confirmed. */
  readonly requiresConfirmation: true;
  /** Runtime enforces reparse/shape only; corpus acceptance separately checks semantic equivalence. */
  readonly semanticValidationRequired: true;
}

export type LocalRenameErrorCode =
  | "INVALID_RENAME_REQUEST"
  | "INVALID_NEW_NAME"
  | "STALE_RENAME_ANALYSIS"
  | "TARGET_SYMBOL_NOT_FOUND"
  | "UNSUPPORTED_RENAME_TARGET"
  | "UNCERTAIN_BINDING"
  | "SUSPICIOUS_PARSE"
  | "TARGET_OUTSIDE_FUNCTION"
  | "SHADOWING_DETECTED"
  | "NAME_COLLISION"
  | "INCOMPLETE_BINDING"
  | "OVERLAPPING_OCCURRENCES"
  | "NO_OP_RENAME";

export class LocalRenameError extends Error {
  readonly code: LocalRenameErrorCode;

  constructor(code: LocalRenameErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "LocalRenameError";
    this.code = code;
  }
}

const ASCII_C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_IMPLEMENTATION_IDENTIFIER = /^(?:__|_[A-Z])/u;

const C17_KEYWORDS = new Set([
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
]);

const ALWAYS_FILE_VISIBLE_KINDS = new Set<SymbolRecord["kind"]>([
  "file-variable",
  "function",
  "object-macro",
  "builtin-function",
  "builtin-typedef",
  "builtin-object-macro",
]);

interface TreeFacts {
  readonly allFunctions: readonly Node[];
  readonly targetFunction: Node;
  readonly macroNames: ReadonlySet<string>;
  readonly namedNodesByRange: ReadonlyMap<string, readonly Node[]>;
  readonly identifierNodes: readonly Node[];
}

/**
 * Plans a deliberately conservative rename of one function-local variable.
 *
 * The symbol snapshot supplies lexical binding facts; the live CST is used as
 * a second trust boundary so every replacement must be one complete
 * `identifier` leaf. The function never mutates source or analysis state.
 */
export function planConservativeLocalRename(
  request: ConservativeLocalRenameRequest,
): ConservativeLocalRenamePlan {
  assertRequestShape(request);
  assertFreshAnalysis(request);
  assertValidNewName(request.newName);

  const target = requireUniqueTarget(request.analysis, request.symbolId);
  if (target.name !== request.expectedOldName) {
    throw renameError("STALE_RENAME_ANALYSIS", "目标符号名称与请求创建时不一致");
  }
  if (target.kind !== "local-variable") {
    throw renameError("UNSUPPORTED_RENAME_TARGET", "只允许重命名函数内局部变量");
  }
  if (target.confidence !== "certain") {
    throw renameError("UNCERTAIN_BINDING", "目标符号绑定不是 certain，拒绝生成补丁");
  }
  if (!ASCII_C_IDENTIFIER.test(target.name) || C17_KEYWORDS.has(target.name)) {
    throw renameError("UNCERTAIN_BINDING", "目标符号不是受支持的 ASCII C17 标识符");
  }
  if (target.name === request.newName) {
    throw renameError("NO_OP_RENAME", "新旧名称相同");
  }

  assertNoSuspiciousGlobalFacts(request.analysis, request.rootNode);
  const targetOccurrences = requireTargetOccurrences(request.analysis, target);
  const declarationRange = requireSingleDeclaration(target, targetOccurrences);
  const treeFacts = inspectTree(request, declarationRange);

  assertOccurrencesAreIdentifierLeaves(request.source, targetOccurrences, target.name, treeFacts);
  assertBindingCoverage(request, target, targetOccurrences, treeFacts);
  assertNoOldNameShadowing(request.analysis, target, treeFacts);
  assertNoNewNameCollision(request.analysis, target, request.newName, treeFacts);

  const patches = Object.freeze(
    targetOccurrences.map((occurrence) => createTextPatch(occurrence.range, request.newName)),
  );
  return Object.freeze({
    kind: "local-variable-rename",
    symbolId: target.id,
    oldName: target.name,
    newName: request.newName,
    functionRange: nodeRange(treeFacts.targetFunction),
    patches,
    requiresConfirmation: true,
    semanticValidationRequired: true,
  });
}

function assertRequestShape(request: ConservativeLocalRenameRequest): void {
  if (typeof request !== "object" || request === null) {
    throw renameError("INVALID_RENAME_REQUEST", "request 必须是对象");
  }
  if (typeof request.source !== "string") {
    throw renameError("INVALID_RENAME_REQUEST", "source 必须是字符串");
  }
  if (typeof request.rootNode !== "object" || request.rootNode === null) {
    throw renameError("INVALID_RENAME_REQUEST", "rootNode 必须是有效 CST 根节点");
  }
  if (typeof request.analysis !== "object" || request.analysis === null) {
    throw renameError("INVALID_RENAME_REQUEST", "analysis 必须是对象");
  }
  if (typeof request.symbolId !== "string" || request.symbolId.length === 0) {
    throw renameError("INVALID_RENAME_REQUEST", "symbolId 不得为空");
  }
  if (typeof request.expectedOldName !== "string") {
    throw renameError("INVALID_RENAME_REQUEST", "expectedOldName 必须是字符串");
  }
  if (typeof request.newName !== "string") {
    throw renameError("INVALID_RENAME_REQUEST", "newName 必须是字符串");
  }
}

function assertFreshAnalysis(request: ConservativeLocalRenameRequest): void {
  const { analysis, rootNode, source } = request;
  let rootMatchesSource = false;
  try {
    rootMatchesSource =
      rootNode.type === "translation_unit" &&
      (rootNode.startIndex === 0 || (rootNode.startIndex === 1 && source.startsWith("\uFEFF"))) &&
      rootNode.endIndex === source.length &&
      rootNode.text === source.slice(rootNode.startIndex, rootNode.endIndex);
  } catch {
    throw renameError("STALE_RENAME_ANALYSIS", "CST 已释放或无法读取");
  }
  if (
    analysis.source !== source ||
    analysis.range.from !== 0 ||
    analysis.range.to !== source.length ||
    !rootMatchesSource
  ) {
    throw renameError("STALE_RENAME_ANALYSIS", "source、分析事实与 CST 不属于同一合法快照");
  }
}

function assertValidNewName(newName: string): void {
  if (
    !ASCII_C_IDENTIFIER.test(newName) ||
    C17_KEYWORDS.has(newName) ||
    RESERVED_IMPLEMENTATION_IDENTIFIER.test(newName)
  ) {
    throw renameError("INVALID_NEW_NAME", "新名称必须是非关键字、非实现保留名的 ASCII C17 标识符");
  }
}

function requireUniqueTarget(analysis: LocalRenameAnalysis, symbolId: string): SymbolRecord {
  const matches = analysis.symbols.symbols.filter((symbol) => symbol.id === symbolId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw renameError("TARGET_SYMBOL_NOT_FOUND", "symbolId 不存在或在快照中不唯一");
  }
  return matches[0];
}

function assertNoSuspiciousGlobalFacts(analysis: LocalRenameAnalysis, rootNode: Node): void {
  if (
    analysis.parse.hasError ||
    analysis.parse.errorRanges.length > 0 ||
    analysis.parse.missingOffsets.length > 0 ||
    rootNode.hasError ||
    analysis.concerns.length > 0
  ) {
    throw renameError("SUSPICIOUS_PARSE", "快照含 ERROR、MISSING 或低置信度解析关注项");
  }
}

function requireTargetOccurrences(
  analysis: LocalRenameAnalysis,
  target: SymbolRecord,
): readonly SymbolOccurrence[] {
  const occurrences = analysis.symbols.occurrences
    .filter((occurrence) => occurrence.symbolId === target.id)
    .sort(
      (left, right) =>
        left.range.from - right.range.from ||
        left.range.to - right.range.to ||
        left.role.localeCompare(right.role),
    );
  if (occurrences.length === 0) {
    throw renameError("INCOMPLETE_BINDING", "目标符号没有 occurrence");
  }

  let previous: SymbolOccurrence | undefined;
  for (const occurrence of occurrences) {
    if (
      occurrence.resolution !== "local" ||
      occurrence.range.from < 0 ||
      occurrence.range.to <= occurrence.range.from ||
      occurrence.range.to > analysis.source.length
    ) {
      throw renameError("INCOMPLETE_BINDING", "目标 occurrence 的绑定或 range 不可信");
    }
    if (previous !== undefined && occurrence.range.from < previous.range.to) {
      throw renameError("OVERLAPPING_OCCURRENCES", "目标 occurrence range 重叠或重复");
    }
    previous = occurrence;
  }
  return Object.freeze(occurrences);
}

function requireSingleDeclaration(
  target: SymbolRecord,
  occurrences: readonly SymbolOccurrence[],
): TextRange {
  const declarations = occurrences.filter((occurrence) => occurrence.role === "declaration");
  if (
    declarations.length !== 1 ||
    declarations[0] === undefined ||
    target.declarationRanges.length !== 1 ||
    target.declarationRanges[0] === undefined ||
    !sameRange(declarations[0].range, target.declarationRanges[0])
  ) {
    throw renameError("UNCERTAIN_BINDING", "局部变量必须有且只有一个一致的声明 occurrence");
  }
  return declarations[0].range;
}

function inspectTree(
  request: ConservativeLocalRenameRequest,
  declarationRange: TextRange,
): TreeFacts {
  const allFunctions: Node[] = [];
  const macroNames = new Set<string>();
  collectFunctionsAndMacros(request.rootNode, request.source, allFunctions, macroNames);
  const containing = allFunctions.filter((node) =>
    containsRange(nodeRange(node), declarationRange),
  );
  if (containing.length !== 1 || containing[0] === undefined) {
    throw renameError("TARGET_OUTSIDE_FUNCTION", "目标声明不属于唯一的函数定义");
  }
  const targetFunction = containing[0];
  assertCompleteTargetFunction(targetFunction);
  const functionRange = nodeRange(targetFunction);

  if (
    request.analysis.issues.some((issue) => rangesIntersect(issue.range, functionRange)) ||
    request.analysis.blocks.some((block) => containsRawBlock(block, functionRange)) ||
    containsPreprocessorNode(targetFunction)
  ) {
    throw renameError("SUSPICIOUS_PARSE", "目标函数含 raw 投影、投影问题或预处理分支");
  }

  const namedNodesByRange = new Map<string, Node[]>();
  const identifierNodes: Node[] = [];
  collectNamedNodes(targetFunction, namedNodesByRange, identifierNodes);
  return Object.freeze({
    allFunctions: Object.freeze(allFunctions),
    targetFunction,
    macroNames,
    namedNodesByRange,
    identifierNodes: Object.freeze(identifierNodes),
  });
}

function assertOccurrencesAreIdentifierLeaves(
  source: string,
  occurrences: readonly SymbolOccurrence[],
  oldName: string,
  treeFacts: TreeFacts,
): void {
  const functionRange = nodeRange(treeFacts.targetFunction);
  for (const occurrence of occurrences) {
    if (!containsRange(functionRange, occurrence.range)) {
      throw renameError("INCOMPLETE_BINDING", "局部变量 occurrence 逃出所属函数");
    }
    if (source.slice(occurrence.range.from, occurrence.range.to) !== oldName) {
      throw renameError("STALE_RENAME_ANALYSIS", "occurrence range 不再对应目标名称");
    }
    const exactIdentifiers = (
      treeFacts.namedNodesByRange.get(rangeKey(occurrence.range)) ?? []
    ).filter(
      (node) =>
        node.type === "identifier" &&
        node.isNamed &&
        !node.isError &&
        !node.isMissing &&
        node.namedChildCount === 0,
    );
    if (exactIdentifiers.length !== 1) {
      throw renameError(
        "INCOMPLETE_BINDING",
        "每个 occurrence 必须精确对应一个完整 identifier 叶子",
      );
    }
  }
}

function assertBindingCoverage(
  request: ConservativeLocalRenameRequest,
  target: SymbolRecord,
  targetOccurrences: readonly SymbolOccurrence[],
  treeFacts: TreeFacts,
): void {
  const targetRanges = new Set(targetOccurrences.map((occurrence) => rangeKey(occurrence.range)));
  const allOccurrencesByRange = new Map<string, SymbolOccurrence[]>();
  for (const occurrence of request.analysis.symbols.occurrences) {
    const key = rangeKey(occurrence.range);
    const bucket = allOccurrencesByRange.get(key);
    if (bucket === undefined) {
      allOccurrencesByRange.set(key, [occurrence]);
    } else {
      bucket.push(occurrence);
    }
  }

  for (const node of treeFacts.identifierNodes) {
    const range = nodeRange(node);
    if (request.source.slice(range.from, range.to) !== target.name) continue;
    const key = rangeKey(range);
    const occurrences = allOccurrencesByRange.get(key) ?? [];
    if (occurrences.length !== 1 || occurrences[0] === undefined) {
      throw renameError("INCOMPLETE_BINDING", "同名 identifier 缺少唯一符号绑定");
    }
    if (occurrences[0].symbolId !== target.id) {
      throw renameError("SHADOWING_DETECTED", "目标函数内存在绑定到其他符号的同名 identifier");
    }
    if (!targetRanges.has(key)) {
      throw renameError("INCOMPLETE_BINDING", "符号快照遗漏了目标 identifier occurrence");
    }
  }
}

function assertNoOldNameShadowing(
  analysis: LocalRenameAnalysis,
  target: SymbolRecord,
  treeFacts: TreeFacts,
): void {
  if (isBuiltinName(target.name) || treeFacts.macroNames.has(target.name)) {
    throw renameError("SHADOWING_DETECTED", "局部变量遮蔽了内置符号或预处理宏");
  }
  const conflict = analysis.symbols.symbols.some(
    (symbol) =>
      symbol.id !== target.id &&
      symbol.name === target.name &&
      symbolIsRelevantToFunction(symbol, analysis.symbols.occurrences, treeFacts),
  );
  if (conflict) {
    throw renameError("SHADOWING_DETECTED", "目标名称在函数或可见文件作用域中发生遮蔽");
  }
}

function assertNoNewNameCollision(
  analysis: LocalRenameAnalysis,
  target: SymbolRecord,
  newName: string,
  treeFacts: TreeFacts,
): void {
  if (isBuiltinName(newName) || treeFacts.macroNames.has(newName)) {
    throw renameError("NAME_COLLISION", "新名称与内置符号或预处理宏冲突");
  }
  const conflict = analysis.symbols.symbols.some(
    (symbol) =>
      symbol.id !== target.id &&
      symbol.name === newName &&
      symbolIsRelevantToFunction(symbol, analysis.symbols.occurrences, treeFacts),
  );
  if (conflict) {
    throw renameError("NAME_COLLISION", "新名称已存在于函数或可见文件作用域");
  }
}

function symbolIsRelevantToFunction(
  symbol: SymbolRecord,
  occurrences: readonly SymbolOccurrence[],
  treeFacts: TreeFacts,
): boolean {
  if (ALWAYS_FILE_VISIBLE_KINDS.has(symbol.kind)) return true;
  const targetRange = nodeRange(treeFacts.targetFunction);
  if (symbol.declarationRanges.some((range) => containsRange(targetRange, range))) return true;
  if (
    occurrences.some(
      (occurrence) =>
        occurrence.symbolId === symbol.id && containsRange(targetRange, occurrence.range),
    )
  ) {
    return true;
  }
  if (symbol.kind !== "typedef" && symbol.kind !== "enum-constant") return false;
  return symbol.declarationRanges.some(
    (declaration) =>
      !treeFacts.allFunctions.some((functionNode) =>
        containsRange(nodeRange(functionNode), declaration),
      ),
  );
}

function isBuiltinName(name: string): boolean {
  return (
    findBuiltinFunction(name) !== undefined ||
    findBuiltinTypedef(name) !== undefined ||
    findBuiltinObjectMacro(name) !== undefined
  );
}

function collectFunctionsAndMacros(
  node: Node,
  source: string,
  functions: Node[],
  macroNames: Set<string>,
): void {
  if (node.type === "function_definition") functions.push(node);
  if (node.type === "preproc_def" || node.type === "preproc_function_def") {
    const name = node.childForFieldName("name");
    if (
      name !== null &&
      !name.isError &&
      !name.isMissing &&
      isSafeNodeBoundary(name.startIndex, source.length) &&
      isSafeNodeBoundary(name.endIndex, source.length) &&
      name.endIndex > name.startIndex
    ) {
      macroNames.add(source.slice(name.startIndex, name.endIndex));
    }
  }
  for (const child of node.children) {
    collectFunctionsAndMacros(child, source, functions, macroNames);
  }
}

function assertCompleteTargetFunction(node: Node): void {
  const type = node.childForFieldName("type");
  const declarator = node.childForFieldName("declarator");
  const body = node.childForFieldName("body");
  if (
    node.hasError ||
    node.isError ||
    node.isMissing ||
    type === null ||
    declarator === null ||
    body === null ||
    body.type !== "compound_statement" ||
    containsRecoveryNode(node)
  ) {
    throw renameError("SUSPICIOUS_PARSE", "目标函数不是完整、无恢复节点的函数定义");
  }
}

function containsRecoveryNode(node: Node): boolean {
  if (node.isError || node.isMissing || node.type === "ERROR") return true;
  return node.children.some(containsRecoveryNode);
}

function containsPreprocessorNode(node: Node): boolean {
  if (node.type.startsWith("preproc_")) return true;
  return node.namedChildren.some(containsPreprocessorNode);
}

function containsRawBlock(block: Block, functionRange: TextRange): boolean {
  if (!rangesIntersect(block.range, functionRange)) return false;
  if (block.kind === "raw") return true;
  return block.children.some((child) => containsRawBlock(child, functionRange));
}

function collectNamedNodes(
  node: Node,
  nodesByRange: Map<string, Node[]>,
  identifiers: Node[],
): void {
  if (node.isNamed && node.endIndex > node.startIndex) {
    const range = nodeRange(node);
    const key = rangeKey(range);
    const bucket = nodesByRange.get(key);
    if (bucket === undefined) {
      nodesByRange.set(key, [node]);
    } else {
      bucket.push(node);
    }
    if (node.type === "identifier" && node.namedChildCount === 0) identifiers.push(node);
  }
  for (const child of node.namedChildren) collectNamedNodes(child, nodesByRange, identifiers);
}

function nodeRange(node: Node): TextRange {
  return textRange(node.startIndex, node.endIndex);
}

function rangeKey(range: TextRange): string {
  return `${range.from}:${range.to}`;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function containsRange(container: TextRange, candidate: TextRange): boolean {
  return container.from <= candidate.from && candidate.to <= container.to;
}

function rangesIntersect(left: TextRange, right: TextRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function isSafeNodeBoundary(value: number, sourceLength: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= sourceLength;
}

function renameError(code: LocalRenameErrorCode, message: string): LocalRenameError {
  return new LocalRenameError(code, message);
}
