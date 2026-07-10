import type { Node } from "web-tree-sitter";
import { textRange, type TextRange } from "../model.js";
import type { TextPatch } from "./model.js";
import { createTextPatch } from "./patch.js";

const STATEMENT_NODE_TYPES = new Set([
  "break_statement",
  "case_statement",
  "continue_statement",
  "do_statement",
  "expression_statement",
  "for_statement",
  "goto_statement",
  "if_statement",
  "labeled_statement",
  "return_statement",
  "switch_statement",
  "while_statement",
]);

const DECLARATION_NODE_TYPES = new Set([
  "declaration",
  "static_assert_declaration",
  "type_definition",
]);

const LIST_PARENT_NODE_TYPES = new Set(["compound_statement", "case_statement"]);
const REQUIRED_BODY_PARENT_NODE_TYPES = new Set([
  "do_statement",
  "else_clause",
  "for_statement",
  "if_statement",
  "labeled_statement",
  "switch_statement",
  "while_statement",
]);

export type StatementParentMode = "statement-list" | "required-body";
export type StatementEditBlocker =
  "multiline-block-comment" | "not-line-exclusive" | "parse-recovery" | "preprocessor-context";

/** Snapshot-local metadata. Source text remains authoritative and is never copied here. */
export interface StatementEditTarget {
  readonly id: string;
  readonly revision: number;
  readonly nodeType: string;
  readonly range: TextRange;
  /** Includes movable leading/trailing comments and the terminating newline when safe. */
  readonly extendedRange: TextRange;
  readonly indentationRange: TextRange;
  readonly parentNodeType: string;
  readonly parentRange: TextRange;
  readonly parentMode: StatementParentMode;
  readonly previousSiblingId: string | null;
  readonly nextSiblingId: string | null;
  readonly beforeBoundaryUnsafe: boolean;
  readonly afterBoundaryUnsafe: boolean;
  readonly blocker: StatementEditBlocker | null;
}

export interface StatementEditTargetSnapshot {
  readonly revision: number;
  readonly sourceLength: number;
  /** Non-cryptographic stale-snapshot guard; target text still comes from the live source. */
  readonly sourceFingerprint: string;
  readonly statements: readonly StatementEditTarget[];
}

interface StatementRequestBase {
  readonly baseRevision: number;
  readonly targetId: string;
  readonly expectedTargetText: string;
}

export interface InsertStatementRequest extends StatementRequestBase {
  readonly kind: "insert-statement";
  readonly position: "before" | "after";
  /** One unindented physical source line. Candidate shape is revalidated after parsing. */
  readonly statementText: string;
}

export interface DeleteStatementRequest extends StatementRequestBase {
  readonly kind: "delete-statement";
}

export interface SwapAdjacentStatementsRequest extends StatementRequestBase {
  readonly kind: "swap-adjacent-statements";
  readonly adjacentTargetId: string;
  readonly expectedAdjacentTargetText: string;
}

export type StatementOperationRequest =
  InsertStatementRequest | DeleteStatementRequest | SwapAdjacentStatementsRequest;

export interface StatementOperationPlan {
  readonly kind: StatementOperationRequest["kind"];
  readonly baseRevision: number;
  readonly targetIds: readonly string[];
  readonly patches: readonly TextPatch[];
  /** All current statement operations may change semantics and require a diff confirmation. */
  readonly requiresConfirmation: true;
}

export type StatementOperationErrorCode =
  | "INVALID_STATEMENT_REQUEST"
  | "MULTILINE_BLOCK_COMMENT"
  | "NOT_ADJACENT_SIBLINGS"
  | "NOT_LINE_EXCLUSIVE"
  | "PREPROCESSOR_BOUNDARY"
  | "STALE_STATEMENT_TARGET"
  | "UNSUPPORTED_STATEMENT_PARENT";

export class StatementOperationError extends Error {
  readonly code: StatementOperationErrorCode;

  constructor(code: StatementOperationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "StatementOperationError";
    this.code = code;
  }
}

interface ParentChildFact {
  readonly index: number;
  readonly nodeType: string;
  readonly range: TextRange;
}

interface ParentFact {
  readonly key: string;
  readonly children: readonly ParentChildFact[];
}

interface StatementTargetDraft {
  readonly id: string;
  readonly revision: number;
  readonly nodeType: string;
  readonly range: TextRange;
  readonly extendedRange: TextRange;
  readonly indentationRange: TextRange;
  readonly parentNodeType: string;
  readonly parentRange: TextRange;
  readonly parentMode: StatementParentMode;
  readonly parentKey: string;
  readonly directChildIndex: number;
  readonly beforeBoundaryUnsafe: boolean;
  readonly afterBoundaryUnsafe: boolean;
  readonly blocker: StatementEditBlocker | null;
  previousSiblingId: string | null;
  nextSiblingId: string | null;
}

interface LineLayout {
  readonly extendedRange: TextRange;
  readonly indentationRange: TextRange;
  readonly blocker: StatementEditBlocker | null;
}

/**
 * Extracts statement-line edit metadata before the Tree-sitter tree is disposed.
 * Only direct statement-list children and required unbraced control bodies are exposed.
 */
export function extractStatementEditTargets(
  rootNode: Node,
  source: string,
  revision: number,
): StatementEditTargetSnapshot {
  assertExtractionInputs(rootNode, source, revision);
  const drafts: StatementTargetDraft[] = [];
  const parentFacts = new Map<string, ParentFact>();
  let nextIndex = 0;

  const visit = (
    node: Node,
    inheritedPreprocessorContext: boolean,
    inheritedRecoveryContext: boolean,
  ): void => {
    const nodePreprocessorContext = inheritedPreprocessorContext || isPreprocessorNode(node.type);
    const nodeRecoveryContext =
      inheritedRecoveryContext ||
      node.hasError ||
      node.isError ||
      node.isMissing ||
      node.type === "ERROR";
    const parentRange = safeNodeRange(node, source.length);
    if (parentRange !== null && LIST_PARENT_NODE_TYPES.has(node.type)) {
      const key = parentKey(node.type, parentRange);
      parentFacts.set(
        key,
        Object.freeze({
          key,
          children: Object.freeze(
            node.namedChildren.flatMap((child, index) => {
              const range = safeNodeRange(child, source.length);
              return range === null ? [] : [Object.freeze({ index, nodeType: child.type, range })];
            }),
          ),
        }),
      );
    }

    for (const [directChildIndex, child] of node.namedChildren.entries()) {
      const relation = classifyEditableRelation(node, child);
      if (relation !== null) {
        const childRange = safeNodeRange(child, source.length);
        if (parentRange !== null && childRange !== null && childRange.from < childRange.to) {
          const layout = inspectLineLayout(source, childRange);
          const blocker = selectBlocker(
            child,
            source,
            nodePreprocessorContext,
            nodeRecoveryContext,
            layout.blocker,
          );
          const key = parentKey(node.type, parentRange);
          const children = parentFacts.get(key)?.children ?? Object.freeze([]);
          const id = `statement:${String(revision)}:${String(nextIndex)}`;
          nextIndex += 1;
          drafts.push({
            id,
            revision,
            nodeType: child.type,
            range: childRange,
            extendedRange: blocker === "not-line-exclusive" ? childRange : layout.extendedRange,
            indentationRange: layout.indentationRange,
            parentNodeType: node.type,
            parentRange,
            parentMode: relation,
            parentKey: key,
            directChildIndex,
            beforeBoundaryUnsafe: adjacentChildIsUnsafe(children, directChildIndex, -1),
            afterBoundaryUnsafe: adjacentChildIsUnsafe(children, directChildIndex, 1),
            blocker,
            previousSiblingId: null,
            nextSiblingId: null,
          });
        }
      }
      visit(child, nodePreprocessorContext, nodeRecoveryContext);
    }
  };

  visit(rootNode, false, false);
  connectAdjacentListSiblings(drafts, parentFacts);

  return Object.freeze({
    revision,
    sourceLength: source.length,
    sourceFingerprint: fingerprintSource(source),
    statements: Object.freeze(drafts.map(freezeTargetDraft)),
  });
}

/**
 * Compiles one statement operation into old-document range patches.
 * The host must apply them as one transaction, reparse, and enforce the R10 hard gate.
 */
export function planStatementOperation(
  source: string,
  snapshot: StatementEditTargetSnapshot,
  request: StatementOperationRequest,
): StatementOperationPlan {
  assertPlanningInputs(source, snapshot, request);
  const target = requireFreshTarget(source, snapshot, request.targetId, request.expectedTargetText);

  switch (request.kind) {
    case "insert-statement": {
      assertTargetEditable(target, false);
      return planInsertion(source, target, request);
    }
    case "delete-statement": {
      assertTargetEditable(target, target.parentMode === "required-body");
      return planDeletion(source, target, request);
    }
    case "swap-adjacent-statements": {
      assertTargetEditable(target, false);
      const adjacent = requireFreshTarget(
        source,
        snapshot,
        request.adjacentTargetId,
        request.expectedAdjacentTargetText,
      );
      assertTargetEditable(adjacent, false);
      return planSwap(source, target, adjacent, request);
    }
  }
}

function planInsertion(
  source: string,
  target: StatementEditTarget,
  request: InsertStatementRequest,
): StatementOperationPlan {
  if (target.parentMode !== "statement-list") {
    throw operationError(
      "UNSUPPORTED_STATEMENT_PARENT",
      "无大括号控制体旁插入会改变控制流归属，必须先补大括号",
    );
  }
  validateInsertedStatementText(request.statementText);
  const boundaryUnsafe =
    request.position === "before" ? target.beforeBoundaryUnsafe : target.afterBoundaryUnsafe;
  const position =
    request.position === "before" ? target.extendedRange.from : target.extendedRange.to;
  if (boundaryUnsafe || insertionBoundaryIsUnsafe(source, position)) {
    throw operationError("PREPROCESSOR_BOUNDARY", "插入点紧邻预处理或续行边界");
  }

  const indentation = source.slice(target.indentationRange.from, target.indentationRange.to);
  const newline = newlineForTarget(source, target);
  const targetEndsWithNewline = endsWithNewline(source, target.extendedRange);
  const newText =
    request.position === "after" && !targetEndsWithNewline
      ? `${newline}${indentation}${request.statementText}`
      : `${indentation}${request.statementText}${newline}`;

  return freezePlan(
    request,
    [target.id],
    [createTextPatch(textRange(position, position), newText)],
  );
}

function planDeletion(
  source: string,
  target: StatementEditTarget,
  request: DeleteStatementRequest,
): StatementOperationPlan {
  let replacement = "";
  let deletionRange = target.extendedRange;
  if (target.parentMode === "required-body") {
    if (target.blocker === "not-line-exclusive") {
      replacement = ";";
      deletionRange = inlineRequiredBodyDeletionRange(source, target.range);
    } else {
      const indentation = source.slice(target.indentationRange.from, target.indentationRange.to);
      const newline = newlineEndingAt(source, target.extendedRange.to);
      replacement = `${indentation};${newline}`;
    }
  }
  return freezePlan(request, [target.id], [createTextPatch(deletionRange, replacement)]);
}

function inlineRequiredBodyDeletionRange(source: string, range: TextRange): TextRange {
  const lineEnd = findLineContentEnd(source, range.to);
  const suffix = source.slice(range.to, lineEnd);
  return suffixContainsOnlyMovableTrailingComments(suffix) ? textRange(range.from, lineEnd) : range;
}

function suffixContainsOnlyMovableTrailingComments(suffix: string): boolean {
  let position = 0;
  let sawComment = false;
  while (position < suffix.length) {
    while (position < suffix.length && isHorizontalWhitespaceCharacter(suffix[position] ?? "")) {
      position += 1;
    }
    if (position >= suffix.length) return sawComment;
    if (suffix.startsWith("//", position)) return true;
    if (!suffix.startsWith("/*", position)) return false;
    const close = suffix.indexOf("*/", position + 2);
    if (close < 0) return false;
    sawComment = true;
    position = close + 2;
  }
  return sawComment;
}

function planSwap(
  source: string,
  target: StatementEditTarget,
  adjacent: StatementEditTarget,
  request: SwapAdjacentStatementsRequest,
): StatementOperationPlan {
  if (target.id === adjacent.id) {
    throw operationError("NOT_ADJACENT_SIBLINGS", "不能把语句与自身交换");
  }
  if (
    target.parentMode !== "statement-list" ||
    adjacent.parentMode !== "statement-list" ||
    target.parentNodeType !== adjacent.parentNodeType ||
    !sameRange(target.parentRange, adjacent.parentRange) ||
    (target.nextSiblingId !== adjacent.id && target.previousSiblingId !== adjacent.id)
  ) {
    throw operationError("NOT_ADJACENT_SIBLINGS", "只允许交换同一父级中的相邻语句");
  }

  const [first, second] =
    target.extendedRange.from < adjacent.extendedRange.from
      ? [target, adjacent]
      : [adjacent, target];
  if (
    first.extendedRange.to > second.extendedRange.from ||
    containsPreprocessorHazard(source, first.extendedRange.to, second.extendedRange.from)
  ) {
    throw operationError("PREPROCESSOR_BOUNDARY", "交换区间重叠或跨越预处理边界");
  }

  const firstText = source.slice(first.extendedRange.from, first.extendedRange.to);
  const secondText = source.slice(second.extendedRange.from, second.extendedRange.to);
  return freezePlan(
    request,
    [target.id, adjacent.id],
    [
      createTextPatch(first.extendedRange, secondText),
      createTextPatch(second.extendedRange, firstText),
    ],
  );
}

function freezePlan(
  request: StatementOperationRequest,
  targetIds: readonly string[],
  patches: readonly TextPatch[],
): StatementOperationPlan {
  return Object.freeze({
    kind: request.kind,
    baseRevision: request.baseRevision,
    targetIds: Object.freeze([...targetIds]),
    patches: Object.freeze([...patches]),
    requiresConfirmation: true,
  });
}

function assertExtractionInputs(rootNode: Node, source: string, revision: number): void {
  if (typeof rootNode !== "object" || rootNode === null || typeof rootNode.type !== "string") {
    throw new TypeError("rootNode 必须是有效 Tree-sitter 节点");
  }
  if (typeof source !== "string") throw new TypeError("source 必须是字符串");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("revision 必须是非负安全整数");
  }
  let rootMatchesSource = false;
  try {
    const startIndex = rootNode.startIndex;
    const endIndex = rootNode.endIndex;
    rootMatchesSource =
      // Tree-sitter C may return an EOF-spanning ERROR as the actual root for
      // malformed preprocessor input; it is still the live full-source tree.
      (rootNode.type === "translation_unit" || rootNode.type === "ERROR") &&
      Number.isSafeInteger(startIndex) &&
      Number.isSafeInteger(endIndex) &&
      startIndex >= 0 &&
      endIndex >= startIndex &&
      endIndex <= source.length &&
      isUncoveredRootPrefix(source.slice(0, startIndex)) &&
      isUncoveredRootSuffix(source.slice(endIndex)) &&
      rootNode.text === source.slice(startIndex, endIndex);
  } catch (error) {
    throw new TypeError("rootNode 已释放或无法读取", { cause: error });
  }
  if (!rootMatchesSource) throw new TypeError("rootNode 与 source 不属于同一源码快照");
}

function isUncoveredRootPrefix(prefix: string): boolean {
  return /^(?:\uFEFF)?[ \t\r\n\f\v]*$/u.test(prefix);
}

function isUncoveredRootSuffix(suffix: string): boolean {
  return /^[ \t\r\n\f\v]*$/u.test(suffix);
}

function assertPlanningInputs(
  source: string,
  snapshot: StatementEditTargetSnapshot,
  request: StatementOperationRequest,
): void {
  if (typeof source !== "string") throw new TypeError("source 必须是字符串");
  if (typeof snapshot !== "object" || snapshot === null) {
    throw operationError("STALE_STATEMENT_TARGET", "statement snapshot 不可用");
  }
  if (
    snapshot.sourceLength !== source.length ||
    snapshot.sourceFingerprint !== fingerprintSource(source)
  ) {
    throw operationError("STALE_STATEMENT_TARGET", "statement snapshot 与当前源码不一致");
  }
  if (typeof request !== "object" || request === null) {
    throw operationError("INVALID_STATEMENT_REQUEST", "request 必须是对象");
  }
  if (
    !Number.isSafeInteger(request.baseRevision) ||
    request.baseRevision < 0 ||
    request.baseRevision !== snapshot.revision
  ) {
    throw operationError("STALE_STATEMENT_TARGET", "baseRevision 与 snapshot 不一致");
  }
  if (
    typeof request.targetId !== "string" ||
    request.targetId.length === 0 ||
    typeof request.expectedTargetText !== "string"
  ) {
    throw operationError("INVALID_STATEMENT_REQUEST", "目标 id 与 expected text 必须有效");
  }
  if (
    request.kind !== "insert-statement" &&
    request.kind !== "delete-statement" &&
    request.kind !== "swap-adjacent-statements"
  ) {
    throw operationError("INVALID_STATEMENT_REQUEST", "未知语句操作");
  }
  if (
    request.kind === "insert-statement" &&
    request.position !== "before" &&
    request.position !== "after"
  ) {
    throw operationError("INVALID_STATEMENT_REQUEST", "插入位置必须是 before 或 after");
  }
  if (request.kind === "swap-adjacent-statements") {
    if (
      typeof request.adjacentTargetId !== "string" ||
      request.adjacentTargetId.length === 0 ||
      typeof request.expectedAdjacentTargetText !== "string"
    ) {
      throw operationError("INVALID_STATEMENT_REQUEST", "相邻目标信息无效");
    }
  }
}

function requireFreshTarget(
  source: string,
  snapshot: StatementEditTargetSnapshot,
  targetId: string,
  expectedText: string,
): StatementEditTarget {
  const matches = snapshot.statements.filter((candidate) => candidate.id === targetId);
  const target = matches[0];
  if (
    matches.length !== 1 ||
    target === undefined ||
    target.revision !== snapshot.revision ||
    source.slice(target.range.from, target.range.to) !== expectedText
  ) {
    throw operationError("STALE_STATEMENT_TARGET", "语句目标已过期或不唯一");
  }
  return target;
}

function assertTargetEditable(
  target: StatementEditTarget,
  allowInlineRequiredBodyDelete: boolean,
): void {
  switch (target.blocker) {
    case null:
      return;
    case "multiline-block-comment":
      throw operationError("MULTILINE_BLOCK_COMMENT", "多行块注释默认不随语句移动或删除");
    case "not-line-exclusive":
      if (allowInlineRequiredBodyDelete && target.parentMode === "required-body") return;
      throw operationError("NOT_LINE_EXCLUSIVE", "语句未独占源代码行");
    case "parse-recovery":
      throw operationError("STALE_STATEMENT_TARGET", "语句位于 ERROR/MISSING 恢复区域");
    case "preprocessor-context":
      throw operationError("PREPROCESSOR_BOUNDARY", "语句位于预处理或续行上下文");
  }
}

function validateInsertedStatementText(statementText: string): void {
  if (
    typeof statementText !== "string" ||
    statementText.length === 0 ||
    statementText.trim().length === 0 ||
    /[\r\n]/u.test(statementText) ||
    /^[ \t\f\v]|[ \t\f\v]$/u.test(statementText)
  ) {
    throw operationError(
      "INVALID_STATEMENT_REQUEST",
      "插入内容必须是一条非空、无外层缩进的物理源代码行",
    );
  }
  const firstPreprocessingToken = statementText.replace(/^(?:[ \t\f\v]|\/\*[^\r\n]*?\*\/)+/u, "");
  if (
    ["#", "%:", "??="].some((token) => firstPreprocessingToken.startsWith(token)) ||
    /(?:\\|\?\?\/)[ \t\f\v]*$/u.test(statementText) ||
    /^\/\//u.test(statementText)
  ) {
    throw operationError("PREPROCESSOR_BOUNDARY", "插入内容不能是预处理、续行或纯注释行");
  }
}

function classifyEditableRelation(parent: Node, child: Node): StatementParentMode | null {
  if (!isStatementLike(child.type)) return null;
  if (LIST_PARENT_NODE_TYPES.has(parent.type)) return "statement-list";
  if (REQUIRED_BODY_PARENT_NODE_TYPES.has(parent.type) && isRequiredBodyChild(parent, child)) {
    return "required-body";
  }
  return null;
}

function isRequiredBodyChild(parent: Node, child: Node): boolean {
  const body =
    parent.childForFieldName("body") ??
    parent.childForFieldName("consequence") ??
    parent.childForFieldName("statement");
  if (body !== null) return sameNode(body, child);
  if (parent.type !== "else_clause" && parent.type !== "labeled_statement") return false;
  const candidates = parent.namedChildren.filter((candidate) => isStatementLike(candidate.type));
  return candidates.length === 1 && candidates[0] !== undefined && sameNode(candidates[0], child);
}

function isStatementLike(nodeType: string): boolean {
  return STATEMENT_NODE_TYPES.has(nodeType) || DECLARATION_NODE_TYPES.has(nodeType);
}

function selectBlocker(
  node: Node,
  source: string,
  inheritedPreprocessorContext: boolean,
  inheritedRecoveryContext: boolean,
  lineBlocker: StatementEditBlocker | null,
): StatementEditBlocker | null {
  if (inheritedRecoveryContext || node.hasError || node.isError || node.isMissing) {
    return "parse-recovery";
  }
  if (
    inheritedPreprocessorContext ||
    subtreeContains(node, (candidate) => isPreprocessorNode(candidate.type)) ||
    containsPreprocessorHazard(source, node.startIndex, node.endIndex)
  ) {
    return "preprocessor-context";
  }
  if (
    subtreeContains(
      node,
      (candidate) =>
        candidate.type === "comment" &&
        /[\r\n]/u.test(source.slice(candidate.startIndex, candidate.endIndex)),
    )
  ) {
    return "multiline-block-comment";
  }
  return lineBlocker;
}

function inspectLineLayout(source: string, range: TextRange): LineLayout {
  const firstLineStart = findLineStart(source, range.from);
  const lastLineContentEnd = findLineContentEnd(source, range.to);
  const lastLineEnd = consumeNewline(source, lastLineContentEnd);
  const indentationRange = textRange(firstLineStart, range.from);
  const prefix = source.slice(firstLineStart, range.from);
  const suffix = source.slice(range.to, lastLineContentEnd);
  const suffixKind = classifyLineSuffix(suffix);
  if (!isHorizontalWhitespace(prefix) || suffixKind !== "safe") {
    return Object.freeze({
      extendedRange: range,
      indentationRange,
      blocker:
        suffixKind === "multiline-block-comment" ? "multiline-block-comment" : "not-line-exclusive",
    });
  }

  let extendedFrom = firstLineStart;
  let cursor = firstLineStart;
  while (cursor > 0) {
    const previous = previousLine(source, cursor);
    if (previous === null) break;
    const lineText = source.slice(previous.start, previous.contentEnd);
    if (!isMovableCommentOnlyLine(lineText)) break;
    extendedFrom = previous.start;
    cursor = previous.start;
  }

  const extendedRange = textRange(extendedFrom, lastLineEnd);
  return Object.freeze({
    extendedRange,
    indentationRange,
    blocker: containsPreprocessorHazard(source, extendedRange.from, extendedRange.to)
      ? "preprocessor-context"
      : null,
  });
}

function classifyLineSuffix(suffix: string): "code" | "multiline-block-comment" | "safe" {
  let position = 0;
  while (position < suffix.length) {
    while (position < suffix.length && isHorizontalWhitespaceCharacter(suffix[position] ?? "")) {
      position += 1;
    }
    if (position >= suffix.length) return "safe";
    if (suffix.startsWith("//", position)) return "safe";
    if (!suffix.startsWith("/*", position)) return "code";
    const close = suffix.indexOf("*/", position + 2);
    if (close < 0) return "multiline-block-comment";
    position = close + 2;
  }
  return "safe";
}

function isMovableCommentOnlyLine(lineText: string): boolean {
  let position = 0;
  let sawComment = false;
  while (position < lineText.length) {
    while (
      position < lineText.length &&
      isHorizontalWhitespaceCharacter(lineText[position] ?? "")
    ) {
      position += 1;
    }
    if (position >= lineText.length) return sawComment;
    if (lineText.startsWith("//", position)) return true;
    if (!lineText.startsWith("/*", position)) return false;
    const close = lineText.indexOf("*/", position + 2);
    if (close < 0) return false;
    sawComment = true;
    position = close + 2;
  }
  return sawComment;
}

function connectAdjacentListSiblings(
  drafts: readonly StatementTargetDraft[],
  parentFacts: ReadonlyMap<string, ParentFact>,
): void {
  const byParent = new Map<string, StatementTargetDraft[]>();
  for (const draft of drafts) {
    if (draft.parentMode !== "statement-list") continue;
    const siblings = byParent.get(draft.parentKey);
    if (siblings === undefined) byParent.set(draft.parentKey, [draft]);
    else siblings.push(draft);
  }

  for (const [key, siblings] of byParent) {
    siblings.sort((left, right) => left.directChildIndex - right.directChildIndex);
    const children = parentFacts.get(key)?.children ?? Object.freeze([]);
    for (let index = 0; index + 1 < siblings.length; index += 1) {
      const left = siblings[index];
      const right = siblings[index + 1];
      if (left === undefined || right === undefined) continue;
      const between = children.filter(
        (child) => left.directChildIndex < child.index && child.index < right.directChildIndex,
      );
      if (between.some((child) => child.nodeType !== "comment")) continue;
      left.nextSiblingId = right.id;
      right.previousSiblingId = left.id;
    }
  }
}

function freezeTargetDraft(draft: StatementTargetDraft): StatementEditTarget {
  return Object.freeze({
    id: draft.id,
    revision: draft.revision,
    nodeType: draft.nodeType,
    range: draft.range,
    extendedRange: draft.extendedRange,
    indentationRange: draft.indentationRange,
    parentNodeType: draft.parentNodeType,
    parentRange: draft.parentRange,
    parentMode: draft.parentMode,
    previousSiblingId: draft.previousSiblingId,
    nextSiblingId: draft.nextSiblingId,
    beforeBoundaryUnsafe: draft.beforeBoundaryUnsafe,
    afterBoundaryUnsafe: draft.afterBoundaryUnsafe,
    blocker: draft.blocker,
  });
}

function adjacentChildIsUnsafe(
  children: readonly ParentChildFact[],
  directChildIndex: number,
  direction: -1 | 1,
): boolean {
  let index = directChildIndex + direction;
  while (0 <= index && index < children.length) {
    const child = children[index];
    if (child === undefined) return false;
    if (child.nodeType === "comment") {
      index += direction;
      continue;
    }
    return isPreprocessorNode(child.nodeType) || child.nodeType === "ERROR";
  }
  return false;
}

function insertionBoundaryIsUnsafe(source: string, position: number): boolean {
  const currentStart = findLineStart(source, position);
  const currentEnd = findLineContentEnd(source, position);
  const currentLine = source.slice(currentStart, currentEnd);
  const previous = previousLine(source, currentStart);
  const previousText = previous === null ? "" : source.slice(previous.start, previous.contentEnd);
  return lineIsPreprocessorHazard(currentLine) || lineIsPreprocessorHazard(previousText);
}

function containsPreprocessorHazard(source: string, from: number, to: number): boolean {
  if (from < 0 || to < from || to > source.length) return true;
  let lineStart = findLineStart(source, from);
  while (lineStart <= to && lineStart < source.length) {
    const lineEnd = findLineContentEnd(source, lineStart);
    if (lineIsPreprocessorHazard(source.slice(lineStart, lineEnd))) return true;
    const next = consumeNewline(source, lineEnd);
    if (next <= lineStart || next >= to) break;
    lineStart = next;
  }
  return false;
}

function lineIsPreprocessorHazard(line: string): boolean {
  return /^[ \t\f\v]*#/u.test(line) || /\\[ \t\f\v]*$/u.test(line);
}

function newlineForTarget(source: string, target: StatementEditTarget): string {
  return (
    newlineEndingAt(source, target.extendedRange.to) ||
    nearestNewline(source, target.range.from) ||
    "\n"
  );
}

function newlineEndingAt(source: string, position: number): string {
  if (position >= 2 && source.slice(position - 2, position) === "\r\n") return "\r\n";
  const last = position >= 1 ? source[position - 1] : undefined;
  return last === "\r" || last === "\n" ? last : "";
}

function nearestNewline(source: string, position: number): string {
  for (let index = position; index < source.length; index += 1) {
    if (source[index] === "\r") return source[index + 1] === "\n" ? "\r\n" : "\r";
    if (source[index] === "\n") return "\n";
  }
  for (let index = position - 1; index >= 0; index -= 1) {
    if (source[index] === "\n") return index > 0 && source[index - 1] === "\r" ? "\r\n" : "\n";
    if (source[index] === "\r") return "\r";
  }
  return "";
}

function endsWithNewline(source: string, range: TextRange): boolean {
  const last = range.to > range.from ? source[range.to - 1] : undefined;
  return last === "\r" || last === "\n";
}

function findLineStart(source: string, position: number): number {
  let cursor = Math.min(Math.max(position, 0), source.length);
  while (cursor > 0) {
    const previous = source[cursor - 1];
    if (previous === "\r" || previous === "\n") break;
    cursor -= 1;
  }
  return cursor;
}

function findLineContentEnd(source: string, position: number): number {
  let cursor = Math.min(Math.max(position, 0), source.length);
  while (cursor < source.length && source[cursor] !== "\r" && source[cursor] !== "\n") {
    cursor += 1;
  }
  return cursor;
}

function consumeNewline(source: string, contentEnd: number): number {
  if (source[contentEnd] === "\r" && source[contentEnd + 1] === "\n") {
    return contentEnd + 2;
  }
  return source[contentEnd] === "\r" || source[contentEnd] === "\n" ? contentEnd + 1 : contentEnd;
}

function previousLine(
  source: string,
  currentLineStart: number,
): { readonly start: number; readonly contentEnd: number } | null {
  if (currentLineStart <= 0) return null;
  let contentEnd = currentLineStart;
  if (source[contentEnd - 1] === "\n") {
    contentEnd -= 1;
    if (contentEnd > 0 && source[contentEnd - 1] === "\r") contentEnd -= 1;
  } else if (source[contentEnd - 1] === "\r") {
    contentEnd -= 1;
  }
  return Object.freeze({ start: findLineStart(source, contentEnd), contentEnd });
}

function isHorizontalWhitespace(text: string): boolean {
  return /^[ \t\f\v]*$/u.test(text);
}

function isHorizontalWhitespaceCharacter(character: string): boolean {
  return character === " " || character === "\t" || character === "\f" || character === "\v";
}

function subtreeContains(node: Node, predicate: (candidate: Node) => boolean): boolean {
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (candidate === undefined) continue;
    if (predicate(candidate)) return true;
    stack.push(...candidate.namedChildren);
  }
  return false;
}

function isPreprocessorNode(nodeType: string): boolean {
  return nodeType.startsWith("preproc_");
}

function safeNodeRange(node: Node, sourceLength: number): TextRange | null {
  if (
    !Number.isSafeInteger(node.startIndex) ||
    !Number.isSafeInteger(node.endIndex) ||
    node.startIndex < 0 ||
    node.endIndex < node.startIndex ||
    node.endIndex > sourceLength
  ) {
    return null;
  }
  return textRange(node.startIndex, node.endIndex);
}

function sameNode(left: Node, right: Node): boolean {
  return (
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function parentKey(nodeType: string, range: TextRange): string {
  return `${nodeType}:${String(range.from)}:${String(range.to)}`;
}

function fingerprintSource(source: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = (Math.imul(second ^ (code + index), 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  }
  return `${String(source.length)}:${first.toString(16)}:${second.toString(16)}`;
}

function operationError(
  code: StatementOperationErrorCode,
  message: string,
): StatementOperationError {
  return new StatementOperationError(code, message);
}
