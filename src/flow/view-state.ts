import { fingerprintSource } from "../shared/source-snapshot.js";
import { textRange } from "../core/model.js";
import {
  FLOW_NODE_ANCHOR_SCHEMA_VERSION,
  FLOW_VIEW_STATE_SCHEMA_VERSION,
  type FlowNode,
  type FlowNodeAnchor,
  type FlowNodeAnchorResolution,
  type FlowNodeKind,
  type FlowPoint,
  type FlowProjection,
  type FlowViewState,
  type FlowViewStateIssue,
  type FlowViewStateIssueCode,
  type FlowViewStateValidation,
  type FlowViewport,
} from "./contracts.js";

const LEGACY_FLOW_VIEW_STATE_SCHEMA_VERSION = 1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MAX_ANCHOR_STRING_LENGTH = 4_096;
const FLOW_NODE_KINDS: ReadonlySet<string> = new Set<FlowNodeKind>([
  "module",
  "start",
  "end",
  "statement",
  "declaration",
  "branch",
  "loop",
  "switch",
  "assert",
  "control",
  "raw",
]);

interface AnchoredNode {
  readonly node: FlowNode;
  readonly anchor: FlowNodeAnchor;
  readonly ownerPath: string;
}

export function createDefaultFlowViewState(projection: FlowProjection): FlowViewState {
  const positions: Record<string, FlowPoint> = {};
  for (const node of projection.nodes) positions[node.id] = node.defaultPosition;
  return freezeFlowViewState({
    schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
    sourceFingerprint: projection.sourceFingerprint,
    viewport: Object.freeze({ x: 0, y: 0, zoom: 1 }),
    positions: Object.freeze(positions),
    selectedNodeIds: Object.freeze([]),
    detailNodeId: null,
  });
}

/** Creates a versioned identity that never embeds a snapshot-local projection ID. */
export function createFlowNodeAnchor(projection: FlowProjection, nodeId: string): FlowNodeAnchor {
  const anchored = buildAnchoredNodes(projection).find((candidate) => candidate.node.id === nodeId);
  if (anchored === undefined) throw new TypeError(`无法为未知 Flow 节点创建锚点：${nodeId}`);
  return anchored.anchor;
}

/** Resolves an untrusted anchor conservatively; repeated matching source text is ambiguous. */
export function resolveFlowNodeAnchor(
  value: unknown,
  projection: FlowProjection,
): FlowNodeAnchorResolution {
  const anchor = readFlowNodeAnchor(value);
  if (anchor === null) {
    return unresolved("invalid-anchor", "节点锚点结构无效");
  }
  return resolveAnchor(anchor, projection, buildAnchoredNodes(projection));
}

/**
 * Validates v2 anchor documents and migrates legacy v1 ID documents in memory.
 * Per-anchor failures are non-fatal: only the affected position/selection/detail is discarded.
 */
export function validateFlowViewState(
  value: unknown,
  projection: FlowProjection,
): FlowViewStateValidation {
  if (!isRecord(value)) {
    return failure([issue("invalid-shape", "$", "FlowViewState 必须是对象")]);
  }
  if (value.schemaVersion === LEGACY_FLOW_VIEW_STATE_SCHEMA_VERSION) {
    return validateLegacyFlowViewState(value, projection);
  }
  if (value.schemaVersion !== FLOW_VIEW_STATE_SCHEMA_VERSION) {
    return failure([
      issue(
        "unsupported-version",
        "$.schemaVersion",
        `仅支持 FlowViewState v${LEGACY_FLOW_VIEW_STATE_SCHEMA_VERSION}–v${FLOW_VIEW_STATE_SCHEMA_VERSION}`,
      ),
    ]);
  }
  return validateAnchoredFlowViewState(value, projection);
}

export function deserializeFlowViewState(
  serialized: string,
  projection: FlowProjection,
): FlowViewStateValidation {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return failure([issue("invalid-json", "$", "布局文件不是合法 JSON")]);
  }
  return validateFlowViewState(value, projection);
}

/** Emits canonical v2 JSON without projected node or edge IDs. */
export function serializeFlowViewState(state: FlowViewState, projection: FlowProjection): string {
  assertSerializableState(state, projection);
  const anchored = buildAnchoredNodes(projection);
  const byNodeId = new Map(anchored.map((entry) => [entry.node.id, entry]));
  const positions = anchored
    .map((entry) => ({
      anchor: serializedAnchor(entry.anchor),
      point: serializedPoint(state.positions[entry.node.id] ?? entry.node.defaultPosition),
    }))
    .sort((left, right) => left.anchor.structurePath.localeCompare(right.anchor.structurePath));
  const selectedNodes = state.selectedNodeIds.map((nodeId) => {
    const entry = byNodeId.get(nodeId);
    if (entry === undefined) throw new TypeError(`选择引用未知 Flow 节点：${nodeId}`);
    return serializedAnchor(entry.anchor);
  });
  const detailNode =
    state.detailNodeId === null
      ? null
      : serializedAnchor(requiredAnchoredNode(byNodeId, state.detailNodeId).anchor);
  return JSON.stringify({
    schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
    sourceFingerprint: state.sourceFingerprint,
    viewport: serializedViewport(state.viewport),
    positions,
    selectedNodes,
    detailNode,
  });
}

function validateAnchoredFlowViewState(
  value: Record<string, unknown>,
  projection: FlowProjection,
): FlowViewStateValidation {
  const issues: FlowViewStateIssue[] = [];
  if (typeof value.sourceFingerprint !== "string" || value.sourceFingerprint.length === 0) {
    return failure([
      issue("invalid-shape", "$.sourceFingerprint", "sourceFingerprint 必须是非空字符串"),
    ]);
  }
  const savedFingerprint = value.sourceFingerprint;
  if (savedFingerprint !== projection.sourceFingerprint) {
    issues.push(
      issue("stale-source", "$.sourceFingerprint", "源码已变化，正在按唯一结构锚点恢复布局"),
    );
  }
  const viewport = readViewport(value.viewport, issues);
  if (viewport === null) return failure(issues);
  if (!Array.isArray(value.positions)) {
    return failure([...issues, issue("invalid-shape", "$.positions", "v2 positions 必须是数组")]);
  }
  if (!Array.isArray(value.selectedNodes)) {
    return failure([
      ...issues,
      issue("invalid-shape", "$.selectedNodes", "v2 selectedNodes 必须是数组"),
    ]);
  }
  if (value.detailNode !== null && !isRecord(value.detailNode)) {
    return failure([
      ...issues,
      issue("invalid-shape", "$.detailNode", "v2 detailNode 必须是锚点或 null"),
    ]);
  }

  const anchoredNodes = buildAnchoredNodes(projection);
  const positions = defaultPositions(projection);
  const positionedNodeIds = new Set<string>();
  value.positions.forEach((entry, index) => {
    const path = `$.positions[${String(index)}]`;
    if (!isRecord(entry) || !isRecord(entry.anchor)) {
      issues.push(issue("invalid-anchor", `${path}.anchor`, "节点位置缺少合法锚点"));
      return;
    }
    if (!isRecord(entry.point) || !isCoordinate(entry.point.x) || !isCoordinate(entry.point.y)) {
      issues.push(issue("invalid-position", `${path}.point`, "节点坐标必须是范围内的有限数值"));
      return;
    }
    const resolution = resolvePersistedAnchor(
      entry.anchor,
      savedFingerprint,
      projection,
      anchoredNodes,
    );
    if (resolution.status === "unresolved") {
      issues.push(issue(resolution.code, `${path}.anchor`, resolution.message));
      return;
    }
    if (positionedNodeIds.has(resolution.nodeId)) {
      issues.push(issue("ambiguous-anchor", `${path}.anchor`, "多个位置锚点指向同一当前节点"));
      return;
    }
    positionedNodeIds.add(resolution.nodeId);
    positions[resolution.nodeId] = Object.freeze({ x: entry.point.x, y: entry.point.y });
  });
  if (
    savedFingerprint === projection.sourceFingerprint &&
    positionedNodeIds.size === projection.nodes.length &&
    matchesLegacyGeneratedLayout(positions, projection)
  ) {
    for (const node of projection.nodes) {
      positions[node.id] = Object.freeze({
        x: node.defaultPosition.x,
        y: node.defaultPosition.y,
      });
    }
    issues.push(
      issue(
        "legacy-generated-layout",
        "$.positions",
        "旧版单列自动布局已升级；自由拖动过的自定义布局不会被自动重排",
      ),
    );
  }

  const selectedNodeIds: string[] = [];
  const selected = new Set<string>();
  value.selectedNodes.forEach((anchorValue, index) => {
    const resolution = resolvePersistedAnchor(
      anchorValue,
      savedFingerprint,
      projection,
      anchoredNodes,
    );
    if (resolution.status === "unresolved") {
      issues.push(issue(resolution.code, `$.selectedNodes[${String(index)}]`, resolution.message));
      return;
    }
    if (selected.has(resolution.nodeId)) {
      issues.push(
        issue(
          "duplicate-selection",
          `$.selectedNodes[${String(index)}]`,
          "多个选择锚点解析到同一当前节点",
        ),
      );
      return;
    }
    selected.add(resolution.nodeId);
    selectedNodeIds.push(resolution.nodeId);
  });

  let detailNodeId: string | null = null;
  if (value.detailNode !== null) {
    const resolution = resolvePersistedAnchor(
      value.detailNode,
      savedFingerprint,
      projection,
      anchoredNodes,
    );
    if (resolution.status === "unresolved") {
      issues.push(issue(resolution.code, "$.detailNode", resolution.message));
    } else {
      detailNodeId = resolution.nodeId;
    }
  }

  return success(
    freezeFlowViewState({
      schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
      sourceFingerprint: projection.sourceFingerprint,
      viewport,
      positions: Object.freeze(positions),
      selectedNodeIds: Object.freeze(selectedNodeIds),
      detailNodeId,
    }),
    issues,
  );
}

function validateLegacyFlowViewState(
  value: Record<string, unknown>,
  projection: FlowProjection,
): FlowViewStateValidation {
  const issues: FlowViewStateIssue[] = [];
  if (typeof value.sourceFingerprint !== "string" || value.sourceFingerprint.length === 0) {
    return failure([
      issue("invalid-shape", "$.sourceFingerprint", "sourceFingerprint 必须是非空字符串"),
    ]);
  }
  const viewport = readViewport(value.viewport, issues);
  if (viewport === null) return failure(issues);
  if (!isRecord(value.positions)) {
    return failure([...issues, issue("invalid-shape", "$.positions", "v1 positions 必须是对象")]);
  }
  if (!Array.isArray(value.selectedNodeIds)) {
    return failure([
      ...issues,
      issue("invalid-shape", "$.selectedNodeIds", "v1 selectedNodeIds 必须是数组"),
    ]);
  }
  if (value.detailNodeId !== null && typeof value.detailNodeId !== "string") {
    return failure([
      ...issues,
      issue("invalid-shape", "$.detailNodeId", "v1 detailNodeId 必须是字符串或 null"),
    ]);
  }

  const positions = defaultPositions(projection);
  if (value.sourceFingerprint !== projection.sourceFingerprint) {
    issues.push(
      issue(
        "legacy-stale-source",
        "$.sourceFingerprint",
        "旧版布局缺少结构锚点且源码已变化，节点定位已安全重置",
      ),
    );
    return success(
      freezeFlowViewState({
        schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
        sourceFingerprint: projection.sourceFingerprint,
        viewport,
        positions: Object.freeze(positions),
        selectedNodeIds: Object.freeze([]),
        detailNodeId: null,
      }),
      issues,
    );
  }

  const knownNodeIds = new Set(projection.nodes.map((node) => node.id));
  for (const [nodeId, point] of Object.entries(value.positions)) {
    if (!knownNodeIds.has(nodeId)) {
      issues.push(issue("unknown-node", `$.positions.${nodeId}`, "旧版布局引用了未知节点"));
      continue;
    }
    if (!isRecord(point) || !isCoordinate(point.x) || !isCoordinate(point.y)) {
      issues.push(
        issue("invalid-position", `$.positions.${nodeId}`, "节点坐标必须是范围内的有限数值"),
      );
      continue;
    }
    positions[nodeId] = Object.freeze({ x: point.x, y: point.y });
  }

  const selectedNodeIds: string[] = [];
  const selected = new Set<string>();
  for (const nodeId of value.selectedNodeIds) {
    if (typeof nodeId !== "string" || !knownNodeIds.has(nodeId)) {
      issues.push(issue("unknown-node", "$.selectedNodeIds", "旧版选择引用了未知节点"));
    } else if (selected.has(nodeId)) {
      issues.push(
        issue("duplicate-selection", "$.selectedNodeIds", `选择中重复出现节点：${nodeId}`),
      );
    } else {
      selected.add(nodeId);
      selectedNodeIds.push(nodeId);
    }
  }
  const detailNodeId =
    typeof value.detailNodeId === "string" && knownNodeIds.has(value.detailNodeId)
      ? value.detailNodeId
      : null;
  if (typeof value.detailNodeId === "string" && detailNodeId === null) {
    issues.push(issue("unknown-node", "$.detailNodeId", "旧版详情窗口引用了未知节点"));
  }

  return success(
    freezeFlowViewState({
      schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
      sourceFingerprint: projection.sourceFingerprint,
      viewport,
      positions: Object.freeze(positions),
      selectedNodeIds: Object.freeze(selectedNodeIds),
      detailNodeId,
    }),
    issues,
  );
}

function resolvePersistedAnchor(
  value: unknown,
  savedFingerprint: string,
  projection: FlowProjection,
  anchoredNodes: readonly AnchoredNode[],
): FlowNodeAnchorResolution {
  const anchor = readFlowNodeAnchor(value);
  if (anchor === null || anchor.sourceFingerprint !== savedFingerprint) {
    return unresolved("invalid-anchor", "节点锚点结构无效或混用了其他源码指纹");
  }
  return resolveAnchor(anchor, projection, anchoredNodes);
}

function resolveAnchor(
  anchor: FlowNodeAnchor,
  projection: FlowProjection,
  anchoredNodes: readonly AnchoredNode[],
): FlowNodeAnchorResolution {
  const semanticMatches = anchoredNodes.filter(
    (candidate) =>
      candidate.anchor.kind === anchor.kind &&
      candidate.anchor.nodeType === anchor.nodeType &&
      candidate.anchor.textFingerprint === anchor.textFingerprint,
  );
  const owner = anchorOwner(anchor.structurePath);
  const ownerMatches = semanticMatches.filter((candidate) => candidate.ownerPath === owner);

  if (anchor.sourceFingerprint === projection.sourceFingerprint) {
    const exact = ownerMatches.filter(
      (candidate) =>
        candidate.anchor.structurePath === anchor.structurePath &&
        sameRange(candidate.anchor.range, anchor.range),
    );
    if (exact.length === 1) return resolved(exact[0]!.node.id);
    if (exact.length > 1) return unresolved("ambiguous-anchor", "同源码锚点解析到多个节点");
  }

  if (ownerMatches.length === 1) return resolved(ownerMatches[0]!.node.id);
  if (ownerMatches.length > 1) {
    return unresolved("ambiguous-anchor", "结构域内存在多个相同文本节点，定位已丢弃");
  }
  return unresolved("anchor-mismatch", "当前源码中找不到唯一匹配的节点锚点");
}

function buildAnchoredNodes(projection: FlowProjection): readonly AnchoredNode[] {
  const functionOwners = new Map<string, string>();
  const sameNameCounts = new Map<string, number>();
  const orderedFunctions = [...projection.functions].sort(
    (left, right) =>
      left.range.from - right.range.from ||
      left.range.to - right.range.to ||
      left.name.localeCompare(right.name),
  );
  for (const fn of orderedFunctions) {
    const occurrence = sameNameCounts.get(fn.name) ?? 0;
    sameNameCounts.set(fn.name, occurrence + 1);
    functionOwners.set(fn.id, `function:${encodeURIComponent(fn.name)}:${String(occurrence)}`);
  }

  const groups = new Map<string, FlowNode[]>();
  for (const node of projection.nodes) {
    const ownerPath =
      node.functionId === null ? "translation-unit" : functionOwners.get(node.functionId);
    if (ownerPath === undefined) throw new TypeError(`Flow 节点引用未知函数：${node.functionId}`);
    const nodes = groups.get(ownerPath) ?? [];
    nodes.push(node);
    groups.set(ownerPath, nodes);
  }

  const result: AnchoredNode[] = [];
  for (const [ownerPath, nodes] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    nodes.sort(compareAnchorNodes);
    nodes.forEach((node, ordinal) => {
      const structurePath = `${ownerPath}/node:${node.kind}:${encodeURIComponent(
        node.nodeType ?? "boundary",
      )}:${String(ordinal)}`;
      const anchor: FlowNodeAnchor = Object.freeze({
        schemaVersion: FLOW_NODE_ANCHOR_SCHEMA_VERSION,
        sourceFingerprint: projection.sourceFingerprint,
        structurePath,
        kind: node.kind,
        nodeType: node.nodeType,
        range: Object.freeze({ from: node.range.from, to: node.range.to }),
        textFingerprint: fingerprintSource(node.sourceText),
      });
      result.push(Object.freeze({ node, anchor, ownerPath }));
    });
  }
  return Object.freeze(result);
}

function compareAnchorNodes(left: FlowNode, right: FlowNode): number {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind) ||
    (left.nodeType ?? "").localeCompare(right.nodeType ?? "") ||
    fingerprintSource(left.sourceText).localeCompare(fingerprintSource(right.sourceText)) ||
    left.id.localeCompare(right.id)
  );
}

function readFlowNodeAnchor(value: unknown): FlowNodeAnchor | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FLOW_NODE_ANCHOR_SCHEMA_VERSION ||
    !isBoundedString(value.sourceFingerprint) ||
    !isBoundedString(value.structurePath) ||
    !FLOW_NODE_KINDS.has(String(value.kind)) ||
    (value.nodeType !== null && !isBoundedString(value.nodeType)) ||
    !isRecord(value.range) ||
    !isOffset(value.range.from) ||
    !isOffset(value.range.to) ||
    value.range.to < value.range.from ||
    !isBoundedString(value.textFingerprint)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: FLOW_NODE_ANCHOR_SCHEMA_VERSION,
    sourceFingerprint: value.sourceFingerprint,
    structurePath: value.structurePath,
    kind: value.kind as FlowNodeKind,
    nodeType: value.nodeType as string | null,
    range: textRange(value.range.from, value.range.to),
    textFingerprint: value.textFingerprint,
  });
}

function readViewport(value: unknown, issues: FlowViewStateIssue[]): FlowViewport | null {
  if (!isRecord(value)) {
    issues.push(issue("invalid-viewport", "$.viewport", "viewport 必须是对象"));
    return null;
  }
  if (!isCoordinate(value.x) || !isCoordinate(value.y) || !isZoom(value.zoom)) {
    issues.push(
      issue(
        "invalid-viewport",
        "$.viewport",
        `viewport 坐标必须有限且 zoom 必须在 ${MIN_ZOOM}–${MAX_ZOOM}`,
      ),
    );
    return null;
  }
  return Object.freeze({ x: value.x, y: value.y, zoom: value.zoom });
}

function defaultPositions(projection: FlowProjection): Record<string, FlowPoint> {
  return Object.fromEntries(
    projection.nodes.map((node) => [
      node.id,
      Object.freeze({ x: node.defaultPosition.x, y: node.defaultPosition.y }),
    ]),
  );
}

function matchesLegacyGeneratedLayout(
  positions: Readonly<Record<string, FlowPoint>>,
  projection: FlowProjection,
): boolean {
  const legacy = legacyGeneratedPositions(projection);
  let differsFromCurrent = false;
  for (const node of projection.nodes) {
    const saved = positions[node.id];
    const oldDefault = legacy[node.id];
    if (
      saved === undefined ||
      oldDefault === undefined ||
      saved.x !== oldDefault.x ||
      saved.y !== oldDefault.y
    ) {
      return false;
    }
    if (saved.x !== node.defaultPosition.x || saved.y !== node.defaultPosition.y) {
      differsFromCurrent = true;
    }
  }
  return differsFromCurrent;
}

function legacyGeneratedPositions(projection: FlowProjection): Record<string, FlowPoint> {
  const functionOrder = new Map(projection.functions.map((fn, index) => [fn.id, index]));
  const fallbackLane = projection.functions.length;
  const lanes = new Map<number, FlowNode[]>();
  for (const node of projection.nodes) {
    const lane =
      node.functionId === null
        ? fallbackLane
        : (functionOrder.get(node.functionId) ?? fallbackLane);
    const nodes = lanes.get(lane) ?? [];
    nodes.push(node);
    lanes.set(lane, nodes);
  }
  const positions: Record<string, FlowPoint> = {};
  for (const [lane, nodes] of [...lanes.entries()].sort((left, right) => left[0] - right[0])) {
    nodes.sort(compareLegacyLayoutNodes);
    nodes.forEach((node, row) => {
      positions[node.id] = Object.freeze({ x: 48 + lane * 224, y: 48 + row * 64 });
    });
  }
  return positions;
}

function compareLegacyLayoutNodes(left: FlowNode, right: FlowNode): number {
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

function assertSerializableState(state: FlowViewState, projection: FlowProjection): void {
  if (state.schemaVersion !== FLOW_VIEW_STATE_SCHEMA_VERSION) {
    throw new TypeError("不能序列化未知版本的 FlowViewState");
  }
  if (
    state.sourceFingerprint.length === 0 ||
    state.sourceFingerprint !== projection.sourceFingerprint
  ) {
    throw new TypeError("FlowViewState 与 FlowProjection 不属于同一源码快照");
  }
  if (
    !isCoordinate(state.viewport.x) ||
    !isCoordinate(state.viewport.y) ||
    !isZoom(state.viewport.zoom)
  ) {
    throw new TypeError("不能序列化非法 viewport");
  }
  const knownNodeIds = new Set(projection.nodes.map((node) => node.id));
  for (const [nodeId, point] of Object.entries(state.positions)) {
    if (!knownNodeIds.has(nodeId) || !isCoordinate(point.x) || !isCoordinate(point.y)) {
      throw new TypeError("不能序列化未知节点或非法节点坐标");
    }
  }
  if (
    new Set(state.selectedNodeIds).size !== state.selectedNodeIds.length ||
    state.selectedNodeIds.some((nodeId) => !knownNodeIds.has(nodeId)) ||
    (state.detailNodeId !== null && !knownNodeIds.has(state.detailNodeId))
  ) {
    throw new TypeError("不能序列化未知节点或重复选择");
  }
}

function serializedAnchor(anchor: FlowNodeAnchor) {
  return {
    schemaVersion: FLOW_NODE_ANCHOR_SCHEMA_VERSION,
    sourceFingerprint: anchor.sourceFingerprint,
    structurePath: anchor.structurePath,
    kind: anchor.kind,
    nodeType: anchor.nodeType,
    range: { from: anchor.range.from, to: anchor.range.to },
    textFingerprint: anchor.textFingerprint,
  };
}

function serializedPoint(point: FlowPoint) {
  return { x: point.x, y: point.y };
}

function serializedViewport(viewport: FlowViewport) {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}

function requiredAnchoredNode(
  mapping: ReadonlyMap<string, AnchoredNode>,
  nodeId: string,
): AnchoredNode {
  const anchored = mapping.get(nodeId);
  if (anchored === undefined) throw new TypeError(`布局引用未知 Flow 节点：${nodeId}`);
  return anchored;
}

function anchorOwner(structurePath: string): string {
  const marker = structurePath.lastIndexOf("/node:");
  return marker < 0 ? structurePath : structurePath.slice(0, marker);
}

function sameRange(
  left: { readonly from: number; readonly to: number },
  right: { readonly from: number; readonly to: number },
): boolean {
  return left.from === right.from && left.to === right.to;
}

function resolved(nodeId: string): FlowNodeAnchorResolution {
  return Object.freeze({ status: "resolved", nodeId });
}

function unresolved(
  code: Extract<FlowNodeAnchorResolution, { status: "unresolved" }>["code"],
  message: string,
): FlowNodeAnchorResolution {
  return Object.freeze({ status: "unresolved", code, message });
}

function freezeFlowViewState(state: FlowViewState): FlowViewState {
  return Object.freeze(state);
}

function success(
  value: FlowViewState,
  issues: readonly FlowViewStateIssue[],
): FlowViewStateValidation {
  return Object.freeze({ ok: true, value, issues: Object.freeze([...issues]) });
}

function failure(issues: readonly FlowViewStateIssue[]): FlowViewStateValidation {
  return Object.freeze({ ok: false, value: null, issues: Object.freeze([...issues]) });
}

function issue(code: FlowViewStateIssueCode, path: string, message: string): FlowViewStateIssue {
  return Object.freeze({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ANCHOR_STRING_LENGTH;
}

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_ABSOLUTE_COORDINATE
  );
}

function isZoom(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM
  );
}
