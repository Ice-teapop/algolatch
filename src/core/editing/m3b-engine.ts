import { textRange, type SymbolOccurrence, type TextRange } from "../model.js";
import type { CAnalysisSnapshot, LocalRenamePlanningRequest } from "../parser.js";
import { renderSourceDoc } from "../render.js";
import type { ConservativeLocalRenamePlan } from "./rename.js";
import type { EditDiff, EditPlan, TextPatch } from "./model.js";
import { applyTextPatches } from "./patch.js";
import {
  planStatementOperation,
  type StatementEditTarget,
  type StatementOperationPlan,
  type StatementOperationRequest,
} from "./statements.js";

const ALLOWED_INSERTED_NODE_TYPES = new Set([
  "break_statement",
  "case_statement",
  "continue_statement",
  "declaration",
  "do_statement",
  "expression_statement",
  "for_statement",
  "goto_statement",
  "if_statement",
  "labeled_statement",
  "return_statement",
  "static_assert_declaration",
  "switch_statement",
  "type_definition",
  "while_statement",
]);

export interface LocalRenameEditRequest extends LocalRenamePlanningRequest {
  readonly kind: "local-variable-rename";
  readonly baseRevision: number;
}

export type M3bEditRequest = StatementOperationRequest | LocalRenameEditRequest;

export interface M3bEditAnalyzer {
  analyze(source: string, revision: number): CAnalysisSnapshot;
  planLocalRename(
    source: string,
    analysis: CAnalysisSnapshot,
    request: LocalRenamePlanningRequest,
  ): ConservativeLocalRenamePlan;
}

export interface M3bEditContext {
  readonly source: string;
  readonly analysis: CAnalysisSnapshot;
  readonly analyzer: M3bEditAnalyzer;
  /** Host-owned policy such as NUL, UTF-8 byte length and file-input limits. */
  readonly validateSource: (source: string) => void;
}

interface ValidatedPlanBase {
  readonly kind: M3bEditRequest["kind"];
  readonly baseRevision: number;
  readonly candidateRevision: number;
  readonly textPlan: EditPlan;
  readonly patches: readonly TextPatch[];
  readonly diffs: readonly EditDiff[];
  readonly inversePatches: readonly TextPatch[];
  readonly candidateSource: string;
  readonly candidateAnalysis: CAnalysisSnapshot;
}

export interface ValidatedStatementEditPlan extends ValidatedPlanBase {
  readonly kind: StatementOperationRequest["kind"];
  readonly targetIds: readonly string[];
  /** Statement changes intentionally may change behavior, so the user must confirm the diff. */
  readonly requiresConfirmation: true;
  readonly semanticValidationRequired: false;
}

export interface ValidatedLocalRenameEditPlan extends ValidatedPlanBase {
  readonly kind: "local-variable-rename";
  readonly symbolId: string;
  /** Corpus acceptance is separate; this runtime plan makes no semantic-equivalence claim. */
  readonly requiresConfirmation: true;
  readonly semanticValidationRequired: true;
}

export type M3bEditPlan = ValidatedStatementEditPlan | ValidatedLocalRenameEditPlan;

export type M3bEditErrorCode =
  | "INVALID_M3B_EDIT_CONTEXT"
  | "INVALID_M3B_EDIT_REQUEST"
  | "STALE_M3B_EDIT"
  | "NO_OP_M3B_EDIT"
  | "CANDIDATE_SOURCE_REJECTED"
  | "CANDIDATE_ANALYSIS_FAILED"
  | "CANDIDATE_PARSE_ERROR"
  | "CANDIDATE_POSTCONDITION_FAILED";

export class M3bEditError extends Error {
  readonly code: M3bEditErrorCode;

  constructor(code: M3bEditErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "M3bEditError";
    this.code = code;
  }
}

interface StatementRawFacts {
  readonly category: "statement";
  readonly plan: StatementOperationPlan;
}

interface RenameRawFacts {
  readonly category: "rename";
  readonly plan: ConservativeLocalRenamePlan;
}

type RawFacts = StatementRawFacts | RenameRawFacts;

/**
 * Runs every M3b operation through one immutable trust pipeline:
 * stale guards -> raw patches -> host policy -> full reparse -> hard gate ->
 * operation-specific structural postconditions.
 */
export function planM3bEdit(context: M3bEditContext, request: M3bEditRequest): M3bEditPlan {
  assertContext(context);
  assertRequest(request);
  assertBaseSnapshot(context.source, context.analysis, request.baseRevision);

  const raw = planRawOperation(context, request);
  const application = applyTextPatches(context.source, raw.plan.patches);
  if (application.plan.patches.length === 0) {
    throw m3bError("NO_OP_M3B_EDIT", "编辑没有改变源码");
  }

  try {
    context.validateSource(application.source);
  } catch (cause) {
    throw m3bError("CANDIDATE_SOURCE_REJECTED", "候选源码未通过宿主输入策略", cause);
  }

  const candidateRevision = nextRevision(request.baseRevision);
  let candidateAnalysis: CAnalysisSnapshot;
  try {
    candidateAnalysis = context.analyzer.analyze(application.source, candidateRevision);
  } catch (cause) {
    throw m3bError("CANDIDATE_ANALYSIS_FAILED", "候选源码完整分析失败", cause);
  }
  assertCandidateSnapshot(application.source, candidateRevision, candidateAnalysis);
  assertNoParseRecovery(candidateAnalysis);
  assertPostcondition(context, request, raw, application.diffs, candidateAnalysis);

  const common = {
    kind: request.kind,
    baseRevision: request.baseRevision,
    candidateRevision,
    textPlan: application.plan,
    patches: application.plan.patches,
    diffs: application.diffs,
    inversePatches: application.inversePatches,
    candidateSource: application.source,
    candidateAnalysis: deepFreeze(candidateAnalysis),
  };

  if (raw.category === "rename") {
    return deepFreeze({
      ...common,
      kind: "local-variable-rename",
      symbolId: raw.plan.symbolId,
      requiresConfirmation: raw.plan.requiresConfirmation,
      semanticValidationRequired: raw.plan.semanticValidationRequired,
    });
  }
  return deepFreeze({
    ...common,
    kind: request.kind as StatementOperationRequest["kind"],
    targetIds: raw.plan.targetIds,
    requiresConfirmation: raw.plan.requiresConfirmation,
    semanticValidationRequired: false,
  });
}

function planRawOperation(context: M3bEditContext, request: M3bEditRequest): RawFacts {
  if (request.kind === "local-variable-rename") {
    return Object.freeze({
      category: "rename",
      plan: context.analyzer.planLocalRename(context.source, context.analysis, {
        symbolId: request.symbolId,
        expectedOldName: request.expectedOldName,
        newName: request.newName,
      }),
    });
  }
  return Object.freeze({
    category: "statement",
    plan: planStatementOperation(context.source, context.analysis.statementEdits, request),
  });
}

function assertContext(context: M3bEditContext): void {
  if (typeof context !== "object" || context === null) {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "context 必须是对象");
  }
  if (typeof context.source !== "string") {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "context.source 必须是字符串");
  }
  if (typeof context.analysis !== "object" || context.analysis === null) {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "context.analysis 必须是对象");
  }
  if (
    typeof context.analyzer?.analyze !== "function" ||
    typeof context.analyzer.planLocalRename !== "function"
  ) {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "context.analyzer 缺少 M3b 分析能力");
  }
  if (typeof context.validateSource !== "function") {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "context.validateSource 不可用");
  }
  try {
    context.validateSource(context.source);
  } catch (cause) {
    throw m3bError("INVALID_M3B_EDIT_CONTEXT", "基础源码未通过宿主输入策略", cause);
  }
}

function assertRequest(request: M3bEditRequest): void {
  if (typeof request !== "object" || request === null) {
    throw m3bError("INVALID_M3B_EDIT_REQUEST", "request 必须是对象");
  }
  if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
    throw m3bError("INVALID_M3B_EDIT_REQUEST", "baseRevision 必须是非负安全整数");
  }
  if (request.kind === "local-variable-rename") {
    if (
      typeof request.symbolId !== "string" ||
      request.symbolId.length === 0 ||
      typeof request.expectedOldName !== "string" ||
      typeof request.newName !== "string"
    ) {
      throw m3bError("INVALID_M3B_EDIT_REQUEST", "rename 的纯值字段无效");
    }
    return;
  }
  if (
    request.kind !== "insert-statement" &&
    request.kind !== "delete-statement" &&
    request.kind !== "swap-adjacent-statements"
  ) {
    throw m3bError("INVALID_M3B_EDIT_REQUEST", "未知 M3b 编辑类型");
  }
}

function assertBaseSnapshot(
  source: string,
  analysis: CAnalysisSnapshot,
  baseRevision: number,
): void {
  if (
    analysis.document.source !== source ||
    analysis.document.range.from !== 0 ||
    analysis.document.range.to !== source.length ||
    analysis.editTargets.revision !== baseRevision ||
    analysis.statementEdits.revision !== baseRevision ||
    analysis.statementEdits.sourceLength !== source.length
  ) {
    throw m3bError("STALE_M3B_EDIT", "源码、完整分析与 baseRevision 不属于同一快照");
  }
}

function assertCandidateSnapshot(
  source: string,
  revision: number,
  analysis: CAnalysisSnapshot,
): void {
  let renderedSource: string;
  try {
    renderedSource = renderSourceDoc(analysis.document);
  } catch (cause) {
    throw m3bError("CANDIDATE_ANALYSIS_FAILED", "候选投影无法独立重建源码", cause);
  }
  if (
    analysis.document.source !== source ||
    analysis.document.range.from !== 0 ||
    analysis.document.range.to !== source.length ||
    analysis.editTargets.revision !== revision ||
    analysis.statementEdits.revision !== revision ||
    analysis.statementEdits.sourceLength !== source.length ||
    renderedSource !== source
  ) {
    throw m3bError("CANDIDATE_ANALYSIS_FAILED", "analyzer 返回了不匹配的候选快照");
  }
}

function assertNoParseRecovery(analysis: CAnalysisSnapshot): void {
  const { parse } = analysis.document;
  if (parse.hasError || parse.errorRanges.length > 0 || parse.missingOffsets.length > 0) {
    throw m3bError("CANDIDATE_PARSE_ERROR", "候选源码含 ERROR 或 MISSING");
  }
}

function assertPostcondition(
  context: M3bEditContext,
  request: M3bEditRequest,
  raw: RawFacts,
  diffs: readonly EditDiff[],
  candidate: CAnalysisSnapshot,
): void {
  if (request.kind === "local-variable-rename") {
    if (raw.category !== "rename") failPostcondition("rename raw plan 类型不一致");
    assertRenamePostcondition(context.analysis, request, raw.plan, diffs, candidate);
    return;
  }
  if (raw.category !== "statement") failPostcondition("statement raw plan 类型不一致");
  switch (request.kind) {
    case "insert-statement":
      assertInsertionPostcondition(context.analysis, request, diffs, candidate);
      return;
    case "delete-statement":
      assertDeletionPostcondition(context, request.targetId, diffs, candidate);
      return;
    case "swap-adjacent-statements":
      assertSwapPostcondition(
        context,
        request.targetId,
        request.adjacentTargetId,
        diffs,
        candidate,
      );
  }
}

function assertInsertionPostcondition(
  base: CAnalysisSnapshot,
  request: Extract<StatementOperationRequest, { readonly kind: "insert-statement" }>,
  diffs: readonly EditDiff[],
  candidate: CAnalysisSnapshot,
): void {
  const target = requireStatementTarget(base, request.targetId);
  if (
    diffs.length !== 1 ||
    diffs[0] === undefined ||
    diffs[0].beforeRange.from !== diffs[0].beforeRange.to
  ) {
    failPostcondition("语句插入必须生成一个 insertion diff");
  }
  const diff = diffs[0];
  const expectedParentRange = mapRange(target.parentRange, diffs);
  const inserted = candidate.statementEdits.statements.filter(
    (entry) =>
      containsRange(diff.afterRange, entry.range) &&
      sameRange(entry.parentRange, expectedParentRange) &&
      entry.parentNodeType === target.parentNodeType,
  );
  const entry = inserted[0];
  if (
    inserted.length !== 1 ||
    entry === undefined ||
    entry.parentMode !== "statement-list" ||
    entry.blocker !== null ||
    !ALLOWED_INSERTED_NODE_TYPES.has(entry.nodeType) ||
    entry.nodeType.startsWith("preproc_") ||
    candidate.document.source.slice(entry.range.from, entry.range.to) !== request.statementText
  ) {
    failPostcondition("新增区间必须恰好包含一个允许的非预处理 statement/declaration");
  }
}

function assertDeletionPostcondition(
  context: M3bEditContext,
  targetId: string,
  diffs: readonly EditDiff[],
  candidate: CAnalysisSnapshot,
): void {
  const target = requireStatementTarget(context.analysis, targetId);
  if (diffs.length !== 1 || diffs[0] === undefined) {
    failPostcondition("语句删除必须生成一个 diff");
  }
  const diff = diffs[0];
  const expectedParentRange = mapRange(target.parentRange, diffs);
  if (target.parentMode === "required-body") {
    const expectedParentStart = mapBoundary(target.parentRange.from, diffs);
    const replacements = candidate.statementEdits.statements.filter(
      (entry) =>
        containsRange(diff.afterRange, entry.range) &&
        entry.parentNodeType === target.parentNodeType &&
        entry.parentRange.from === expectedParentStart &&
        containsRange(entry.parentRange, entry.range),
    );
    const empty = replacements[0];
    if (
      replacements.length !== 1 ||
      empty === undefined ||
      empty.parentMode !== "required-body" ||
      empty.nodeType !== "expression_statement" ||
      candidate.document.source.slice(empty.range.from, empty.range.to) !== ";"
    ) {
      failPostcondition("required-body 删除后必须由唯一 empty statement 保持语法体");
    }
    return;
  }

  const before = directParentStatements(context.analysis, target);
  const after = directParentStatementsAt(candidate, target.parentNodeType, expectedParentRange);
  const targetIndex = before.findIndex((entry) => entry.id === target.id);
  if (targetIndex < 0) failPostcondition("基础父级中缺少删除目标");
  const expected = before
    .filter((entry) => entry.id !== target.id)
    .map((entry) => coreSignature(context.source, entry));
  const actual = after.map((entry) => coreSignature(candidate.document.source, entry));
  if (after.length !== before.length - 1 || !sameStrings(actual, expected)) {
    failPostcondition("statement-list 删除后目标必须消失且其余同父语句保持不变");
  }
}

function assertSwapPostcondition(
  context: M3bEditContext,
  targetId: string,
  adjacentTargetId: string,
  diffs: readonly EditDiff[],
  candidate: CAnalysisSnapshot,
): void {
  const target = requireStatementTarget(context.analysis, targetId);
  const adjacent = requireStatementTarget(context.analysis, adjacentTargetId);
  const expectedParentRange = mapRange(target.parentRange, diffs);
  const before = directParentStatements(context.analysis, target);
  const after = directParentStatementsAt(candidate, target.parentNodeType, expectedParentRange);
  const targetIndex = before.findIndex((entry) => entry.id === target.id);
  const adjacentIndex = before.findIndex((entry) => entry.id === adjacent.id);
  if (targetIndex < 0 || adjacentIndex < 0 || Math.abs(targetIndex - adjacentIndex) !== 1) {
    failPostcondition("交换目标不再是同父相邻语句");
  }

  const expectedCore = before.map((entry) => coreSignature(context.source, entry));
  const expectedExtended = before.map((entry) => extendedText(context.source, entry));
  swapEntries(expectedCore, targetIndex, adjacentIndex);
  swapEntries(expectedExtended, targetIndex, adjacentIndex);
  const actualCore = after.map((entry) => coreSignature(candidate.document.source, entry));
  const actualExtended = after.map((entry) => extendedText(candidate.document.source, entry));
  if (
    after.length !== before.length ||
    !sameStrings(actualCore, expectedCore) ||
    !sameStrings(actualExtended, expectedExtended)
  ) {
    failPostcondition("交换后同父数量必须不变，且两个语句及附着文本必须精确互换");
  }
}

function assertRenamePostcondition(
  base: CAnalysisSnapshot,
  request: LocalRenameEditRequest,
  raw: ConservativeLocalRenamePlan,
  diffs: readonly EditDiff[],
  candidate: CAnalysisSnapshot,
): void {
  const oldOccurrences = base.document.symbols.occurrences.filter(
    (occurrence) => occurrence.symbolId === raw.symbolId,
  );
  const orderedOldOccurrences = sortOccurrences(oldOccurrences);
  const orderedPatches = [...raw.patches].sort((left, right) =>
    compareRanges(left.range, right.range),
  );
  const orderedDiffs = [...diffs].sort((left, right) =>
    compareRanges(left.beforeRange, right.beforeRange),
  );
  if (
    orderedOldOccurrences.length !== orderedPatches.length ||
    orderedOldOccurrences.length !== orderedDiffs.length
  ) {
    failPostcondition("rename diff 必须逐一覆盖原局部符号 occurrence");
  }
  for (let index = 0; index < orderedOldOccurrences.length; index += 1) {
    const occurrence = orderedOldOccurrences[index];
    const patch = orderedPatches[index];
    const diff = orderedDiffs[index];
    if (
      occurrence === undefined ||
      patch === undefined ||
      diff === undefined ||
      !sameRange(patch.range, occurrence.range) ||
      !sameRange(diff.beforeRange, occurrence.range) ||
      patch.newText !== request.newName ||
      diff.beforeText !== request.expectedOldName ||
      diff.afterText !== request.newName ||
      base.document.source.slice(occurrence.range.from, occurrence.range.to) !==
        request.expectedOldName
    ) {
      failPostcondition("rename patch/diff 必须精确绑定每个旧 occurrence range");
    }
  }

  const functionRange = mapRange(raw.functionRange, diffs);
  const candidates = candidate.document.symbols.symbols.filter(
    (symbol) =>
      symbol.kind === "local-variable" &&
      symbol.name === request.newName &&
      symbol.declarationRanges.some((range) => containsRange(functionRange, range)),
  );
  const renamed = candidates[0];
  if (candidates.length !== 1 || renamed === undefined) {
    failPostcondition("候选函数中必须恰好存在一个新名称局部符号");
  }
  const newOccurrences = sortOccurrences(
    candidate.document.symbols.occurrences.filter(
      (occurrence) => occurrence.symbolId === renamed.id,
    ),
  );
  const expectedOccurrences = orderedOldOccurrences.map((occurrence) =>
    Object.freeze({ role: occurrence.role, range: mapRange(occurrence.range, diffs) }),
  );
  if (
    newOccurrences.some((occurrence) => !containsRange(functionRange, occurrence.range)) ||
    !sameOccurrenceFacts(expectedOccurrences, newOccurrences)
  ) {
    failPostcondition("rename 后每个 declaration/use occurrence 的 role 与映射 range 必须精确保持");
  }
  const expectedDeclarations = expectedOccurrences
    .filter((occurrence) => occurrence.role === "declaration")
    .map((occurrence) => occurrence.range)
    .sort(compareRanges);
  const actualDeclarations = [...renamed.declarationRanges].sort(compareRanges);
  if (!sameRangeLists(expectedDeclarations, actualDeclarations)) {
    failPostcondition("rename 后 symbol declarationRanges 必须与声明 occurrence 一致");
  }
}

function requireStatementTarget(
  analysis: CAnalysisSnapshot,
  targetId: string,
): StatementEditTarget {
  const matches = analysis.statementEdits.statements.filter((target) => target.id === targetId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw m3bError("STALE_M3B_EDIT", "statement target 不存在或不唯一");
  }
  return matches[0];
}

function directParentStatements(
  analysis: CAnalysisSnapshot,
  target: StatementEditTarget,
): readonly StatementEditTarget[] {
  return directParentStatementsAt(analysis, target.parentNodeType, target.parentRange);
}

function directParentStatementsAt(
  analysis: CAnalysisSnapshot,
  parentNodeType: string,
  parentRange: TextRange,
): readonly StatementEditTarget[] {
  return analysis.statementEdits.statements
    .filter(
      (entry) =>
        entry.parentMode === "statement-list" &&
        entry.parentNodeType === parentNodeType &&
        sameRange(entry.parentRange, parentRange),
    )
    .sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
}

function coreSignature(source: string, target: StatementEditTarget): string {
  return `${target.nodeType}\0${source.slice(target.range.from, target.range.to)}`;
}

function extendedText(source: string, target: StatementEditTarget): string {
  return source.slice(target.extendedRange.from, target.extendedRange.to);
}

function sortOccurrences(occurrences: readonly SymbolOccurrence[]): readonly SymbolOccurrence[] {
  return [...occurrences].sort(
    (left, right) => compareRanges(left.range, right.range) || left.role.localeCompare(right.role),
  );
}

function sameOccurrenceFacts(
  expected: readonly Pick<SymbolOccurrence, "role" | "range">[],
  actual: readonly SymbolOccurrence[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (occurrence, index) =>
        occurrence.role === actual[index]?.role &&
        sameRange(occurrence.range, actual[index]!.range),
    )
  );
}

function sameRangeLists(expected: readonly TextRange[], actual: readonly TextRange[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((range, index) => actual[index] !== undefined && sameRange(range, actual[index]))
  );
}

function compareRanges(left: TextRange, right: TextRange): number {
  return left.from - right.from || left.to - right.to;
}

function mapRange(range: TextRange, diffs: readonly EditDiff[]): TextRange {
  return textRange(mapBoundary(range.from, diffs), mapBoundary(range.to, diffs));
}

function mapBoundary(offset: number, diffs: readonly EditDiff[]): number {
  let delta = 0;
  for (const diff of diffs) {
    if (diff.beforeRange.to <= offset) {
      delta +=
        diff.afterRange.to - diff.afterRange.from - (diff.beforeRange.to - diff.beforeRange.from);
    }
  }
  return offset + delta;
}

function containsRange(outer: TextRange, inner: TextRange): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function swapEntries(values: string[], left: number, right: number): void {
  const leftValue = values[left];
  const rightValue = values[right];
  if (leftValue === undefined || rightValue === undefined) failPostcondition("交换索引越界");
  values[left] = rightValue;
  values[right] = leftValue;
}

function nextRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw m3bError("INVALID_M3B_EDIT_REQUEST", "baseRevision 无法安全递增");
  }
  return revision + 1;
}

function failPostcondition(message: string): never {
  throw m3bError("CANDIDATE_POSTCONDITION_FAILED", message);
}

function m3bError(code: M3bEditErrorCode, message: string, cause?: unknown): M3bEditError {
  return cause === undefined
    ? new M3bEditError(code, message)
    : new M3bEditError(code, message, { cause });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
