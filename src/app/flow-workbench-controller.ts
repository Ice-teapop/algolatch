import {
  createDefaultFlowViewState,
  deserializeFlowViewState,
  planFlowConnection,
  serializeFlowViewState,
  type ConnectionIntent,
  type FlowNode,
  type FlowProjection,
  type FlowViewState,
  type FlowViewStateIssue,
} from "../flow/index.js";
import type { PanelApi } from "../shared/api.js";
import type {
  PresetBlockKind,
  PresetBlockLifecycle,
  PresetPortDefinition,
  PresetSyntaxAncestorCapability,
  PresetSyntaxSlotKind,
} from "../learning/index.js";
import type { CAnalysisSnapshot } from "../core/index.js";
import {
  canvasSlotInsertRequest,
  canvasSlotInventory,
  slotAcceptsPlacement,
  type CanvasSlot,
  type CanvasSlotInsertRequest,
} from "./canvas-slot-inventory.js";
import {
  canvasSlotRectAtPoint,
  canvasSlotRects,
  type CanvasSlotRect,
} from "./canvas-slot-geometry.js";
import {
  createFlowCanvas,
  flowCanvasClientToWorld,
  type FlowCanvasConnectionGesture,
  type FlowCanvasController,
  type FlowCanvasActivePath,
  type FlowCanvasDetailContext,
  type FlowCanvasDraftConnectionIntent,
  type FlowCanvasDraftNode,
  type FlowCanvasDraftVisualState,
  type FlowCanvasInteractionContext,
  type FlowCanvasVirtualConnectionIntent,
} from "../ui/flow-canvas.js";
import {
  createResizableLayout,
  type ResizableLayoutController,
  type ResizableLayoutSnapshot,
} from "../ui/resizable-layout.js";
import {
  WORKBENCH_REVEAL_FLOW_DETAIL_EVENT,
  type WorkbenchElements,
} from "../ui/workbench-shell.js";
import {
  restoreFlowDraftSidecarState,
  serializeFlowDraftSidecarState,
  type FlowDraftSidecarRestore,
  type FlowSidecarRestoreIssue,
} from "./flow-sidecar-state.js";
import {
  createWorkspaceSidecarPersistence,
  type SidecarAdoption,
  type WorkspaceSidecarPersistence,
} from "./workspace-sidecar-persistence.js";
import {
  activeVirtualPlaybackNodes,
  connectVirtualFlowOverlay,
  decoratePathWithVirtualOverlay,
  reconcileVirtualFlowOverlay,
} from "./virtual-flow-overlay.js";
import type { DefUseDisabledReasonCode, ProgramAnalysisSnapshot } from "../analysis/index.js";
import {
  WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT,
  WORKBENCH_QUICK_OPEN_COLLECT_EVENT,
  quickOpenActivateDetail,
  quickOpenCollectDetail,
  quickOpenItemId,
  type QuickOpenItem,
} from "../commands/index.js";
import {
  evidenceForFlowNode,
  type FlowNodeEvidence,
  type FlowNodeRuntimeSnapshot,
} from "./flow-node-evidence.js";
import { FlowSourceCommitError } from "./flow-source-editor.js";
import { installCodeTextareaIndentation } from "../ui/code-textarea-keymap.js";
import {
  createCanvasEdgeInsertRequest,
  type CanvasEdgeInsertionAvailability,
  type CanvasEdgeInsertPreset,
  type CanvasEdgeInsertRequest,
  type CanvasStructureAction,
  type CanvasStructureAvailability,
} from "../ui/canvas-structure-actions.js";
import {
  CURRENT_WORKBENCH_LAYOUT_PROFILE,
  planWorkbenchLayoutRestore,
} from "./workbench-layout-profile.js";

export interface FlowWorkbenchControllerOptions {
  readonly elements: WorkbenchElements;
  readonly api: Pick<PanelApi, "readWorkspaceSidecar" | "saveWorkspaceSidecar">;
  readonly onNodeSelect: (node: FlowNode) => void;
  readonly onReplaceNodeSource: (node: FlowNode, source: string) => void;
  readonly onDeleteNodes: (nodes: readonly FlowNode[]) => void;
  readonly onConnectionPreflight: (intent: ConnectionIntent) => { readonly accepted: boolean };
  readonly onConnectionIntent: (intent: ConnectionIntent) => boolean;
  readonly resolvePreset: (presetId: string) => ResolvedFlowPreset | null;
  /** Statement targets for the current source; the drop strips are derived from these. */
  readonly getStatementAnalysis?: (() => CAnalysisSnapshot | null) | undefined;
  readonly onCanvasSlotInsertRequest?:
    ((request: CanvasSlotInsertRequest) => boolean | void) | undefined;
  readonly onDraftConnectionIntent: (intent: FlowCanvasDraftConnectionIntent) => boolean;
  readonly onDraftPresentationChange: (nodes: readonly FlowCanvasDraftNode[]) => void;
  readonly onLearningObservation?: ((observation: FlowLearningObservation) => void) | undefined;
  readonly onSourceUndo: () => void;
  readonly onSourceRedo?: (() => void) | undefined;
  readonly onVirtualPlaybackNode?:
    ((node: FlowCanvasDraftNode, mode: FlowCanvasActivePath["mode"]) => void) | undefined;
  readonly onCanvasStructureAction?:
    ((action: CanvasStructureAction) => boolean | void) | undefined;
  readonly onCanvasEdgeInsertRequest?:
    ((request: CanvasEdgeInsertRequest) => boolean | void) | undefined;
  readonly getCanvasEdgeInsertPresets?:
    | ((
        request: CanvasEdgeInsertRequest,
        locale: "zh-CN" | "en",
      ) => readonly CanvasEdgeInsertPreset[])
    | undefined;
  readonly onCanvasEdgePresetInsert?:
    ((request: CanvasEdgeInsertRequest, presetId: string) => boolean | void) | undefined;
  readonly inspectCanvasNode?:
    | ((node: FlowNode, locale: "zh-CN" | "en") => CanvasStructureAvailability | undefined)
    | undefined;
  readonly inspectCanvasEdge?:
    | ((
        edge: FlowProjection["edges"][number],
        locale: "zh-CN" | "en",
      ) => CanvasEdgeInsertionAvailability | undefined)
    | undefined;
  readonly onStatus: (message: string, state: "ready" | "warning" | "error") => void;
}

interface FlowLearningObservationBase {
  readonly workspaceId: string;
  readonly presetId: string;
  /** Fingerprint after the source-backed preset has been committed. */
  readonly sourceFingerprint: string;
  readonly roundtripAccepted: true;
  readonly cfgAccepted: true;
}

/**
 * A narrow, post-commit adapter for guided lessons. These observations are never emitted for a
 * detached draft or before the existing source reparse/roundtrip/CFG gate has returned success.
 */
export type FlowLearningObservation =
  | (FlowLearningObservationBase & {
      readonly type: "preset-inserted";
      readonly committed: true;
    })
  | (FlowLearningObservationBase & {
      readonly type: "connection-committed";
    });

export interface FlowLearningDraftCommitCandidate {
  readonly workspaceId: string | null;
  readonly beforeProjection: FlowProjection | null;
  readonly intent: FlowCanvasDraftConnectionIntent;
  readonly resultingSourceFingerprint: string;
  readonly committed: boolean;
  readonly roundtripAccepted: boolean;
  readonly cfgAccepted: boolean;
}

interface ResolvedFlowPreset {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly source: string | null;
  readonly blockKind: PresetBlockKind;
  readonly lifecycle: PresetBlockLifecycle;
  readonly ports: readonly PresetPortDefinition[];
  readonly acceptedSyntaxSlots?: readonly PresetSyntaxSlotKind[] | undefined;
  readonly requiredAnyAncestorCapabilities?: readonly PresetSyntaxAncestorCapability[] | undefined;
}

interface FlowWorkbenchHistorySnapshot {
  readonly view: FlowViewState;
  readonly drafts: FlowCanvasDraftVisualState;
  readonly sourceMutation: boolean;
  readonly action: string;
}

export interface FlowWorkbenchController {
  readonly projection: FlowProjection | null;
  readonly activeEntryId: string | null;
  readonly hasPendingChanges: boolean;
  adoptProjection(projection: FlowProjection): void;
  setAnalysis(analysis: ProgramAnalysisSnapshot | null): void;
  /**
   * Shows a temporary, read-only projection for C Cell input. The project projection remains the
   * authoritative source-backed model and no preview state is written to flow-view.json.
   */
  previewProjection(projection: FlowProjection, analysis?: ProgramAnalysisSnapshot | null): void;
  clearProjectionPreview(): void;
  setActivePath(path: FlowCanvasActivePath, evidence?: FlowNodeRuntimeSnapshot | null): void;
  focusNode(nodeId: string): void;
  setWorkspaceEntry(entryId: string | null): Promise<void>;
  finalizePendingSidecarRestore(): void;
  flush(): Promise<void>;
  destroy(): void;
}

export interface FlowWorkbenchSidecar {
  readonly schemaVersion: 1 | 2;
  readonly layoutProfile?: string | undefined;
  readonly sourceFingerprint: string;
  readonly viewState: unknown;
  readonly layoutPreset: string;
  readonly layouts: Readonly<Record<string, ResizableLayoutSnapshot>>;
  readonly panelVisibility: Readonly<Record<string, boolean>>;
  readonly drafts: unknown;
}

export const FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION = 2 as const;
const VALID_LAYOUT_PRESETS = new Set(["learn", "build", "debug", "analyze", "minimal"]);

export type FlowProjectionSidecarRestore =
  | {
      readonly ok: true;
      readonly viewState: FlowViewState;
      readonly draftState: FlowCanvasDraftVisualState;
      readonly issues: readonly (FlowViewStateIssue | FlowSidecarRestoreIssue)[];
      readonly retryable: boolean;
    }
  | {
      readonly ok: false;
      readonly viewState: null;
      readonly draftState: null;
      readonly issues: readonly (FlowViewStateIssue | FlowSidecarRestoreIssue)[];
      readonly retryable: false;
    };

/** Restores only projection-dependent sidecar data and identifies progressive-CFG misses. */
export function restoreFlowProjectionSidecarState(
  sidecar: FlowWorkbenchSidecar,
  projection: FlowProjection,
  sourceMatches: boolean,
): FlowProjectionSidecarRestore {
  const draftRestore: FlowDraftSidecarRestore = restoreFlowDraftSidecarState(
    sidecar.drafts,
    projection,
    {
      schemaVersion: sidecar.schemaVersion,
      savedSourceFingerprint: sidecar.sourceFingerprint,
      sourceMatches,
    },
  );
  const viewRestore = deserializeFlowViewState(JSON.stringify(sidecar.viewState), projection);
  const issues = Object.freeze([...viewRestore.issues, ...draftRestore.issues]);
  if (!viewRestore.ok || !draftRestore.ok) {
    return Object.freeze({
      ok: false,
      viewState: null,
      draftState: null,
      issues,
      retryable: false,
    });
  }
  const retryable = issues.some((issue) =>
    sidecar.schemaVersion === FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION
      ? issue.code === "anchor-mismatch"
      : sourceMatches && (issue.code === "unknown-node" || issue.code === "invalid-virtual-edge"),
  );
  return Object.freeze({
    ok: true,
    viewState: viewRestore.value,
    draftState: draftRestore.state,
    issues,
    retryable,
  });
}

export interface FlowWorkspaceAdoptionPresentation {
  readonly restoreSidecar: (serialized: string, matchesSource: boolean) => void;
  readonly resetPresentation: () => void;
  readonly fitFirstProjection: () => void;
}

/**
 * Applies the view part of workspace adoption. A missing sidecar is the one first-view case that
 * must frame the new projection; an existing sidecar owns its viewport and must never be followed
 * by an automatic fit that would silently overwrite the restored learner layout.
 *
 * Returns true when the caller should persist the newly-created default view.
 */
export function applyFlowWorkspaceAdoptionPresentation(
  adoption: SidecarAdoption,
  presentation: FlowWorkspaceAdoptionPresentation,
): boolean {
  if (adoption.document !== null) {
    presentation.restoreSidecar(adoption.document.serialized, adoption.matchesSource);
    return false;
  }
  presentation.resetPresentation();
  presentation.fitFirstProjection();
  return true;
}

export function createFlowWorkbenchController(
  options: FlowWorkbenchControllerOptions,
): FlowWorkbenchController {
  assertOptions(options);
  let projection: FlowProjection | null = null;
  let activeEntryId: string | null = null;
  let currentViewState: FlowViewState | null = null;
  let currentDraftState: FlowCanvasDraftVisualState = emptyDraftState();
  let layoutPreset = "build";
  let destroyed = false;
  let restoring = false;
  let adoptionGeneration = 0;
  let sidecarLoading = false;
  let pendingSidecarRestore: {
    readonly sidecar: FlowWorkbenchSidecar;
    readonly sourceMatches: boolean;
  } | null = null;
  let activeVirtualNodeIds = new Set<string>();
  let analysis: ProgramAnalysisSnapshot | null = null;
  let projectionPreview: {
    readonly projection: FlowProjection;
    readonly analysis: ProgramAnalysisSnapshot | null;
    viewState: FlowViewState;
  } | null = null;
  let runtimeEvidence: FlowNodeRuntimeSnapshot | null = null;
  let activePresetDragId: string | null = null;
  let activePresetDropHandled = false;
  let slots: readonly CanvasSlot[] = [];
  let slotRects: readonly CanvasSlotRect[] = [];

  function refreshSlots(): void {
    const analysis = options.getStatementAnalysis?.() ?? null;
    slots = canvasSlotInventory(analysis);
    slotRects =
      projection === null ? [] : canvasSlotRects(slots, projection.nodes, positionForSlotAnchor);
    canvas.setSlots(projectionPreview === null ? slotRects : []);
  }

  function positionForSlotAnchor(node: FlowNode): { readonly x: number; readonly y: number } {
    return currentViewState?.positions[node.id] ?? node.defaultPosition;
  }

  function compatibleSlotIds(presetId: string | null): ReadonlySet<string> {
    const preset = presetId === null ? null : options.resolvePreset(presetId);
    if (preset === null || preset.source === null || preset.blockKind === "virtual") {
      return new Set();
    }
    const placement = {
      acceptedSyntaxSlots: preset.acceptedSyntaxSlots ?? [],
      requiredAnyAncestorCapabilities: preset.requiredAnyAncestorCapabilities ?? [],
    };
    return new Set(
      slots.filter((slot) => slotAcceptsPlacement(slot, placement)).map((slot) => slot.id),
    );
  }

  function slotAtClientPoint(clientX: number, clientY: number): CanvasSlot | null {
    if (slotRects.length === 0) return null;
    const view = canvas.getViewState();
    const world = flowCanvasClientToWorld(canvas.element, view, clientX, clientY);
    const rect = canvasSlotRectAtPoint(slotRects, world.x, world.y, 6);
    if (rect === null) return null;
    return slots.find((slot) => slot.id === rect.slotId) ?? null;
  }
  const undoHistory: FlowWorkbenchHistorySnapshot[] = [];
  const redoHistory: FlowWorkbenchHistorySnapshot[] = [];
  const canvasToolbar = required(options.elements.shell, ".canvas-toolbar");
  const canvasToolbarActions = required(canvasToolbar, ".canvas-toolbar__actions");
  const canvasHint = required(options.elements.shell, ".canvas-toolbar__hint");
  const canvasSourceBadge = required(canvasToolbar, ".canvas-toolbar__source-badge");
  const alignLeftButton = required(
    canvasToolbarActions,
    "button[data-flow-command='align-left']",
  ) as HTMLButtonElement;
  const distributeButton = required(
    canvasToolbarActions,
    "button[data-flow-command='distribute-y']",
  ) as HTMLButtonElement;
  let canvasInteractionContext: FlowCanvasInteractionContext = Object.freeze({
    mode: "idle",
    selectedCount: 0,
  });
  let lastLocalizedStatus: {
    readonly zh: string;
    readonly en: string;
    readonly state: "ready" | "warning" | "error";
  } | null = null;

  const presentLocalizedStatus = (
    zh: string,
    en: string,
    state: "ready" | "warning" | "error",
  ): void => {
    lastLocalizedStatus = Object.freeze({ zh, en, state });
    options.onStatus(options.elements.shell.dataset.locale === "en" ? en : zh, state);
  };

  const renderCanvasInteractionContext = (): void => {
    const english = options.elements.shell.dataset.locale === "en";
    const { mode, selectedCount } = canvasInteractionContext;
    if (projectionPreview !== null) {
      canvasToolbar.dataset.presentation = "preview";
      canvasSourceBadge.textContent = english ? "C Cell · Read only" : "C Cell · 只读";
      canvasHint.textContent = english
        ? "Read-only C Cell projection · runtime evidence opens from Runtime Panel"
        : "C Cell 只读投影 · 运行证据从“运行面板”打开";
      alignLeftButton.hidden = true;
      distributeButton.hidden = true;
      return;
    }
    delete canvasToolbar.dataset.presentation;
    canvasSourceBadge.textContent = "main.c";
    canvasHint.textContent =
      mode === "wiring"
        ? english
          ? "Drop on a port marked connect · blank space cancels"
          : "拖到标记“可连接”的端口 · 空白取消"
        : mode === "edge"
          ? english
            ? "Drag either cable plug · highlighted sockets are safe · Esc cancels"
            : "拖动任一端插头 · 仅高亮安全端口 · Esc 取消"
          : mode === "multi"
            ? english
              ? `${String(selectedCount)} selected · align or distribute`
              : `已选 ${String(selectedCount)} 个 · 可对齐或纵向分布`
            : mode === "draft"
              ? english
                ? "Drag draft · wire from its right port · double-click to edit"
                : "拖动草稿 · 从右侧端口接入 · 双击编辑"
              : mode === "node"
                ? english
                  ? "Use the node toolbar to edit C · dragging only changes layout · ports rewire"
                  : "用节点操作条编辑 C · 拖动只调整布局 · 端口用于改接"
                : english
                  ? "Drop blocks on highlighted wires · drag nodes for layout only · select a node for structure actions"
                  : "拖积木到高亮连线 · 拖节点只调布局 · 选择节点用操作条改结构";
    alignLeftButton.hidden = mode !== "multi" || selectedCount < 2;
    distributeButton.hidden = mode !== "multi" || selectedCount < 3;
  };

  const layouts = createWorkbenchLayouts(options.elements, (snapshot) => {
    if (!restoring) persistSnapshot(snapshot.id, snapshot.value);
  });
  const layoutSnapshots = new Map<string, ResizableLayoutSnapshot>(
    layouts.map((layout) => [layout.id, layout.controller.getSnapshot()]),
  );

  const persistence: WorkspaceSidecarPersistence = createWorkspaceSidecarPersistence({
    kind: "flow-view",
    read: (entryId, kind) => options.api.readWorkspaceSidecar({ entryId, kind }),
    save: (request) => options.api.saveWorkspaceSidecar(request),
    onStatus(status) {
      if (status.state === "error") options.onStatus(status.message, "error");
    },
  });

  const canvas: FlowCanvasController = createFlowCanvas(options.elements.flowCanvas, {
    onNodeClick(node) {
      if (projectionPreview !== null) return;
      options.onNodeSelect(node);
    },
    onViewStateChange(state, reason) {
      if (projectionPreview !== null) {
        projectionPreview.viewState = state;
        return;
      }
      currentViewState = state;
      if (!restoring && reason !== "projection" && reason !== "restore") {
        pendingSidecarRestore = null;
        persist();
      }
    },
    onConnectionIntent(gesture) {
      if (projectionPreview !== null) return false;
      return handleConnectionIntent(gesture);
    },
    onConnectionPreflight(gesture) {
      if (projectionPreview !== null) return Object.freeze({ accepted: false });
      if (gesture.edgeKind === null) return Object.freeze({ accepted: false });
      return options.onConnectionPreflight(
        Object.freeze({
          sourceFingerprint: gesture.sourceFingerprint,
          fromNodeId: gesture.fromNodeId,
          fromPortId: gesture.fromPortId,
          toNodeId: gesture.toNodeId,
          toPortId: gesture.toPortId,
          kind: gesture.edgeKind,
          replaceEdgeId: gesture.replaceEdgeId,
        }),
      );
    },
    onDraftConnectionIntent(intent) {
      if (projectionPreview !== null) return false;
      const beforeProjection = projection;
      const historyDepth = undoHistory.length;
      checkpoint(true, "接入草稿积木");
      try {
        const committed = options.onDraftConnectionIntent(intent);
        if (!committed) {
          undoHistory.splice(historyDepth);
          markDraftInvalid(intent.draftNodeId);
          return false;
        }
        emitLearningObservations({
          workspaceId: activeEntryId,
          beforeProjection,
          intent,
          resultingSourceFingerprint: projection?.sourceFingerprint ?? "",
          committed,
          roundtripAccepted: true,
          cfgAccepted: true,
        });
        currentDraftState = Object.freeze({
          nodes: Object.freeze(
            currentDraftState.nodes.filter((node) => node.id !== intent.draftNodeId),
          ),
          selectedNodeIds: Object.freeze([]),
          connection: null,
          virtualEdges: Object.freeze(
            (currentDraftState.virtualEdges ?? []).filter(
              (edge) =>
                edge.from.nodeId !== intent.draftNodeId && edge.to.nodeId !== intent.draftNodeId,
            ),
          ),
        });
        presentDraftState();
        persist();
        return true;
      } catch (error: unknown) {
        undoHistory.splice(historyDepth);
        markDraftInvalid(intent.draftNodeId);
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`草稿连接被拒绝：${detail}。main.c 未修改。`, "error");
        return false;
      }
    },
    onVirtualConnectionIntent(intent) {
      if (projectionPreview !== null) return false;
      return handleVirtualConnectionIntent(intent);
    },
    onWireStatus(message, state) {
      options.onStatus(message, state);
    },
    onInteractionContextChange(context) {
      canvasInteractionContext = context;
      renderCanvasInteractionContext();
    },
    onStructureAction(action) {
      if (projectionPreview !== null) return false;
      return options.onCanvasStructureAction?.(action) ?? false;
    },
    onEdgeInsertRequest(request) {
      if (projectionPreview !== null) return false;
      return options.onCanvasEdgeInsertRequest?.(request) ?? false;
    },
    getEdgeInsertPresets(request) {
      const locale = options.elements.shell.dataset.locale === "en" ? "en" : "zh-CN";
      return options.getCanvasEdgeInsertPresets?.(request, locale) ?? Object.freeze([]);
    },
    onEdgePresetInsert(request, presetId) {
      if (projectionPreview !== null) return false;
      return options.onCanvasEdgePresetInsert?.(request, presetId) ?? false;
    },
    inspectStructureNode(node) {
      const locale = options.elements.shell.dataset.locale === "en" ? "en" : "zh-CN";
      return options.inspectCanvasNode?.(node, locale);
    },
    canInsertOnEdge(edge) {
      const locale = options.elements.shell.dataset.locale === "en" ? "en" : "zh-CN";
      return options.inspectCanvasEdge?.(edge, locale)?.available ?? true;
    },
    onHistoryCheckpoint: () => checkpoint(false, "调整画布"),
    onUndo: undo,
    onRedo: redo,
    onDraftStateChange(state, reason) {
      if (projectionPreview !== null) return;
      currentDraftState = state;
      publishDraftPresentation();
      if (!restoring && reason !== "restore") {
        pendingSidecarRestore = null;
        persist();
      }
    },
    onDeleteNodes(nodeIds) {
      if (projectionPreview !== null) return;
      const current = projection;
      if (current === null) return;
      const nodes = nodeIds.flatMap((nodeId) => {
        const node = current.nodes.find((candidate) => candidate.id === nodeId);
        return node === undefined ? [] : [node];
      });
      if (nodes.length > 0) {
        try {
          options.onDeleteNodes(Object.freeze(nodes));
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          options.onStatus(`节点删除被拒绝：${detail}。main.c 未修改。`, "error");
        }
      }
    },
    onCopyNodes(nodeIds) {
      if (projectionPreview !== null) return;
      const current = projection;
      if (current === null) return;
      const copied = nodeIds.flatMap((nodeId, index) => {
        const node = current.nodes.find((candidate) => candidate.id === nodeId);
        if (node === undefined || node.sourceText.trim().length === 0) return [];
        return [
          draftNode(
            `copy-${String(Date.now())}-${String(index)}`,
            `${node.label} 副本`,
            node.sourceText,
            {
              x: (currentViewState?.positions[node.id]?.x ?? node.defaultPosition.x) + 28,
              y: (currentViewState?.positions[node.id]?.y ?? node.defaultPosition.y) + 48,
            },
            null,
          ),
        ];
      });
      currentDraftState = Object.freeze({
        nodes: Object.freeze([...currentDraftState.nodes, ...copied]),
        selectedNodeIds: Object.freeze(copied.map((node) => node.id)),
        connection: null,
        virtualEdges: Object.freeze([...(currentDraftState.virtualEdges ?? [])]),
      });
      presentDraftState();
      persist();
      const count = copied.length;
      options.onStatus(
        count === 0
          ? "没有可复制的源码节点。"
          : `已复制 ${String(count)} 个节点为草稿；连接前不会改写 main.c。`,
        count === 0 ? "warning" : "ready",
      );
    },
    renderNodeDetail(context) {
      const effectiveProjection = projectionPreview?.projection ?? projection;
      const effectiveAnalysis = projectionPreview?.analysis ?? analysis;
      renderWorkbenchNodeDetail(
        context,
        options.onReplaceNodeSource,
        options.onStatus,
        effectiveProjection === null
          ? Object.freeze({ diagnostics: Object.freeze([]), runtime: null })
          : evidenceForFlowNode(
              context.node,
              effectiveProjection,
              effectiveAnalysis,
              projectionPreview === null ? runtimeEvidence : null,
            ),
        options.elements.shell.dataset.locale === "en",
      );
    },
  });
  function publishDraftPresentation(): void {
    options.onDraftPresentationChange(Object.freeze([...currentDraftState.nodes]));
  }

  function presentDraftState(): void {
    canvas.setDraftVisualState(currentDraftState);
  }

  function renderDataFlowAvailability(current: FlowProjection | null): void {
    const host = options.elements.dataFlowStatusHost;
    const unavailable = current?.functions.filter((item) => !item.dataFlowAvailable) ?? [];
    if (current === null || unavailable.length === 0) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    const english = options.elements.shell.dataset.locale === "en";
    const reasonCodes = [...new Set(unavailable.flatMap((item) => item.dataFlowDisabledReasons))];
    const message = host.ownerDocument.createElement("p");
    message.textContent =
      reasonCodes.length === 0
        ? english
          ? "Data relationships are still being analyzed. The control-flow projection remains available."
          : "数据关系仍在分析；控制流投影可以继续使用。"
        : english
          ? `Data relationships are unavailable for ${functionList(unavailable.map((item) => item.name))}: ${reasonCodes.map((reason) => defUseReasonLabel(reason, true)).join("; ")}.`
          : `${functionList(unavailable.map((item) => item.name))} 暂无可靠数据关系：${reasonCodes.map((reason) => defUseReasonLabel(reason, false)).join("；")}。`;
    host.hidden = false;
    host.replaceChildren(message);
  }

  function markDraftInvalid(nodeId: string): void {
    if (!currentDraftState.nodes.some((node) => node.id === nodeId)) return;
    currentDraftState = Object.freeze({
      ...currentDraftState,
      nodes: Object.freeze(
        currentDraftState.nodes.map((node) =>
          node.id === nodeId ? Object.freeze({ ...node, status: "invalid" as const }) : node,
        ),
      ),
      connection: null,
    });
    presentDraftState();
    persist();
  }

  publishDraftPresentation();
  const onCanvasLocaleChange = (): void => {
    renderCanvasInteractionContext();
    renderDataFlowAvailability(projectionPreview?.projection ?? projection);
    if (lastLocalizedStatus !== null) {
      const current = lastLocalizedStatus;
      options.onStatus(
        options.elements.shell.dataset.locale === "en" ? current.en : current.zh,
        current.state,
      );
    }
  };
  options.elements.shell.addEventListener("workbench-locale-change", onCanvasLocaleChange);
  renderCanvasInteractionContext();
  const onCanvasToolbarClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-flow-command]",
    );
    const command = target?.dataset.flowCommand;
    if (command === "undo" && projectionPreview === null) undo();
    else if (command === "align-left") canvas.alignSelection("left");
    else if (command === "distribute-y") canvas.alignSelection("distribute-y");
  };
  canvasToolbarActions.addEventListener("click", onCanvasToolbarClick);
  const onRevealFlowDetail = (): void => {
    const visibleProjection = projectionPreview?.projection ?? projection;
    const node =
      visibleProjection?.nodes.find(
        (candidate) =>
          candidate.kind !== "start" &&
          candidate.kind !== "end" &&
          candidate.sourceText.trim().length > 0,
      ) ??
      visibleProjection?.nodes.find(
        (candidate) => candidate.kind !== "start" && candidate.kind !== "end",
      );
    if (node !== undefined) canvas.focusNode(node.id);
  };
  options.elements.shell.addEventListener(WORKBENCH_REVEAL_FLOW_DETAIL_EVENT, onRevealFlowDetail);
  const onQuickOpenCollect = (event: Event): void => {
    const detail = quickOpenCollectDetail(event);
    const current = projection;
    if (
      detail === null ||
      (detail.scope !== null && detail.scope !== "node") ||
      current === null ||
      options.elements.parserStatus.dataset.analysisState === "pending"
    ) {
      return;
    }
    const english = options.elements.shell.dataset.locale === "en";
    const functionNames = new Map(current.functions.map((entry) => [entry.id, entry.name]));
    const items: readonly QuickOpenItem[] = Object.freeze(
      current.nodes
        .filter((node) =>
          quickOpenNodeMatches(
            node,
            detail.query,
            node.functionId === null ? "" : (functionNames.get(node.functionId) ?? ""),
          ),
        )
        .map((node, index) => {
          const functionName =
            node.functionId === null ? "全局" : functionNames.get(node.functionId);
          return Object.freeze({
            id: quickOpenItemId("node", node.id),
            kind: "node" as const,
            targetId: node.id,
            label: english ? compactQuickOpenNodeSource(node.sourceText, node.kind) : node.label,
            detail: english
              ? `${node.functionId === null ? "Global" : (functionName ?? "Function")} · ${node.kind}${node.locked ? " · read-only" : ""}`
              : `${functionName ?? "函数"} · ${node.kind}${node.locked ? " · 只读" : ""}`,
            keywords: Object.freeze([
              node.kind,
              node.nodeType ?? "",
              node.sourceText,
              functionName ?? "",
            ]),
            order: index,
            contextKey: `${current.sourceFingerprint}:${String(current.sourceRevision)}`,
          });
        }),
    );
    detail.add(items);
  };
  const onQuickOpenActivate = (event: Event): void => {
    const detail = quickOpenActivateDetail(event);
    if (detail?.item.kind !== "node") return;
    const current = projection;
    const contextKey =
      current === null ? "" : `${current.sourceFingerprint}:${String(current.sourceRevision)}`;
    const node = current?.nodes.find((candidate) => candidate.id === detail.item.targetId);
    if (node === undefined || detail.item.contextKey !== contextKey) {
      options.onStatus("节点结果已因源码变化失效，请重新搜索。", "warning");
      return;
    }
    options.elements.showPage("build");
    canvas.focusNode(node.id);
  };
  options.elements.shell.addEventListener(WORKBENCH_QUICK_OPEN_COLLECT_EVENT, onQuickOpenCollect);
  options.elements.shell.addEventListener(WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT, onQuickOpenActivate);

  function handleVirtualConnectionIntent(intent: FlowCanvasVirtualConnectionIntent): boolean {
    const current = projection;
    if (current === null) return false;
    const historyDepth = undoHistory.length;
    checkpoint(false, "连接运行标记");
    try {
      currentDraftState = connectVirtualFlowOverlay(current, currentDraftState, intent);
      presentDraftState();
      persist();
      const edge = currentDraftState.virtualEdges?.find(
        (candidate) =>
          candidate.from.nodeId === intent.from.nodeId &&
          candidate.from.portId === intent.from.portId &&
          candidate.to.nodeId === intent.to.nodeId &&
          candidate.to.portId === intent.to.portId,
      );
      options.onStatus(
        edge?.status === "valid"
          ? "虚拟节点已绑定到一条真实 CFG 边；只影响回放，不改写 main.c。"
          : "已连接虚拟节点一端；请把另一端接到同一条真实 CFG 边。",
        edge?.status === "valid" ? "ready" : "warning",
      );
      return true;
    } catch (error: unknown) {
      undoHistory.splice(historyDepth);
      const detail = error instanceof Error ? error.message : String(error);
      options.onStatus(`虚拟连线被拒绝：${detail}。main.c 未修改。`, "error");
      return false;
    }
  }

  function checkpoint(sourceMutation: boolean, action: string): void {
    if (projectionPreview !== null || restoring || currentViewState === null) return;
    undoHistory.push(
      Object.freeze({
        view: currentViewState,
        drafts: currentDraftState,
        sourceMutation,
        action,
      }),
    );
    redoHistory.length = 0;
    if (undoHistory.length > 50) undoHistory.splice(0, undoHistory.length - 50);
  }

  function undo(): void {
    const snapshot = undoHistory.pop();
    if (snapshot === undefined) {
      options.onSourceUndo();
      return;
    }
    if (currentViewState !== null) {
      redoHistory.push(
        Object.freeze({
          view: currentViewState,
          drafts: currentDraftState,
          sourceMutation: snapshot.sourceMutation,
          action: snapshot.action,
        }),
      );
    }
    restoring = true;
    try {
      if (snapshot.sourceMutation) options.onSourceUndo();
      currentViewState = snapshot.view;
      currentDraftState = snapshot.drafts;
      canvas.setViewState(snapshot.view);
      presentDraftState();
    } finally {
      restoring = false;
    }
    persist();
    options.onStatus(`已撤销：${snapshot.action}。`, "ready");
  }

  function redo(): void {
    const snapshot = redoHistory.pop();
    if (snapshot === undefined) {
      options.onStatus("没有可重做的画布操作。", "warning");
      return;
    }
    if (snapshot.sourceMutation && options.onSourceRedo === undefined) {
      redoHistory.push(snapshot);
      options.onStatus("当前源码编辑器未提供重做通道；可继续使用撤销历史。", "warning");
      return;
    }
    if (currentViewState !== null) {
      undoHistory.push(
        Object.freeze({
          view: currentViewState,
          drafts: currentDraftState,
          sourceMutation: snapshot.sourceMutation,
          action: snapshot.action,
        }),
      );
    }
    restoring = true;
    try {
      if (snapshot.sourceMutation) options.onSourceRedo?.();
      currentViewState = snapshot.view;
      currentDraftState = snapshot.drafts;
      canvas.setViewState(snapshot.view);
      presentDraftState();
    } finally {
      restoring = false;
    }
    persist();
    options.onStatus(`已重做：${snapshot.action}。`, "ready");
  }

  function handleConnectionIntent(gesture: FlowCanvasConnectionGesture): boolean {
    const current = projection;
    if (current === null || gesture.edgeKind === null) {
      options.onStatus("连接缺少明确的 C 控制流类型；源码未修改。", "error");
      return false;
    }
    const intent: ConnectionIntent = Object.freeze({
      sourceFingerprint: gesture.sourceFingerprint,
      fromNodeId: gesture.fromNodeId,
      fromPortId: gesture.fromPortId,
      toNodeId: gesture.toNodeId,
      toPortId: gesture.toPortId,
      kind: gesture.edgeKind,
      replaceEdgeId: gesture.replaceEdgeId,
    });
    const plan = planFlowConnection(current, intent);
    if (plan.status === "rejected") {
      options.onStatus(`连接被拒绝：${plan.message}。main.c 未修改。`, "error");
      return false;
    }
    const historyDepth = undoHistory.length;
    checkpoint(true, "改接控制流");
    try {
      const committed = options.onConnectionIntent(intent);
      if (!committed) undoHistory.splice(historyDepth);
      options.onStatus(
        committed
          ? "连线已通过精确 diff、重解析、无损往返和 CFG 后置条件并写入 main.c。"
          : "已取消连线；main.c 未修改。",
        committed ? "ready" : "warning",
      );
      return committed;
    } catch (error: unknown) {
      if (!(error instanceof FlowSourceCommitError)) undoHistory.splice(historyDepth);
      const detail = error instanceof Error ? error.message : String(error);
      options.onStatus(
        error instanceof FlowSourceCommitError
          ? `${detail}。源码撤销快照已保留，请使用 Command/Control+Z 恢复。`
          : `连线被拒绝：${detail}。main.c 未修改。`,
        "error",
      );
      return false;
    }
  }

  function persistSnapshot(id: string, snapshot: ResizableLayoutSnapshot): void {
    layoutSnapshots.set(id, snapshot);
    persist();
  }

  function persist(): void {
    const current = projection;
    if (
      destroyed ||
      current === null ||
      currentViewState === null ||
      activeEntryId === null ||
      sidecarLoading ||
      pendingSidecarRestore !== null
    ) {
      return;
    }
    let serializedView: unknown;
    try {
      serializedView = JSON.parse(serializeFlowViewState(currentViewState, current)) as unknown;
    } catch {
      // A transient preview callback must never make project persistence fail. If view coordinates
      // no longer belong to the authoritative main.c projection, discard only that view state and
      // persist a source-derived default; source, drafts and project files remain untouched.
      currentViewState = createDefaultFlowViewState(current);
      serializedView = JSON.parse(serializeFlowViewState(currentViewState, current)) as unknown;
      presentLocalizedStatus(
        "画布视图与当前源码失配，已仅重置节点位置；main.c 未修改。",
        "The canvas view no longer matched the current source. Node positions were reset; main.c was not changed.",
        "warning",
      );
    }
    const sidecar: FlowWorkbenchSidecar = Object.freeze({
      schemaVersion: FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION,
      layoutProfile: CURRENT_WORKBENCH_LAYOUT_PROFILE,
      sourceFingerprint: current.sourceFingerprint,
      viewState: serializedView,
      layoutPreset,
      layouts: Object.freeze(Object.fromEntries(layoutSnapshots)),
      panelVisibility: options.elements.getPanelVisibility(),
      drafts: serializeFlowDraftSidecarState(currentDraftState, current),
    });
    persistence.update(JSON.stringify(sidecar), current.sourceFingerprint);
  }

  function adoptDefaultView(current: FlowProjection): void {
    restoring = true;
    try {
      currentViewState = createDefaultFlowViewState(current);
      if (projectionPreview === null) {
        canvas.setProjection(current);
        canvas.setViewState(currentViewState);
        presentDraftState();
      }
    } finally {
      restoring = false;
    }
  }

  function resetWorkspacePresentation(): void {
    restoring = true;
    try {
      resetLayouts(
        layouts.map((layout) => layout.id),
        layouts,
        layoutSnapshots,
      );
      layoutPreset = "build";
      options.elements.applyLayoutPreset(layoutPreset, { activateWorkspace: false });
    } finally {
      restoring = false;
    }
  }

  function applyProjectionSidecarRestore(
    restored: Extract<FlowProjectionSidecarRestore, { readonly ok: true }>,
    readableViewportMigration = false,
  ): void {
    currentDraftState = restored.draftState;
    presentDraftState();
    currentViewState = restored.viewState;
    canvas.setViewState(currentViewState);
    if (readableViewportMigration) {
      canvas.fitReadableNodes();
      currentViewState = canvas.getViewState();
    }
  }

  function retryPendingSidecarRestore(finalize: boolean): void {
    const current = projection;
    const pending = pendingSidecarRestore;
    if (current === null || pending === null) return;
    const restored = restoreFlowProjectionSidecarState(
      pending.sidecar,
      current,
      pending.sourceMatches,
    );
    if (!restored.ok) {
      pendingSidecarRestore = null;
      options.onStatus(
        `布局无法恢复：${restored.issues.map((issue) => issue.message).join("；")}。main.c 未修改。`,
        "warning",
      );
      return;
    }
    applyProjectionSidecarRestore(
      restored,
      pending.sidecar.schemaVersion === 1 ||
        pending.sidecar.layoutProfile !== CURRENT_WORKBENCH_LAYOUT_PROFILE,
    );
    if (finalize || !restored.retryable) pendingSidecarRestore = null;
    if (finalize && restored.issues.length > 0) {
      options.onStatus(
        `布局已部分恢复：${restored.issues.map((issue) => issue.message).join("；")}。失配定位已丢弃，main.c 未修改。`,
        "warning",
      );
    }
  }

  function restoreSidecar(serialized: string, matchesSource: boolean): void {
    const current = projection;
    if (current === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      options.onStatus("flow-view.json 不是合法 JSON；仅重置视图，main.c 未修改。", "warning");
      return;
    }
    const sidecar = readFlowWorkbenchSidecar(parsed);
    if (sidecar === null) {
      options.onStatus("flow-view.json 版本或结构无效；仅重置视图，main.c 未修改。", "warning");
      return;
    }
    restoring = true;
    try {
      const layoutRestore = planWorkbenchLayoutRestore(sidecar.layoutProfile, sidecar.layouts);
      resetLayouts(layoutRestore.resetLayoutIds, layouts, layoutSnapshots);
      restoreLayouts(layoutRestore.snapshots, layouts, layoutSnapshots);
      // Sidecar I/O completes asynchronously. Restore the underlying workspace layout without
      // navigating: otherwise a late read can overwrite a Library/Analysis page the user opened
      // while the project was loading.
      options.elements.applyLayoutPreset(sidecar.layoutPreset, { activateWorkspace: false });
      options.elements.setPanelVisibility(sidecar.panelVisibility);
      layoutPreset = sidecar.layoutPreset;
      const sourceMatches =
        matchesSource && sidecar.sourceFingerprint === current.sourceFingerprint;
      const restored = restoreFlowProjectionSidecarState(sidecar, current, sourceMatches);
      if (!restored.ok) {
        options.onStatus(
          `布局无法恢复：${restored.issues.map((issue) => issue.message).join("；")}。main.c 未修改。`,
          "warning",
        );
        return;
      }
      applyProjectionSidecarRestore(
        restored,
        sidecar.schemaVersion === 1 || sidecar.layoutProfile !== CURRENT_WORKBENCH_LAYOUT_PROFILE,
      );
      pendingSidecarRestore = restored.retryable ? Object.freeze({ sidecar, sourceMatches }) : null;
      if (restored.retryable) {
        presentLocalizedStatus(
          "布局锚点正在等待后台 CFG；分析完成后会自动恢复，期间不会覆盖 flow-view.json。",
          "Layout anchors are waiting for the background CFG. They will restore after analysis without overwriting flow-view.json.",
          "ready",
        );
      } else if (restored.issues.length > 0) {
        options.onStatus(
          `布局已部分恢复：${restored.issues.map((issue) => issue.message).join("；")}。失配定位已丢弃，main.c 未修改。`,
          "warning",
        );
      } else if (sidecar.schemaVersion === 1) {
        presentLocalizedStatus(
          "旧版 flow-view 已载入；下一次保存将迁移为锚点格式 v2。",
          "Legacy flow-view loaded. The next save will migrate it to anchor format v2.",
          "ready",
        );
      }
    } finally {
      restoring = false;
    }
  }

  const onWorkbenchAction = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isRecord(detail) || detail.rootId !== "panels" || typeof detail.branchId !== "string") {
      return;
    }
    if (VALID_LAYOUT_PRESETS.has(detail.branchId)) {
      layoutPreset = detail.branchId;
      options.elements.applyLayoutPreset(layoutPreset);
      persist();
    } else if (detail.branchId === "reset-layout") {
      restoring = true;
      try {
        for (const layout of layouts) layout.controller.reset();
        layoutPreset = "build";
        options.elements.applyLayoutPreset(layoutPreset);
      } finally {
        restoring = false;
      }
      for (const layout of layouts) layoutSnapshots.set(layout.id, layout.controller.getSnapshot());
      persist();
    } else if (detail.branchId === "save-layout") {
      for (const layout of layouts) layoutSnapshots.set(layout.id, layout.controller.getSnapshot());
      persist();
      options.onStatus("当前面板布局已写入 flow-view.json。", "ready");
    }
    globalThis.setTimeout(() => persist(), 0);
  };
  options.elements.shell.addEventListener("workbench-action", onWorkbenchAction);
  const onCanvasDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes("application/x-c-block-preset")) return;
    event.preventDefault();
    const preset = activePresetDragId === null ? null : options.resolvePreset(activePresetDragId);
    const slot =
      preset?.blockKind === "virtual" ? null : slotAtClientPoint(event.clientX, event.clientY);
    const compatible =
      slot !== null && compatibleSlotIds(activePresetDragId).has(slot.id) ? slot : null;
    const edge =
      preset?.blockKind === "virtual" || compatible !== null
        ? null
        : canvas.findInsertableControlEdgeAtClientPoint(event.clientX, event.clientY);
    event.dataTransfer.dropEffect =
      preset?.blockKind === "virtual" || compatible !== null || edge !== null ? "copy" : "none";
    canvas.setSlotDropPreview(compatible?.id ?? null);
    canvas.setEdgeInsertionPreview(edge?.id ?? null);
  };
  const onCanvasDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget;
    if (related !== null && options.elements.flowCanvas.contains(related as Node)) return;
    canvas.setSlotDropPreview(null);
    canvas.setEdgeInsertionPreview(null);
  };
  const onCanvasDrop = (event: DragEvent): void => {
    const presetId = event.dataTransfer?.getData("application/x-c-block-preset") ?? "";
    if (presetId.length === 0) return;
    event.preventDefault();
    activePresetDropHandled = true;
    const droppedSlot = slotAtClientPoint(event.clientX, event.clientY);
    const insertionEdge =
      droppedSlot === null
        ? canvas.findInsertableControlEdgeAtClientPoint(event.clientX, event.clientY)
        : null;
    canvas.setSlotDropPreview(null);
    canvas.setEdgeInsertionPreview(null);
    canvas.setPresetDragActive(false);
    const preset = options.resolvePreset(presetId);
    if (
      droppedSlot !== null &&
      preset !== null &&
      preset.source !== null &&
      preset.blockKind !== "virtual" &&
      compatibleSlotIds(presetId).has(droppedSlot.id)
    ) {
      const analysis = options.getStatementAnalysis?.() ?? null;
      const request =
        analysis === null ? null : canvasSlotInsertRequest(analysis, droppedSlot, preset.source);
      const handled = request === null ? undefined : options.onCanvasSlotInsertRequest?.(request);
      if (request !== null && handled !== false) return;
    }
    if (preset === null) {
      options.onStatus("拖入的预设已经失效；未创建草稿。", "error");
      return;
    }
    if (preset.id === "builtin.flow.start" || preset.id === "builtin.flow.end") {
      const kind = preset.id.endsWith(".start") ? "start" : "end";
      const matches = projection?.nodes.filter((node) => node.kind === kind) ?? [];
      if (matches.length !== 1) {
        options.onStatus(
          matches.length === 0
            ? `当前源码没有可绑定的 ${preset.label} CFG 边界。`
            : `当前源码有多个函数；请直接选择目标函数的 ${preset.label} 节点。`,
          "warning",
        );
        return;
      }
      canvas.focusNode(matches[0]!.id);
      options.onStatus(`${preset.label} 已绑定真实函数 CFG 边界，不创建伪 C 节点。`, "ready");
      return;
    }
    const rect = canvas.element.getBoundingClientRect();
    const view = canvas.getViewState();
    const position = Object.freeze({
      x: (event.clientX - rect.left - view.viewport.x) / view.viewport.zoom,
      y: (event.clientY - rect.top - view.viewport.y) / view.viewport.zoom,
    });
    if (insertionEdge !== null && preset.source !== null && preset.blockKind !== "virtual") {
      try {
        const accepted =
          options.onCanvasEdgeInsertRequest?.(
            createCanvasEdgeInsertRequest(
              projection?.sourceFingerprint ?? "",
              insertionEdge,
              position,
              "custom",
              preset.source,
            ),
          ) === true;
        options.onStatus(
          accepted
            ? `已为“${preset.label}”打开源码差异确认；确认前 main.c 不会改变。`
            : "当前连线不能精确映射到安全的 C 语句插槽；main.c 未修改。",
          accepted ? "ready" : "warning",
        );
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`连线插入被拒绝：${detail}。main.c 未修改。`, "error");
      }
      return;
    }
    if (preset.source !== null && preset.blockKind !== "virtual") {
      options.onStatus(
        canvas.getInsertableControlEdgeCount() === 0
          ? "当前源码没有可精确映射的插入连线；请选择节点后使用上方或下方插入。"
          : "请把积木放到已高亮的连线上；空白画布只用于布局，不会创建源码草稿。",
        "warning",
      );
      return;
    }
    const next = draftNode(
      `preset-${String(Date.now())}-${String(currentDraftState.nodes.length)}`,
      preset.label,
      preset.source,
      position,
      preset,
    );
    checkpoint(false, "放置积木");
    currentDraftState = Object.freeze({
      nodes: Object.freeze([...currentDraftState.nodes, next]),
      selectedNodeIds: Object.freeze([next.id]),
      connection: null,
      virtualEdges: Object.freeze([...(currentDraftState.virtualEdges ?? [])]),
    });
    presentDraftState();
    persist();
    options.onStatus(`已放置虚拟节点“${preset.label}”；它只控制回放，不改变 C 语义。`, "ready");
  };
  options.elements.flowCanvas.addEventListener("dragover", onCanvasDragOver);
  options.elements.flowCanvas.addEventListener("dragleave", onCanvasDragLeave);
  options.elements.flowCanvas.addEventListener("drop", onCanvasDrop);
  const onPresetDragStart = (event: DragEvent): void => {
    const presetId = event.dataTransfer?.getData("application/x-c-block-preset") ?? "";
    if (presetId.length === 0) return;
    activePresetDragId = presetId;
    activePresetDropHandled = false;
    canvas.setPresetDragActive(true);
    canvas.setSlotCompatibility(compatibleSlotIds(presetId));
    const preset = options.resolvePreset(presetId);
    if (preset?.blockKind === "virtual") {
      presentLocalizedStatus(
        "虚拟节点可放在画布空白处；它只控制回放，不修改 C。",
        "Virtual nodes may be placed on blank canvas; they control playback without changing C.",
        "ready",
      );
      return;
    }
    const count = canvas.getInsertableControlEdgeCount();
    const locale = options.elements.shell.dataset.locale === "en" ? "en" : "zh-CN";
    const exactReason =
      count === 0
        ? projection?.edges
            .filter(
              (edge) => edge.kind === "entry" || edge.kind === "next" || edge.kind === "return",
            )
            .map((edge) => options.inspectCanvasEdge?.(edge, locale))
            .find((result) => result?.available === false && result.reason !== null)?.reason
        : null;
    presentLocalizedStatus(
      count === 0
        ? (exactReason ?? "当前源码没有安全插入连线；请选择节点，用操作条在上方或下方插入。")
        : `已高亮 ${String(count)} 个安全插入位置；请把积木放到其中一条连线上。`,
      count === 0
        ? (exactReason ??
            "This source has no safe insertion wire. Select a node and insert above or below.")
        : `${String(count)} safe insertion positions are highlighted. Drop the block on one of them.`,
      count === 0 ? "warning" : "ready",
    );
  };
  const onPresetDragEnd = (): void => {
    if (activePresetDragId === null) return;
    const preset = options.resolvePreset(activePresetDragId);
    if (!activePresetDropHandled && preset?.source !== null && preset?.blockKind !== "virtual") {
      presentLocalizedStatus(
        "积木没有落到安全插入位置；main.c 未修改。",
        "The block was not dropped on a safe insertion position; main.c is unchanged.",
        "warning",
      );
    }
    activePresetDragId = null;
    activePresetDropHandled = false;
    canvas.setPresetDragActive(false);
    renderCanvasInteractionContext();
  };
  options.elements.shell.addEventListener("dragstart", onPresetDragStart);
  options.elements.shell.addEventListener("dragend", onPresetDragEnd);

  function emitLearningObservations(candidate: FlowLearningDraftCommitCandidate): void {
    const observer = options.onLearningObservation;
    if (observer === undefined) return;
    for (const observation of flowLearningObservationsForDraftCommit(candidate)) {
      try {
        observer(observation);
      } catch {
        // Tutorial evidence is observational and must never turn a verified source commit into an
        // apparent failure. The lesson coordinator can recover from the next source projection.
      }
    }
  }

  return Object.freeze({
    get projection(): FlowProjection | null {
      return projection;
    },
    get activeEntryId(): string | null {
      return activeEntryId;
    },
    get hasPendingChanges(): boolean {
      return persistence.hasPendingChanges;
    },
    adoptProjection(nextProjection: FlowProjection): void {
      assertActive(destroyed);
      const sameSource = projection?.sourceFingerprint === nextProjection.sourceFingerprint;
      if (!sameSource) pendingSidecarRestore = null;
      projection = nextProjection;
      currentDraftState = reconcileVirtualFlowOverlay(nextProjection, currentDraftState);
      activeVirtualNodeIds = new Set();
      if (!sameSource && undoHistory.at(-1)?.sourceMutation !== true) {
        undoHistory.length = 0;
        redoHistory.length = 0;
      }
      if (analysis?.sourceFingerprint !== nextProjection.sourceFingerprint) analysis = null;
      if (runtimeEvidence?.sourceFingerprint !== nextProjection.sourceFingerprint) {
        runtimeEvidence = null;
      }
      if (sameSource && currentViewState !== null) {
        restoring = true;
        try {
          if (projectionPreview === null) {
            canvas.setProjection(nextProjection);
            currentViewState = canvas.getViewState();
            presentDraftState();
          }
          retryPendingSidecarRestore(false);
        } finally {
          restoring = false;
        }
      } else {
        adoptDefaultView(nextProjection);
      }
      refreshSlots();
      renderDataFlowAvailability(projectionPreview?.projection ?? nextProjection);
      persist();
    },
    setAnalysis(nextAnalysis: ProgramAnalysisSnapshot | null): void {
      assertActive(destroyed);
      analysis =
        nextAnalysis !== null && nextAnalysis.sourceFingerprint === projection?.sourceFingerprint
          ? nextAnalysis
          : null;
      refreshSlots();
      if (projectionPreview === null) canvas.refreshDetail();
    },
    previewProjection(
      nextProjection: FlowProjection,
      nextAnalysis: ProgramAnalysisSnapshot | null = null,
    ): void {
      assertActive(destroyed);
      const preview = readOnlyPreviewProjection(nextProjection);
      const previewAnalysis =
        nextAnalysis !== null && nextAnalysis.sourceFingerprint === preview.sourceFingerprint
          ? nextAnalysis
          : null;
      const viewState = createDefaultFlowViewState(preview);
      projectionPreview = { projection: preview, analysis: previewAnalysis, viewState };
      renderCanvasInteractionContext();
      restoring = true;
      try {
        canvas.setProjection(preview);
        canvas.setViewState(viewState);
        canvas.setDraftVisualState(null);
        canvas.setSlots([]);
        canvas.setResponsiveFit(true);
        projectionPreview.viewState = canvas.getViewState();
        canvas.refreshDetail();
        renderDataFlowAvailability(preview);
      } finally {
        restoring = false;
      }
    },
    clearProjectionPreview(): void {
      assertActive(destroyed);
      if (projectionPreview === null) return;
      const authoritativeViewState = currentViewState;
      restoring = true;
      try {
        canvas.setResponsiveFit(false);
        // Keep preview mode active while the canvas swaps projections. setProjection() emits a
        // view-state callback synchronously; clearing the preview first would let that transient
        // preview state overwrite the authoritative main.c view and later poison flow-view.json.
        if (projection === null || authoritativeViewState === null) {
          canvas.setProjection(null);
          canvas.setDraftVisualState(null);
          canvas.setSlots([]);
        } else {
          canvas.setProjection(projection);
          canvas.setViewState(authoritativeViewState);
          presentDraftState();
          canvas.setSlots(slotRects);
        }
        currentViewState = authoritativeViewState;
        projectionPreview = null;
        renderCanvasInteractionContext();
        canvas.refreshDetail();
        renderDataFlowAvailability(projection);
      } finally {
        restoring = false;
      }
    },
    setActivePath(path: FlowCanvasActivePath, nextEvidence?: FlowNodeRuntimeSnapshot | null): void {
      assertActive(destroyed);
      if (nextEvidence !== undefined) {
        runtimeEvidence =
          nextEvidence !== null && nextEvidence.sourceFingerprint === projection?.sourceFingerprint
            ? nextEvidence
            : null;
      }
      const virtualNodes = activeVirtualPlaybackNodes(currentDraftState, path.edgeIds);
      const nextActive = new Set(virtualNodes.map((node) => node.id));
      for (const node of virtualNodes) {
        if (activeVirtualNodeIds.has(node.id)) continue;
        options.onVirtualPlaybackNode?.(node, path.mode);
        if (node.presetId === "builtin.flow.pause") {
          options.onStatus("回放已在虚拟 Pause 节点暂停；真实进程语义未改变。", "warning");
        } else if (node.presetId === "builtin.flow.checkpoint") {
          options.onStatus("Checkpoint 已记录当前回放位置与已收集运行证据。", "ready");
        }
      }
      activeVirtualNodeIds = nextActive;
      canvas.setActivePath(decoratePathWithVirtualOverlay(currentDraftState, path));
      canvas.refreshDetail();
    },
    focusNode(nodeId: string): void {
      assertActive(destroyed);
      canvas.focusNode(nodeId);
    },
    async setWorkspaceEntry(entryId: string | null): Promise<void> {
      assertActive(destroyed);
      const generation = ++adoptionGeneration;
      pendingSidecarRestore = null;
      if (entryId === null) {
        sidecarLoading = false;
        activeEntryId = null;
        activeVirtualNodeIds = new Set();
        undoHistory.length = 0;
        redoHistory.length = 0;
        await persistence.deactivate();
        return;
      }
      sidecarLoading = true;
      activeEntryId = entryId;
      const current = projection;
      if (current === null) {
        sidecarLoading = false;
        return;
      }
      try {
        const adoption = await persistence.adopt(entryId, current.sourceFingerprint);
        if (destroyed || generation !== adoptionGeneration || activeEntryId !== entryId) return;
        const shouldPersistFirstView = applyFlowWorkspaceAdoptionPresentation(adoption, {
          restoreSidecar,
          // Layout controllers live for the lifetime of the window. A new workspace has no
          // sidecar to overwrite their current sizes, so reset before its first persistence;
          // otherwise the project silently inherits the entry we just left.
          resetPresentation: resetWorkspacePresentation,
          fitFirstProjection: canvas.fitReadableNodes,
        });
        sidecarLoading = false;
        if (shouldPersistFirstView) persist();
      } catch (error: unknown) {
        if (destroyed || generation !== adoptionGeneration) return;
        sidecarLoading = false;
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`布局读取失败：${detail}。main.c 未修改。`, "error");
      }
    },
    finalizePendingSidecarRestore(): void {
      assertActive(destroyed);
      if (pendingSidecarRestore === null) return;
      restoring = true;
      try {
        retryPendingSidecarRestore(true);
      } finally {
        restoring = false;
      }
      persist();
    },
    flush: () => persistence.flush(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      adoptionGeneration += 1;
      options.elements.shell.removeEventListener("workbench-action", onWorkbenchAction);
      options.elements.shell.removeEventListener(
        WORKBENCH_REVEAL_FLOW_DETAIL_EVENT,
        onRevealFlowDetail,
      );
      options.elements.shell.removeEventListener(
        WORKBENCH_QUICK_OPEN_COLLECT_EVENT,
        onQuickOpenCollect,
      );
      options.elements.shell.removeEventListener(
        WORKBENCH_QUICK_OPEN_ACTIVATE_EVENT,
        onQuickOpenActivate,
      );
      options.elements.flowCanvas.removeEventListener("dragover", onCanvasDragOver);
      options.elements.flowCanvas.removeEventListener("dragleave", onCanvasDragLeave);
      options.elements.flowCanvas.removeEventListener("drop", onCanvasDrop);
      options.elements.shell.removeEventListener("dragstart", onPresetDragStart);
      options.elements.shell.removeEventListener("dragend", onPresetDragEnd);
      options.elements.shell.removeEventListener("workbench-locale-change", onCanvasLocaleChange);
      canvasToolbarActions.removeEventListener("click", onCanvasToolbarClick);
      persistence.destroy();
      canvas.destroy();
      for (const layout of [...layouts].reverse()) layout.controller.destroy();
      layoutSnapshots.clear();
      projection = null;
      projectionPreview = null;
      renderDataFlowAvailability(null);
      currentViewState = null;
      currentDraftState = emptyDraftState();
      activeEntryId = null;
      pendingSidecarRestore = null;
      sidecarLoading = false;
      activeVirtualNodeIds = new Set();
      analysis = null;
      runtimeEvidence = null;
      activePresetDragId = null;
      activePresetDropHandled = false;
      undoHistory.length = 0;
      redoHistory.length = 0;
    },
  });
}

/**
 * Converts one already-validated, source-backed preset connection into lesson evidence. The
 * conservative checks here deliberately duplicate the important projection boundary so a stale,
 * raw or partial canvas action cannot be counted even if a caller accidentally reports success.
 */
export function flowLearningObservationsForDraftCommit(
  candidate: FlowLearningDraftCommitCandidate,
): readonly FlowLearningObservation[] {
  const { beforeProjection, intent } = candidate;
  const presetId = intent.presetId;
  if (
    !candidate.committed ||
    !candidate.roundtripAccepted ||
    !candidate.cfgAccepted ||
    candidate.workspaceId === null ||
    candidate.workspaceId.length === 0 ||
    beforeProjection === null ||
    presetId === null ||
    presetId.length === 0 ||
    presetId.trim() !== presetId ||
    intent.sourceText === null ||
    intent.sourceText.trim().length === 0 ||
    intent.sourceFingerprint !== beforeProjection.sourceFingerprint ||
    candidate.resultingSourceFingerprint.length === 0 ||
    candidate.resultingSourceFingerprint === beforeProjection.sourceFingerprint ||
    beforeProjection.documentHasError ||
    beforeProjection.functions.some((fn) => fn.partial) ||
    beforeProjection.nodes.some((node) => node.kind === "raw")
  ) {
    return Object.freeze([]);
  }

  const target = beforeProjection.nodes.find((node) => node.id === intent.toNodeId);
  const targetFunction = beforeProjection.functions.find((fn) => fn.id === target?.functionId);
  const targetPort = target?.ports.find((port) => port.id === intent.toPortId);
  if (
    target === undefined ||
    target.locked ||
    target.kind === "raw" ||
    targetFunction === undefined ||
    targetFunction.partial ||
    targetPort === undefined ||
    !targetPort.editable ||
    targetPort.direction !== "input" ||
    targetPort.channel !== "control"
  ) {
    return Object.freeze([]);
  }

  const base = Object.freeze({
    workspaceId: candidate.workspaceId,
    presetId,
    sourceFingerprint: candidate.resultingSourceFingerprint,
    roundtripAccepted: true as const,
    cfgAccepted: true as const,
  });
  return Object.freeze([
    Object.freeze({ ...base, type: "preset-inserted" as const, committed: true as const }),
    Object.freeze({ ...base, type: "connection-committed" as const }),
  ]);
}

function renderWorkbenchNodeDetail(
  context: FlowCanvasDetailContext,
  replaceSource: (node: FlowNode, source: string) => void,
  onStatus: (message: string, state: "ready" | "warning" | "error") => void,
  evidenceSnapshot: FlowNodeEvidence,
  english = false,
): void {
  const { node, body } = context;
  const ownerDocument = body.ownerDocument;
  const explanation = ownerDocument.createElement("section");
  explanation.className = "flow-detail__explanation";
  const heading = ownerDocument.createElement("h3");
  heading.textContent = english ? "Plain-language explanation" : "通俗解释";
  const copy = ownerDocument.createElement("p");
  copy.textContent = explainNode(node, english);
  explanation.append(heading, copy);

  const editor = ownerDocument.createElement("section");
  editor.className = "flow-detail__editor";
  const editorHeading = ownerDocument.createElement("h3");
  editorHeading.textContent = english ? "Exact source editing" : "精确源码编辑";
  const textarea = ownerDocument.createElement("textarea");
  textarea.value = node.sourceText;
  textarea.spellcheck = false;
  installCodeTextareaIndentation(textarea);
  textarea.disabled = node.locked || node.kind === "start" || node.kind === "end";
  textarea.setAttribute("aria-label", `${node.label}${english ? " C source" : " 的 C 源码"}`);
  const save = ownerDocument.createElement("button");
  save.type = "button";
  save.className = "button button--primary";
  save.textContent = english ? "Validate and write to main.c" : "验证并写入 main.c";
  save.disabled = textarea.disabled;
  save.addEventListener("click", () => {
    try {
      replaceSource(node, textarea.value);
      onStatus(
        english
          ? "The node source passed reparse and lossless round-trip validation."
          : "节点源码已通过重解析与无损往返验证。",
        "ready",
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      onStatus(
        english
          ? `The node edit was rejected${/[\u3400-\u9fff]/u.test(detail) ? "." : `: ${detail}`}`
          : `节点修改被拒绝：${detail}`,
        "error",
      );
    }
  });
  editor.append(editorHeading, textarea, save);

  const evidence = ownerDocument.createElement("section");
  evidence.className = "flow-detail__evidence";
  const evidenceHeading = ownerDocument.createElement("h3");
  evidenceHeading.textContent = english
    ? "Diagnostics / runtime evidence / lifecycle"
    : "诊断 / 运行证据 / 生命周期";
  const evidenceCopy = ownerDocument.createElement("p");
  const diagnostics =
    evidenceSnapshot.diagnostics.length === 0
      ? english
        ? "Static diagnostics: no finding is precisely bound to this node"
        : "静态诊断：当前没有与此节点精确绑定的 finding"
      : `${english ? "Static diagnostics: " : "静态诊断："}${evidenceSnapshot.diagnostics
          .map(
            (finding) =>
              `${finding.ruleId}${english ? " (" : "（"}${finding.confidence}${finding.subject === null ? "" : ` · ${finding.subject}`}${english ? ")" : "）"}`,
          )
          .join(english ? "; " : "；")}`;
  const runtime =
    evidenceSnapshot.runtime === null
      ? english
        ? "Runtime evidence: no same-source path yet"
        : "运行证据：尚无同源码轨迹"
      : english
        ? `Runtime evidence: ${evidenceSnapshot.runtime.mode === "real" ? "real" : "teaching-simulation"} path visited ${String(evidenceSnapshot.runtime.visitCount)} times${evidenceSnapshot.runtime.current ? " · current node" : ""}`
        : `运行证据：${evidenceSnapshot.runtime.mode === "real" ? "真实" : "教学模拟"}路径访问 ${String(evidenceSnapshot.runtime.visitCount)} 次${evidenceSnapshot.runtime.current ? " · 当前节点" : ""}`;
  const lock = node.locked
    ? english
      ? `Locked: ${node.lockReasons.map(englishLockReason).join("; ")}. Existing source can still compile and run.`
      : `锁定：${node.lockReasons.map((reason) => reason.message).join("；")}。现有源码仍可编译运行。`
    : english
      ? "Lifecycle: this node is an exact projection of main.c."
      : "生命周期：当前节点来自 main.c 的精确投影。";
  evidenceCopy.textContent = `${diagnostics}${english ? ". " : "。"}${runtime}${english ? ". " : "。"}${lock}`;
  evidence.append(evidenceHeading, evidenceCopy);
  body.append(explanation, editor, evidence);
}

function explainNode(node: FlowNode, english = false): string {
  const explanations: Readonly<Record<FlowNode["kind"], string>> = english
    ? Object.freeze({
        module:
          "An include, macro, typedef, or global declaration outside a function. It belongs to the Translation Unit and preserves exact source without participating in function-level control rewiring.",
        start:
          "The function's control-flow entry. It supports location and replay without generating an extra C statement.",
        end: "The function's control-flow exit. Return statements and natural completion converge here.",
        statement: "One C statement executed in sequence, usually with a single control output.",
        declaration:
          "Creates or declares a variable and establishes the name and type used by later statements.",
        branch:
          "Selects a path from the real condition; the canvas cannot choose a branch arbitrarily.",
        loop: "Repeats the loop body and exits when its condition is false.",
        switch:
          "Selects a case/default path from an expression and may legally connect to several branches.",
        assert: "Checks a runtime condition and terminates the current execution if it fails.",
        control: "Changes normal function order, such as return, break, continue, or goto.",
        raw: "A raw C region that the parser cannot safely structure. Source is preserved, while unsafe rewiring remains disabled.",
      })
    : Object.freeze({
        module:
          "函数外的 include、宏、typedef 或全局声明；它属于 Translation Unit，保留精确源码但不参与函数控制改线。",
        start: "函数的控制流入口；它用于定位与回放，不会额外生成 C 语句。",
        end: "函数的控制流出口；return 与自然结束最终汇合到这里。",
        statement: "按顺序执行的一条 C 语句，通常只有一个控制输出。",
        declaration: "创建或声明变量，并确定后续语句可引用的名字与类型。",
        branch: "根据真实条件选择一条分支；分支不是由画布随意指定的。",
        loop: "重复执行循环体，并在条件不成立时离开循环。",
        switch: "按表达式值选择 case/default 路径，可合法连接多个分支。",
        assert: "检查运行时条件；失败会终止当前执行。",
        control: "改变当前函数的正常顺序，例如 return、break、continue 或 goto。",
        raw: "解析器无法安全结构化的原始 C 区域；保留源码但禁止危险改线。",
      });
  return explanations[node.kind];
}

function englishLockReason(reason: FlowNode["lockReasons"][number]): string {
  if (reason.code === "partial-cfg") {
    return `incomplete CFG${reason.partialCode === null ? "" : `: ${reason.partialCode}`}`;
  }
  if (reason.code === "raw-block") {
    return `raw source cannot be safely rewired${reason.rawReason === null ? "" : `: ${reason.rawReason}`}`;
  }
  return "source outside a function belongs to the Translation Unit and cannot be control-rewired";
}

function createWorkbenchLayouts(
  elements: WorkbenchElements,
  onPersist: (snapshot: { readonly id: string; readonly value: ResizableLayoutSnapshot }) => void,
): readonly { readonly id: string; readonly controller: ResizableLayoutController }[] {
  const owner = elements.shell;
  const presetsPane = required(owner, "#presets-pane");
  const outlinePane = required(owner, "#outline-pane");
  const codePanel = required(owner, "#code-panel");
  const inspector = required(owner, "#inspector-stack");
  const runPanel = required(owner, "#run-panel");
  const scenarioPanel = required(owner, "#scenario-workbench-host");
  const tracePanel = required(owner, "#trace-workbench-host");
  const executionPanel = required(owner, ".runtime-advanced");
  return Object.freeze([
    layout(
      "main",
      elements.buildLayout,
      "horizontal",
      [
        pane("left", elements.leftPane, 240, 150, 420),
        pane("work", elements.workArea, 980, 640, 2400),
      ],
      undefined,
      [elements.narrowPanelScrim],
    ),
    layout(
      "work",
      elements.workArea,
      "vertical",
      [
        pane("primary", elements.primaryWorkspace, 510, 320, 1400),
        pane("bottom", elements.bottomPane, 250, 170, 620),
      ],
      "primary",
    ),
    layout("primary", elements.primaryWorkspace, "horizontal", [
      pane("center", elements.centerPane, 700, 420, 1800),
      pane("right", elements.rightPane, 340, 260, 760),
    ]),
    layout("left", elements.leftPane, "vertical", [
      pane("presets", presetsPane, 360, 120, 700),
      pane("outline", outlinePane, 220, 100, 620),
    ]),
    layout("right", elements.rightPane, "vertical", [
      pane("code", codePanel, 340, 160, 900),
      pane("inspector", inspector, 190, 120, 620),
    ]),
    layout("runtime", runPanel, "horizontal", [
      pane("scenario", scenarioPanel, 320, 240, 620),
      pane("trace", tracePanel, 520, 320, 1100),
      pane("execution", executionPanel, 300, 240, 680),
    ]),
  ]);

  function layout(
    id: string,
    host: HTMLElement,
    axis: "horizontal" | "vertical",
    panes: readonly ReturnType<typeof pane>[],
    overflowFillPaneId?: string,
    overlays?: readonly HTMLElement[],
  ) {
    const controller = createResizableLayout(host, {
      axis,
      panes,
      overflowFillPaneId,
      overlays,
      localeHost: elements.shell,
      onPersist(value) {
        onPersist(Object.freeze({ id, value }));
      },
    });
    return Object.freeze({ id, controller });
  }
}

function pane(
  id: string,
  element: HTMLElement,
  initialSize: number,
  minSize: number,
  maxSize: number,
) {
  return Object.freeze({ id, element, initialSize, minSize, maxSize, label: id });
}

function restoreLayouts(
  snapshots: Readonly<Record<string, ResizableLayoutSnapshot>>,
  layouts: readonly { readonly id: string; readonly controller: ResizableLayoutController }[],
  target: Map<string, ResizableLayoutSnapshot>,
): void {
  for (const layout of layouts) {
    const snapshot = snapshots[layout.id];
    if (snapshot === undefined) continue;
    layout.controller.restore(snapshot.sizes);
    target.set(layout.id, layout.controller.getSnapshot());
  }
}

function resetLayouts(
  layoutIds: readonly string[],
  layouts: readonly { readonly id: string; readonly controller: ResizableLayoutController }[],
  target: Map<string, ResizableLayoutSnapshot>,
): void {
  const requested = new Set(layoutIds);
  for (const layout of layouts) {
    if (!requested.has(layout.id)) continue;
    layout.controller.reset();
    target.set(layout.id, layout.controller.getSnapshot());
  }
}

export function readFlowWorkbenchSidecar(value: unknown): FlowWorkbenchSidecar | null {
  if (!isRecord(value)) return null;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION) ||
    typeof value.sourceFingerprint !== "string" ||
    (value.layoutProfile !== undefined && typeof value.layoutProfile !== "string") ||
    typeof value.layoutPreset !== "string" ||
    !VALID_LAYOUT_PRESETS.has(value.layoutPreset) ||
    !isRecord(value.layouts) ||
    (value.panelVisibility !== undefined && !isBooleanRecord(value.panelVisibility))
  ) {
    return null;
  }
  const layouts: Record<string, ResizableLayoutSnapshot> = {};
  for (const [id, snapshot] of Object.entries(value.layouts)) {
    if (!isResizableSnapshot(snapshot)) return null;
    layouts[id] = snapshot;
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    ...(value.layoutProfile === undefined ? {} : { layoutProfile: value.layoutProfile }),
    sourceFingerprint: value.sourceFingerprint,
    viewState: value.viewState,
    layoutPreset: value.layoutPreset,
    layouts: Object.freeze(layouts),
    panelVisibility: Object.freeze(
      value.panelVisibility === undefined ? {} : (value.panelVisibility as Record<string, boolean>),
    ),
    drafts: value.drafts === undefined ? emptyDraftState() : value.drafts,
  });
}

function emptyDraftState(): FlowCanvasDraftVisualState {
  return Object.freeze({
    nodes: Object.freeze([]),
    selectedNodeIds: Object.freeze([]),
    connection: null,
    virtualEdges: Object.freeze([]),
  });
}

function draftNode(
  id: string,
  label: string,
  source: string | null,
  position: { readonly x: number; readonly y: number },
  preset: ResolvedFlowPreset | null,
): FlowCanvasDraftNode {
  const isVirtual = preset?.blockKind === "virtual";
  return Object.freeze({
    id,
    label,
    position: Object.freeze({ ...position }),
    status: "detached" as const,
    presetId: preset?.id ?? null,
    presetVersion: preset?.version ?? null,
    blockKind: preset?.blockKind ?? "statement",
    placedAt: new Date().toISOString(),
    ...(source === null ? {} : { sourceText: source }),
    ports: Object.freeze(
      isVirtual
        ? (preset?.ports ?? []).map((port) =>
            Object.freeze({
              id: `${id}:${port.id}`,
              direction: port.direction,
              channel: port.channel,
              edgeKind:
                port.channel === "control" && port.direction === "output"
                  ? ("next" as const)
                  : null,
              label: port.label,
              editable: port.channel === "control",
            }),
          )
        : [
            Object.freeze({
              id: `${id}:next`,
              direction: "output" as const,
              channel: "control" as const,
              edgeKind: "next" as const,
              label: "接入",
              editable: true,
            }),
          ],
    ),
  });
}

function isResizableSnapshot(value: unknown): value is ResizableLayoutSnapshot {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.axis === "horizontal" || value.axis === "vertical") &&
    isRecord(value.sizes) &&
    Object.values(value.sizes).every((size) => typeof size === "number" && Number.isFinite(size))
  );
}

function quickOpenNodeMatches(node: FlowNode, query: string, functionName: string): boolean {
  const tokens = query
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hans-CN")
    .split(/[^\p{Letter}\p{Number}_#<>.-]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const searchable = [
    node.id,
    node.kind,
    node.nodeType ?? "",
    node.label,
    node.sourceText,
    functionName,
  ]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hans-CN");
  return tokens.every((token) => searchable.includes(token));
}

function compactQuickOpenNodeSource(source: string, fallback: string): string {
  const compact = source.replaceAll(/\s+/gu, " ").trim();
  if (compact.length === 0) return fallback;
  return compact.length <= 52 ? compact : `${compact.slice(0, 49)}…`;
}

function readOnlyPreviewProjection(projection: FlowProjection): FlowProjection {
  return Object.freeze({
    ...projection,
    nodes: Object.freeze(
      projection.nodes.map((node) =>
        Object.freeze({
          ...node,
          locked: true,
          ports: Object.freeze(
            node.ports.map((port) => Object.freeze({ ...port, editable: false })),
          ),
        }),
      ),
    ),
    edges: Object.freeze(
      projection.edges.map((edge) => Object.freeze({ ...edge, editable: false })),
    ),
  });
}

function functionList(names: readonly string[]): string {
  const visible = names.slice(0, 3).join(", ");
  return names.length <= 3 ? visible : `${visible} +${String(names.length - 3)}`;
}

function defUseReasonLabel(reason: DefUseDisabledReasonCode, english: boolean): string {
  const labels: Readonly<Record<DefUseDisabledReasonCode, Readonly<{ zh: string; en: string }>>> = {
    "cfg-partial": { zh: "控制流图不完整", en: "partial control-flow graph" },
    "invalid-function-cst": { zh: "函数语法树无效", en: "invalid function syntax tree" },
    "parse-error": { zh: "源码存在解析错误", en: "source parse error" },
    preprocessor: { zh: "预处理边界影响分析", en: "preprocessor boundary" },
    "projection-issue": { zh: "源码投影不完整", en: "incomplete source projection" },
    "parse-concern": { zh: "解析结果存在歧义", en: "ambiguous parse result" },
    "raw-block": { zh: "包含无法结构化的源码", en: "unstructured source region" },
    "missing-function-projection": {
      zh: "函数投影尚未建立",
      en: "function projection unavailable",
    },
    "unsequenced-conflict": {
      zh: "表达式求值顺序存在冲突",
      en: "unsequenced expression conflict",
    },
    "unsupported-effect-order": {
      zh: "当前分析器无法可靠确定副作用顺序",
      en: "effect order cannot yet be proven reliably",
    },
    "effect-cst-mismatch": {
      zh: "副作用与语法树无法可靠对应",
      en: "effect and syntax-tree mismatch",
    },
    "opaque-alias-effect": {
      zh: "指针别名副作用不透明",
      en: "opaque pointer-alias effect",
    },
  };
  const label = labels[reason];
  return english ? `${label.en} (${reason})` : `${label.zh}（${reason}）`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "boolean");
}

function required(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`自由工作台缺少 ${selector}`);
  return element;
}

function assertOptions(options: FlowWorkbenchControllerOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.api?.readWorkspaceSidecar !== "function" ||
    typeof options.api.saveWorkspaceSidecar !== "function" ||
    typeof options.onNodeSelect !== "function" ||
    typeof options.onReplaceNodeSource !== "function" ||
    typeof options.onDeleteNodes !== "function" ||
    typeof options.onConnectionPreflight !== "function" ||
    typeof options.onConnectionIntent !== "function" ||
    typeof options.resolvePreset !== "function" ||
    typeof options.onDraftConnectionIntent !== "function" ||
    typeof options.onDraftPresentationChange !== "function" ||
    (options.onLearningObservation !== undefined &&
      typeof options.onLearningObservation !== "function") ||
    typeof options.onSourceUndo !== "function" ||
    typeof options.onStatus !== "function"
  ) {
    throw new TypeError("Flow workbench controller options 无效");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("Flow workbench controller 已销毁");
}
