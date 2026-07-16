import type {
  CfgEdge,
  CfgEdgeKind,
  CfgNode,
  FunctionCfg,
  ProgramAnalysisSnapshot,
} from "../analysis/model.js";
import type { Block, RawBlock, SourceDoc, SyntaxBlock, TextRange } from "../core/model.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import {
  FLOW_PROJECTION_SCHEMA_VERSION,
  type FlowEdge,
  type FlowDataEdge,
  type FlowFunctionProjection,
  type FlowLockReason,
  type FlowNode,
  type FlowNodeKind,
  type FlowPoint,
  type FlowPort,
  type FlowProjection,
} from "./contracts.js";

interface FlowNodeDraft extends Omit<FlowNode, "defaultPosition"> {}

const LANE_X = 224;
const NODE_Y = 72;
const LAYOUT_ORIGIN = 48;
const MAX_LABEL_LENGTH = 52;

const EDGE_LABELS: Readonly<Record<CfgEdgeKind, string>> = Object.freeze({
  entry: "进入",
  next: "下一步",
  "branch-true": "条件成立",
  "branch-false": "条件不成立",
  "switch-case": "case",
  "switch-default": "default",
  "switch-miss": "无匹配",
  break: "break",
  continue: "continue",
  goto: "goto",
  return: "return",
  terminate: "终止",
});

const LOOP_NODE_TYPES = new Set(["for_statement", "while_statement", "do_statement"]);

/**
 * Builds a read-only visual graph from the exact source snapshot that produced the CFG.
 * No inferred edge is added and no source patch is produced here.
 */
export function createFlowProjection(
  analysis: ProgramAnalysisSnapshot,
  document: SourceDoc,
): FlowProjection {
  assertSameSourceSnapshot(analysis, document);

  const sourceNodeToFlowNode = new Map<string, string>();
  const drafts: FlowNodeDraft[] = [];
  const functions: FlowFunctionProjection[] = [];

  for (const block of collectTranslationUnitBlocks(document.blocks)) {
    const sourceText = document.source.slice(block.range.from, block.range.to);
    const id = moduleNodeId(block);
    drafts.push(
      Object.freeze({
        id,
        functionId: null,
        sourceNodeId: null,
        kind: "module",
        label: moduleNodeLabel(block, sourceText),
        nodeType: block.nodeType,
        range: block.range,
        ownerBlockRange: block.range,
        sourceText,
        reachable: false,
        locked: true,
        lockReasons: Object.freeze([translationUnitLockReason(block)]),
        allowsFanOut: false,
        ports: Object.freeze([]),
      }),
    );
  }

  for (const cfg of analysis.functions) {
    const lockReasons = partialLockReasons(cfg);
    const locked = cfg.partial;
    const outgoingByNode = groupOutgoingEdges(cfg);

    for (const node of cfg.nodes) {
      const id = flowNodeId(node.id);
      sourceNodeToFlowNode.set(node.id, id);
      const outgoing = outgoingByNode.get(node.id) ?? [];
      const sourceText = sourceTextForNode(document.source, node);
      const kind = flowNodeKind(node, sourceText, outgoing);
      const ports = createPorts(id, node, outgoing, locked, kind);
      drafts.push(
        Object.freeze({
          id,
          functionId: cfg.id,
          sourceNodeId: node.id,
          kind,
          label: flowNodeLabel(cfg.name, node, sourceText),
          nodeType: node.nodeType,
          range: node.range,
          ownerBlockRange: node.ownerBlockRange,
          sourceText,
          reachable: node.reachable,
          locked,
          lockReasons,
          allowsFanOut:
            ports.filter((port) => port.direction === "output" && port.editable).length > 1 ||
            ports.some((port) => port.direction === "output" && port.editable && port.allowsFanOut),
          ports,
        }),
      );
    }

    const entryNodeId = requiredFlowNodeId(sourceNodeToFlowNode, cfg.entryId);
    const exitNodeId = requiredFlowNodeId(sourceNodeToFlowNode, cfg.exitId);
    functions.push(
      Object.freeze({
        id: cfg.id,
        name: cfg.name,
        range: cfg.range,
        entryNodeId,
        exitNodeId,
        partial: cfg.partial,
        lockReasons,
      }),
    );
  }

  for (const rawBlock of collectRawBlocks(document.blocks)) {
    const functionId = smallestContainingFunction(analysis.functions, rawBlock.range)?.id ?? null;
    const lockReason = rawLockReason(rawBlock);
    const id = rawNodeId(rawBlock);
    drafts.push(
      Object.freeze({
        id,
        functionId,
        sourceNodeId: null,
        kind: "raw",
        label: rawNodeLabel(rawBlock),
        nodeType: null,
        range: rawBlock.range,
        ownerBlockRange: rawBlock.range,
        sourceText: document.source.slice(rawBlock.range.from, rawBlock.range.to),
        reachable: false,
        locked: true,
        lockReasons: Object.freeze([lockReason]),
        allowsFanOut: false,
        ports: Object.freeze([]),
      }),
    );
  }

  const displayDrafts = disambiguateRepeatedNodeLabels(drafts, document.source);
  const positions = defaultPositions(displayDrafts, analysis.functions);
  const nodes = Object.freeze(
    displayDrafts.map((draft) =>
      Object.freeze({
        ...draft,
        defaultPosition: requiredPosition(positions, draft.id),
      }),
    ),
  );
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = Object.freeze(
    analysis.functions.flatMap((cfg) => createEdges(cfg, sourceNodeToFlowNode, nodesById)),
  );
  const dataEdges = createDataEdges(analysis, sourceNodeToFlowNode, nodesById);

  return Object.freeze({
    schemaVersion: FLOW_PROJECTION_SCHEMA_VERSION,
    sourceRevision: analysis.revision,
    sourceFingerprint: analysis.sourceFingerprint,
    sourceLength: analysis.sourceLength,
    documentHasError: document.parse.hasError,
    functions: Object.freeze(functions),
    nodes,
    edges,
    dataEdges,
  });
}

function createDataEdges(
  analysis: ProgramAnalysisSnapshot,
  sourceNodeToFlowNode: ReadonlyMap<string, string>,
  nodesById: ReadonlyMap<string, FlowNode>,
): readonly FlowDataEdge[] {
  const result = new Map<string, FlowDataEdge>();
  for (const defUse of analysis.defUse) {
    if (defUse.status !== "complete") continue;
    const variables = new Map(defUse.variables.map((variable) => [variable.id, variable.name]));
    const definitionOwners = new Map<
      string,
      { readonly nodeId: string; readonly variableId: string }
    >();
    for (const fact of defUse.facts) {
      for (const effect of fact.effects) {
        if (effect.kind === "def") {
          definitionOwners.set(
            effect.id,
            Object.freeze({ nodeId: fact.nodeId, variableId: effect.variableId }),
          );
        }
      }
    }
    for (const reaching of defUse.reachingDefinitions) {
      const toNodeId = sourceNodeToFlowNode.get(reaching.nodeId);
      if (toNodeId === undefined || !nodesById.has(toNodeId)) continue;
      for (const use of reaching.uses) {
        if (use.availability !== "tracked") continue;
        for (const definitionEffectId of use.definitionEffectIds) {
          const owner = definitionOwners.get(definitionEffectId);
          if (owner === undefined) continue;
          const fromNodeId = sourceNodeToFlowNode.get(owner.nodeId);
          if (fromNodeId === undefined || fromNodeId === toNodeId || !nodesById.has(fromNodeId)) {
            continue;
          }
          const key = `${defUse.functionId}\u0000${owner.variableId}\u0000${fromNodeId}\u0000${toNodeId}`;
          if (result.has(key)) continue;
          result.set(
            key,
            Object.freeze({
              id: `flow-data:${defUse.functionId}:${owner.variableId}:${fromNodeId}:${toNodeId}`,
              functionId: defUse.functionId,
              fromNodeId,
              toNodeId,
              variableId: owner.variableId,
              variableName: variables.get(owner.variableId) ?? owner.variableId,
              channel: "data",
              editable: false,
            }),
          );
        }
      }
    }
  }
  return Object.freeze([...result.values()].sort(compareDataEdges));
}

function compareDataEdges(left: FlowDataEdge, right: FlowDataEdge): number {
  return (
    left.functionId.localeCompare(right.functionId) ||
    left.fromNodeId.localeCompare(right.fromNodeId) ||
    left.toNodeId.localeCompare(right.toNodeId) ||
    left.variableId.localeCompare(right.variableId)
  );
}

function assertSameSourceSnapshot(analysis: ProgramAnalysisSnapshot, document: SourceDoc): void {
  if (
    analysis.sourceLength !== document.source.length ||
    analysis.sourceFingerprint !== fingerprintSource(document.source)
  ) {
    throw new TypeError("Flow 投影的 ProgramAnalysisSnapshot 与 SourceDoc 不属于同一源码快照");
  }
  if (document.range.from !== 0 || document.range.to !== document.source.length) {
    throw new TypeError("Flow 投影要求 SourceDoc 精确覆盖完整源码");
  }
}

function partialLockReasons(cfg: FunctionCfg): readonly FlowLockReason[] {
  if (!cfg.partial) return Object.freeze([]);
  return Object.freeze(
    cfg.partialReasons.map((reason) =>
      Object.freeze({
        code: "partial-cfg" as const,
        message: `CFG 不完整：${reason.code}（${reason.nodeType}）`,
        range: reason.range,
        partialCode: reason.code,
        rawReason: null,
      }),
    ),
  );
}

function rawLockReason(block: RawBlock): FlowLockReason {
  return Object.freeze({
    code: "raw-block",
    message: `原始源码区域不可安全改线：${block.reason}`,
    range: block.range,
    partialCode: null,
    rawReason: block.reason,
  });
}

function translationUnitLockReason(block: SyntaxBlock): FlowLockReason {
  return Object.freeze({
    code: "translation-unit",
    message: "函数外源码属于 Translation Unit；当前可查看和运行，但禁止控制改线",
    range: block.range,
    partialCode: null,
    rawReason: null,
  });
}

function groupOutgoingEdges(cfg: FunctionCfg): ReadonlyMap<string, readonly CfgEdge[]> {
  const mutable = new Map<string, CfgEdge[]>();
  for (const edge of cfg.edges) {
    const edges = mutable.get(edge.from) ?? [];
    edges.push(edge);
    mutable.set(edge.from, edges);
  }
  return new Map(
    [...mutable.entries()].map(([nodeId, edges]) => [nodeId, Object.freeze(edges)] as const),
  );
}

function createPorts(
  nodeId: string,
  node: CfgNode,
  outgoing: readonly CfgEdge[],
  locked: boolean,
  flowKind: FlowNodeKind,
): readonly FlowPort[] {
  const ports: FlowPort[] = [];
  if (node.kind !== "entry") {
    ports.push(
      freezePort({
        id: inputPortId(nodeId),
        nodeId,
        direction: "input",
        channel: "control",
        edgeKind: null,
        label: "输入",
        editable: !locked && node.ownership === "primary",
        capacity: "many",
        allowsFanOut: false,
      }),
    );
  }

  const kinds = [...new Set(outgoing.map((edge) => edge.kind))];
  for (const edgeKind of kinds) {
    const capacity = edgeKind === "switch-case" ? "many" : "one";
    ports.push(
      freezePort({
        id: outputPortId(nodeId, edgeKind),
        nodeId,
        direction: "output",
        channel: "control",
        edgeKind,
        label: EDGE_LABELS[edgeKind],
        editable: !locked && supportsSourceRewrite(node, flowKind, edgeKind),
        capacity,
        allowsFanOut: capacity === "many",
      }),
    );
  }
  return Object.freeze(ports);
}

function supportsSourceRewrite(
  node: CfgNode,
  flowKind: FlowNodeKind,
  edgeKind: CfgEdgeKind,
): boolean {
  if (node.nodeType === "expression_statement") return edgeKind === "next";
  return (
    (flowKind === "branch" || flowKind === "loop" || flowKind === "assert") &&
    (edgeKind === "branch-true" || edgeKind === "branch-false")
  );
}

function freezePort(port: FlowPort): FlowPort {
  return Object.freeze(port);
}

function createEdges(
  cfg: FunctionCfg,
  sourceNodeToFlowNode: ReadonlyMap<string, string>,
  nodesById: ReadonlyMap<string, FlowNode>,
): readonly FlowEdge[] {
  const slots = new Map<string, number>();
  return cfg.edges.map((edge) => {
    const fromNodeId = requiredFlowNodeId(sourceNodeToFlowNode, edge.from);
    const toNodeId = requiredFlowNodeId(sourceNodeToFlowNode, edge.to);
    const slotKey = `${fromNodeId}\u0000${edge.kind}`;
    const slot = slots.get(slotKey) ?? 0;
    slots.set(slotKey, slot + 1);
    const fromNode = requiredNode(nodesById, fromNodeId);
    const toNode = requiredNode(nodesById, toNodeId);
    return Object.freeze({
      id: flowEdgeId(cfg.id, fromNodeId, edge.kind, toNodeId),
      functionId: cfg.id,
      from: Object.freeze({
        nodeId: fromNodeId,
        portId: outputPortId(fromNodeId, edge.kind),
      }),
      to: Object.freeze({ nodeId: toNodeId, portId: inputPortId(toNodeId) }),
      kind: edge.kind,
      channel: "control",
      slot,
      editable:
        !fromNode.locked &&
        !toNode.locked &&
        fromNode.ports.some(
          (port) =>
            port.id === outputPortId(fromNodeId, edge.kind) &&
            port.direction === "output" &&
            port.editable,
        ),
    });
  });
}

function flowNodeKind(
  node: CfgNode,
  sourceText: string,
  outgoing: readonly CfgEdge[],
): FlowNodeKind {
  if (node.kind === "entry") return "start";
  if (node.kind === "exit") return "end";
  if (node.nodeType === "switch_statement") return "switch";
  if (LOOP_NODE_TYPES.has(node.nodeType ?? "") || node.nodeType === "do_condition") return "loop";
  if (
    /^\s*assert\s*\(/u.test(sourceText) &&
    outgoing.some((edge) => edge.kind === "branch-true") &&
    outgoing.some((edge) => edge.kind === "branch-false")
  ) {
    return "assert";
  }
  if (node.nodeType === "if_statement") return "branch";
  if (node.kind === "control" || node.role === "control") return "control";
  if (node.role === "declaration") return "declaration";
  return "statement";
}

function flowNodeLabel(functionName: string, node: CfgNode, sourceText: string): string {
  if (node.kind === "entry") return `Start · ${functionName}`;
  if (node.kind === "exit") return `End · ${functionName}`;
  const compact = sourceText.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_LABEL_LENGTH) return compact;
  return `${compact.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

function sourceTextForNode(source: string, node: CfgNode): string {
  if (node.kind === "entry" || node.kind === "exit") return "";
  return source.slice(node.range.from, node.range.to);
}

function collectRawBlocks(blocks: readonly Block[]): readonly RawBlock[] {
  const byRange = new Map<string, RawBlock>();
  const visit = (block: Block): void => {
    if (block.kind === "raw") {
      byRange.set(`${block.range.from}:${block.range.to}:${block.reason}`, block);
    }
    for (const child of block.children) visit(child);
  };
  for (const block of blocks) visit(block);
  return Object.freeze(
    [...byRange.values()].sort(
      (left, right) =>
        left.range.from - right.range.from ||
        left.range.to - right.range.to ||
        left.reason.localeCompare(right.reason),
    ),
  );
}

function collectTranslationUnitBlocks(blocks: readonly Block[]): readonly SyntaxBlock[] {
  return Object.freeze(
    blocks.filter(
      (block): block is SyntaxBlock =>
        block.kind === "syntax" && (block.role === "declaration" || block.role === "preprocessor"),
    ),
  );
}

function smallestContainingFunction(
  functions: readonly FunctionCfg[],
  range: TextRange,
): FunctionCfg | null {
  return (
    functions
      .filter((cfg) => containsRange(cfg.range, range))
      .sort(
        (left, right) => left.range.to - left.range.from - (right.range.to - right.range.from),
      )[0] ?? null
  );
}

function defaultPositions(
  drafts: readonly FlowNodeDraft[],
  functions: readonly FunctionCfg[],
): ReadonlyMap<string, FlowPoint> {
  const functionOrder = new Map(functions.map((cfg, index) => [cfg.id, index]));
  const fallbackLane = functions.length;
  const lanes = new Map<number, FlowNodeDraft[]>();
  for (const draft of drafts) {
    const lane =
      draft.functionId === null
        ? fallbackLane
        : (functionOrder.get(draft.functionId) ?? fallbackLane);
    const nodes = lanes.get(lane) ?? [];
    nodes.push(draft);
    lanes.set(lane, nodes);
  }

  const positions = new Map<string, FlowPoint>();
  let laneOriginX = LAYOUT_ORIGIN;
  for (const [, laneNodes] of [...lanes.entries()].sort((left, right) => left[0] - right[0])) {
    laneNodes.sort(compareFlowNodeDrafts);
    const controlNodes = laneNodes.filter((node) => isLexicalControlNode(node));
    const depths = new Map(
      laneNodes.map((node) => [node.id, lexicalLaneDepth(node, controlNodes)] as const),
    );
    laneNodes.forEach((node, row) => {
      positions.set(
        node.id,
        Object.freeze({
          x: laneOriginX + (depths.get(node.id) ?? 0) * LANE_X,
          y: LAYOUT_ORIGIN + row * NODE_Y,
        }),
      );
    });
    const maximumDepth = Math.max(0, ...depths.values());
    laneOriginX += (maximumDepth + 1) * LANE_X;
  }
  return positions;
}

function isLexicalControlNode(node: FlowNodeDraft): boolean {
  return (
    node.kind === "branch" ||
    node.kind === "loop" ||
    node.kind === "switch" ||
    node.kind === "assert"
  );
}

function lexicalLaneDepth(node: FlowNodeDraft, controls: readonly FlowNodeDraft[]): number {
  const nestedRange = node.nodeType === "for_initializer" ? node.ownerBlockRange : node.range;
  return controls.filter(
    (control) =>
      control.id !== node.id &&
      control.range.from <= nestedRange.from &&
      control.range.to >= nestedRange.to &&
      (control.range.from < nestedRange.from || control.range.to > nestedRange.to),
  ).length;
}

function disambiguateRepeatedNodeLabels(
  drafts: readonly FlowNodeDraft[],
  source: string,
): readonly FlowNodeDraft[] {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    const key = repeatedLabelKey(draft);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.freeze(
    drafts.map((draft) => {
      const key = repeatedLabelKey(draft);
      if (key === null || (counts.get(key) ?? 0) < 2) return draft;
      return Object.freeze({
        ...draft,
        label: `L${String(sourceLineAt(source, draft.range.from))} · ${draft.label}`,
      });
    }),
  );
}

function repeatedLabelKey(node: FlowNodeDraft): string | null {
  const compact = node.sourceText.replace(/\s+/gu, " ").trim();
  if (node.functionId === null || compact.length === 0) return null;
  return `${node.functionId}\u0000${node.kind}\u0000${node.nodeType ?? ""}\u0000${compact}`;
}

function sourceLineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function compareFlowNodeDrafts(left: FlowNodeDraft, right: FlowNodeDraft): number {
  const kindOrder: Readonly<Record<FlowNodeKind, number>> = {
    module: 0,
    start: 0,
    declaration: 1,
    statement: 1,
    branch: 1,
    loop: 1,
    switch: 1,
    assert: 1,
    control: 1,
    raw: 1,
    end: 2,
  };
  return (
    kindOrder[left.kind] - kindOrder[right.kind] ||
    left.range.from - right.range.from ||
    right.range.to - left.range.to ||
    left.id.localeCompare(right.id)
  );
}

function rawNodeLabel(block: RawBlock): string {
  const reason = block.reason === "parse-error" ? "解析恢复" : "未结构化";
  return `Raw · ${reason}`;
}

function moduleNodeLabel(block: SyntaxBlock, sourceText: string): string {
  const prefix =
    block.nodeType === "preproc_include"
      ? "Include"
      : block.nodeType === "preproc_def"
        ? "Macro"
        : block.nodeType === "type_definition"
          ? "Typedef"
          : block.role === "preprocessor"
            ? "Preprocessor"
            : "Global";
  const compact = sourceText.replace(/\s+/gu, " ").trim();
  const available = Math.max(1, MAX_LABEL_LENGTH - prefix.length - 3);
  const summary = compact.length <= available ? compact : `${compact.slice(0, available - 1)}…`;
  return `${prefix} · ${summary}`;
}

function flowNodeId(sourceNodeId: string): string {
  return `flow:${sourceNodeId}`;
}

function rawNodeId(block: RawBlock): string {
  return `flow:raw:${block.range.from}:${block.range.to}:${block.reason}`;
}

function moduleNodeId(block: SyntaxBlock): string {
  return `flow:module:${block.nodeType}:${block.range.from}:${block.range.to}`;
}

function inputPortId(nodeId: string): string {
  return `${nodeId}:port:control:in`;
}

export function flowOutputPortId(nodeId: string, kind: CfgEdgeKind): string {
  return outputPortId(nodeId, kind);
}

function outputPortId(nodeId: string, kind: CfgEdgeKind): string {
  return `${nodeId}:port:control:out:${kind}`;
}

export function flowInputPortId(nodeId: string): string {
  return inputPortId(nodeId);
}

export function createFlowEdgeId(
  functionId: string,
  fromNodeId: string,
  kind: CfgEdgeKind,
  toNodeId: string,
): string {
  return flowEdgeId(functionId, fromNodeId, kind, toNodeId);
}

function flowEdgeId(
  functionId: string,
  fromNodeId: string,
  kind: CfgEdgeKind,
  toNodeId: string,
): string {
  return `flow-edge:${functionId}:${fromNodeId}:${kind}:${toNodeId}`;
}

function requiredFlowNodeId(mapping: ReadonlyMap<string, string>, sourceNodeId: string): string {
  const nodeId = mapping.get(sourceNodeId);
  if (nodeId === undefined) {
    throw new TypeError(`CFG edge 引用了未投影节点：${sourceNodeId}`);
  }
  return nodeId;
}

function requiredNode(nodes: ReadonlyMap<string, FlowNode>, nodeId: string): FlowNode {
  const node = nodes.get(nodeId);
  if (node === undefined) throw new TypeError(`Flow edge 引用了不存在的节点：${nodeId}`);
  return node;
}

function requiredPosition(positions: ReadonlyMap<string, FlowPoint>, nodeId: string): FlowPoint {
  const point = positions.get(nodeId);
  if (point === undefined) throw new TypeError(`Flow 节点缺少默认坐标：${nodeId}`);
  return point;
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}
