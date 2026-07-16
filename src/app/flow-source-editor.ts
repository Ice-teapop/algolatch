import {
  applyTextPatches,
  createBlockIndex,
  createTextPatch,
  planStatementOperation,
  renderSourceDoc,
  textRange,
  type CAnalysisSnapshot,
  type CParser,
  type EditTarget,
  type EditDiff,
  type StatementEditTarget,
  type TextPatch,
} from "../core/index.js";
import {
  createFlowProjection,
  planFlowConnection,
  type ConnectionIntent,
  type FlowNode,
  type FlowProjection,
} from "../flow/index.js";
import { validateSourceText } from "../shared/source-import.js";
import type { FlowCanvasDraftConnectionIntent } from "../ui/flow-canvas.js";
import { planFlowDraftConnection } from "./flow-draft-connection.js";
import { planFlowPresetSlotReplacement } from "./flow-preset-slot.js";
import { analyzeProgramSnapshot, type ReadySession } from "./program-analysis-session.js";
import { assertNoCompleteCfgRegression } from "./source-edit-safety.js";

export interface FlowSourceEditorOptions {
  readonly getSession: () => ReadySession | null;
  readonly getProjection: () => FlowProjection | null;
  readonly getParser: () => CParser | null;
  readonly getProjectionMode: () => string;
  readonly getEditorSource: () => string;
  readonly applyPatches: (patches: readonly TextPatch[]) => boolean;
  readonly resetProjection: () => void;
  readonly nextRevision: () => number;
  readonly adopt: (
    imported: ReadySession["imported"],
    analysis: CAnalysisSnapshot,
    preferredTarget: EditTarget | null,
  ) => void;
  readonly confirm: (message: string) => boolean;
  readonly onCommitted: (message: string) => void;
}

export interface FlowSourceEditor {
  replaceNodeSource(node: FlowNode, replacement: string): void;
  deleteNodes(nodes: readonly FlowNode[]): void;
  assessConnection(intent: ConnectionIntent): FlowSourceConnectionAssessment;
  connectNodes(intent: ConnectionIntent): boolean;
  connectDraft(intent: FlowCanvasDraftConnectionIntent): boolean;
}

export type FlowSourceConnectionAssessment =
  { readonly accepted: true } | { readonly accepted: false; readonly message: string };

export class FlowSourceCommitError extends Error {
  readonly sourceChanged = true;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`源码已写入，但提交后的界面刷新失败：${detail}`);
    this.name = "FlowSourceCommitError";
  }
}

export function createFlowSourceEditor(options: FlowSourceEditorOptions): FlowSourceEditor {
  assertOptions(options);

  const requireEditableSession = (node: FlowNode): ReadySession => {
    const current = options.getSession();
    const projection = options.getProjection();
    if (current === null || projection === null || options.getProjectionMode() !== "synced") {
      throw new Error("源码投影尚未同步");
    }
    if (!projection.nodes.some((candidate) => candidate.id === node.id)) {
      throw new Error("节点详情已经过期，请重新选择");
    }
    if (current.imported.source.slice(node.range.from, node.range.to) !== node.sourceText) {
      throw new Error("节点源码锚点已经失效，请重新选择");
    }
    return current;
  };

  const commitValidatedPatches = (candidateSource: string, patches: readonly TextPatch[]): void => {
    const current = options.getSession();
    const parser = options.getParser();
    if (current === null || parser === null) throw new Error("C 解析器或源码会话尚未就绪");
    const validation = validateSourceText(candidateSource);
    if (!validation.ok) throw new Error(`${validation.code}：${validation.message}`);
    const candidateAnalysis = parser.analyze(candidateSource, options.nextRevision());
    if (renderSourceDoc(candidateAnalysis.document) !== candidateSource) {
      throw new Error("候选源码未通过逐字符无损往返");
    }
    if (!current.analysis.document.parse.hasError && candidateAnalysis.document.parse.hasError) {
      throw new Error("候选源码引入了解析错误");
    }
    const candidateIndex = createBlockIndex(candidateAnalysis.document);
    const candidateProgram = analyzeProgramSnapshot(
      parser,
      candidateSource,
      candidateAnalysis.editTargets.revision,
      candidateIndex.entries.length,
    );
    assertNoCompleteCfgRegression(current.programAnalysis, candidateProgram);
    const changed = options.applyPatches(patches);
    if (!changed || options.getEditorSource() !== candidateSource) {
      throw new Error("CodeMirror 未能精确应用候选补丁");
    }
    try {
      options.resetProjection();
      options.adopt(
        Object.freeze({ ...current.imported, source: candidateSource }),
        candidateAnalysis,
        null,
      );
      options.onCommitted("画布修改已提交到 main.c；可使用撤销恢复。");
    } catch (error: unknown) {
      throw new FlowSourceCommitError(error);
    }
  };

  return Object.freeze({
    replaceNodeSource(node: FlowNode, replacement: string): void {
      const current = requireEditableSession(node);
      if (node.kind === "start" || node.kind === "end" || node.locked) {
        throw new Error("入口、出口或锁定节点不能直接改写");
      }
      if (replacement === node.sourceText) return;
      const candidateSource =
        current.imported.source.slice(0, node.range.from) +
        replacement +
        current.imported.source.slice(node.range.to);
      commitValidatedPatches(candidateSource, [
        Object.freeze({ range: node.range, newText: replacement }),
      ]);
    },

    deleteNodes(nodes: readonly FlowNode[]): void {
      if (nodes.length === 0) return;
      const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
      for (const node of unique) {
        requireEditableSession(node);
        if (node.locked || node.kind === "start" || node.kind === "end") {
          throw new Error(`节点“${node.label}”属于锁定区域或 CFG 边界，不能删除`);
        }
      }
      const ordered = [...unique].sort((left, right) => left.range.from - right.range.from);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          previous.range.to > current.range.from
        ) {
          throw new Error("所选节点源码范围互相重叠，无法作为一次精确删除提交");
        }
      }
      const source = options.getSession()?.imported.source;
      if (source === undefined) throw new Error("源码会话尚未就绪");
      let candidateSource = source;
      for (const node of [...ordered].reverse()) {
        candidateSource =
          candidateSource.slice(0, node.range.from) + candidateSource.slice(node.range.to);
      }
      commitValidatedPatches(
        candidateSource,
        ordered.map((node) => Object.freeze({ range: node.range, newText: "" })),
      );
    },

    assessConnection(intent: ConnectionIntent): FlowSourceConnectionAssessment {
      const current = options.getSession();
      const projection = options.getProjection();
      if (current === null || projection === null || options.getProjectionMode() !== "synced") {
        return rejectedSourceConnection("源码、CFG 或解析器尚未同步");
      }
      return assessSourceBackedConnection(current.analysis, projection, intent);
    },

    connectNodes(intent: ConnectionIntent): boolean {
      const current = options.getSession();
      const projection = options.getProjection();
      const parser = options.getParser();
      if (
        current === null ||
        projection === null ||
        parser === null ||
        options.getProjectionMode() !== "synced"
      ) {
        throw new Error("源码、CFG 或解析器尚未同步");
      }
      const graphPlan = planFlowConnection(projection, intent);
      if (graphPlan.status === "rejected") {
        throw new Error(`${graphPlan.code}：${graphPlan.message}`);
      }
      const sourceAssessment = assessSourceBackedConnection(current.analysis, projection, intent);
      if (!sourceAssessment.accepted) throw new Error(sourceAssessment.message);
      if (
        graphPlan.operation === "replace" &&
        (intent.kind === "branch-true" || intent.kind === "branch-false")
      ) {
        const displacedId = graphPlan.displacedEdgeIds[0];
        const displaced = projection.edges.find((edge) => edge.id === displacedId);
        const fromNode = projection.nodes.find((node) => node.id === intent.fromNodeId);
        const toNode = projection.nodes.find((node) => node.id === intent.toNodeId);
        const currentTarget = projection.nodes.find((node) => node.id === displaced?.to.nodeId);
        if (
          displaced === undefined ||
          fromNode === undefined ||
          toNode === undefined ||
          currentTarget === undefined ||
          !["branch", "loop", "assert"].includes(fromNode.kind)
        ) {
          throw new Error("分支连线已经过期或不属于可重排的结构化控制节点");
        }
        if (displaced.from.nodeId === fromNode.id && displaced.to.nodeId === toNode.id) {
          throw new Error("插头仍位于原端口，无需改接");
        }
        const branchMove = planBranchSuccessorMove(
          parser,
          current.imported.source,
          current.analysis,
          currentTarget,
          toNode,
          current.analysis.editTargets.revision + 1,
        );
        const candidateIndex = createBlockIndex(branchMove.analysis.document);
        const candidateProgram = analyzeProgramSnapshot(
          parser,
          branchMove.source,
          branchMove.analysis.editTargets.revision,
          candidateIndex.entries.length,
        );
        assertNoCompleteCfgRegression(current.programAnalysis, candidateProgram);
        const candidateProjection = createFlowProjection(
          candidateProgram,
          branchMove.analysis.document,
        );
        const candidateFrom = candidateProjection.nodes.filter(
          (node) =>
            node.kind === fromNode.kind &&
            node.nodeType === fromNode.nodeType &&
            node.range.from === fromNode.range.from,
        );
        const candidateTo = candidateProjection.nodes.filter(
          (node) =>
            node.kind === toNode.kind &&
            node.sourceText === toNode.sourceText &&
            node.functionId === candidateFrom[0]?.functionId,
        );
        if (candidateFrom.length !== 1 || candidateTo.length !== 1) {
          throw new Error("分支改线后的源码锚点存在歧义");
        }
        const verifiedEdges = candidateProjection.edges.filter(
          (edge) =>
            edge.from.nodeId === candidateFrom[0]!.id &&
            edge.to.nodeId === candidateTo[0]!.id &&
            edge.kind === intent.kind,
        );
        if (verifiedEdges.length !== 1) {
          throw new Error("重解析后的 CFG 未精确出现请求的分支边");
        }
        assertDisplacedEdgeAbsent(
          candidateProjection,
          candidateFrom[0]!,
          currentTarget,
          intent.kind,
        );
        const patch = minimalReplacementPatch(current.imported.source, branchMove.source);
        if (
          !options.confirm(
            `这条分支连线会把目标表达式移动到该分支的首个执行位置。候选源码已通过重解析、无损往返和 CFG 边验证。\n\n位置 ${String(patch.range.from)}–${String(patch.range.to)}\n- ${current.imported.source.slice(patch.range.from, patch.range.to)}\n+ ${patch.newText}\n\n写入 main.c？`,
          )
        ) {
          return false;
        }
        commitValidatedPatches(branchMove.source, [patch]);
        return true;
      }
      if (graphPlan.operation !== "replace" || intent.kind !== "next") {
        throw new Error("当前只对同一语句列表中的相邻顺序节点生成可证明安全的改线补丁");
      }
      const fromNode = projection.nodes.find((node) => node.id === intent.fromNodeId);
      const toNode = projection.nodes.find((node) => node.id === intent.toNodeId);
      const displacedId = graphPlan.displacedEdgeIds[0];
      const displaced = projection.edges.find((edge) => edge.id === displacedId);
      const previousSource = projection.nodes.find((node) => node.id === displaced?.from.nodeId);
      const previousTarget = projection.nodes.find((node) => node.id === displaced?.to.nodeId);
      if (
        fromNode === undefined ||
        toNode === undefined ||
        displaced === undefined ||
        previousSource === undefined ||
        previousTarget === undefined
      ) {
        throw new Error("连线节点或被拔出的原连接已经过期");
      }
      if (previousSource.id === fromNode.id && previousTarget.id === toNode.id) {
        throw new Error("插头仍位于原端口，无需改接");
      }
      const keepsSource =
        displaced.from.nodeId === fromNode.id && displaced.from.portId === intent.fromPortId;
      const keepsTarget =
        displaced.to.nodeId === toNode.id && displaced.to.portId === intent.toPortId;
      if (keepsSource === keepsTarget) {
        throw new Error("改接一次必须只移动控制线的一端");
      }
      if (fromNode.kind !== "statement" || toNode.kind !== "statement") {
        throw new Error("安全相邻改线首版只交换普通表达式语句，不移动声明或控制结构");
      }
      const swapTargets = resolveSequentialRewireSwapTargets(
        current.analysis.statementEdits.statements,
        fromNode,
        toNode,
        previousTarget,
        keepsSource,
      );
      if (swapTargets === null) {
        throw new Error("顺序线只能通过一次相邻语句交换完成改接");
      }
      const [firstSwapTarget, secondSwapTarget] = swapTargets;
      const statementPlan = planStatementOperation(
        current.imported.source,
        current.analysis.statementEdits,
        {
          kind: "swap-adjacent-statements",
          baseRevision: current.analysis.statementEdits.revision,
          targetId: firstSwapTarget.id,
          expectedTargetText: current.imported.source.slice(
            firstSwapTarget.range.from,
            firstSwapTarget.range.to,
          ),
          adjacentTargetId: secondSwapTarget.id,
          expectedAdjacentTargetText: current.imported.source.slice(
            secondSwapTarget.range.from,
            secondSwapTarget.range.to,
          ),
        },
      );
      const application = applyTextPatches(current.imported.source, statementPlan.patches);
      const candidateAnalysis = parser.analyze(application.source, options.nextRevision());
      if (candidateAnalysis.document.parse.hasError) throw new Error("改线候选源码引入了解析错误");
      if (renderSourceDoc(candidateAnalysis.document) !== application.source) {
        throw new Error("改线候选源码未通过逐字符无损往返");
      }
      const candidateIndex = createBlockIndex(candidateAnalysis.document);
      const candidateProgram = analyzeProgramSnapshot(
        parser,
        application.source,
        candidateAnalysis.editTargets.revision,
        candidateIndex.entries.length,
      );
      assertNoCompleteCfgRegression(current.programAnalysis, candidateProgram);
      const candidateProjection = createFlowProjection(
        candidateProgram,
        candidateAnalysis.document,
      );
      const fromMatches = candidateProjection.nodes.filter(
        (node) => node.sourceText === fromNode.sourceText && node.kind === fromNode.kind,
      );
      const toMatches = candidateProjection.nodes.filter(
        (node) => node.sourceText === toNode.sourceText && node.kind === toNode.kind,
      );
      if (fromMatches.length !== 1 || toMatches.length !== 1) {
        throw new Error("改线后的源码锚点存在歧义，无法证明目标 CFG 边");
      }
      const candidateEdge = candidateProjection.edges.filter(
        (edge) =>
          edge.from.nodeId === fromMatches[0]!.id &&
          edge.to.nodeId === toMatches[0]!.id &&
          edge.kind === "next",
      );
      if (candidateEdge.length !== 1) {
        throw new Error("重解析后的 CFG 未精确出现请求的顺序边");
      }
      assertOriginalEdgeAbsent(candidateProjection, previousSource, previousTarget, "next");
      const preview = statementPlan.patches
        .map(
          (patch) =>
            `位置 ${String(patch.range.from)}–${String(patch.range.to)}\n- ${current.imported.source.slice(patch.range.from, patch.range.to)}\n+ ${patch.newText}`,
        )
        .join("\n\n");
      if (
        !options.confirm(
          `这条连线会交换两个相邻 C 语句。候选源码已通过重解析、无损往返和 CFG 边验证。\n\n${preview}\n\n写入 main.c？`,
        )
      ) {
        return false;
      }
      commitValidatedPatches(application.source, statementPlan.patches);
      return true;
    },

    connectDraft(intent: FlowCanvasDraftConnectionIntent): boolean {
      const current = options.getSession();
      const projection = options.getProjection();
      const parser = options.getParser();
      if (
        current === null ||
        projection === null ||
        parser === null ||
        options.getProjectionMode() !== "synced"
      ) {
        throw new Error("源码、CFG 或解析器尚未同步");
      }
      const slot = planFlowPresetSlotReplacement(current.imported.source, projection, intent);
      if (slot !== null) {
        if (
          projection.documentHasError ||
          projection.functions.some((item) => item.partial) ||
          projection.nodes.some((node) => node.kind === "raw")
        ) {
          throw new Error("raw 或 partial CFG 区域禁止替换补全插槽");
        }
        const validation = validateSourceText(slot.candidateSource);
        if (!validation.ok) throw new Error(`${validation.code}：${validation.message}`);
        const candidateAnalysis = parser.analyze(slot.candidateSource, options.nextRevision());
        if (
          candidateAnalysis.document.parse.hasError ||
          renderSourceDoc(candidateAnalysis.document) !== slot.candidateSource
        ) {
          throw new Error("补全插槽候选未通过重解析与逐字符无损往返");
        }
        const candidateIndex = createBlockIndex(candidateAnalysis.document);
        const candidateProgram = analyzeProgramSnapshot(
          parser,
          slot.candidateSource,
          candidateAnalysis.editTargets.revision,
          candidateIndex.entries.length,
        );
        assertNoCompleteCfgRegression(current.programAnalysis, candidateProgram);
        if (candidateProgram.functions.some((item) => item.partial)) {
          throw new Error("补全插槽候选没有生成完整 CFG");
        }
        const candidateProjection = createFlowProjection(
          candidateProgram,
          candidateAnalysis.document,
        );
        const insertedFrom = slot.patch.range.from;
        const insertedTo = insertedFrom + slot.patch.newText.length;
        const insertedBranches = candidateProjection.nodes.filter(
          (node) =>
            node.kind === "branch" &&
            node.range.from >= insertedFrom &&
            node.range.to <= insertedTo,
        );
        if (insertedBranches.length !== 1) {
          throw new Error("补全插槽候选无法唯一映射到新分支节点");
        }
        if (
          !options.confirm(
            `把“${intent.presetId ?? "积木"}”写入补全插槽。候选源码已通过重解析、无损往返和完整 CFG 验证。\n\n继续？`,
          )
        ) {
          return false;
        }
        commitValidatedPatches(slot.candidateSource, [slot.patch]);
        return true;
      }
      const plan = planFlowDraftConnection({
        source: current.imported.source,
        analysis: current.analysis,
        programAnalysis: current.programAnalysis,
        projection,
        intent,
      });
      if (plan.status === "rejected") throw new Error(`${plan.code}：${plan.message}`);
      const application = applyTextPatches(current.imported.source, plan.patches);
      const preview = plan.patches
        .map(
          (patch) =>
            `位置 ${String(patch.range.from)}\n- ${current.imported.source.slice(patch.range.from, patch.range.to)}\n+ ${patch.newText}`,
        )
        .join("\n\n");
      if (
        !options.confirm(
          `将草稿接入 main.c。系统会在写入前重解析并验证 CFG。\n\n${preview}\n\n继续？`,
        )
      ) {
        return false;
      }
      const candidateAnalysis = parser.analyze(application.source, options.nextRevision());
      if (candidateAnalysis.document.parse.hasError) throw new Error("草稿插入会引入解析错误");
      if (renderSourceDoc(candidateAnalysis.document) !== application.source) {
        throw new Error("草稿插入未通过逐字符无损往返");
      }
      const candidateIndex = createBlockIndex(candidateAnalysis.document);
      const candidateProgram = analyzeProgramSnapshot(
        parser,
        application.source,
        candidateAnalysis.editTargets.revision,
        candidateIndex.entries.length,
      );
      assertNoCompleteCfgRegression(current.programAnalysis, candidateProgram);
      const candidateProjection = createFlowProjection(
        candidateProgram,
        candidateAnalysis.document,
      );
      const insertedRanges = application.diffs.map((diff) => diff.afterRange);
      const insertedNodes = candidateProjection.nodes.filter(
        (node) =>
          node.sourceText.trim() === plan.insertedStatementText.trim() &&
          insertedRanges.some(
            (range) => node.range.from >= range.from && node.range.to <= range.to,
          ),
      );
      if (insertedNodes.length !== 1) {
        throw new Error("重解析后的 CFG 无法唯一确认新草稿节点");
      }
      const insertedNode = insertedNodes[0]!;
      if (intent.insertOnEdge !== undefined) {
        assertEdgeInsertionPostcondition(
          projection,
          candidateProjection,
          intent,
          insertedNode,
          application.diffs,
        );
      }
      commitValidatedPatches(application.source, plan.patches);
      return true;
    },
  });
}

function assertEdgeInsertionPostcondition(
  before: FlowProjection,
  after: FlowProjection,
  intent: FlowCanvasDraftConnectionIntent,
  insertedNode: FlowNode,
  diffs: readonly EditDiff[],
): void {
  const anchor = intent.insertOnEdge;
  if (anchor === undefined) return;
  const originalEdge = before.edges.find((edge) => edge.id === anchor.edgeId);
  const originalFrom = before.nodes.find((node) => node.id === anchor.fromNodeId);
  const originalTo = before.nodes.find((node) => node.id === anchor.toNodeId);
  if (
    originalEdge === undefined ||
    originalFrom === undefined ||
    originalTo === undefined ||
    originalEdge.kind !== "next"
  ) {
    throw new Error("插入前的 CFG 连线锚点已失效");
  }
  const candidateFrom = remapFlowNode(originalFrom, after, diffs);
  const candidateTo = remapFlowNode(originalTo, after, diffs);
  if (candidateFrom === null || candidateTo === null) {
    throw new Error("重解析后无法唯一恢复插入连线的两个端点");
  }
  const incoming = after.edges.filter(
    (edge) =>
      edge.from.nodeId === candidateFrom.id &&
      edge.to.nodeId === insertedNode.id &&
      edge.kind === "next",
  );
  const outgoing = after.edges.filter(
    (edge) =>
      edge.from.nodeId === insertedNode.id &&
      edge.to.nodeId === candidateTo.id &&
      edge.kind === "next",
  );
  if (incoming.length !== 1 || outgoing.length !== 1) {
    throw new Error("候选 CFG 未把原连线原子替换为“前驱 → 新积木 → 后继”");
  }
}

function remapFlowNode(
  original: FlowNode,
  projection: FlowProjection,
  diffs: readonly EditDiff[],
): FlowNode | null {
  const mapped = {
    from: mapBoundary(original.range.from, diffs),
    to: mapBoundary(original.range.to, diffs),
  };
  const matches = projection.nodes.filter(
    (candidate) =>
      candidate.kind === original.kind &&
      candidate.nodeType === original.nodeType &&
      candidate.range.from === mapped.from &&
      candidate.range.to === mapped.to,
  );
  return matches.length === 1 ? matches[0]! : null;
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

interface PlannedBranchMove {
  readonly source: string;
  readonly analysis: CAnalysisSnapshot;
}

function planBranchSuccessorMove(
  parser: CParser,
  source: string,
  analysis: CAnalysisSnapshot,
  currentTargetNode: FlowNode,
  requestedTargetNode: FlowNode,
  firstRevision: number,
): PlannedBranchMove {
  const currentTarget = uniqueStatementTarget(
    analysis.statementEdits.statements,
    currentTargetNode,
  );
  const requestedTarget = uniqueStatementTarget(
    analysis.statementEdits.statements,
    requestedTargetNode,
  );
  if (
    currentTarget === null ||
    requestedTarget === null ||
    currentTarget.parentMode !== "statement-list" ||
    requestedTarget.parentMode !== "statement-list" ||
    currentTarget.parentRange.from !== requestedTarget.parentRange.from ||
    currentTarget.parentRange.to !== requestedTarget.parentRange.to ||
    currentTarget.nodeType !== "expression_statement" ||
    requestedTarget.nodeType !== "expression_statement"
  ) {
    throw new Error("分支目标必须是同一语句列表内的普通表达式语句");
  }
  const currentText = source.slice(currentTarget.range.from, currentTarget.range.to);
  const requestedText = source.slice(requestedTarget.range.from, requestedTarget.range.to);
  if (currentText === requestedText) throw new Error("分支首节点与目标源码文本存在歧义");
  assertForwardSiblingPath(analysis.statementEdits.statements, currentTarget, requestedTarget);

  let candidateSource = source;
  let candidateAnalysis = analysis;
  let revision = firstRevision;
  const maximumSwaps = Math.min(1_000, analysis.statementEdits.statements.length);
  for (let swapCount = 0; swapCount < maximumSwaps; swapCount += 1) {
    const current = uniqueStatementByText(candidateAnalysis, candidateSource, currentText);
    const requested = uniqueStatementByText(candidateAnalysis, candidateSource, requestedText);
    if (
      current === null ||
      requested === null ||
      current.parentRange.from !== requested.parentRange.from ||
      current.parentRange.to !== requested.parentRange.to
    ) {
      throw new Error("分支改线过程中语句锚点变得不唯一");
    }
    if (requested.nextSiblingId === current.id) {
      return Object.freeze({ source: candidateSource, analysis: candidateAnalysis });
    }
    const previous = candidateAnalysis.statementEdits.statements.find(
      (target) => target.id === requested.previousSiblingId,
    );
    if (previous === undefined || previous.nodeType !== "expression_statement") {
      throw new Error("分支目标与当前首节点之间含声明或控制结构，拒绝跨越改线");
    }
    const operation = planStatementOperation(candidateSource, candidateAnalysis.statementEdits, {
      kind: "swap-adjacent-statements",
      baseRevision: candidateAnalysis.statementEdits.revision,
      targetId: requested.id,
      expectedTargetText: requestedText,
      adjacentTargetId: previous.id,
      expectedAdjacentTargetText: candidateSource.slice(previous.range.from, previous.range.to),
    });
    candidateSource = applyTextPatches(candidateSource, operation.patches).source;
    candidateAnalysis = parser.analyze(candidateSource, revision);
    revision += 1;
    if (
      candidateAnalysis.document.parse.hasError ||
      renderSourceDoc(candidateAnalysis.document) !== candidateSource
    ) {
      throw new Error("分支改线的中间候选未通过重解析与无损往返");
    }
  }
  throw new Error("分支改线需要过多相邻交换，已安全终止");
}

function assertForwardSiblingPath(
  targets: readonly StatementEditTarget[],
  first: StatementEditTarget,
  requested: StatementEditTarget,
): void {
  let cursor: StatementEditTarget | undefined = first;
  const visited = new Set<string>();
  while (cursor !== undefined && !visited.has(cursor.id)) {
    if (cursor.id === requested.id) return;
    visited.add(cursor.id);
    cursor = targets.find((target) => target.id === cursor?.nextSiblingId);
  }
  throw new Error("请求目标不在当前分支首节点之后的同级执行序列中");
}

function uniqueStatementByText(
  analysis: CAnalysisSnapshot,
  source: string,
  text: string,
): StatementEditTarget | null {
  const matches = analysis.statementEdits.statements.filter(
    (target) => source.slice(target.range.from, target.range.to) === text,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function assertDisplacedEdgeAbsent(
  candidate: FlowProjection,
  candidateFrom: FlowNode,
  previousTarget: FlowNode,
  kind: ConnectionIntent["kind"],
): void {
  const oldTargetMatches = candidate.nodes.filter(
    (node) =>
      node.functionId === candidateFrom.functionId &&
      node.kind === previousTarget.kind &&
      node.nodeType === previousTarget.nodeType &&
      node.sourceText === previousTarget.sourceText,
  );
  if (oldTargetMatches.length !== 1) {
    throw new Error("改线后无法唯一确认原插头目标仍被保留");
  }
  const oldEdgeStillExists = candidate.edges.some(
    (edge) =>
      edge.from.nodeId === candidateFrom.id &&
      edge.to.nodeId === oldTargetMatches[0]!.id &&
      edge.kind === kind,
  );
  if (oldEdgeStillExists) throw new Error("重解析后的 CFG 仍包含被替换的原连接");
}

function minimalReplacementPatch(before: string, after: string): TextPatch {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let beforeTo = before.length;
  let afterTo = after.length;
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo -= 1;
    afterTo -= 1;
  }
  return createTextPatch(textRange(from, beforeTo), after.slice(from, afterTo));
}

function uniqueStatementTarget(
  targets: readonly StatementEditTarget[],
  node: FlowNode,
): StatementEditTarget | null {
  const matches = targets.filter(
    (target) =>
      target.range.from === node.ownerBlockRange.from &&
      target.range.to === node.ownerBlockRange.to,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Mirrors the source-backed subset of the graph planner. The canvas uses this before painting a
 * target green, so a graph-only operation is never advertised as a C operation that can commit.
 */
function assessSourceBackedConnection(
  analysis: CAnalysisSnapshot,
  projection: FlowProjection,
  intent: ConnectionIntent,
): FlowSourceConnectionAssessment {
  const graphPlan = planFlowConnection(projection, intent);
  if (graphPlan.status === "rejected") {
    return rejectedSourceConnection(`${graphPlan.code}：${graphPlan.message}`);
  }
  if (graphPlan.operation !== "replace") {
    return rejectedSourceConnection("当前 C 写回只支持改接现有控制线；新增语句请先拖入积木草稿");
  }
  const displacedId = graphPlan.displacedEdgeIds[0];
  const displaced = projection.edges.find((edge) => edge.id === displacedId);
  const fromNode = projection.nodes.find((node) => node.id === intent.fromNodeId);
  const toNode = projection.nodes.find((node) => node.id === intent.toNodeId);
  if (displaced === undefined || fromNode === undefined || toNode === undefined) {
    return rejectedSourceConnection("待改接的节点或控制线已经过期");
  }
  const keepsSource =
    displaced.from.nodeId === fromNode.id && displaced.from.portId === intent.fromPortId;
  const keepsTarget = displaced.to.nodeId === toNode.id && displaced.to.portId === intent.toPortId;
  if (keepsSource === keepsTarget) {
    return rejectedSourceConnection("改接一次必须只移动控制线的一端");
  }

  if (intent.kind === "branch-true" || intent.kind === "branch-false") {
    if (!keepsSource || !["branch", "loop", "assert"].includes(fromNode.kind)) {
      return rejectedSourceConnection("分支线目前只能移动目标端，不能改变条件来源");
    }
    const currentTarget = projection.nodes.find((node) => node.id === displaced.to.nodeId);
    if (currentTarget === undefined || currentTarget.id === toNode.id) {
      return rejectedSourceConnection("分支插头仍位于原端口");
    }
    const current = uniqueStatementTarget(analysis.statementEdits.statements, currentTarget);
    const requested = uniqueStatementTarget(analysis.statementEdits.statements, toNode);
    if (
      current === null ||
      requested === null ||
      current.parentMode !== "statement-list" ||
      requested.parentMode !== "statement-list" ||
      current.parentRange.from !== requested.parentRange.from ||
      current.parentRange.to !== requested.parentRange.to ||
      current.nodeType !== "expression_statement" ||
      requested.nodeType !== "expression_statement"
    ) {
      return rejectedSourceConnection("分支目标必须是同一语句列表中的普通表达式语句");
    }
    try {
      assertForwardSiblingPath(analysis.statementEdits.statements, current, requested);
    } catch (error: unknown) {
      return rejectedSourceConnection(error instanceof Error ? error.message : String(error));
    }
    return Object.freeze({ accepted: true });
  }

  if (intent.kind !== "next") {
    return rejectedSourceConnection("该控制线没有可证明安全的 C 源码改接方案");
  }
  const previousTarget = projection.nodes.find((node) => node.id === displaced.to.nodeId);
  if (previousTarget === undefined) {
    return rejectedSourceConnection("原连接的目标节点已经过期");
  }
  if (fromNode.kind !== "statement" || toNode.kind !== "statement") {
    return rejectedSourceConnection("顺序线只能在普通表达式语句之间改接");
  }
  const swapTargets = resolveSequentialRewireSwapTargets(
    analysis.statementEdits.statements,
    fromNode,
    toNode,
    previousTarget,
    keepsSource,
  );
  if (swapTargets === null) {
    return rejectedSourceConnection("顺序线只能通过一次相邻语句交换完成改接");
  }
  return Object.freeze({ accepted: true });
}

function resolveSequentialRewireSwapTargets(
  targets: readonly StatementEditTarget[],
  requestedSource: FlowNode,
  requestedTarget: FlowNode,
  previousTarget: FlowNode,
  keepsSource: boolean,
): readonly [StatementEditTarget, StatementEditTarget] | null {
  const source = uniqueStatementTarget(targets, requestedSource);
  const target = uniqueStatementTarget(targets, requestedTarget);
  if (target !== null && source !== null && areSafeAdjacentSwapTargets(target, source)) {
    return Object.freeze([target, source]);
  }
  if (!keepsSource) return null;
  const displacedTarget = uniqueStatementTarget(targets, previousTarget);
  return displacedTarget !== null &&
    target !== null &&
    areSafeAdjacentSwapTargets(displacedTarget, target)
    ? Object.freeze([displacedTarget, target])
    : null;
}

function areSafeAdjacentSwapTargets(
  first: StatementEditTarget | null,
  second: StatementEditTarget | null,
): boolean {
  return (
    first !== null &&
    second !== null &&
    first.parentMode === "statement-list" &&
    second.parentMode === "statement-list" &&
    first.blocker === null &&
    second.blocker === null &&
    first.parentRange.from === second.parentRange.from &&
    first.parentRange.to === second.parentRange.to &&
    first.nextSiblingId === second.id
  );
}

function rejectedSourceConnection(message: string): FlowSourceConnectionAssessment {
  return Object.freeze({ accepted: false, message });
}

function assertOriginalEdgeAbsent(
  candidate: FlowProjection,
  previousSource: FlowNode,
  previousTarget: FlowNode,
  kind: ConnectionIntent["kind"],
): void {
  const sourceMatches = candidate.nodes.filter(
    (node) =>
      node.kind === previousSource.kind &&
      node.nodeType === previousSource.nodeType &&
      node.sourceText === previousSource.sourceText,
  );
  const targetMatches = candidate.nodes.filter(
    (node) =>
      node.kind === previousTarget.kind &&
      node.nodeType === previousTarget.nodeType &&
      node.sourceText === previousTarget.sourceText,
  );
  if (sourceMatches.length !== 1 || targetMatches.length !== 1) {
    throw new Error("改线后无法唯一确认原连接的两个源码锚点");
  }
  if (
    candidate.edges.some(
      (edge) =>
        edge.from.nodeId === sourceMatches[0]!.id &&
        edge.to.nodeId === targetMatches[0]!.id &&
        edge.kind === kind,
    )
  ) {
    throw new Error("重解析后的 CFG 仍包含被替换的原连接");
  }
}

function assertOptions(options: FlowSourceEditorOptions): void {
  for (const callback of [
    options.getSession,
    options.getProjection,
    options.getParser,
    options.getProjectionMode,
    options.getEditorSource,
    options.applyPatches,
    options.resetProjection,
    options.nextRevision,
    options.adopt,
    options.confirm,
    options.onCommitted,
  ]) {
    if (typeof callback !== "function") throw new TypeError("Flow source editor options 无效");
  }
}
