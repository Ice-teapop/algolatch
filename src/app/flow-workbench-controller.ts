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
} from "../learning/index.js";
import {
  createFlowCanvas,
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
  type WorkspaceSidecarPersistence,
} from "./workspace-sidecar-persistence.js";
import {
  activeVirtualPlaybackNodes,
  connectVirtualFlowOverlay,
  decoratePathWithVirtualOverlay,
  reconcileVirtualFlowOverlay,
} from "./virtual-flow-overlay.js";
import type { ProgramAnalysisSnapshot } from "../analysis/index.js";
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

export interface FlowWorkbenchControllerOptions {
  readonly elements: WorkbenchElements;
  readonly api: Pick<PanelApi, "readWorkspaceSidecar" | "saveWorkspaceSidecar">;
  readonly onNodeSelect: (node: FlowNode) => void;
  readonly onReplaceNodeSource: (node: FlowNode, source: string) => void;
  readonly onDeleteNodes: (nodes: readonly FlowNode[]) => void;
  readonly onConnectionPreflight: (intent: ConnectionIntent) => { readonly accepted: boolean };
  readonly onConnectionIntent: (intent: ConnectionIntent) => boolean;
  readonly resolvePreset: (presetId: string) => ResolvedFlowPreset | null;
  readonly onDraftConnectionIntent: (intent: FlowCanvasDraftConnectionIntent) => boolean;
  readonly onDraftPresentationChange: (nodes: readonly FlowCanvasDraftNode[]) => void;
  readonly onLearningObservation?: ((observation: FlowLearningObservation) => void) | undefined;
  readonly onSourceUndo: () => void;
  readonly onVirtualPlaybackNode?:
    ((node: FlowCanvasDraftNode, mode: FlowCanvasActivePath["mode"]) => void) | undefined;
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
}

export interface FlowWorkbenchController {
  readonly projection: FlowProjection | null;
  readonly activeEntryId: string | null;
  readonly hasPendingChanges: boolean;
  adoptProjection(projection: FlowProjection): void;
  setAnalysis(analysis: ProgramAnalysisSnapshot | null): void;
  setActivePath(path: FlowCanvasActivePath, evidence?: FlowNodeRuntimeSnapshot | null): void;
  focusNode(nodeId: string): void;
  setWorkspaceEntry(entryId: string | null): Promise<void>;
  finalizePendingSidecarRestore(): void;
  flush(): Promise<void>;
  destroy(): void;
}

export interface FlowWorkbenchSidecar {
  readonly schemaVersion: 1 | 2;
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
  let runtimeEvidence: FlowNodeRuntimeSnapshot | null = null;
  const undoHistory: Array<{
    readonly view: FlowViewState;
    readonly drafts: FlowCanvasDraftVisualState;
    readonly sourceMutation: boolean;
  }> = [];
  const canvasToolbar = required(options.elements.shell, ".canvas-toolbar__actions");
  const canvasHint = required(options.elements.shell, ".canvas-toolbar__hint");
  const alignLeftButton = required(
    canvasToolbar,
    "button[data-flow-command='align-left']",
  ) as HTMLButtonElement;
  const distributeButton = required(
    canvasToolbar,
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
                  ? "Drag node · drag a port to wire · double-click for details"
                  : "拖动积木 · 拖端口接线 · 双击打开详情"
                : english
                  ? "Drag in blocks · drag blank canvas to pan · wheel to zoom"
                  : "拖入积木 · 拖空白平移 · 滚轮缩放";
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
      options.onNodeSelect(node);
    },
    onViewStateChange(state, reason) {
      currentViewState = state;
      if (!restoring && reason !== "projection" && reason !== "restore") {
        pendingSidecarRestore = null;
        persist();
      }
    },
    onConnectionIntent(gesture) {
      handleConnectionIntent(gesture);
    },
    onConnectionPreflight(gesture) {
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
      const beforeProjection = projection;
      const historyDepth = undoHistory.length;
      checkpoint(true);
      try {
        const committed = options.onDraftConnectionIntent(intent);
        if (!committed) {
          undoHistory.splice(historyDepth);
          return;
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
      } catch (error: unknown) {
        undoHistory.splice(historyDepth);
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`草稿连接被拒绝：${detail}。main.c 未修改。`, "error");
      }
    },
    onVirtualConnectionIntent(intent) {
      handleVirtualConnectionIntent(intent);
    },
    onWireStatus(message, state) {
      options.onStatus(message, state);
    },
    onInteractionContextChange(context) {
      canvasInteractionContext = context;
      renderCanvasInteractionContext();
    },
    onHistoryCheckpoint: () => checkpoint(false),
    onUndo: undo,
    onDraftStateChange(state, reason) {
      currentDraftState = state;
      publishDraftPresentation();
      if (!restoring && reason !== "restore") {
        pendingSidecarRestore = null;
        persist();
      }
    },
    onDeleteNodes(nodeIds) {
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
      renderWorkbenchNodeDetail(
        context,
        options.onReplaceNodeSource,
        options.onStatus,
        projection === null
          ? Object.freeze({ diagnostics: Object.freeze([]), runtime: null })
          : evidenceForFlowNode(context.node, projection, analysis, runtimeEvidence),
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

  publishDraftPresentation();
  const onCanvasLocaleChange = (): void => {
    renderCanvasInteractionContext();
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
    if (command === "undo") undo();
    else if (command === "align-left") canvas.alignSelection("left");
    else if (command === "distribute-y") canvas.alignSelection("distribute-y");
  };
  canvasToolbar.addEventListener("click", onCanvasToolbarClick);
  const onRevealFlowDetail = (): void => {
    const node =
      projection?.nodes.find(
        (candidate) =>
          candidate.kind !== "start" &&
          candidate.kind !== "end" &&
          candidate.sourceText.trim().length > 0,
      ) ??
      projection?.nodes.find((candidate) => candidate.kind !== "start" && candidate.kind !== "end");
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

  function handleVirtualConnectionIntent(intent: FlowCanvasVirtualConnectionIntent): void {
    const current = projection;
    if (current === null) return;
    const historyDepth = undoHistory.length;
    checkpoint(false);
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
    } catch (error: unknown) {
      undoHistory.splice(historyDepth);
      const detail = error instanceof Error ? error.message : String(error);
      options.onStatus(`虚拟连线被拒绝：${detail}。main.c 未修改。`, "error");
    }
  }

  function checkpoint(sourceMutation: boolean): void {
    if (restoring || currentViewState === null) return;
    undoHistory.push(
      Object.freeze({
        view: currentViewState,
        drafts: currentDraftState,
        sourceMutation,
      }),
    );
    if (undoHistory.length > 50) undoHistory.splice(0, undoHistory.length - 50);
  }

  function undo(): void {
    const snapshot = undoHistory.pop();
    if (snapshot === undefined) {
      options.onSourceUndo();
      return;
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
  }

  function handleConnectionIntent(gesture: FlowCanvasConnectionGesture): void {
    const current = projection;
    if (current === null || gesture.edgeKind === null) {
      options.onStatus("连接缺少明确的 C 控制流类型；源码未修改。", "error");
      return;
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
      return;
    }
    const historyDepth = undoHistory.length;
    checkpoint(true);
    try {
      const committed = options.onConnectionIntent(intent);
      if (!committed) undoHistory.splice(historyDepth);
      options.onStatus(
        committed
          ? "连线已通过精确 diff、重解析、无损往返和 CFG 后置条件并写入 main.c。"
          : "已取消连线；main.c 未修改。",
        committed ? "ready" : "warning",
      );
    } catch (error: unknown) {
      if (!(error instanceof FlowSourceCommitError)) undoHistory.splice(historyDepth);
      const detail = error instanceof Error ? error.message : String(error);
      options.onStatus(
        error instanceof FlowSourceCommitError
          ? `${detail}。源码撤销快照已保留，请使用 Command/Control+Z 恢复。`
          : `连线被拒绝：${detail}。main.c 未修改。`,
        "error",
      );
    }
  }

  function persistSnapshot(id: string, snapshot: ResizableLayoutSnapshot): void {
    layoutSnapshots.set(id, snapshot);
    persist();
  }

  function persist(): void {
    const current = projection;
    const viewState = currentViewState;
    if (
      destroyed ||
      current === null ||
      viewState === null ||
      activeEntryId === null ||
      sidecarLoading ||
      pendingSidecarRestore !== null
    ) {
      return;
    }
    const serializedView = JSON.parse(serializeFlowViewState(viewState, current)) as unknown;
    const sidecar: FlowWorkbenchSidecar = Object.freeze({
      schemaVersion: FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION,
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
      canvas.setProjection(current);
      canvas.setViewState(currentViewState);
      presentDraftState();
    } finally {
      restoring = false;
    }
  }

  function applyProjectionSidecarRestore(
    restored: Extract<FlowProjectionSidecarRestore, { readonly ok: true }>,
  ): void {
    currentDraftState = restored.draftState;
    presentDraftState();
    currentViewState = restored.viewState;
    canvas.setViewState(currentViewState);
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
    applyProjectionSidecarRestore(restored);
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
      restoreLayouts(sidecar.layouts, layouts, layoutSnapshots);
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
      applyProjectionSidecarRestore(restored);
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
    event.dataTransfer.dropEffect = "copy";
    const edge = canvas.findEditableControlEdgeAtClientPoint(event.clientX, event.clientY);
    canvas.setEdgeInsertionPreview(edge?.id ?? null);
  };
  const onCanvasDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget;
    if (related !== null && options.elements.flowCanvas.contains(related as Node)) return;
    canvas.setEdgeInsertionPreview(null);
  };
  const onCanvasDrop = (event: DragEvent): void => {
    const presetId = event.dataTransfer?.getData("application/x-c-block-preset") ?? "";
    if (presetId.length === 0) return;
    event.preventDefault();
    const insertionEdge = canvas.findEditableControlEdgeAtClientPoint(event.clientX, event.clientY);
    canvas.setEdgeInsertionPreview(null);
    const preset = options.resolvePreset(presetId);
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
    const next = draftNode(
      `preset-${String(Date.now())}-${String(currentDraftState.nodes.length)}`,
      preset.label,
      preset.source,
      position,
      preset,
    );
    if (insertionEdge !== null && preset.source !== null && preset.blockKind !== "virtual") {
      const historyDepth = undoHistory.length;
      checkpoint(true);
      const intent: FlowCanvasDraftConnectionIntent = Object.freeze({
        sourceFingerprint: projection?.sourceFingerprint ?? "",
        draftNodeId: next.id,
        draftPortId: `${next.id}:next`,
        presetId: preset.id,
        sourceText: preset.source,
        toNodeId: insertionEdge.to.nodeId,
        toPortId: insertionEdge.to.portId,
        edgeKind: insertionEdge.kind,
        insertOnEdge: Object.freeze({
          edgeId: insertionEdge.id,
          fromNodeId: insertionEdge.from.nodeId,
          fromPortId: insertionEdge.from.portId,
          toNodeId: insertionEdge.to.nodeId,
          toPortId: insertionEdge.to.portId,
          edgeKind: insertionEdge.kind,
        }),
      });
      try {
        const beforeProjection = projection;
        const committed = options.onDraftConnectionIntent(intent);
        if (!committed) {
          undoHistory.splice(historyDepth);
          options.onStatus("已取消插入；main.c 未修改。", "warning");
          return;
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
        persist();
        options.onStatus(`已把“${preset.label}”插入所选连线并通过 CFG 后置验证。`, "ready");
      } catch (error: unknown) {
        undoHistory.splice(historyDepth);
        const detail = error instanceof Error ? error.message : String(error);
        options.onStatus(`连线插入被拒绝：${detail}。main.c 未修改。`, "error");
      }
      return;
    }
    checkpoint(false);
    currentDraftState = Object.freeze({
      nodes: Object.freeze([...currentDraftState.nodes, next]),
      selectedNodeIds: Object.freeze([next.id]),
      connection: null,
      virtualEdges: Object.freeze([...(currentDraftState.virtualEdges ?? [])]),
    });
    presentDraftState();
    persist();
    options.onStatus(
      preset.source === null
        ? `已放置虚拟节点“${preset.label}”；它只控制回放，不改变 C 语义。`
        : `已放置未接入草稿“${preset.label}”；连接并验证前 main.c 不会改变。`,
      "ready",
    );
  };
  options.elements.flowCanvas.addEventListener("dragover", onCanvasDragOver);
  options.elements.flowCanvas.addEventListener("dragleave", onCanvasDragLeave);
  options.elements.flowCanvas.addEventListener("drop", onCanvasDrop);

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
      if (!sameSource && undoHistory.at(-1)?.sourceMutation !== true) undoHistory.length = 0;
      if (analysis?.sourceFingerprint !== nextProjection.sourceFingerprint) analysis = null;
      if (runtimeEvidence?.sourceFingerprint !== nextProjection.sourceFingerprint) {
        runtimeEvidence = null;
      }
      if (sameSource && currentViewState !== null) {
        restoring = true;
        try {
          canvas.setProjection(nextProjection);
          currentViewState = canvas.getViewState();
          presentDraftState();
          retryPendingSidecarRestore(false);
        } finally {
          restoring = false;
        }
      } else {
        adoptDefaultView(nextProjection);
      }
      persist();
    },
    setAnalysis(nextAnalysis: ProgramAnalysisSnapshot | null): void {
      assertActive(destroyed);
      analysis =
        nextAnalysis !== null && nextAnalysis.sourceFingerprint === projection?.sourceFingerprint
          ? nextAnalysis
          : null;
      canvas.refreshDetail();
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
        if (adoption.document !== null) {
          restoreSidecar(adoption.document.serialized, adoption.matchesSource);
        }
        sidecarLoading = false;
        if (adoption.document === null) persist();
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
      options.elements.shell.removeEventListener("workbench-locale-change", onCanvasLocaleChange);
      canvasToolbar.removeEventListener("click", onCanvasToolbarClick);
      persistence.destroy();
      canvas.destroy();
      for (const layout of [...layouts].reverse()) layout.controller.destroy();
      layoutSnapshots.clear();
      projection = null;
      currentViewState = null;
      currentDraftState = emptyDraftState();
      activeEntryId = null;
      pendingSidecarRestore = null;
      sidecarLoading = false;
      activeVirtualNodeIds = new Set();
      analysis = null;
      runtimeEvidence = null;
      undoHistory.length = 0;
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
    layout("main", elements.buildLayout, "horizontal", [
      pane("left", elements.leftPane, 240, 150, 420),
      pane("work", elements.workArea, 980, 640, 2400),
    ]),
    layout("work", elements.workArea, "vertical", [
      pane("primary", elements.primaryWorkspace, 510, 320, 1400),
      pane("bottom", elements.bottomPane, 250, 170, 620),
    ]),
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
  ) {
    const controller = createResizableLayout(host, {
      axis,
      panes,
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

export function readFlowWorkbenchSidecar(value: unknown): FlowWorkbenchSidecar | null {
  if (!isRecord(value)) return null;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== FLOW_WORKBENCH_SIDECAR_SCHEMA_VERSION) ||
    typeof value.sourceFingerprint !== "string" ||
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
