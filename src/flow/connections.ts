import type { CfgEdgeKind } from "../analysis/model.js";
import {
  type AcceptedConnectionPlan,
  type ConnectionIntent,
  type ConnectionPlan,
  type ConnectionPostcondition,
  type ConnectionRejectionCode,
  type FlowEdge,
  type FlowNode,
  type FlowPort,
  type FlowProjection,
  type RejectedConnectionPlan,
} from "./contracts.js";
import { createFlowEdgeId } from "./projection.js";

const REQUIRED_POSTCONDITIONS: readonly ConnectionPostcondition[] = Object.freeze([
  "exact-source-diff",
  "source-reparse",
  "source-roundtrip",
  "cfg-edge-match",
  "no-new-partial-cfg",
]);

/**
 * Performs conservative graph-level checks only. An accepted result is not a C patch: the write
 * adapter must still generate an exact diff and satisfy every published postcondition.
 */
export function planFlowConnection(
  projection: FlowProjection,
  requestedIntent: ConnectionIntent,
): ConnectionPlan {
  const intent = freezeIntent(requestedIntent);
  if (intent.sourceFingerprint !== projection.sourceFingerprint) {
    return reject(intent, "stale-source", "连接请求不属于当前源码快照");
  }

  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const fromNode = nodes.get(intent.fromNodeId);
  if (fromNode === undefined) {
    return reject(intent, "unknown-source-node", "找不到连接起点节点");
  }
  const toNode = nodes.get(intent.toNodeId);
  if (toNode === undefined) {
    return reject(intent, "unknown-target-node", "找不到连接终点节点");
  }
  if (fromNode.id === toNode.id) {
    return reject(intent, "same-node", "不能把节点直接连接到自身");
  }
  if (fromNode.locked || toNode.locked) {
    return reject(intent, "locked-node", "锁定节点只能查看，不能改线");
  }
  if (fromNode.kind === "end") {
    return reject(intent, "source-is-end", "End 节点不能产生控制输出");
  }
  if (toNode.kind === "start") {
    return reject(intent, "target-is-start", "Start 节点不能接收控制输入");
  }
  if (fromNode.functionId === null || fromNode.functionId !== toNode.functionId) {
    return reject(intent, "cross-function", "首版不允许跨函数控制连线");
  }

  const sourcePort = outputPortForKind(fromNode, intent.kind);
  if (sourcePort === null) {
    return reject(intent, "unsupported-kind", "该源码节点不支持请求的控制边类型");
  }
  if (intent.fromPortId !== null && intent.fromPortId !== sourcePort.id) {
    return reject(intent, "invalid-source-port", "起点端口与控制边类型不匹配");
  }
  const targetPort = controlInputPort(toNode);
  if (targetPort === null || (intent.toPortId !== null && intent.toPortId !== targetPort.id)) {
    return reject(intent, "invalid-target-port", "终点不是可用的控制输入端口");
  }
  const invalidTargetMessage = invalidSemanticTarget(fromNode, toNode, intent.kind);
  if (invalidTargetMessage !== null) {
    return reject(intent, "invalid-target", invalidTargetMessage);
  }

  const replacement = findReplacement(projection, intent);
  if (replacement.status === "rejected") return replacement;
  const replacedEdge = replacement.edge;
  const remaining = projection.edges.filter((edge) => edge.id !== replacedEdge?.id);
  const outgoing = remaining.filter((edge) => edge.from.nodeId === fromNode.id);
  const duplicate = remaining.find(
    (edge) =>
      edge.from.nodeId === fromNode.id && edge.to.nodeId === toNode.id && edge.kind === intent.kind,
  );
  if (duplicate !== undefined) {
    return reject(intent, "duplicate-edge", "相同语义的控制边已经存在");
  }

  if (replacedEdge === null) {
    if (!fromNode.allowsFanOut && outgoing.length > 0) {
      return reject(intent, "fan-out-not-supported", "普通顺序节点只能有一个控制输出");
    }
    const samePortCount = outgoing.filter((edge) => edge.from.portId === sourcePort.id).length;
    if (sourcePort.capacity === "one" && samePortCount > 0) {
      return reject(intent, "port-capacity", "该语法分支已经连接，必须选择替换现有边");
    }
  }

  const slot =
    replacedEdge?.slot ??
    nextSlot(
      remaining.filter((edge) => edge.from.nodeId === fromNode.id && edge.kind === intent.kind),
    );
  const candidateEdge = freezeEdge({
    id: createFlowEdgeId(fromNode.functionId, fromNode.id, intent.kind, toNode.id),
    functionId: fromNode.functionId,
    from: Object.freeze({ nodeId: fromNode.id, portId: sourcePort.id }),
    to: Object.freeze({ nodeId: toNode.id, portId: targetPort.id }),
    kind: intent.kind,
    channel: "control",
    slot,
    editable: true,
  });

  if (
    createsCycle(fromNode.id, toNode.id, [...remaining, candidateEdge]) &&
    !isSupportedStructuredCycle(fromNode, toNode, intent.kind)
  ) {
    return reject(intent, "unsafe-cycle", "该连线会形成无法映射为结构化 C 的控制环");
  }

  const plan: AcceptedConnectionPlan = {
    status: "accepted",
    intent,
    operation: replacedEdge === null ? "add" : "replace",
    candidateEdge,
    displacedEdgeIds: Object.freeze(replacedEdge === null ? [] : [replacedEdge.id]),
    cSourcePatch: null,
    requiredPostconditions: REQUIRED_POSTCONDITIONS,
  };
  return Object.freeze(plan);
}

type ReplacementResult =
  { readonly status: "accepted"; readonly edge: FlowEdge | null } | RejectedConnectionPlan;

function findReplacement(projection: FlowProjection, intent: ConnectionIntent): ReplacementResult {
  if (intent.replaceEdgeId === null) {
    return Object.freeze({ status: "accepted", edge: null });
  }
  const edge = projection.edges.find((candidate) => candidate.id === intent.replaceEdgeId);
  if (edge === undefined) {
    return reject(intent, "replacement-not-found", "找不到待替换的控制边");
  }
  if (!edge.editable) {
    return reject(intent, "replacement-mismatch", "待替换控制边为只读，不能拔出或改接");
  }
  const oldSource = projection.nodes.find((node) => node.id === edge.from.nodeId);
  const oldTarget = projection.nodes.find((node) => node.id === edge.to.nodeId);
  if (oldSource === undefined || oldTarget === undefined || oldSource.locked || oldTarget.locked) {
    return reject(intent, "replacement-mismatch", "待替换控制边的原端点已经失效或被锁定");
  }
  if (edge.kind !== intent.kind) {
    return reject(intent, "replacement-mismatch", "待替换边与插头的控制流语义不一致");
  }
  const keepsSource =
    edge.from.nodeId === intent.fromNodeId &&
    (intent.fromPortId === null || edge.from.portId === intent.fromPortId);
  const keepsTarget =
    edge.to.nodeId === intent.toNodeId &&
    (intent.toPortId === null || edge.to.portId === intent.toPortId);
  if (!keepsSource && !keepsTarget) {
    return reject(
      intent,
      "replacement-mismatch",
      "改接一次只能移动一端；另一端必须仍插在原来的控制端口",
    );
  }
  if (keepsSource && keepsTarget) {
    return reject(intent, "replacement-mismatch", "连接的两个端点都没有变化");
  }
  return Object.freeze({ status: "accepted", edge });
}

function invalidSemanticTarget(
  fromNode: FlowNode,
  toNode: FlowNode,
  kind: CfgEdgeKind,
): string | null {
  if (fromNode.kind === "start" && kind !== "entry") return "Start 只能使用 entry 控制边";
  if (kind === "entry" && fromNode.kind !== "start") return "entry 控制边只能来自 Start";
  if ((kind === "return" || kind === "terminate") && toNode.kind !== "end") {
    return `${kind} 控制边必须指向 End`;
  }
  return null;
}

function outputPortForKind(node: FlowNode, kind: CfgEdgeKind): FlowPort | null {
  return (
    node.ports.find(
      (port) =>
        port.direction === "output" &&
        port.channel === "control" &&
        port.edgeKind === kind &&
        port.editable,
    ) ?? null
  );
}

function controlInputPort(node: FlowNode): FlowPort | null {
  return (
    node.ports.find(
      (port) => port.direction === "input" && port.channel === "control" && port.editable,
    ) ?? null
  );
}

function createsCycle(fromNodeId: string, toNodeId: string, edges: readonly FlowEdge[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.from.nodeId) ?? [];
    targets.push(edge.to.nodeId);
    outgoing.set(edge.from.nodeId, targets);
  }
  const pending = [toNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    if (nodeId === fromNodeId) return true;
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return false;
}

function isSupportedStructuredCycle(
  fromNode: FlowNode,
  toNode: FlowNode,
  kind: CfgEdgeKind,
): boolean {
  return (
    kind === "continue" ||
    kind === "goto" ||
    (fromNode.kind === "loop" && kind === "branch-true") ||
    (kind === "next" && toNode.kind === "loop") ||
    (kind === "next" &&
      isReorderableStatement(fromNode) &&
      isReorderableStatement(toNode) &&
      toNode.ownerBlockRange.to <= fromNode.ownerBlockRange.from)
  );
}

function isReorderableStatement(node: FlowNode): boolean {
  return node.kind === "statement";
}

function nextSlot(edges: readonly FlowEdge[]): number {
  return edges.reduce((highest, edge) => Math.max(highest, edge.slot + 1), 0);
}

function freezeEdge(edge: FlowEdge): FlowEdge {
  return Object.freeze(edge);
}

function freezeIntent(intent: ConnectionIntent): ConnectionIntent {
  return Object.freeze({ ...intent });
}

function reject(
  intent: ConnectionIntent,
  code: ConnectionRejectionCode,
  message: string,
): RejectedConnectionPlan {
  return Object.freeze({ status: "rejected", intent, code, message });
}
