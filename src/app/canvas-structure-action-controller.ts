import { createBlockIndex, type BlockIndexEntry, type CAnalysisSnapshot } from "../core/index.js";
import type { FlowEdge, FlowNode, FlowPoint, FlowProjection } from "../flow/index.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import type { AssemblyInsertPosition } from "../ui/block-tree.js";
import {
  canvasEdgeInsertionAvailability,
  canvasStructureAvailability,
  type CanvasEdgeInsertPreset,
  type CanvasEdgeInsertionAvailability,
  type CanvasEdgeInsertRequest,
  type CanvasStructureAction,
  type CanvasStructureAvailability,
} from "../ui/canvas-structure-actions.js";
import {
  buildStructureEditRequest,
  type StructureEditRequest,
  type StructureEditSelection,
} from "../ui/structure-edit-panel.js";
import type { StructureEditController } from "./structure-edit-controller.js";
import { structureEditSelectionForBlock } from "./structure-edit-selection.js";

export interface CanvasStructureEditTargetIntent {
  readonly sourceFingerprint: string;
  readonly nodeId: string | null;
  readonly target: BlockIndexEntry;
  readonly selection: StructureEditSelection;
}

export interface CanvasPresetInsertTargetIntent {
  readonly sourceFingerprint: string;
  readonly edgeId: string;
  readonly target: BlockIndexEntry;
  readonly selection: StructureEditSelection;
  readonly position: AssemblyInsertPosition;
  readonly worldPosition: FlowPoint;
}

export interface CanvasStructureActionControllerOptions {
  readonly getAnalysis: () => CAnalysisSnapshot | null;
  readonly getProjection: () => FlowProjection | null;
  readonly structureEdits: Pick<StructureEditController, "assertReady" | "run">;
  readonly onEditTarget: (intent: CanvasStructureEditTargetIntent) => void;
  readonly onSelectPresetTarget: (intent: CanvasPresetInsertTargetIntent) => void;
  readonly onListPresetTarget: (
    intent: CanvasPresetInsertTargetIntent,
    locale: InterfaceLocale,
  ) => readonly CanvasEdgeInsertPreset[];
  readonly onInsertPresetTarget: (
    intent: CanvasPresetInsertTargetIntent,
    presetId: string,
  ) => boolean;
  readonly onError: (error: Error) => void;
}

export interface CanvasStructureActionController {
  handleStructureAction(action: CanvasStructureAction): boolean;
  handleEdgeInsertRequest(request: CanvasEdgeInsertRequest): boolean;
  listCompatiblePresets(
    request: CanvasEdgeInsertRequest,
    locale?: InterfaceLocale,
  ): readonly CanvasEdgeInsertPreset[];
  handleEdgePresetInsertRequest(request: CanvasEdgeInsertRequest, presetId: string): boolean;
  inspectNode(node: FlowNode, locale?: InterfaceLocale): CanvasStructureAvailability;
  inspectEdge(edge: FlowEdge, locale?: InterfaceLocale): CanvasEdgeInsertionAvailability;
  canInsertOnEdge(edge: FlowEdge): boolean;
  destroy(): void;
}

interface CurrentCanvasStructureSnapshot {
  readonly analysis: CAnalysisSnapshot;
  readonly projection: FlowProjection;
}

interface ResolvedStructureTarget {
  readonly node: FlowNode;
  readonly target: BlockIndexEntry;
  readonly selection: StructureEditSelection;
}

interface ResolvedEdgeInsertTarget {
  readonly target: BlockIndexEntry;
  readonly selection: StructureEditSelection;
  readonly position: AssemblyInsertPosition;
}

/**
 * Maps canvas intents onto the shared source-authoritative structure-edit pipeline. This module
 * validates identity and location only; it never applies a patch or mutates source directly.
 */
export function createCanvasStructureActionController(
  options: CanvasStructureActionControllerOptions,
): CanvasStructureActionController {
  assertOptions(options);
  let destroyed = false;

  const report = (error: unknown): false => {
    if (!destroyed) options.onError(asError(error));
    return false;
  };

  const begin = (request: StructureEditRequest): void => {
    void options.structureEdits.run(request).catch((error: unknown) => {
      if (!destroyed) options.onError(asError(error));
    });
  };

  const inspectEdgeInsertion = (
    edge: FlowEdge,
    locale: InterfaceLocale = "zh-CN",
  ): CanvasEdgeInsertionAvailability => {
    try {
      assertActive(destroyed);
      options.structureEdits.assertReady();
      const snapshot = requireCurrentSnapshot(options);
      const current = snapshot.projection.edges.find((candidate) => candidate.id === edge.id);
      if (
        current === undefined ||
        current.kind !== edge.kind ||
        current.channel !== edge.channel ||
        current.editable !== edge.editable ||
        current.from.nodeId !== edge.from.nodeId ||
        current.from.portId !== edge.from.portId ||
        current.to.nodeId !== edge.to.nodeId ||
        current.to.portId !== edge.to.portId
      ) {
        throw new Error("画布连线已变化，无法作为当前源码的插入位置");
      }
      const coarse = canvasEdgeInsertionAvailability(current, locale);
      if (!coarse.available) return coarse;
      resolveEdgeInsertTarget(snapshot, current);
      return Object.freeze({ available: true, reason: null });
    } catch (error: unknown) {
      return Object.freeze({
        available: false,
        reason:
          locale === "en"
            ? "This wire does not map to an editable adjacent C statement slot."
            : asError(error).message,
      });
    }
  };

  return Object.freeze({
    handleStructureAction(action: CanvasStructureAction): boolean {
      try {
        assertActive(destroyed);
        options.structureEdits.assertReady();
        const snapshot = requireCurrentSnapshot(options);
        const resolved = resolveStructureTarget(snapshot, action);
        const availability = exactStructureAvailability(resolved.node, resolved.selection);
        if (!isStructureActionAvailable(action, availability)) {
          throw new Error(availability.reason ?? "当前结构操作在该语句位置不可用");
        }
        const editTargetIntent = Object.freeze({
          sourceFingerprint: snapshot.projection.sourceFingerprint,
          nodeId: resolved.node.id,
          target: resolved.target,
          selection: resolved.selection,
        });
        if (action.kind === "edit") {
          options.onEditTarget(editTargetIntent);
          return true;
        }
        const intent =
          action.kind === "insert-before" || action.kind === "insert-after"
            ? Object.freeze({ kind: action.kind, statementText: action.statementText })
            : Object.freeze({ kind: action.kind });
        options.onEditTarget(editTargetIntent);
        begin(buildStructureEditRequest(resolved.selection, intent));
        return true;
      } catch (error: unknown) {
        return report(error);
      }
    },

    handleEdgeInsertRequest(request: CanvasEdgeInsertRequest): boolean {
      try {
        assertActive(destroyed);
        options.structureEdits.assertReady();
        const snapshot = requireCurrentSnapshot(options);
        const edge = requireExactEdge(snapshot.projection, request);
        const resolved = resolveEdgeInsertTarget(snapshot, edge);
        if (request.mode === "presets") {
          options.onSelectPresetTarget(
            Object.freeze({
              sourceFingerprint: snapshot.projection.sourceFingerprint,
              edgeId: edge.id,
              target: resolved.target,
              selection: resolved.selection,
              position: resolved.position,
              worldPosition: Object.freeze({
                x: request.worldPosition.x,
                y: request.worldPosition.y,
              }),
            }),
          );
          return true;
        }
        if (request.mode !== "custom" || request.statementText === null) {
          throw new TypeError("画布边插入模式无效");
        }
        options.onEditTarget(
          Object.freeze({
            sourceFingerprint: snapshot.projection.sourceFingerprint,
            nodeId: null,
            target: resolved.target,
            selection: resolved.selection,
          }),
        );
        begin(
          buildStructureEditRequest(resolved.selection, {
            kind: resolved.position === "before" ? "insert-before" : "insert-after",
            statementText: request.statementText,
          }),
        );
        return true;
      } catch (error: unknown) {
        return report(error);
      }
    },

    listCompatiblePresets(
      request: CanvasEdgeInsertRequest,
      locale: InterfaceLocale = "zh-CN",
    ): readonly CanvasEdgeInsertPreset[] {
      try {
        assertActive(destroyed);
        options.structureEdits.assertReady();
        const intent = resolvePresetTargetIntent(requireCurrentSnapshot(options), request);
        return Object.freeze([...options.onListPresetTarget(intent, locale)]);
      } catch (error: unknown) {
        report(error);
        return Object.freeze([]);
      }
    },

    handleEdgePresetInsertRequest(request: CanvasEdgeInsertRequest, presetId: string): boolean {
      try {
        assertActive(destroyed);
        options.structureEdits.assertReady();
        if (presetId.trim().length === 0 || presetId.trim() !== presetId) {
          throw new TypeError("预设积木 ID 无效");
        }
        const intent = resolvePresetTargetIntent(requireCurrentSnapshot(options), request);
        return options.onInsertPresetTarget(intent, presetId);
      } catch (error: unknown) {
        return report(error);
      }
    },

    inspectNode(node: FlowNode, locale: InterfaceLocale = "zh-CN"): CanvasStructureAvailability {
      try {
        assertActive(destroyed);
        options.structureEdits.assertReady();
        const snapshot = requireCurrentSnapshot(options);
        const current = requireExactNode(snapshot.projection, node);
        const coarse = canvasStructureAvailability(current, locale);
        if (!coarse.editable) return coarse;
        const target = exactBlockEntryForNode(snapshot.analysis, current);
        const selection = requireEditableStatementSelection(snapshot.analysis, target);
        return exactStructureAvailability(current, selection, locale);
      } catch (error: unknown) {
        return unavailableStructureAvailability(
          locale === "en"
            ? "This node does not map to an editable statement in the current source snapshot."
            : asError(error).message,
        );
      }
    },

    inspectEdge(
      edge: FlowEdge,
      locale: InterfaceLocale = "zh-CN",
    ): CanvasEdgeInsertionAvailability {
      return inspectEdgeInsertion(edge, locale);
    },

    canInsertOnEdge(edge: FlowEdge): boolean {
      return inspectEdgeInsertion(edge).available;
    },

    destroy(): void {
      destroyed = true;
    },
  });
}

function resolvePresetTargetIntent(
  snapshot: CurrentCanvasStructureSnapshot,
  request: CanvasEdgeInsertRequest,
): CanvasPresetInsertTargetIntent {
  if (request.mode !== "presets" || request.statementText !== null) {
    throw new TypeError("画布预设插入请求格式无效");
  }
  const edge = requireExactEdge(snapshot.projection, request);
  const resolved = resolveEdgeInsertTarget(snapshot, edge);
  return Object.freeze({
    sourceFingerprint: snapshot.projection.sourceFingerprint,
    edgeId: edge.id,
    target: resolved.target,
    selection: resolved.selection,
    position: resolved.position,
    worldPosition: Object.freeze({
      x: request.worldPosition.x,
      y: request.worldPosition.y,
    }),
  });
}

function requireCurrentSnapshot(
  options: Pick<CanvasStructureActionControllerOptions, "getAnalysis" | "getProjection">,
): CurrentCanvasStructureSnapshot {
  const analysis = options.getAnalysis();
  const projection = options.getProjection();
  if (analysis === null || projection === null) {
    throw new Error("画布结构操作需要已完成的源码与 CFG 分析");
  }
  const revision = analysis.statementEdits.revision;
  if (
    projection.sourceRevision !== revision ||
    analysis.editTargets.revision !== revision ||
    projection.sourceLength !== analysis.document.source.length ||
    projection.sourceFingerprint !== fingerprintSource(analysis.document.source)
  ) {
    throw new Error("画布、结构索引与源码不属于同一分析快照");
  }
  return Object.freeze({ analysis, projection });
}

function resolveStructureTarget(
  snapshot: CurrentCanvasStructureSnapshot,
  action: CanvasStructureAction,
): ResolvedStructureTarget {
  if (action.sourceFingerprint !== snapshot.projection.sourceFingerprint) {
    throw new Error("画布结构操作已过期；源码未修改");
  }
  const node = snapshot.projection.nodes.find((candidate) => candidate.id === action.nodeId);
  if (
    node === undefined ||
    node.sourceNodeId !== action.sourceNodeId ||
    node.kind !== action.nodeKind
  ) {
    throw new Error("画布结构操作引用了未知或已变化的节点");
  }
  const availability = canvasStructureAvailability(node);
  if (!availability.editable) {
    throw new Error(availability.reason ?? "当前画布节点不可进行结构操作");
  }
  const target = exactBlockEntryForNode(snapshot.analysis, node);
  const selection = requireEditableStatementSelection(snapshot.analysis, target);
  return Object.freeze({ node, target, selection });
}

function requireExactNode(projection: FlowProjection, node: FlowNode): FlowNode {
  const current = projection.nodes.find((candidate) => candidate.id === node.id);
  if (
    current === undefined ||
    current.sourceNodeId !== node.sourceNodeId ||
    current.kind !== node.kind ||
    current.range.from !== node.range.from ||
    current.range.to !== node.range.to ||
    current.ownerBlockRange.from !== node.ownerBlockRange.from ||
    current.ownerBlockRange.to !== node.ownerBlockRange.to
  ) {
    throw new Error("画布节点已变化，无法执行当前结构操作");
  }
  return current;
}

function exactStructureAvailability(
  node: FlowNode,
  selection: StructureEditSelection,
  locale: InterfaceLocale = "zh-CN",
): CanvasStructureAvailability {
  const coarse = canvasStructureAvailability(node, locale);
  if (!coarse.editable) return coarse;
  const statement = selection.statement;
  const statementListReady =
    statement !== undefined &&
    statement.blocker === null &&
    statement.parentMode === "statement-list";
  return Object.freeze({
    editable: true,
    insertBefore: statementListReady,
    insertAfter: statementListReady,
    movePrevious: statementListReady && statement.previous !== null,
    moveNext: statementListReady && statement.next !== null,
    edit: true,
    reason:
      statement === undefined
        ? locale === "en"
          ? "This node has no exact editable C statement."
          : "该节点没有可精确编辑的 C 语句。"
        : null,
  });
}

function unavailableStructureAvailability(reason: string): CanvasStructureAvailability {
  return Object.freeze({
    editable: false,
    insertBefore: false,
    insertAfter: false,
    movePrevious: false,
    moveNext: false,
    edit: false,
    reason,
  });
}

function isStructureActionAvailable(
  action: CanvasStructureAction,
  availability: CanvasStructureAvailability,
): boolean {
  if (action.kind === "insert-before") return availability.insertBefore;
  if (action.kind === "insert-after") return availability.insertAfter;
  if (action.kind === "move-previous") return availability.movePrevious;
  if (action.kind === "move-next") return availability.moveNext;
  return availability.edit;
}

function requireExactEdge(projection: FlowProjection, request: CanvasEdgeInsertRequest): FlowEdge {
  if (request.sourceFingerprint !== projection.sourceFingerprint) {
    throw new Error("画布边插入请求已过期；源码未修改");
  }
  if (
    !Number.isFinite(request.worldPosition.x) ||
    !Number.isFinite(request.worldPosition.y) ||
    (request.mode !== "custom" && request.mode !== "presets")
  ) {
    throw new TypeError("画布边插入请求格式无效");
  }
  const edge = projection.edges.find((candidate) => candidate.id === request.edgeId);
  if (
    edge === undefined ||
    edge.from.nodeId !== request.fromNodeId ||
    edge.from.portId !== request.fromPortId ||
    edge.to.nodeId !== request.toNodeId ||
    edge.to.portId !== request.toPortId ||
    edge.kind !== request.edgeKind
  ) {
    throw new Error("画布边插入请求引用了未知或已变化的连线");
  }
  const availability = canvasEdgeInsertionAvailability(edge);
  if (!availability.available) {
    throw new Error(availability.reason ?? "当前连线不支持插入积木");
  }
  const from = requiredNode(projection, edge.from.nodeId);
  const to = requiredNode(projection, edge.to.nodeId);
  if (
    !from.ports.some((port) => port.id === edge.from.portId && port.direction === "output") ||
    !to.ports.some((port) => port.id === edge.to.portId && port.direction === "input")
  ) {
    throw new Error("画布边端口不属于当前投影节点");
  }
  return edge;
}

function resolveEdgeInsertTarget(
  snapshot: CurrentCanvasStructureSnapshot,
  edge: FlowEdge,
): ResolvedEdgeInsertTarget {
  const fromNode = requiredNode(snapshot.projection, edge.from.nodeId);
  const toNode = requiredNode(snapshot.projection, edge.to.nodeId);
  const from = optionalStructureTarget(snapshot.analysis, fromNode);
  const to = optionalStructureTarget(snapshot.analysis, toNode);

  if (from !== null && to !== null) {
    const fromStatement = from.selection.statement;
    const toStatement = to.selection.statement;
    if (
      fromStatement === undefined ||
      toStatement === undefined ||
      fromStatement.id === toStatement.id ||
      fromStatement.next?.id !== toStatement.id ||
      toStatement.previous?.id !== fromStatement.id
    ) {
      throw new Error("该 CFG 顺序边不对应相邻 C 语句插槽");
    }
    assertStatementSideInsertable(to.selection);
    return Object.freeze({ target: to.target, selection: to.selection, position: "before" });
  }

  if (
    fromNode.kind === "start" &&
    edge.kind === "entry" &&
    to !== null &&
    to.selection.statement?.previous === null
  ) {
    assertStatementSideInsertable(to.selection);
    return Object.freeze({ target: to.target, selection: to.selection, position: "before" });
  }

  if (from !== null && toNode.kind === "end" && (edge.kind === "next" || edge.kind === "return")) {
    const statement = from.selection.statement;
    if (statement === undefined || statement.next !== null) {
      throw new Error("该 End 连线不对应函数末尾的 C 语句插槽");
    }
    assertStatementSideInsertable(from.selection);
    return Object.freeze({ target: from.target, selection: from.selection, position: "after" });
  }

  throw new Error("该 CFG 顺序边没有可精确映射的 C 语句插槽");
}

function optionalStructureTarget(
  analysis: CAnalysisSnapshot,
  node: FlowNode,
): Omit<ResolvedStructureTarget, "node"> | null {
  if (
    node.locked ||
    node.sourceNodeId === null ||
    node.kind === "start" ||
    node.kind === "end" ||
    node.kind === "module" ||
    node.kind === "raw"
  ) {
    return null;
  }
  const target = exactBlockEntryForNode(analysis, node);
  const selection = requireEditableStatementSelection(analysis, target);
  return Object.freeze({ target, selection });
}

function exactBlockEntryForNode(analysis: CAnalysisSnapshot, node: FlowNode): BlockIndexEntry {
  const matches = createBlockIndex(analysis.document).entries.filter(
    (candidate) =>
      candidate.block?.kind === "syntax" &&
      (candidate.block.role === "statement" || candidate.block.role === "declaration") &&
      candidate.range.from === node.ownerBlockRange.from &&
      candidate.range.to === node.ownerBlockRange.to,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("画布节点无法唯一映射到当前结构索引");
  }
  return matches[0];
}

function requireEditableStatementSelection(
  analysis: CAnalysisSnapshot,
  target: BlockIndexEntry,
): StructureEditSelection {
  const selection = structureEditSelectionForBlock(analysis, target);
  if (selection?.statement === undefined) {
    throw new Error("画布目标不是当前快照中的可编辑 C 语句");
  }
  return selection;
}

function assertStatementSideInsertable(selection: StructureEditSelection): void {
  const statement = selection.statement;
  if (
    statement === undefined ||
    statement.parentMode !== "statement-list" ||
    statement.blocker !== null
  ) {
    throw new Error("画布连线没有可编辑的相邻语句插槽");
  }
}

function requiredNode(projection: FlowProjection, nodeId: string): FlowNode {
  const node = projection.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error("画布连线引用了不存在的节点");
  return node;
}

function assertOptions(options: CanvasStructureActionControllerOptions): void {
  if (
    typeof options?.getAnalysis !== "function" ||
    typeof options.getProjection !== "function" ||
    typeof options.structureEdits?.assertReady !== "function" ||
    typeof options.structureEdits.run !== "function" ||
    typeof options.onEditTarget !== "function" ||
    typeof options.onSelectPresetTarget !== "function" ||
    typeof options.onListPresetTarget !== "function" ||
    typeof options.onInsertPresetTarget !== "function" ||
    typeof options.onError !== "function"
  ) {
    throw new TypeError("canvas structure action controller options 不完整");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("画布结构操作控制器已销毁");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("无法完成画布结构操作");
}
