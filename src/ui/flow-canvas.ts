import {
  FLOW_VIEW_STATE_SCHEMA_VERSION,
  planFlowConnection,
  type FlowEdge,
  type FlowDataEdge,
  type FlowNode,
  type FlowLockReason,
  type FlowPoint,
  type FlowPort,
  type FlowProjection,
  type FlowViewState,
} from "../flow/index.js";
import {
  createFlowWirePath,
  createFlowWirePathFromRoute,
  createFlowWireRoute,
  distanceToFlowWire,
  distanceToFlowWireRoute,
  flowWireLabelPoint,
  flowWireLabelPointFromRoute,
  type FlowWireObstacle,
} from "./flow-wire-router.js";
import { installCodeTextareaIndentation } from "./code-textarea-keymap.js";

export {
  createFlowWirePath,
  createFlowWireRoute,
  distanceToFlowWire,
  flowWireLabelPoint,
} from "./flow-wire-router.js";

export type FlowCanvasViewChangeReason =
  | "projection"
  | "restore"
  | "selection"
  | "node-move"
  | "keyboard-move"
  | "viewport"
  | "detail"
  | "align";

export type FlowCanvasDraftChangeReason =
  "restore" | "selection" | "node-move" | "keyboard-move" | "delete" | "content" | "align";

export interface FlowCanvasConnectionGesture {
  readonly sourceFingerprint: string;
  readonly fromNodeId: string;
  readonly fromPortId: string;
  readonly toNodeId: string;
  readonly toPortId: string;
  readonly edgeKind: FlowPort["edgeKind"];
  /** Exact canonical edge unplugged for this gesture. Null means a new cable. */
  readonly replaceEdgeId: string | null;
}

export interface FlowCanvasCompatibleBlockSearchRequest {
  readonly sourceFingerprint: string;
  readonly endpoint: FlowCanvasWireEndpoint;
  readonly compatibleDirection: FlowPort["direction"];
  readonly worldPosition: FlowPoint;
}

export interface FlowCanvasWireEndpoint {
  readonly source: "projection" | "draft";
  readonly nodeId: string;
  readonly portId: string;
  readonly direction: FlowPort["direction"];
  readonly channel: FlowPort["channel"];
  readonly edgeKind: FlowPort["edgeKind"];
}

export interface FlowCanvasCanonicalWireConnection {
  readonly from: FlowCanvasWireEndpoint;
  readonly to: FlowCanvasWireEndpoint;
  readonly edgeKind: Exclude<FlowPort["edgeKind"], null>;
}

export type FlowCanvasWireStart =
  | {
      readonly status: "new";
      readonly anchor: FlowCanvasWireEndpoint;
      readonly detached: null;
      readonly replaceEdgeId: null;
    }
  | {
      readonly status: "reconnect";
      readonly anchor: FlowCanvasWireEndpoint;
      readonly detached: FlowCanvasWireEndpoint;
      readonly replaceEdgeId: string;
    }
  | {
      readonly status: "ambiguous";
      readonly edgeIds: readonly string[];
    };

export interface FlowCanvasDraftNode {
  readonly id: string;
  readonly label: string;
  readonly position: FlowPoint;
  readonly status: "detached" | "valid" | "invalid";
  readonly presetId?: string | null | undefined;
  readonly presetVersion?: string | null | undefined;
  readonly blockKind?: "statement" | "control" | "function" | "module" | "virtual" | undefined;
  readonly placedAt?: string | undefined;
  readonly sourceText?: string | undefined;
  readonly ports?: readonly FlowCanvasDraftPort[] | undefined;
}

export interface FlowCanvasDraftPort {
  readonly id: string;
  readonly direction: "input" | "output";
  readonly channel: "control" | "data";
  readonly edgeKind: FlowPort["edgeKind"];
  readonly label: string;
  readonly editable: boolean;
}

export interface FlowCanvasDraftConnectionIntent {
  readonly sourceFingerprint: string;
  readonly draftNodeId: string;
  readonly draftPortId: string;
  readonly presetId: string | null;
  readonly sourceText: string | null;
  readonly toNodeId: string;
  readonly toPortId: string;
  readonly edgeKind: Exclude<FlowPort["edgeKind"], null>;
  /** Present only when a detached source-backed preset is dropped directly on this exact edge. */
  readonly insertOnEdge?:
    | {
        readonly edgeId: string;
        readonly fromNodeId: string;
        readonly fromPortId: string;
        readonly toNodeId: string;
        readonly toPortId: string;
        readonly edgeKind: Exclude<FlowPort["edgeKind"], null>;
      }
    | undefined;
}

export interface FlowCanvasDraftConnection {
  readonly from: FlowPoint;
  readonly to: FlowPoint;
  readonly status: "pending" | "valid" | "invalid";
}

export interface FlowCanvasVirtualEndpoint {
  readonly source: "projection" | "virtual";
  readonly nodeId: string;
  readonly portId: string;
}

export interface FlowCanvasVirtualConnectionIntent {
  readonly sourceFingerprint: string;
  readonly from: FlowCanvasVirtualEndpoint;
  readonly to: FlowCanvasVirtualEndpoint;
}

/** A playback-only attachment. It never represents or rewrites a C CFG edge. */
export interface FlowCanvasVirtualEdge {
  readonly id: string;
  readonly from: FlowCanvasVirtualEndpoint;
  readonly to: FlowCanvasVirtualEndpoint;
  readonly status: "pending" | "valid";
  readonly sourceEdgeIds: readonly string[];
}

export interface FlowCanvasDraftVisualState {
  readonly nodes: readonly FlowCanvasDraftNode[];
  readonly connection: FlowCanvasDraftConnection | null;
  readonly selectedNodeIds?: readonly string[] | undefined;
  readonly virtualEdges?: readonly FlowCanvasVirtualEdge[] | undefined;
}

export interface FlowCanvasActivePath {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly currentNodeId: string | null;
  readonly mode: "real" | "simulation";
}

export interface FlowCanvasDetailContext {
  readonly node: FlowNode;
  readonly body: HTMLElement;
}

export interface FlowCanvasInteractionContext {
  readonly mode: "idle" | "node" | "draft" | "multi" | "edge" | "wiring";
  readonly selectedCount: number;
}

export interface FlowCanvasNodePresentation {
  readonly kind: string;
  readonly label: string;
  readonly portLabels: readonly string[];
  readonly lockReasons: readonly string[];
}

export interface FlowCanvasOptions {
  readonly onNodeClick?: ((node: FlowNode, selectedNodeIds: readonly string[]) => void) | undefined;
  readonly onViewStateChange?:
    ((state: FlowViewState, reason: FlowCanvasViewChangeReason) => void) | undefined;
  readonly onConnectionIntent?: ((gesture: FlowCanvasConnectionGesture) => void) | undefined;
  /** Final source-level gate used by port highlighting as well as drop commit. */
  readonly onConnectionPreflight?:
    ((gesture: FlowCanvasConnectionGesture) => { readonly accepted: boolean }) | undefined;
  readonly onDraftConnectionIntent?:
    ((intent: FlowCanvasDraftConnectionIntent) => void) | undefined;
  readonly onVirtualConnectionIntent?:
    ((intent: FlowCanvasVirtualConnectionIntent) => void) | undefined;
  readonly onDraftStateChange?:
    ((state: FlowCanvasDraftVisualState, reason: FlowCanvasDraftChangeReason) => void) | undefined;
  readonly onDraftNodeClick?:
    ((node: FlowCanvasDraftNode, selectedNodeIds: readonly string[]) => void) | undefined;
  readonly onDeleteDraftNodes?: ((nodeIds: readonly string[]) => void) | undefined;
  readonly onDeleteNodes?: ((nodeIds: readonly string[]) => void) | undefined;
  readonly onCopyNodes?: ((nodeIds: readonly string[]) => void) | undefined;
  readonly onUndo?: (() => void) | undefined;
  readonly onHistoryCheckpoint?: (() => void) | undefined;
  readonly onCompatibleBlockSearch?:
    ((request: FlowCanvasCompatibleBlockSearchRequest) => void) | undefined;
  readonly onWireStatus?:
    ((message: string, state: "ready" | "warning" | "error") => void) | undefined;
  readonly onInteractionContextChange?:
    ((context: FlowCanvasInteractionContext) => void) | undefined;
  readonly renderNodeDetail?: ((context: FlowCanvasDetailContext) => void) | undefined;
}

export interface FlowCanvasController {
  readonly element: HTMLElement;
  setProjection(projection: FlowProjection | null): void;
  setViewState(viewState: FlowViewState): void;
  getViewState(): FlowViewState;
  setActivePath(path: FlowCanvasActivePath | readonly string[]): void;
  setDraftVisualState(state: FlowCanvasDraftVisualState | null): void;
  getDraftVisualState(): FlowCanvasDraftVisualState | null;
  findEditableControlEdgeAtClientPoint(
    clientX: number,
    clientY: number,
    tolerancePx?: number,
  ): FlowEdge | null;
  setEdgeInsertionPreview(edgeId: string | null): void;
  focusNode(nodeId: string): void;
  refreshDetail(): void;
  alignSelection(mode: "left" | "distribute-y"): void;
  destroy(): void;
}

interface NodeDragGesture {
  readonly kind: "node";
  readonly pointerId: number;
  readonly nodeId: string;
  readonly startClient: FlowPoint;
  readonly origins: Readonly<Record<string, FlowPoint>>;
  readonly collapseSelectionOnClick: boolean;
  readonly openDetailOnRelease: boolean;
  activated: boolean;
}

interface PanGesture {
  readonly kind: "pan";
  readonly pointerId: number;
  readonly startClient: FlowPoint;
  readonly origin: FlowPoint;
  readonly clearSelectionOnClick: boolean;
  activated: boolean;
}

interface MarqueeGesture {
  readonly kind: "marquee";
  readonly pointerId: number;
  readonly startClient: FlowPoint;
  currentClient: FlowPoint;
  readonly additive: boolean;
}

interface WireGesture {
  readonly kind: "wire";
  readonly source: "projection" | "draft";
  readonly pointerId: number;
  readonly nodeId: string;
  readonly portId: string;
  readonly detached: FlowCanvasWireEndpoint | null;
  readonly replaceEdgeId: string | null;
  readonly start: FlowPoint;
  current: FlowPoint;
}

interface DraftNodeDragGesture {
  readonly kind: "draft-node";
  readonly pointerId: number;
  readonly nodeId: string;
  readonly startClient: FlowPoint;
  readonly origins: Readonly<Record<string, FlowPoint>>;
  readonly collapseSelectionOnClick: boolean;
  readonly openDetailOnRelease: boolean;
  activated: boolean;
}

interface MinimapPanGesture {
  readonly kind: "minimap-pan";
  readonly pointerId: number;
  readonly startClient: FlowPoint;
  readonly origin: FlowPoint;
  readonly worldPerPixel: FlowPoint;
}

interface DetailMoveGesture {
  readonly kind: "detail-move";
  readonly pointerId: number;
  readonly startClient: FlowPoint;
  readonly origin: FlowPoint;
}

interface DetailResizeGesture {
  readonly kind: "detail-resize";
  readonly pointerId: number;
  readonly startClient: FlowPoint;
  readonly origin: FlowPoint;
}

type CanvasGesture =
  | NodeDragGesture
  | PanGesture
  | MarqueeGesture
  | WireGesture
  | DraftNodeDragGesture
  | MinimapPanGesture
  | DetailMoveGesture
  | DetailResizeGesture;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NODE_WIDTH = 160;
const NODE_HEIGHT = 32;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const KEYBOARD_MOVE = 2;
const DETAIL_MIN_WIDTH = 280;
const DETAIL_MIN_HEIGHT = 180;
const NODE_DRAG_THRESHOLD = 4;
const PAN_DRAG_THRESHOLD = 2;
const VIEWPORT_FIT_PADDING = 44;
const MINIMAP_PADDING = 64;
const FLOW_CANVAS_QUICK_ADD_EVENT = "flow-canvas-compatible-block-search";

export function createFlowCanvas(
  host: HTMLElement,
  options: FlowCanvasOptions = {},
): FlowCanvasController {
  const ownerDocument = host.ownerDocument;
  const documentElement = ownerDocument.documentElement as HTMLElement | undefined;
  const localeHost =
    typeof host.closest === "function"
      ? (host.closest<HTMLElement>("[data-locale]") ?? documentElement ?? host)
      : (documentElement ?? host);
  const english = (): boolean =>
    localeHost.dataset.locale === "en" ||
    (localeHost.dataset.locale === undefined && documentElement?.lang.startsWith("en") === true);
  const text = (zh: string, en: string): string => (english() ? en : zh);
  const root = ownerDocument.createElement("section");
  root.className = "flow-canvas";
  root.tabIndex = 0;
  root.setAttribute("role", "application");
  root.setAttribute(
    "aria-label",
    text(
      "算法流程画布。单击选择，双击或回车打开详情，拖动空白平移，Shift 拖动框选。",
      "Algorithm flow canvas. Click to select, double-click or press Enter for details, drag empty space to pan, and Shift-drag to marquee-select.",
    ),
  );
  root.setAttribute("aria-keyshortcuts", "Meta+K Control+K Home F Enter");
  root.dataset.flowCanvas = "true";

  const wires = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  wires.classList.add("flow-canvas__wires");
  wires.setAttribute("aria-hidden", "true");
  const wireViewport = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  const edgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  edgeLayer.classList.add("flow-canvas__edge-layer");
  const draftWire = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  draftWire.classList.add("flow-canvas__draft-wire");
  draftWire.setAttribute("visibility", "hidden");
  wireViewport.append(edgeLayer, draftWire);
  wires.append(wireViewport);

  const viewport = ownerDocument.createElement("div");
  viewport.className = "flow-canvas__viewport";
  const surface = ownerDocument.createElement("div");
  surface.className = "flow-canvas__surface";
  const nodeLayer = ownerDocument.createElement("div");
  nodeLayer.className = "flow-canvas__node-layer";
  const draftLayer = ownerDocument.createElement("div");
  draftLayer.className = "flow-canvas__draft-layer";
  surface.append(nodeLayer, draftLayer);
  viewport.append(surface);

  const marquee = ownerDocument.createElement("div");
  marquee.className = "flow-canvas__marquee";
  marquee.hidden = true;
  marquee.setAttribute("aria-hidden", "true");

  const emptyState = ownerDocument.createElement("p");
  emptyState.className = "flow-canvas__empty";
  emptyState.textContent = text(
    "打开 C 文件后，这里会显示可自由摆放的流程节点。",
    "Open a C file to show freely positioned flow nodes here.",
  );

  const wireStatus = ownerDocument.createElement("output");
  wireStatus.className = "flow-canvas__wire-status";
  wireStatus.setAttribute("role", "status");
  wireStatus.setAttribute("aria-live", "polite");
  wireStatus.dataset.flowWireStatus = "true";

  const detail = createDetailWindow(ownerDocument, english());
  const minimap = createMinimap(ownerDocument, english());
  const hud = ownerDocument.createElement("div");
  hud.className = "flow-canvas__hud";
  hud.append(minimap.root);
  root.append(wires, viewport, marquee, emptyState, wireStatus, hud, detail.window);
  host.replaceChildren(root);

  let projection: FlowProjection | null = null;
  let viewState = emptyViewState("");
  let activePath: FlowCanvasActivePath = emptyActivePath();
  let draftState: FlowCanvasDraftVisualState | null = null;
  let detailDraftNodeId: string | null = null;
  let gesture: CanvasGesture | null = null;
  let spacePressed = false;
  let destroyed = false;
  let edgeInsertionPreviewId: string | null = null;
  let selectedEdgeId: string | null = null;
  let lastDetailPointerDown: {
    readonly source: "projection" | "draft";
    readonly nodeId: string;
    readonly at: number;
  } | null = null;
  let wireStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInteractionContextKey = "";
  let restoredViewportRecoveryPending = false;
  const nodeElements = new Map<string, HTMLElement>();
  const edgeElements = new Map<string, SVGPathElement>();
  const edgeLabelElements = new Map<string, SVGTextElement>();
  const edgeHitElements = new Map<string, SVGPathElement>();
  const virtualEdgeElements = new Map<string, SVGPathElement>();
  const draftNodeElements = new Map<string, HTMLElement>();
  let minimapWorldBounds: Bounds | null = null;
  let minimapAnimationFrame: number | null = null;
  let controlWireRouteSignature = "";
  const controlWireRoutes = new Map<string, readonly FlowPoint[]>();

  function setDetailPosition(left: number, top: number): void {
    const maximumLeft = Math.max(0, root.clientWidth - detail.window.offsetWidth);
    const maximumTop = Math.max(0, root.clientHeight - detail.window.offsetHeight);
    detail.window.style.left = `${String(clamp(left, 0, maximumLeft))}px`;
    detail.window.style.top = `${String(clamp(top, 0, maximumTop))}px`;
  }

  function setDetailSize(width: number, height: number): void {
    const minimumWidth = Math.min(DETAIL_MIN_WIDTH, Math.max(0, root.clientWidth));
    const minimumHeight = Math.min(DETAIL_MIN_HEIGHT, Math.max(0, root.clientHeight));
    const maximumWidth = Math.max(minimumWidth, root.clientWidth - detail.window.offsetLeft);
    const maximumHeight = Math.max(minimumHeight, root.clientHeight - detail.window.offsetTop);
    detail.window.style.width = `${String(clamp(width, minimumWidth, maximumWidth))}px`;
    detail.window.style.height = `${String(clamp(height, minimumHeight, maximumHeight))}px`;
  }

  function clampDetailGeometry(): void {
    if (detail.window.hidden || root.clientWidth <= 0 || root.clientHeight <= 0) return;
    if (detail.window.dataset.minimized !== "true") {
      setDetailSize(detail.window.offsetWidth, detail.window.offsetHeight);
    }
    setDetailPosition(detail.window.offsetLeft, detail.window.offsetTop);
  }

  const publishViewState = (reason: FlowCanvasViewChangeReason): void => {
    options.onViewStateChange?.(cloneViewState(viewState), reason);
  };

  const publishDraftState = (reason: FlowCanvasDraftChangeReason): void => {
    if (draftState !== null) options.onDraftStateChange?.(freezeDraftState(draftState), reason);
  };

  const setInternalViewState = (
    candidate: FlowViewState,
    reason: FlowCanvasViewChangeReason,
  ): void => {
    viewState =
      projection === null
        ? cloneViewState(candidate)
        : normalizeFlowCanvasViewState(projection, candidate);
    restoredViewportRecoveryPending = reason === "restore";
    recoverRestoredViewportIfReady();
    renderViewport();
    renderSelection();
    renderDetail();
    publishViewState(reason);
  };

  function recoverRestoredViewportIfReady(): boolean {
    if (!restoredViewportRecoveryPending || projection === null) return false;
    const bounds = root.getBoundingClientRect();
    const size = {
      width: root.clientWidth || bounds.width,
      height: root.clientHeight || bounds.height,
    };
    if (size.width < 64 || size.height < 64) return false;
    const recovered = recoverDisconnectedFlowCanvasViewport(projection, viewState, size);
    restoredViewportRecoveryPending = false;
    if (
      recovered.x === viewState.viewport.x &&
      recovered.y === viewState.viewport.y &&
      recovered.zoom === viewState.viewport.zoom
    ) {
      return false;
    }
    viewState = cloneViewState(viewState, { viewport: recovered });
    return true;
  }

  const nodeForId = (nodeId: string): FlowNode | undefined =>
    projection?.nodes.find((node) => node.id === nodeId);

  const draftNodeForId = (nodeId: string): FlowCanvasDraftNode | undefined =>
    draftState?.nodes.find((node) => node.id === nodeId);

  const positionFor = (node: FlowNode): FlowPoint =>
    viewState.positions[node.id] ?? node.defaultPosition;

  function renderProjection(): void {
    if (
      selectedEdgeId !== null &&
      !projection?.edges.some((candidate) => candidate.id === selectedEdgeId)
    ) {
      selectedEdgeId = null;
    }
    nodeElements.clear();
    edgeElements.clear();
    edgeLabelElements.clear();
    edgeHitElements.clear();
    virtualEdgeElements.clear();
    nodeLayer.replaceChildren();
    edgeLayer.replaceChildren();
    emptyState.hidden = projection !== null && projection.nodes.length > 0;
    if (projection === null) {
      renderDetail();
      return;
    }

    for (const edge of projection.edges) {
      const group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
      group.classList.add("flow-canvas__wire-group");
      group.dataset.flowEdgeGroupId = edge.id;
      const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      path.classList.add("flow-canvas__wire");
      path.dataset.flowEdgeId = edge.id;
      path.dataset.fromNodeId = edge.from.nodeId;
      path.dataset.toNodeId = edge.to.nodeId;
      path.dataset.edgeKind = edge.kind;
      path.dataset.editable = String(edge.editable);
      if (edge.id === edgeInsertionPreviewId) path.classList.add("is-insertion-preview");
      if (edge.editable) {
        const hit = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
        hit.classList.add("flow-canvas__wire-hit");
        hit.dataset.flowEdgeHitId = edge.id;
        hit.dataset.fromNodeId = edge.from.nodeId;
        hit.dataset.toNodeId = edge.to.nodeId;
        hit.dataset.editable = "true";
        group.append(hit);
        edgeHitElements.set(edge.id, hit);
      }
      group.append(path);
      if (edge.kind === "branch-true" || edge.kind === "branch-false") {
        const label = ownerDocument.createElementNS(SVG_NAMESPACE, "text");
        label.classList.add("flow-canvas__wire-label");
        label.dataset.flowEdgeLabelId = edge.id;
        label.dataset.edgeKind = edge.kind;
        label.textContent = edge.kind === "branch-true" ? "true" : "false";
        label.setAttribute("aria-hidden", "true");
        group.append(label);
        edgeLabelElements.set(edge.id, label);
      }
      edgeLayer.append(group);
      edgeElements.set(edge.id, path);
    }
    for (const edge of projection.dataEdges) {
      const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      path.classList.add("flow-canvas__wire", "flow-canvas__wire--data");
      path.dataset.flowDataEdgeId = edge.id;
      path.dataset.channel = "data";
      path.dataset.variableName = edge.variableName;
      path.dataset.editable = "false";
      edgeLayer.prepend(path);
      edgeElements.set(edge.id, path);
    }

    for (const node of projection.nodes) {
      const element = renderNode(ownerDocument, node, projection.edges, english());
      nodeLayer.append(element);
      nodeElements.set(node.id, element);
    }
    renderViewport();
    renderSelection();
    renderActivePath();
    renderDraft();
    renderDetail();
  }

  function renderViewport(): void {
    const { x, y, zoom } = viewState.viewport;
    root.style.backgroundPosition = `${String(x)}px ${String(y)}px`;
    root.style.backgroundSize = `${String(24 * zoom)}px ${String(24 * zoom)}px`;
    viewport.style.transform = `translate(${String(x)}px, ${String(y)}px) scale(${String(zoom)})`;
    wireViewport.setAttribute(
      "transform",
      `translate(${String(x)} ${String(y)}) scale(${String(zoom)})`,
    );
    root.dataset.zoom = zoom.toFixed(2);
    for (const node of projection?.nodes ?? []) {
      const element = nodeElements.get(node.id);
      const position = positionFor(node);
      if (element !== undefined) {
        element.style.transform = `translate(${String(position.x)}px, ${String(position.y)}px)`;
      }
    }
    renderWires();
    renderMinimap();
  }

  function renderMinimap(): void {
    const view = ownerDocument.defaultView;
    if (view === null || typeof view.requestAnimationFrame !== "function") {
      renderMinimapNow();
      return;
    }
    if (minimapAnimationFrame !== null) return;
    minimapAnimationFrame = view.requestAnimationFrame(() => {
      minimapAnimationFrame = null;
      if (!destroyed) renderMinimapNow();
    });
  }

  function renderMinimapNow(): void {
    const canvasSize = canvasPixelSize(root);
    const visible = visibleWorldBounds(viewState, canvasSize);
    const itemBounds = flowItemBounds(projection, viewState, draftState);
    minimapWorldBounds = expandBounds(
      itemBounds === null ? visible : unionBounds(itemBounds, visible),
      MINIMAP_PADDING,
    );
    const bounds = minimapWorldBounds;
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    minimap.svg.setAttribute(
      "viewBox",
      `${formatCoordinate(bounds.left)} ${formatCoordinate(bounds.top)} ${formatCoordinate(width)} ${formatCoordinate(height)}`,
    );
    minimap.nodes.replaceChildren();
    minimap.edges.replaceChildren();
    const activeNodeIds = new Set(activePath.nodeIds);
    const activeEdgeIds = new Set(activePath.edgeIds);
    const nodePositions = new Map<string, FlowPoint>();
    for (const node of projection?.nodes ?? []) {
      const position = positionFor(node);
      nodePositions.set(node.id, position);
      const rectangle = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
      rectangle.classList.add("flow-minimap__node");
      if (activeNodeIds.has(node.id)) rectangle.classList.add("is-active-path");
      rectangle.dataset.executionMode = activeNodeIds.has(node.id) ? activePath.mode : "idle";
      rectangle.setAttribute("x", formatCoordinate(position.x));
      rectangle.setAttribute("y", formatCoordinate(position.y));
      rectangle.setAttribute("width", String(NODE_WIDTH));
      rectangle.setAttribute("height", String(NODE_HEIGHT));
      minimap.nodes.append(rectangle);
    }
    for (const node of draftState?.nodes ?? []) {
      nodePositions.set(node.id, node.position);
      const rectangle = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
      rectangle.classList.add("flow-minimap__node", "flow-minimap__node--draft");
      if (activeNodeIds.has(node.id)) rectangle.classList.add("is-active-path");
      rectangle.dataset.executionMode = activeNodeIds.has(node.id) ? activePath.mode : "idle";
      rectangle.setAttribute("x", formatCoordinate(node.position.x));
      rectangle.setAttribute("y", formatCoordinate(node.position.y));
      rectangle.setAttribute("width", String(NODE_WIDTH));
      rectangle.setAttribute("height", String(NODE_HEIGHT));
      minimap.nodes.append(rectangle);
    }
    for (const edge of projection?.edges ?? []) {
      if (!activeEdgeIds.has(edge.id)) continue;
      const from = nodePositions.get(edge.from.nodeId);
      const to = nodePositions.get(edge.to.nodeId);
      if (from === undefined || to === undefined) continue;
      const line = ownerDocument.createElementNS(SVG_NAMESPACE, "line");
      line.classList.add("flow-minimap__path");
      line.dataset.executionMode = activePath.mode;
      line.setAttribute("x1", formatCoordinate(from.x + NODE_WIDTH / 2));
      line.setAttribute("y1", formatCoordinate(from.y + NODE_HEIGHT / 2));
      line.setAttribute("x2", formatCoordinate(to.x + NODE_WIDTH / 2));
      line.setAttribute("y2", formatCoordinate(to.y + NODE_HEIGHT / 2));
      minimap.edges.append(line);
    }
    minimap.viewport.setAttribute("x", formatCoordinate(visible.left));
    minimap.viewport.setAttribute("y", formatCoordinate(visible.top));
    minimap.viewport.setAttribute("width", formatCoordinate(visible.right - visible.left));
    minimap.viewport.setAttribute("height", formatCoordinate(visible.bottom - visible.top));
  }

  function renderWires(): void {
    if (projection === null) return;
    const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
    refreshControlWireRouteCache();
    for (const edge of projection.edges) {
      const path = edgeElements.get(edge.id);
      const fromNode = nodes.get(edge.from.nodeId);
      const toNode = nodes.get(edge.to.nodeId);
      const fromPort = fromNode?.ports.find((port) => port.id === edge.from.portId);
      const toPort = toNode?.ports.find((port) => port.id === edge.to.portId);
      if (
        path === undefined ||
        fromNode === undefined ||
        toNode === undefined ||
        fromPort === undefined ||
        toPort === undefined
      ) {
        path?.setAttribute("d", "");
        continue;
      }
      const from = flowPortPoint(fromNode, fromPort, positionFor(fromNode));
      const to = flowPortPoint(toNode, toPort, positionFor(toNode));
      const route = controlWireRoute(edge, fromNode, toNode, from, to);
      const wirePath = createFlowWirePathFromRoute(route);
      path.setAttribute("d", wirePath);
      edgeHitElements.get(edge.id)?.setAttribute("d", wirePath);
      const label = edgeLabelElements.get(edge.id);
      if (label !== undefined) {
        const labelPoint = flowWireLabelPointFromRoute(route);
        label.setAttribute("x", formatCoordinate(labelPoint.x));
        label.setAttribute("y", formatCoordinate(labelPoint.y - 5));
      }
    }
    for (const edge of projection.dataEdges) renderDataWire(edge, nodes);
    renderVirtualWires();
    renderGestureWire();
  }

  function refreshControlWireRouteCache(): void {
    const signature = [
      projection?.sourceFingerprint ?? "",
      ...(projection?.nodes ?? []).map((node) => {
        const position = positionFor(node);
        return `${node.id}:${String(position.x)},${String(position.y)}`;
      }),
      ...(draftState?.nodes ?? []).map(
        (node) => `${node.id}:${String(node.position.x)},${String(node.position.y)}`,
      ),
    ].join("|");
    if (signature === controlWireRouteSignature) return;
    controlWireRouteSignature = signature;
    controlWireRoutes.clear();
  }

  function controlWireRoute(
    edge: FlowEdge,
    fromNode: FlowNode,
    toNode: FlowNode,
    from: FlowPoint,
    to: FlowPoint,
  ): readonly FlowPoint[] {
    const cached = controlWireRoutes.get(edge.id);
    if (cached !== undefined) return cached;
    const excluded = new Set([fromNode.id, toNode.id]);
    const obstacles: FlowWireObstacle[] = [
      ...(projection?.nodes ?? [])
        .filter((node) => !excluded.has(node.id))
        .map((node) => obstacleAt(positionFor(node))),
      ...(draftState?.nodes ?? [])
        .filter((node) => !excluded.has(node.id))
        .map((node) => obstacleAt(node.position)),
    ];
    const route = createFlowWireRoute(from, to, flowWireLane(edge), obstacles);
    controlWireRoutes.set(edge.id, route);
    return route;
  }

  function obstacleAt(position: FlowPoint): FlowWireObstacle {
    return Object.freeze({
      left: position.x,
      top: position.y,
      right: position.x + NODE_WIDTH,
      bottom: position.y + NODE_HEIGHT,
    });
  }

  function renderVirtualEdges(): void {
    for (const [edgeId, element] of virtualEdgeElements) {
      element.remove();
      edgeElements.delete(edgeId);
    }
    virtualEdgeElements.clear();
    for (const edge of draftState?.virtualEdges ?? []) {
      const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      path.classList.add("flow-canvas__wire", "flow-canvas__wire--virtual");
      path.dataset.flowVirtualEdgeId = edge.id;
      path.dataset.status = edge.status;
      path.dataset.editable = "true";
      edgeLayer.append(path);
      virtualEdgeElements.set(edge.id, path);
      edgeElements.set(edge.id, path);
    }
    renderVirtualWires();
  }

  function renderVirtualWires(): void {
    for (const edge of draftState?.virtualEdges ?? []) {
      const path = virtualEdgeElements.get(edge.id);
      const from = virtualEndpointPoint(edge.from);
      const to = virtualEndpointPoint(edge.to);
      path?.setAttribute("d", from === null || to === null ? "" : createFlowWirePath(from, to));
    }
  }

  function virtualEndpointPoint(endpoint: FlowCanvasVirtualEndpoint): FlowPoint | null {
    if (endpoint.source === "projection") {
      const node = nodeForId(endpoint.nodeId);
      const port = node?.ports.find((candidate) => candidate.id === endpoint.portId);
      return node === undefined || port === undefined
        ? null
        : flowPortPoint(node, port, positionFor(node));
    }
    const node = draftNodeForId(endpoint.nodeId);
    const port = node?.ports?.find((candidate) => candidate.id === endpoint.portId);
    return node === undefined || port === undefined ? null : draftPortPoint(node, port);
  }

  function renderDataWire(edge: FlowDataEdge, nodes: ReadonlyMap<string, FlowNode>): void {
    const path = edgeElements.get(edge.id);
    const fromNode = nodes.get(edge.fromNodeId);
    const toNode = nodes.get(edge.toNodeId);
    if (path === undefined || fromNode === undefined || toNode === undefined) {
      path?.setAttribute("d", "");
      return;
    }
    const fromPosition = positionFor(fromNode);
    const toPosition = positionFor(toNode);
    path.setAttribute(
      "d",
      createFlowWirePath(
        point(fromPosition.x + NODE_WIDTH, fromPosition.y + 9),
        point(toPosition.x, toPosition.y + NODE_HEIGHT - 9),
      ),
    );
  }

  function renderGestureWire(): void {
    const connection =
      gesture?.kind === "wire"
        ? { from: gesture.start, to: gesture.current, status: "pending" as const }
        : draftState?.connection;
    if (connection === null || connection === undefined) {
      draftWire.setAttribute("visibility", "hidden");
      draftWire.setAttribute("d", "");
      delete draftWire.dataset.status;
      publishInteractionContext();
      return;
    }
    draftWire.removeAttribute("visibility");
    draftWire.dataset.status = connection.status;
    draftWire.setAttribute("d", createFlowWirePath(connection.from, connection.to));
    publishInteractionContext();
  }

  function renderSelection(): void {
    const selected = new Set(viewState.selectedNodeIds);
    for (const [nodeId, element] of nodeElements) {
      const isSelected = selected.has(nodeId);
      element.classList.toggle("is-selected", isSelected);
      element.setAttribute("aria-selected", String(isSelected));
      element.tabIndex = isSelected ? 0 : -1;
    }
    const selectedDrafts = new Set(draftState?.selectedNodeIds ?? []);
    for (const [nodeId, element] of draftNodeElements) {
      const isSelected = selectedDrafts.has(nodeId);
      element.classList.toggle("is-selected", isSelected);
      element.setAttribute("aria-selected", String(isSelected));
      element.tabIndex = isSelected ? 0 : -1;
    }
    for (const edge of projection?.dataEdges ?? []) {
      edgeElements
        .get(edge.id)
        ?.classList.toggle(
          "is-contextual",
          selected.has(edge.fromNodeId) || selected.has(edge.toNodeId),
        );
    }
    renderEdgeSelection();
    publishInteractionContext();
  }

  function publishInteractionContext(): void {
    const projectionCount = viewState.selectedNodeIds.length;
    const draftCount = draftState?.selectedNodeIds?.length ?? 0;
    const selectedCount = projectionCount + draftCount;
    const mode: FlowCanvasInteractionContext["mode"] =
      gesture?.kind === "wire"
        ? "wiring"
        : selectedEdgeId !== null
          ? "edge"
          : selectedCount > 1
            ? "multi"
            : draftCount === 1
              ? "draft"
              : projectionCount === 1
                ? "node"
                : "idle";
    const key = `${mode}:${String(selectedCount)}`;
    root.dataset.interactionContext = mode;
    if (key === lastInteractionContextKey) return;
    lastInteractionContextKey = key;
    options.onInteractionContextChange?.(Object.freeze({ mode, selectedCount }));
  }

  function renderEdgeSelection(): void {
    for (const [edgeId, element] of edgeElements) {
      element.classList.toggle("is-selected", edgeId === selectedEdgeId);
    }
    for (const element of [...nodeElements.values(), ...draftNodeElements.values()]) {
      for (const port of element.querySelectorAll<HTMLElement>(
        "[data-flow-port-id], [data-flow-draft-port-id]",
      )) {
        delete port.dataset.selectedCableEnd;
        delete port.dataset.cableRole;
        delete port.dataset.cableLabel;
      }
    }
    if (selectedEdgeId === null || projection === null) {
      clearPersistentWireStatus();
      return;
    }
    const edge = projection.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (edge === undefined) return;
    markSelectedCableEnd(edge.from.nodeId, edge.from.portId, "reconnect-output");
    markSelectedCableEnd(edge.to.nodeId, edge.to.portId, "reconnect-input");
  }

  function markSelectedCableEnd(
    nodeId: string,
    portId: string,
    role: "reconnect-output" | "reconnect-input",
  ): void {
    const node = nodeElements.get(nodeId);
    const port = [...(node?.querySelectorAll<HTMLElement>("[data-flow-port-id]") ?? [])].find(
      (candidate) => candidate.dataset.flowPortId === portId,
    );
    if (port === null || port === undefined) return;
    const english = root.closest<HTMLElement>("[data-locale='en']") !== null;
    port.dataset.selectedCableEnd = "true";
    port.dataset.cableRole = role;
    port.dataset.cableLabel = english ? "drag to rewire" : "拖动改接";
  }

  function selectEdge(edgeId: string | null): void {
    selectedEdgeId = edgeId;
    if (edgeId !== null) {
      clearNodeSelectionForEdge();
      const edge = projection?.edges.find((candidate) => candidate.id === edgeId);
      if (edge !== undefined) {
        announceWire(
          text(
            "已选择连接线。可拖动任一端插头；只有能安全落成 C 的端口会高亮。",
            "Cable selected. Drag either plug; only sockets with a safe C rewrite are highlighted.",
          ),
          "ready",
          true,
        );
      }
    }
    renderSelection();
  }

  function clearNodeSelectionForEdge(): void {
    const hadProjectionSelection = viewState.selectedNodeIds.length > 0;
    const hadDraftSelection = (draftState?.selectedNodeIds?.length ?? 0) > 0;
    if (hadProjectionSelection) {
      viewState = cloneViewState(viewState, { selectedNodeIds: [] });
      publishViewState("selection");
    }
    if (draftState !== null && hadDraftSelection) {
      draftState = freezeDraftState({ ...draftState, selectedNodeIds: [] });
      publishDraftState("selection");
    }
  }

  function clearPersistentWireStatus(): void {
    if (wireStatus.dataset.persistent !== "true") return;
    wireStatus.textContent = "";
    delete wireStatus.dataset.persistent;
    delete wireStatus.dataset.state;
  }

  function announceWire(
    message: string,
    state: "ready" | "warning" | "error" = "ready",
    persistent = false,
  ): void {
    if (wireStatusTimer !== null) {
      clearTimeout(wireStatusTimer);
      wireStatusTimer = null;
    }
    wireStatus.textContent = "";
    wireStatus.dataset.state = state;
    if (persistent) wireStatus.dataset.persistent = "true";
    else delete wireStatus.dataset.persistent;
    options.onWireStatus?.(message, state);
    ownerDocument.defaultView?.queueMicrotask(() => {
      if (destroyed) return;
      wireStatus.textContent = message;
      if (persistent) return;
      wireStatusTimer = setTimeout(() => {
        wireStatus.textContent = "";
        delete wireStatus.dataset.state;
        wireStatusTimer = null;
      }, 2400);
    });
  }

  function renderActivePath(): void {
    const activeNodes = new Set(activePath.nodeIds);
    const activeEdges = new Set(activePath.edgeIds);
    const hasActivePath = activeNodes.size > 0 || activeEdges.size > 0;
    root.classList.toggle("has-active-path", hasActivePath);
    root.dataset.executionMode = hasActivePath ? activePath.mode : "idle";
    for (const [nodeId, element] of nodeElements) {
      applyNodeExecutionState(element, nodeId, activeNodes, hasActivePath);
    }
    for (const [edgeId, element] of edgeElements) {
      element.classList.toggle("is-active-path", activeEdges.has(edgeId));
      element.dataset.executionMode = activeEdges.has(edgeId) ? activePath.mode : "idle";
    }
    for (const [edgeId, element] of edgeLabelElements) {
      element.classList.toggle("is-active-path", activeEdges.has(edgeId));
      element.dataset.executionMode = activeEdges.has(edgeId) ? activePath.mode : "idle";
    }
    for (const [nodeId, element] of draftNodeElements) {
      applyNodeExecutionState(element, nodeId, activeNodes, hasActivePath);
    }
    renderMinimap();
  }

  function applyNodeExecutionState(
    element: HTMLElement,
    nodeId: string,
    activeNodes: ReadonlySet<string>,
    hasActivePath: boolean,
  ): void {
    const active = activeNodes.has(nodeId);
    const current = active && activePath.currentNodeId === nodeId;
    element.classList.toggle("is-active-path", active);
    element.classList.toggle("is-current", current);
    element.dataset.executionMode = active ? activePath.mode : "idle";
    element.dataset.executionState = current
      ? "current"
      : active
        ? "visited"
        : hasActivePath
          ? "inactive"
          : "idle";
    if (current) element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
  }

  function renderDraft(): void {
    draftNodeElements.clear();
    draftLayer.replaceChildren();
    for (const node of draftState?.nodes ?? []) {
      const element = ownerDocument.createElement("article");
      element.className = "flow-canvas__draft-node";
      element.dataset.draftId = node.id;
      element.dataset.flowDraftNodeId = node.id;
      element.dataset.status = node.status;
      element.setAttribute("role", "button");
      element.setAttribute(
        "aria-label",
        `${node.label}${english() ? ", " : "，"}${draftStatusLabel(node.status, english())}`,
      );
      element.setAttribute("aria-selected", "false");
      element.tabIndex = -1;
      element.style.width = `${String(NODE_WIDTH)}px`;
      element.style.minHeight = `${String(NODE_HEIGHT)}px`;
      element.style.cursor = "grab";
      element.style.transform = `translate(${String(node.position.x)}px, ${String(node.position.y)}px)`;
      const label = ownerDocument.createElement("span");
      label.className = "flow-node__label";
      label.textContent = node.label;
      const status = ownerDocument.createElement("span");
      status.className = "flow-node__status";
      status.textContent = draftStatusLabel(node.status, english(), true);
      element.append(label, status);
      for (const port of node.ports ?? []) {
        const portElement = ownerDocument.createElement("button");
        portElement.className = `flow-node__port flow-node__port--${port.direction}`;
        portElement.type = "button";
        portElement.tabIndex = -1;
        portElement.dataset.flowDraftNodeId = node.id;
        portElement.dataset.flowDraftPortId = port.id;
        portElement.dataset.channel = port.channel;
        portElement.dataset.editable = String(port.editable);
        portElement.dataset.edgeKind = port.edgeKind ?? "input";
        portElement.style.left = `calc(50% + ${String(portHorizontalOffset(node.ports ?? [], port))}px)`;
        portElement.disabled = !port.editable;
        portElement.setAttribute("aria-label", `${node.label}：${port.label}`);
        portElement.title = port.label;
        element.append(portElement);
      }
      draftLayer.append(element);
      draftNodeElements.set(node.id, element);
    }
    renderSelection();
    renderVirtualEdges();
    renderGestureWire();
    renderActivePath();
  }

  function renderDetail(): void {
    const node =
      viewState.detailNodeId === null
        ? undefined
        : projection?.nodes.find((candidate) => candidate.id === viewState.detailNodeId);
    const draftNode =
      node === undefined && detailDraftNodeId !== null
        ? draftNodeForId(detailDraftNodeId)
        : undefined;
    if (node === undefined && draftNode === undefined) {
      detail.window.hidden = true;
      detail.body.replaceChildren();
      return;
    }
    detail.window.hidden = false;
    detail.title.textContent = node?.label ?? draftNode?.label ?? text("草稿", "Draft");
    detail.window.dataset.nodeId = node?.id ?? draftNode?.id ?? "";
    detail.window.dataset.locked = String(node?.locked ?? false);
    detail.window.dataset.draft = String(draftNode !== undefined);
    detail.body.replaceChildren();
    if (node !== undefined) {
      renderDefaultDetail(ownerDocument, detail.body, node, english());
      options.renderNodeDetail?.(Object.freeze({ node, body: detail.body }));
    } else if (draftNode !== undefined) {
      renderDefaultDraftDetail(ownerDocument, detail.body, draftNode, english(), (sourceText) => {
        if (draftState === null || draftNode.blockKind === "virtual") return;
        options.onHistoryCheckpoint?.();
        draftState = freezeDraftState({
          ...draftState,
          nodes: draftState.nodes.map((candidate) =>
            candidate.id === draftNode.id
              ? Object.freeze({ ...candidate, sourceText, status: "detached" as const })
              : candidate,
          ),
        });
        renderDraft();
        publishDraftState("content");
        renderDetail();
      });
    }
    clampDetailGeometry();
  }

  function selectNode(node: FlowNode, additive: boolean): void {
    if (selectedEdgeId !== null) selectedEdgeId = null;
    detailDraftNodeId = null;
    if ((draftState?.selectedNodeIds?.length ?? 0) > 0 && draftState !== null) {
      draftState = freezeDraftState({ ...draftState, selectedNodeIds: [] });
      publishDraftState("selection");
    }
    const selected = new Set(additive ? viewState.selectedNodeIds : []);
    if (additive && selected.has(node.id)) selected.delete(node.id);
    else selected.add(node.id);
    viewState = cloneViewState(viewState, {
      selectedNodeIds: [...selected],
    });
    renderSelection();
    renderDetail();
    publishViewState("selection");
    options.onNodeClick?.(node, viewState.selectedNodeIds);
  }

  function selectDraftNode(node: FlowCanvasDraftNode, additive: boolean): void {
    if (selectedEdgeId !== null) selectedEdgeId = null;
    if (draftState === null) return;
    const selected = new Set(additive ? (draftState.selectedNodeIds ?? []) : []);
    if (additive && selected.has(node.id)) selected.delete(node.id);
    else selected.add(node.id);
    draftState = freezeDraftState({ ...draftState, selectedNodeIds: [...selected] });
    if (viewState.selectedNodeIds.length > 0 || viewState.detailNodeId !== null) {
      viewState = cloneViewState(viewState, { selectedNodeIds: [], detailNodeId: null });
      publishViewState("selection");
    }
    renderSelection();
    renderDetail();
    publishDraftState("selection");
    options.onDraftNodeClick?.(node, draftState.selectedNodeIds ?? []);
  }

  function openNodeDetail(node: FlowNode): void {
    detailDraftNodeId = null;
    viewState = cloneViewState(viewState, { detailNodeId: node.id });
    renderDetail();
    publishViewState("detail");
  }

  function openDraftNodeDetail(node: FlowCanvasDraftNode): void {
    detailDraftNodeId = node.id;
    if (viewState.detailNodeId !== null) {
      viewState = cloneViewState(viewState, { detailNodeId: null });
    }
    renderDetail();
    publishViewState("detail");
  }

  function clearSelection(): void {
    const hadEdgeSelection = selectedEdgeId !== null;
    const hadProjectionSelection = viewState.selectedNodeIds.length > 0;
    const hadProjectionDetail = viewState.detailNodeId !== null;
    const hadDraftSelection = (draftState?.selectedNodeIds?.length ?? 0) > 0;
    const hadDraftDetail = detailDraftNodeId !== null;
    if (
      !hadProjectionSelection &&
      !hadProjectionDetail &&
      !hadDraftSelection &&
      !hadDraftDetail &&
      !hadEdgeSelection
    ) {
      return;
    }
    selectedEdgeId = null;
    viewState = cloneViewState(viewState, { selectedNodeIds: [], detailNodeId: null });
    detailDraftNodeId = null;
    if (draftState !== null && hadDraftSelection) {
      draftState = freezeDraftState({ ...draftState, selectedNodeIds: [] });
      publishDraftState("selection");
    }
    renderSelection();
    renderDetail();
    publishViewState("selection");
  }

  function startNodeGesture(event: PointerEvent, node: FlowNode): void {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const alreadySelected = viewState.selectedNodeIds.includes(node.id);
    if (additive || !alreadySelected) selectNode(node, additive);
    const selected = viewState.selectedNodeIds.includes(node.id)
      ? viewState.selectedNodeIds
      : [node.id];
    const origins: Record<string, FlowPoint> = {};
    for (const selectedId of selected) {
      const selectedNode = nodeForId(selectedId);
      if (selectedNode !== undefined) origins[selectedId] = positionFor(selectedNode);
    }
    gesture = {
      kind: "node",
      pointerId: event.pointerId,
      nodeId: node.id,
      startClient: point(event.clientX, event.clientY),
      origins: Object.freeze(origins),
      collapseSelectionOnClick: !additive && alreadySelected && selected.length > 1,
      openDetailOnRelease: markDetailPointerDown("projection", node.id),
      activated: false,
    };
  }

  function startDraftNodeGesture(event: PointerEvent, node: FlowCanvasDraftNode): void {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const alreadySelected = (draftState?.selectedNodeIds ?? []).includes(node.id);
    if (additive || !alreadySelected) selectDraftNode(node, additive);
    const draftSelection = draftState?.selectedNodeIds ?? [];
    const selected = draftSelection.includes(node.id) ? draftSelection : [node.id];
    const origins: Record<string, FlowPoint> = {};
    for (const selectedId of selected ?? []) {
      const selectedNode = draftNodeForId(selectedId);
      if (selectedNode !== undefined) origins[selectedId] = selectedNode.position;
    }
    gesture = {
      kind: "draft-node",
      pointerId: event.pointerId,
      nodeId: node.id,
      startClient: point(event.clientX, event.clientY),
      origins: Object.freeze(origins),
      collapseSelectionOnClick: !additive && alreadySelected && selected.length > 1,
      openDetailOnRelease: markDetailPointerDown("draft", node.id),
      activated: false,
    };
  }

  function startWireGesture(event: PointerEvent, node: FlowNode, port: FlowPort): void {
    if (
      port.channel !== "control" ||
      (port.direction === "input" ? !port.editable : port.edgeKind === null)
    ) {
      return;
    }
    const requested = wireEndpoint("projection", node.id, port);
    const wireStart = resolveFlowCanvasWireStart(projection, requested, selectedEdgeId);
    if (wireStart.status === "ambiguous") {
      announceWire(
        text(
          "这个插口连接了多根线。请先单击要修改的连接线，再拖动插头。",
          "Several cables use this socket. Select the cable to change, then drag its plug.",
        ),
        "warning",
      );
      return;
    }
    const anchorNode = nodeForId(wireStart.anchor.nodeId);
    const anchorPort = anchorNode?.ports.find(
      (candidate) => candidate.id === wireStart.anchor.portId,
    );
    if (anchorNode === undefined || anchorPort === undefined) return;
    const start = flowPortPoint(anchorNode, anchorPort, positionFor(anchorNode));
    gesture = {
      kind: "wire",
      source: wireStart.anchor.source,
      pointerId: event.pointerId,
      nodeId: wireStart.anchor.nodeId,
      portId: wireStart.anchor.portId,
      detached: wireStart.detached,
      replaceEdgeId: wireStart.replaceEdgeId,
      start,
      current: clientToWorld(root, viewState, event.clientX, event.clientY),
    };
    if (wireStart.replaceEdgeId !== null) {
      selectedEdgeId = wireStart.replaceEdgeId;
      clearNodeSelectionForEdge();
      edgeElements.get(wireStart.replaceEdgeId)?.classList.add("is-reconnecting");
      announceWire(
        text(
          "已拔出插头。拖到高亮的兼容插口完成改接；拖到空白或按 Escape 恢复原连接。",
          "Plug detached. Drop it on a highlighted compatible socket to rewire, or drop on empty space / press Escape to restore the original cable.",
        ),
      );
    } else {
      announceWire(
        text(
          "正在连接。拖到高亮的兼容插口完成插接。",
          "Connecting. Drop on a highlighted compatible socket.",
        ),
      );
    }
    renderWireCompatibility(wireStart.anchor);
    renderGestureWire();
  }

  function startDraftWireGesture(
    event: PointerEvent,
    node: FlowCanvasDraftNode,
    port: FlowCanvasDraftPort,
  ): void {
    if (
      !port.editable ||
      port.channel !== "control" ||
      (port.direction === "output" && port.edgeKind === null)
    ) {
      return;
    }
    gesture = {
      kind: "wire",
      source: "draft",
      pointerId: event.pointerId,
      nodeId: node.id,
      portId: port.id,
      detached: null,
      replaceEdgeId: null,
      start: draftPortPoint(node, port),
      current: clientToWorld(root, viewState, event.clientX, event.clientY),
    };
    renderWireCompatibility(wireEndpoint("draft", node.id, port));
    renderGestureWire();
  }

  function renderWireCompatibility(started: FlowCanvasWireEndpoint | null): void {
    root.classList.toggle("is-wiring", started !== null);
    for (const element of [...nodeElements.values(), ...draftNodeElements.values()]) {
      for (const portElement of element.querySelectorAll<HTMLElement>(
        "[data-flow-port-id], [data-flow-draft-port-id]",
      )) {
        delete portElement.dataset.wireTarget;
        delete portElement.dataset.wireLabel;
        if (started === null) continue;
        const endpoint =
          portElement.dataset.flowDraftPortId !== undefined
            ? resolveWireEndpoint(
                "draft",
                portElement.dataset.flowDraftNodeId ?? "",
                portElement.dataset.flowDraftPortId,
              )
            : resolveWireEndpoint(
                "projection",
                portElement.dataset.flowNodeId ?? "",
                portElement.dataset.flowPortId ?? "",
              );
        if (endpoint === null) continue;
        const target =
          gesture?.kind === "wire" &&
          gesture.detached?.nodeId === endpoint.nodeId &&
          gesture.detached.portId === endpoint.portId
            ? "detached"
            : endpoint.nodeId === started.nodeId && endpoint.portId === started.portId
              ? "source"
              : isStructurallyCompatibleWireTarget(started, endpoint)
                ? "compatible"
                : "invalid";
        portElement.dataset.wireTarget = target;
        const english = root.closest<HTMLElement>("[data-locale='en']") !== null;
        if (target === "compatible") portElement.dataset.wireLabel = english ? "connect" : "可连接";
        else if (target === "detached")
          portElement.dataset.wireLabel = english ? "restore" : "恢复";
      }
    }
  }

  function isStructurallyCompatibleWireTarget(
    started: FlowCanvasWireEndpoint,
    target: FlowCanvasWireEndpoint,
  ): boolean {
    const canonical = canonicalizeFlowCanvasWireEndpoints(started, target);
    if (canonical === null || started.nodeId === target.nodeId) return false;
    const fromNode =
      canonical.from.source === "projection"
        ? nodeForId(canonical.from.nodeId)
        : draftNodeForId(canonical.from.nodeId);
    const toNode =
      canonical.to.source === "projection"
        ? nodeForId(canonical.to.nodeId)
        : draftNodeForId(canonical.to.nodeId);
    if (fromNode === undefined || toNode === undefined) return false;
    if ("locked" in fromNode && fromNode.locked) return false;
    if ("locked" in toNode && toNode.locked) return false;
    if ("status" in fromNode && fromNode.status === "invalid") return false;
    if ("status" in toNode && toNode.status === "invalid") return false;
    const fromVirtual = "blockKind" in fromNode && fromNode.blockKind === "virtual";
    const toVirtual = "blockKind" in toNode && toNode.blockKind === "virtual";
    if (fromVirtual || toVirtual) {
      return (
        fromVirtual !== toVirtual &&
        (canonical.from.source === "projection" || canonical.to.source === "projection")
      );
    }
    if (canonical.from.source === "draft" || canonical.to.source === "draft") {
      return (
        canonical.from.source === "draft" &&
        canonical.to.source === "projection" &&
        endpointIsEditable(canonical.from) &&
        endpointIsEditable(canonical.to)
      );
    }
    if (!endpointIsEditable(canonical.from) || !endpointIsEditable(canonical.to)) return false;
    if (projection === null) return false;
    const reconnectingEdgeId = gesture?.kind === "wire" ? gesture.replaceEdgeId : null;
    const reconnectingEdge =
      reconnectingEdgeId === null
        ? undefined
        : projection.edges.find((edge) => edge.id === reconnectingEdgeId);
    if (reconnectingEdge !== undefined && reconnectingEdge.kind !== canonical.edgeKind)
      return false;
    const candidate = Object.freeze({
      sourceFingerprint: projection.sourceFingerprint,
      fromNodeId: canonical.from.nodeId,
      fromPortId: canonical.from.portId,
      toNodeId: canonical.to.nodeId,
      toPortId: canonical.to.portId,
      edgeKind: canonical.edgeKind,
      replaceEdgeId: reconnectingEdge?.id ?? null,
    });
    const graphPlan = planFlowConnection(
      projection,
      Object.freeze({
        sourceFingerprint: candidate.sourceFingerprint,
        fromNodeId: candidate.fromNodeId,
        fromPortId: candidate.fromPortId,
        toNodeId: candidate.toNodeId,
        toPortId: candidate.toPortId,
        kind: candidate.edgeKind,
        replaceEdgeId: candidate.replaceEdgeId,
      }),
    );
    return (
      graphPlan.status === "accepted" &&
      (options.onConnectionPreflight?.(candidate).accepted ?? true)
    );
  }

  function endpointIsEditable(endpoint: FlowCanvasWireEndpoint): boolean {
    if (endpoint.source === "projection") {
      return (
        nodeForId(endpoint.nodeId)?.ports.find((port) => port.id === endpoint.portId)?.editable ??
        false
      );
    }
    return (
      draftNodeForId(endpoint.nodeId)?.ports?.find((port) => port.id === endpoint.portId)
        ?.editable ?? false
    );
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed || event.button > 1) return;
    const target = closestElement(event.target);
    if (target === null) return;

    if (target.closest("[data-flow-minimap-viewport]") !== null) {
      if (event.button !== 0) return;
      const world = minimapWorldBounds;
      const map = minimap.svg.getBoundingClientRect();
      if (world === null || map.width <= 0 || map.height <= 0) return;
      event.preventDefault();
      gesture = {
        kind: "minimap-pan",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        origin: point(viewState.viewport.x, viewState.viewport.y),
        worldPerPixel: point(
          (world.right - world.left) / map.width,
          (world.bottom - world.top) / map.height,
        ),
      };
      root.setPointerCapture?.(event.pointerId);
      return;
    }
    if (target.closest("[data-flow-minimap]") !== null) return;

    if (target.closest("[data-flow-detail-resize]") !== null) {
      if (event.button !== 0) return;
      event.preventDefault();
      gesture = {
        kind: "detail-resize",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        origin: point(detail.window.offsetWidth, detail.window.offsetHeight),
      };
      root.setPointerCapture?.(event.pointerId);
      return;
    }
    if (
      event.button === 0 &&
      !isFlowDetailInteractiveTarget(target) &&
      target.closest("[data-flow-detail-handle]") !== null
    ) {
      event.preventDefault();
      gesture = {
        kind: "detail-move",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        origin: point(detail.window.offsetLeft, detail.window.offsetTop),
      };
      root.setPointerCapture?.(event.pointerId);
      return;
    }
    if (target.closest("[data-flow-detail-window]") !== null) return;
    root.focus({ preventScroll: true });

    const edgeHit = target.closest<SVGPathElement>("[data-flow-edge-hit-id]");
    if (edgeHit !== null && event.button === 0) {
      const edge = nearestEditableControlEdgeAtClientPoint(event.clientX, event.clientY, 12);
      if (edge !== undefined) {
        event.preventDefault();
        selectEdge(edge.id);
      }
      return;
    }

    if (event.button === 1 || spacePressed) {
      event.preventDefault();
      gesture = {
        kind: "pan",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        origin: point(viewState.viewport.x, viewState.viewport.y),
        clearSelectionOnClick: false,
        activated: false,
      };
      root.setPointerCapture?.(event.pointerId);
      return;
    }

    const draftPortElement = target.closest<HTMLElement>("[data-flow-draft-port-id]");
    if (draftPortElement !== null) {
      const node = draftNodeForId(draftPortElement.dataset.flowDraftNodeId ?? "");
      const port = node?.ports?.find(
        (candidate) => candidate.id === draftPortElement.dataset.flowDraftPortId,
      );
      if (node !== undefined && port !== undefined) {
        event.preventDefault();
        startDraftWireGesture(event, node, port);
        if (gesture !== null) root.setPointerCapture?.(event.pointerId);
      }
      return;
    }

    const portElement = target.closest<HTMLElement>("[data-flow-port-id]");
    if (portElement !== null) {
      const node = nodeForId(portElement.dataset.flowNodeId ?? "");
      const port = node?.ports.find((candidate) => candidate.id === portElement.dataset.flowPortId);
      if (node !== undefined && port !== undefined) {
        event.preventDefault();
        startWireGesture(event, node, port);
        if (gesture !== null) root.setPointerCapture?.(event.pointerId);
      }
      return;
    }

    const draftNodeElement = target.closest<HTMLElement>("[data-flow-draft-node-id]");
    if (draftNodeElement !== null) {
      const node = draftNodeForId(draftNodeElement.dataset.flowDraftNodeId ?? "");
      if (node !== undefined) {
        event.preventDefault();
        startDraftNodeGesture(event, node);
        root.setPointerCapture?.(event.pointerId);
      }
      return;
    }

    const nodeElement = target.closest<HTMLElement>("[data-flow-node-id]");
    if (nodeElement !== null) {
      const node = nodeForId(nodeElement.dataset.flowNodeId ?? "");
      if (node !== undefined) {
        event.preventDefault();
        startNodeGesture(event, node);
        root.setPointerCapture?.(event.pointerId);
      }
      return;
    }

    if (target.closest(".flow-canvas") !== root) return;
    event.preventDefault();
    if (event.button === 0 && event.shiftKey && !spacePressed) {
      gesture = {
        kind: "marquee",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        currentClient: point(event.clientX, event.clientY),
        additive: true,
      };
      marquee.hidden = false;
      renderMarquee(root, marquee, gesture);
    } else {
      gesture = {
        kind: "pan",
        pointerId: event.pointerId,
        startClient: point(event.clientX, event.clientY),
        origin: point(viewState.viewport.x, viewState.viewport.y),
        clearSelectionOnClick: event.button === 0 && !spacePressed,
        activated: false,
      };
    }
    root.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (destroyed || gesture === null || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "node") {
      if (!gesture.activated) {
        if (
          !exceedsFlowCanvasDragThreshold(
            gesture.startClient,
            point(event.clientX, event.clientY),
            NODE_DRAG_THRESHOLD,
          )
        )
          return;
        gesture.activated = true;
        lastDetailPointerDown = null;
        options.onHistoryCheckpoint?.();
        root.classList.add("is-moving-nodes");
      }
      const dx = (event.clientX - gesture.startClient.x) / viewState.viewport.zoom;
      const dy = (event.clientY - gesture.startClient.y) / viewState.viewport.zoom;
      const positions = { ...viewState.positions };
      for (const [nodeId, origin] of Object.entries(gesture.origins)) {
        positions[nodeId] = point(origin.x + dx, origin.y + dy);
      }
      viewState = cloneViewState(viewState, { positions });
      renderViewport();
      publishViewState("node-move");
    } else if (gesture.kind === "draft-node") {
      if (draftState === null) return;
      if (!gesture.activated) {
        if (
          !exceedsFlowCanvasDragThreshold(
            gesture.startClient,
            point(event.clientX, event.clientY),
            NODE_DRAG_THRESHOLD,
          )
        )
          return;
        gesture.activated = true;
        lastDetailPointerDown = null;
        options.onHistoryCheckpoint?.();
        root.classList.add("is-moving-nodes");
      }
      const dx = (event.clientX - gesture.startClient.x) / viewState.viewport.zoom;
      const dy = (event.clientY - gesture.startClient.y) / viewState.viewport.zoom;
      draftState = freezeDraftState({
        ...draftState,
        nodes: draftState.nodes.map((node) => {
          const origin = gesture?.kind === "draft-node" ? gesture.origins[node.id] : undefined;
          return origin === undefined
            ? node
            : { ...node, position: point(origin.x + dx, origin.y + dy) };
        }),
      });
      renderDraft();
      publishDraftState("node-move");
    } else if (gesture.kind === "pan") {
      if (!gesture.activated) {
        if (
          !exceedsFlowCanvasDragThreshold(
            gesture.startClient,
            point(event.clientX, event.clientY),
            PAN_DRAG_THRESHOLD,
          )
        )
          return;
        gesture.activated = true;
        root.classList.add("is-panning");
      }
      viewState = cloneViewState(viewState, {
        viewport: {
          ...viewState.viewport,
          x: gesture.origin.x + event.clientX - gesture.startClient.x,
          y: gesture.origin.y + event.clientY - gesture.startClient.y,
        },
      });
      renderViewport();
      publishViewState("viewport");
    } else if (gesture.kind === "marquee") {
      gesture.currentClient = point(event.clientX, event.clientY);
      renderMarquee(root, marquee, gesture);
    } else if (gesture.kind === "wire") {
      gesture.current = clientToWorld(root, viewState, event.clientX, event.clientY);
      renderGestureWire();
    } else if (gesture.kind === "minimap-pan") {
      const dx = (event.clientX - gesture.startClient.x) * gesture.worldPerPixel.x;
      const dy = (event.clientY - gesture.startClient.y) * gesture.worldPerPixel.y;
      viewState = cloneViewState(viewState, {
        viewport: {
          ...viewState.viewport,
          x: gesture.origin.x - dx * viewState.viewport.zoom,
          y: gesture.origin.y - dy * viewState.viewport.zoom,
        },
      });
      renderViewport();
      publishViewState("viewport");
    } else if (gesture.kind === "detail-move") {
      setDetailPosition(
        gesture.origin.x + event.clientX - gesture.startClient.x,
        gesture.origin.y + event.clientY - gesture.startClient.y,
      );
    } else {
      setDetailSize(
        gesture.origin.x + event.clientX - gesture.startClient.x,
        gesture.origin.y + event.clientY - gesture.startClient.y,
      );
    }
  };

  const finishGesture = (event: PointerEvent): void => {
    if (destroyed || gesture === null || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "marquee") finishMarquee(gesture);
    else if (gesture.kind === "wire") finishWire(gesture, event);
    else if (gesture.kind === "node" && !gesture.activated) {
      const node = nodeForId(gesture.nodeId);
      if (node !== undefined) {
        if (gesture.collapseSelectionOnClick) selectNode(node, false);
        if (gesture.openDetailOnRelease) openNodeDetail(node);
      }
    } else if (gesture.kind === "draft-node" && !gesture.activated) {
      const node = draftNodeForId(gesture.nodeId);
      if (node !== undefined) {
        if (gesture.collapseSelectionOnClick) selectDraftNode(node, false);
        if (gesture.openDetailOnRelease) openDraftNodeDetail(node);
      }
    } else if (gesture.kind === "pan" && !gesture.activated && gesture.clearSelectionOnClick) {
      clearSelection();
    }
    clearGesture(event.pointerId);
  };

  function markDetailPointerDown(source: "projection" | "draft", nodeId: string): boolean {
    const at = Date.now();
    const previous = lastDetailPointerDown;
    if (
      previous !== null &&
      previous.source === source &&
      previous.nodeId === nodeId &&
      at - previous.at >= 0 &&
      at - previous.at <= 500
    ) {
      lastDetailPointerDown = null;
      return true;
    }
    lastDetailPointerDown = Object.freeze({ source, nodeId, at });
    return false;
  }

  const cancelGesture = (event: PointerEvent): void => {
    if (destroyed || gesture === null || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "wire" && gesture.replaceEdgeId !== null) {
      announceWire(
        text("改接已取消，原连接已恢复。", "Rewire cancelled; the original cable was restored."),
      );
    }
    clearGesture(event.pointerId);
  };

  function clearGesture(pointerId: number): void {
    gesture = null;
    root.classList.remove("is-panning");
    root.classList.remove("is-moving-nodes");
    for (const element of edgeElements.values()) element.classList.remove("is-reconnecting");
    marquee.hidden = true;
    if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId);
    renderWireCompatibility(null);
    renderGestureWire();
    renderEdgeSelection();
  }

  function finishMarquee(current: MarqueeGesture): void {
    const start = clientToWorld(root, viewState, current.startClient.x, current.startClient.y);
    const end = clientToWorld(root, viewState, current.currentClient.x, current.currentClient.y);
    const bounds = normalizedBounds(start, end);
    const selected = new Set(current.additive ? viewState.selectedNodeIds : []);
    for (const node of projection?.nodes ?? []) {
      const position = positionFor(node);
      if (
        rectanglesIntersect(bounds, {
          left: position.x,
          top: position.y,
          right: position.x + NODE_WIDTH,
          bottom: position.y + NODE_HEIGHT,
        })
      ) {
        selected.add(node.id);
      }
    }
    viewState = cloneViewState(viewState, { selectedNodeIds: [...selected] });
    if (draftState !== null) {
      const selectedDrafts = new Set(current.additive ? (draftState.selectedNodeIds ?? []) : []);
      for (const node of draftState.nodes) {
        if (
          rectanglesIntersect(bounds, {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + NODE_WIDTH,
            bottom: node.position.y + NODE_HEIGHT,
          })
        ) {
          selectedDrafts.add(node.id);
        }
      }
      draftState = freezeDraftState({ ...draftState, selectedNodeIds: [...selectedDrafts] });
      publishDraftState("selection");
    }
    renderSelection();
    publishViewState("selection");
  }

  function finishWire(current: WireGesture, event: PointerEvent): void {
    const target = ownerDocument.elementFromPoint?.(event.clientX, event.clientY);
    if (projection === null) return;
    const started = resolveWireEndpoint(current.source, current.nodeId, current.portId);
    if (started === null) return;
    const dropped = target instanceof Element ? resolveWireDropEndpoint(target) : null;
    if (dropped === null) {
      if (current.replaceEdgeId !== null) {
        announceWire(
          text(
            "没有插入新端口，原连接已恢复。",
            "No new socket was selected; the original cable was restored.",
          ),
        );
        return;
      }
      if (
        target instanceof Element &&
        target.closest("[data-flow-detail-window], [data-flow-minimap]") === null &&
        target.closest(".flow-canvas") === root
      ) {
        requestCompatibleBlockSearch(
          started,
          clientToWorld(root, viewState, event.clientX, event.clientY),
        );
      }
      return;
    }
    if (
      current.detached !== null &&
      current.detached.source === dropped.source &&
      current.detached.nodeId === dropped.nodeId &&
      current.detached.portId === dropped.portId
    ) {
      announceWire(
        text(
          "插头已放回原端口，连接保持不变。",
          "The plug returned to its original socket; the cable is unchanged.",
        ),
      );
      return;
    }
    const connection = canonicalizeFlowCanvasWireEndpoints(started, dropped);
    if (connection === null || !isStructurallyCompatibleWireTarget(started, dropped)) {
      announceWire(
        text(
          "该插口不兼容，原连接已恢复。",
          "That socket is incompatible; the original cable was restored.",
        ),
        "warning",
      );
      return;
    }

    const fromDraft =
      connection.from.source === "draft" ? draftNodeForId(connection.from.nodeId) : undefined;
    const toDraft =
      connection.to.source === "draft" ? draftNodeForId(connection.to.nodeId) : undefined;
    const fromVirtual = fromDraft?.blockKind === "virtual";
    const toVirtual = toDraft?.blockKind === "virtual";

    if (fromVirtual || toVirtual) {
      if (
        (connection.from.source === "draft" && !fromVirtual) ||
        (connection.to.source === "draft" && !toVirtual) ||
        (fromVirtual && toVirtual)
      ) {
        return;
      }
      options.onVirtualConnectionIntent?.(
        Object.freeze({
          sourceFingerprint: projection.sourceFingerprint,
          from: virtualEndpoint(connection.from),
          to: virtualEndpoint(connection.to),
        }),
      );
      return;
    }

    if (connection.from.source === "draft" && connection.to.source === "projection") {
      const sourceNode = fromDraft;
      const sourcePort = sourceNode?.ports?.find((port) => port.id === connection.from.portId);
      const targetNode = nodeForId(connection.to.nodeId);
      const targetPort = targetNode?.ports.find((port) => port.id === connection.to.portId);
      if (
        sourceNode === undefined ||
        sourcePort === undefined ||
        targetNode === undefined ||
        targetPort === undefined
      ) {
        return;
      }
      const intent = createFlowCanvasDraftConnectionIntent(
        projection,
        sourceNode,
        sourcePort,
        targetNode,
        targetPort,
      );
      if (intent !== null) options.onDraftConnectionIntent?.(intent);
      return;
    }

    if (connection.from.source !== "projection" || connection.to.source !== "projection") return;
    const sourceNode = nodeForId(connection.from.nodeId);
    const sourcePort = sourceNode?.ports.find((port) => port.id === connection.from.portId);
    const targetNode = nodeForId(connection.to.nodeId);
    const targetPort = targetNode?.ports.find((port) => port.id === connection.to.portId);
    if (
      sourceNode === undefined ||
      sourcePort === undefined ||
      !sourcePort.editable ||
      targetNode === undefined ||
      targetPort === undefined ||
      !targetPort.editable
    ) {
      return;
    }
    announceWire(
      text("正在校验 C 语法、源码差异与 CFG…", "Validating C syntax, source diff, and CFG…"),
    );
    options.onConnectionIntent?.(
      Object.freeze({
        sourceFingerprint: projection.sourceFingerprint,
        fromNodeId: sourceNode.id,
        fromPortId: sourcePort.id,
        toNodeId: targetNode.id,
        toPortId: targetPort.id,
        edgeKind: connection.edgeKind,
        replaceEdgeId: current.replaceEdgeId,
      }),
    );
  }

  function requestCompatibleBlockSearch(
    endpoint: FlowCanvasWireEndpoint,
    worldPosition: FlowPoint,
  ): void {
    if (projection === null) return;
    const request = Object.freeze({
      sourceFingerprint: projection.sourceFingerprint,
      endpoint,
      compatibleDirection: endpoint.direction === "output" ? "input" : "output",
      worldPosition: Object.freeze(point(worldPosition.x, worldPosition.y)),
    });
    options.onCompatibleBlockSearch?.(request);
    dispatchCanvasEvent(root, FLOW_CANVAS_QUICK_ADD_EVENT, request);
    if (options.onCompatibleBlockSearch === undefined) focusPresetSearch(ownerDocument);
  }

  function resolveWireEndpoint(
    source: WireGesture["source"],
    nodeId: string,
    portId: string,
  ): FlowCanvasWireEndpoint | null {
    if (source === "projection") {
      const node = nodeForId(nodeId);
      const port = node?.ports.find((candidate) => candidate.id === portId);
      return node === undefined || port === undefined
        ? null
        : wireEndpoint("projection", node.id, port);
    }
    const node = draftNodeForId(nodeId);
    const port = node?.ports?.find((candidate) => candidate.id === portId);
    return node === undefined || port === undefined ? null : wireEndpoint("draft", node.id, port);
  }

  function resolveWireDropEndpoint(target: Element): FlowCanvasWireEndpoint | null {
    const draftPortElement = target.closest<HTMLElement>("[data-flow-draft-port-id]");
    if (draftPortElement !== null) {
      return resolveWireEndpoint(
        "draft",
        draftPortElement.dataset.flowDraftNodeId ?? "",
        draftPortElement.dataset.flowDraftPortId ?? "",
      );
    }
    const portElement = target.closest<HTMLElement>("[data-flow-port-id]");
    return portElement === null
      ? null
      : resolveWireEndpoint(
          "projection",
          portElement.dataset.flowNodeId ?? "",
          portElement.dataset.flowPortId ?? "",
        );
  }

  function nearestEditableControlEdgeAtClientPoint(
    clientX: number,
    clientY: number,
    tolerancePx: number,
    kind: FlowEdge["kind"] | null = null,
  ): FlowEdge | undefined {
    if (
      projection === null ||
      !Number.isFinite(clientX) ||
      !Number.isFinite(clientY) ||
      !Number.isFinite(tolerancePx) ||
      tolerancePx <= 0
    ) {
      return undefined;
    }
    const world = clientToWorld(root, viewState, clientX, clientY);
    const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
    refreshControlWireRouteCache();
    let nearest: { readonly edge: FlowEdge; readonly distance: number } | undefined;
    for (const edge of projection.edges) {
      if (!edge.editable || (kind !== null && edge.kind !== kind)) continue;
      const fromNode = nodes.get(edge.from.nodeId);
      const toNode = nodes.get(edge.to.nodeId);
      const fromPort = fromNode?.ports.find((port) => port.id === edge.from.portId);
      const toPort = toNode?.ports.find((port) => port.id === edge.to.portId);
      if (
        fromNode === undefined ||
        toNode === undefined ||
        fromPort === undefined ||
        toPort === undefined ||
        fromNode.locked ||
        toNode.locked ||
        !toPort.editable
      ) {
        continue;
      }
      const from = flowPortPoint(fromNode, fromPort, positionFor(fromNode));
      const to = flowPortPoint(toNode, toPort, positionFor(toNode));
      const route = controlWireRoute(edge, fromNode, toNode, from, to);
      const distance = distanceToFlowWireRoute(world, route);
      if (
        distance <= tolerancePx / viewState.viewport.zoom &&
        (nearest === undefined ||
          distance < nearest.distance ||
          (distance === nearest.distance && edge.id === selectedEdgeId))
      ) {
        nearest = { edge, distance };
      }
    }
    return nearest?.edge;
  }

  const onWheel = (event: WheelEvent): void => {
    if (destroyed || projection === null) return;
    const target = closestElement(event.target);
    if (
      target !== null &&
      target.closest("[data-flow-detail-window], [data-flow-minimap]") !== null
    )
      return;
    event.preventDefault();
    const bounds = root.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const nextZoom = clamp(
        viewState.viewport.zoom * Math.exp(-event.deltaY * 0.0015),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const cursorX = event.clientX - bounds.left;
      const cursorY = event.clientY - bounds.top;
      const worldX = (cursorX - viewState.viewport.x) / viewState.viewport.zoom;
      const worldY = (cursorY - viewState.viewport.y) / viewState.viewport.zoom;
      viewState = cloneViewState(viewState, {
        viewport: {
          x: cursorX - worldX * nextZoom,
          y: cursorY - worldY * nextZoom,
          zoom: nextZoom,
        },
      });
    } else {
      viewState = cloneViewState(viewState, {
        viewport: {
          ...viewState.viewport,
          x: viewState.viewport.x - event.deltaX,
          y: viewState.viewport.y - event.deltaY,
        },
      });
    }
    renderViewport();
    publishViewState("viewport");
  };

  function fitAllNodes(): void {
    const bounds = flowItemBounds(projection, viewState, draftState);
    if (bounds === null) return;
    viewState = cloneViewState(viewState, {
      viewport: fitFlowCanvasViewport(bounds, canvasPixelSize(root), VIEWPORT_FIT_PADDING, 1.5),
    });
    renderViewport();
    publishViewState("viewport");
  }

  function focusSelectedNodes(): void {
    const bounds = selectedItemBounds(projection, viewState, draftState);
    if (bounds === null) return;
    viewState = cloneViewState(viewState, {
      viewport: fitFlowCanvasViewport(bounds, canvasPixelSize(root), VIEWPORT_FIT_PADDING, 1.8),
    });
    renderViewport();
    publishViewState("viewport");
  }

  function openSelectedDetail(): boolean {
    const selectedProjectionId = viewState.selectedNodeIds[0];
    if (selectedProjectionId !== undefined) {
      const node = nodeForId(selectedProjectionId);
      if (node !== undefined) {
        openNodeDetail(node);
        return true;
      }
    }
    const selectedDraftId = draftState?.selectedNodeIds?.[0];
    if (selectedDraftId !== undefined) {
      const node = draftNodeForId(selectedDraftId);
      if (node !== undefined) {
        openDraftNodeDetail(node);
        return true;
      }
    }
    return false;
  }

  const onKeydown = (event: KeyboardEvent): void => {
    const detailTarget = closestElement(event.target);
    const detailDelta = keyboardDelta(event.key, event.shiftKey ? 24 : 8);
    if (
      detailDelta !== null &&
      detailTarget?.closest("[data-flow-detail-handle]") === detail.header &&
      !isFlowDetailInteractiveTarget(detailTarget)
    ) {
      event.preventDefault();
      event.stopPropagation();
      setDetailPosition(
        detail.window.offsetLeft + detailDelta.x,
        detail.window.offsetTop + detailDelta.y,
      );
      return;
    }
    if (
      detailDelta !== null &&
      detailTarget?.closest("[data-flow-detail-resize]") === detail.resize
    ) {
      event.preventDefault();
      event.stopPropagation();
      setDetailSize(
        detail.window.offsetWidth + detailDelta.x,
        detail.window.offsetHeight + detailDelta.y,
      );
      return;
    }
    if (destroyed || isEditableTarget(event.target)) return;
    if (event.key === " ") {
      event.preventDefault();
      spacePressed = true;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (gesture !== null) {
        if (gesture.kind === "wire" && gesture.replaceEdgeId !== null) {
          announceWire(
            text(
              "改接已取消，原连接已恢复。",
              "Rewire cancelled; the original cable was restored.",
            ),
          );
        }
        clearGesture(gesture.pointerId);
        return;
      }
      if (viewState.detailNodeId !== null || detailDraftNodeId !== null) {
        viewState = cloneViewState(viewState, { detailNodeId: null });
        detailDraftNodeId = null;
        renderDetail();
        publishViewState("detail");
      }
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    if (!command && event.key === "Enter") {
      if (openSelectedDetail()) event.preventDefault();
      return;
    }
    if (!command && event.key === "Home") {
      event.preventDefault();
      fitAllNodes();
      return;
    }
    if (!command && event.key.toLowerCase() === "f") {
      event.preventDefault();
      focusSelectedNodes();
      return;
    }
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      viewState = cloneViewState(viewState, {
        selectedNodeIds: projection?.nodes.map((node) => node.id) ?? [],
      });
      if (draftState !== null) {
        draftState = freezeDraftState({
          ...draftState,
          selectedNodeIds: draftState.nodes.map((node) => node.id),
        });
        publishDraftState("selection");
      }
      renderSelection();
      publishViewState("selection");
      return;
    }
    if (
      command &&
      event.key.toLowerCase() === "c" &&
      (viewState.selectedNodeIds.length > 0 || (draftState?.selectedNodeIds?.length ?? 0) > 0)
    ) {
      event.preventDefault();
      options.onHistoryCheckpoint?.();
      // Snapshot before invoking callbacks: onCopyNodes synchronously presents the new draft back
      // to this canvas. Reading live selection afterwards would copy that just-created draft a
      // second time during the same Cmd/Ctrl+C key event.
      const projectedSelection = Object.freeze([...viewState.selectedNodeIds]);
      const draftSelection = Object.freeze([...(draftState?.selectedNodeIds ?? [])]);
      if (projectedSelection.length > 0) {
        options.onCopyNodes?.(projectedSelection);
        viewState = cloneViewState(viewState, { selectedNodeIds: [], detailNodeId: null });
        renderSelection();
        renderDetail();
        publishViewState("selection");
      } else if (draftState !== null && draftSelection.length > 0) {
        const selected = new Set(draftSelection);
        const copies = draftState.nodes
          .filter((node) => selected.has(node.id))
          .map((node, index) =>
            Object.freeze({
              ...node,
              id: `${node.id}:copy:${String(Date.now())}:${String(index)}`,
              position: Object.freeze(point(node.position.x + 24, node.position.y + 42)),
              placedAt: new Date().toISOString(),
            }),
          );
        draftState = freezeDraftState({
          ...draftState,
          nodes: [...draftState.nodes, ...copies],
          selectedNodeIds: copies.map((node) => node.id),
        });
        renderDraft();
        publishDraftState("content");
      }
      return;
    }
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      options.onUndo?.();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedEdgeId !== null) {
      event.preventDefault();
      announceWire(
        text(
          "不能单独删除真实控制流。要改变去向，请拖动输入端；要移除逻辑，请删除对应语句或分支节点。",
          "A real control-flow cable cannot be deleted by itself. Drag the input end to change its destination, or delete the corresponding statement or branch node to remove the logic.",
        ),
        "warning",
      );
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      (viewState.selectedNodeIds.length > 0 || (draftState?.selectedNodeIds?.length ?? 0) > 0)
    ) {
      event.preventDefault();
      const selectedDraftIds = draftState?.selectedNodeIds ?? [];
      if (draftState !== null && selectedDraftIds.length > 0) {
        options.onHistoryCheckpoint?.();
        const deleted = Object.freeze([...selectedDraftIds]);
        const deletedSet = new Set(deleted);
        draftState = freezeDraftState({
          ...draftState,
          nodes: draftState.nodes.filter((node) => !deletedSet.has(node.id)),
          virtualEdges: (draftState.virtualEdges ?? []).filter(
            (edge) => !deletedSet.has(edge.from.nodeId) && !deletedSet.has(edge.to.nodeId),
          ),
          selectedNodeIds: [],
        });
        if (detailDraftNodeId !== null && deletedSet.has(detailDraftNodeId)) {
          detailDraftNodeId = null;
          renderDetail();
        }
        renderDraft();
        publishDraftState("delete");
        options.onDeleteDraftNodes?.(deleted);
      }
      if (viewState.selectedNodeIds.length > 0) {
        options.onDeleteNodes?.(viewState.selectedNodeIds);
      }
      return;
    }
    const delta = keyboardDelta(event.key, event.shiftKey ? KEYBOARD_MOVE * 5 : KEYBOARD_MOVE);
    const selectedDraftIds = draftState?.selectedNodeIds ?? [];
    if (
      delta === null ||
      (viewState.selectedNodeIds.length === 0 && selectedDraftIds.length === 0)
    ) {
      return;
    }
    event.preventDefault();
    options.onHistoryCheckpoint?.();
    const positions = { ...viewState.positions };
    for (const nodeId of viewState.selectedNodeIds) {
      const node = nodeForId(nodeId);
      if (node === undefined) continue;
      const origin = positionFor(node);
      positions[nodeId] = point(origin.x + delta.x, origin.y + delta.y);
    }
    viewState = cloneViewState(viewState, { positions });
    if (draftState !== null && selectedDraftIds.length > 0) {
      const selectedDraftSet = new Set(selectedDraftIds);
      draftState = freezeDraftState({
        ...draftState,
        nodes: draftState.nodes.map((node) =>
          selectedDraftSet.has(node.id)
            ? { ...node, position: point(node.position.x + delta.x, node.position.y + delta.y) }
            : node,
        ),
      });
      renderDraft();
      publishDraftState("keyboard-move");
    }
    renderViewport();
    publishViewState("keyboard-move");
  };

  const onKeyup = (event: KeyboardEvent): void => {
    if (event.key === " ") spacePressed = false;
  };

  const onDetailClick = (event: MouseEvent): void => {
    const target = closestElement(event.target);
    if (target !== null && target.closest("[data-flow-detail-close]") !== null) {
      viewState = cloneViewState(viewState, { detailNodeId: null });
      detailDraftNodeId = null;
      renderDetail();
      publishViewState("detail");
    } else if (target !== null && target.closest("[data-flow-detail-minimize]") !== null) {
      const minimized = detail.window.dataset.minimized !== "true";
      detail.window.dataset.minimized = String(minimized);
      detail.body.hidden = minimized;
      detail.resize.hidden = minimized;
      detail.minimize.textContent = minimized ? text("展开", "Expand") : text("收起", "Collapse");
      detail.minimize.setAttribute("aria-expanded", String(!minimized));
    }
  };

  const onDoubleClick = (event: MouseEvent): void => {
    const target = closestElement(event.target);
    if (
      target === null ||
      target.closest(
        "[data-flow-port-id], [data-flow-draft-port-id], [data-flow-detail-window], [data-flow-minimap]",
      ) !== null
    ) {
      return;
    }
    const draftElement = target.closest<HTMLElement>("[data-flow-draft-node-id]");
    if (draftElement !== null) {
      const node = draftNodeForId(draftElement.dataset.flowDraftNodeId ?? "");
      if (node !== undefined) {
        event.preventDefault();
        if (!(draftState?.selectedNodeIds ?? []).includes(node.id)) selectDraftNode(node, false);
        openDraftNodeDetail(node);
      }
      return;
    }
    const element = target.closest<HTMLElement>("[data-flow-node-id]");
    if (element === null) return;
    const node = nodeForId(element.dataset.flowNodeId ?? "");
    if (node === undefined) return;
    event.preventDefault();
    if (!viewState.selectedNodeIds.includes(node.id)) selectNode(node, false);
    openNodeDetail(node);
  };

  const onMinimapClick = (event: MouseEvent): void => {
    const target = closestElement(event.target);
    if (target === null || target.closest("[data-flow-minimap-toggle]") === null) return;
    const collapsed = minimap.root.dataset.collapsed !== "true";
    minimap.root.dataset.collapsed = String(collapsed);
    minimap.svg.style.display = collapsed ? "none" : "block";
    minimap.toggle.setAttribute("aria-expanded", String(!collapsed));
    minimap.toggle.setAttribute(
      "aria-label",
      collapsed
        ? text("展开画布概览", "Expand canvas overview")
        : text("收起画布概览", "Collapse canvas overview"),
    );
  };

  const onBlur = (): void => {
    spacePressed = false;
  };

  const onWindowBlur = (): void => {
    spacePressed = false;
    if (gesture === null) return;
    const pointerId = gesture.pointerId;
    if (gesture.kind === "wire" && gesture.replaceEdgeId !== null) {
      announceWire(
        text("改接已取消，原连接已恢复。", "Rewire cancelled; the original cable was restored."),
      );
    }
    clearGesture(pointerId);
  };

  const applyLocaleCopy = (): void => {
    root.setAttribute(
      "aria-label",
      text(
        "算法流程画布。单击选择，双击或回车打开详情，拖动空白平移，Shift 拖动框选。",
        "Algorithm flow canvas. Click to select, double-click or press Enter for details, drag empty space to pan, and Shift-drag to marquee-select.",
      ),
    );
    emptyState.textContent = text(
      "打开 C 文件后，这里会显示可自由摆放的流程节点。",
      "Open a C file to show freely positioned flow nodes here.",
    );
    detail.window.setAttribute("aria-label", text("节点详情", "Node details"));
    detail.header.setAttribute("aria-label", text("移动节点详情", "Move node details"));
    detail.minimize.textContent =
      detail.window.dataset.minimized === "true"
        ? text("展开", "Expand")
        : text("收起", "Collapse");
    detail.close.textContent = text("关闭", "Close");
    detail.resize.setAttribute("aria-label", text("调整节点详情大小", "Resize node details"));
    minimap.root.setAttribute("aria-label", text("画布概览", "Canvas overview"));
    minimap.toggle.textContent = text("概览", "Overview");
    minimap.toggle.setAttribute(
      "aria-label",
      minimap.root.dataset.collapsed === "true"
        ? text("展开画布概览", "Expand canvas overview")
        : text("收起画布概览", "Collapse canvas overview"),
    );
    minimap.svg.setAttribute(
      "aria-label",
      text("节点、运行路径与当前视口", "Nodes, runtime path, and current viewport"),
    );
  };

  const onLocaleChange = (): void => {
    if (destroyed) return;
    applyLocaleCopy();
    wireStatus.textContent = "";
    renderProjection();
    renderDraft();
    renderDetail();
    renderEdgeSelection();
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", finishGesture);
  root.addEventListener("pointercancel", cancelGesture);
  root.addEventListener("lostpointercapture", cancelGesture);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("keyup", onKeyup);
  root.addEventListener("dblclick", onDoubleClick);
  root.addEventListener("blur", onBlur);
  ownerDocument.defaultView?.addEventListener("blur", onWindowBlur);
  detail.window.addEventListener("click", onDetailClick);
  minimap.root.addEventListener("click", onMinimapClick);
  localeHost.addEventListener?.("workbench-locale-change", onLocaleChange);
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          const recovered = recoverRestoredViewportIfReady();
          if (recovered) {
            renderViewport();
            publishViewState("restore");
          }
          renderMinimap();
          clampDetailGeometry();
        });
  resizeObserver?.observe(root);
  applyLocaleCopy();
  publishInteractionContext();

  return Object.freeze({
    element: root,
    setProjection(nextProjection: FlowProjection | null): void {
      assertActive(destroyed);
      projection = nextProjection;
      viewState =
        nextProjection === null
          ? emptyViewState("")
          : normalizeFlowCanvasViewState(nextProjection, viewState);
      activePath = emptyActivePath();
      gesture = null;
      root.classList.remove("is-panning", "is-moving-nodes", "is-wiring");
      renderProjection();
      publishViewState("projection");
    },
    setViewState(nextViewState: FlowViewState): void {
      assertActive(destroyed);
      setInternalViewState(nextViewState, "restore");
    },
    getViewState(): FlowViewState {
      assertActive(destroyed);
      return cloneViewState(viewState);
    },
    setActivePath(nextPath: FlowCanvasActivePath | readonly string[]): void {
      assertActive(destroyed);
      const requested = Array.isArray(nextPath)
        ? Object.freeze({
            nodeIds: Object.freeze([...nextPath]),
            edgeIds: Object.freeze([]),
            currentNodeId: nextPath.at(-1) ?? null,
            mode: "real" as const,
          })
        : freezeActivePath(nextPath as FlowCanvasActivePath);
      activePath = normalizeActivePathForCanvas(requested, projection, draftState);
      renderActivePath();
    },
    setDraftVisualState(nextDraftState: FlowCanvasDraftVisualState | null): void {
      assertActive(destroyed);
      draftState = nextDraftState === null ? null : freezeDraftState(nextDraftState);
      if (detailDraftNodeId !== null && draftNodeForId(detailDraftNodeId) === undefined) {
        detailDraftNodeId = null;
      }
      renderDraft();
      renderDetail();
      if (draftState !== null) publishDraftState("restore");
    },
    getDraftVisualState(): FlowCanvasDraftVisualState | null {
      assertActive(destroyed);
      return draftState === null ? null : freezeDraftState(draftState);
    },
    findEditableControlEdgeAtClientPoint(
      clientX: number,
      clientY: number,
      tolerancePx = 14,
    ): FlowEdge | null {
      assertActive(destroyed);
      return nearestEditableControlEdgeAtClientPoint(clientX, clientY, tolerancePx, "next") ?? null;
    },
    setEdgeInsertionPreview(edgeId: string | null): void {
      assertActive(destroyed);
      if (edgeId !== null && !edgeElements.has(edgeId)) return;
      if (edgeInsertionPreviewId === edgeId) return;
      if (edgeInsertionPreviewId !== null) {
        edgeElements.get(edgeInsertionPreviewId)?.classList.remove("is-insertion-preview");
      }
      edgeInsertionPreviewId = edgeId;
      if (edgeId !== null) edgeElements.get(edgeId)?.classList.add("is-insertion-preview");
    },
    focusNode(nodeId: string): void {
      assertActive(destroyed);
      const node = nodeForId(nodeId);
      const element = nodeElements.get(nodeId);
      if (node === undefined || element === undefined)
        throw new RangeError(`未知流程节点：${nodeId}`);
      viewState = cloneViewState(viewState, {
        selectedNodeIds: [nodeId],
        detailNodeId: nodeId,
      });
      renderSelection();
      renderDetail();
      element.focus();
      publishViewState("selection");
    },
    refreshDetail(): void {
      assertActive(destroyed);
      renderDetail();
    },
    alignSelection(mode: "left" | "distribute-y"): void {
      assertActive(destroyed);
      const selected = selectedPositions(projection, viewState, draftState);
      if (selected.length < (mode === "left" ? 2 : 3)) return;
      options.onHistoryCheckpoint?.();
      const updates = alignFlowCanvasPositions(selected, mode);
      viewState = cloneViewState(viewState, {
        positions: Object.freeze({
          ...viewState.positions,
          ...Object.fromEntries(
            [...updates.entries()]
              .filter(([id]) => nodeForId(id) !== undefined)
              .map(([id, value]) => [id, value]),
          ),
        }),
      });
      if (draftState !== null) {
        draftState = freezeDraftState({
          ...draftState,
          nodes: draftState.nodes.map((node) =>
            updates.has(node.id) ? { ...node, position: updates.get(node.id)! } : node,
          ),
        });
        renderDraft();
        publishDraftState("align");
      }
      renderViewport();
      publishViewState("align");
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      gesture = null;
      if (wireStatusTimer !== null) {
        clearTimeout(wireStatusTimer);
        wireStatusTimer = null;
      }
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", finishGesture);
      root.removeEventListener("pointercancel", cancelGesture);
      root.removeEventListener("lostpointercapture", cancelGesture);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("keydown", onKeydown);
      root.removeEventListener("keyup", onKeyup);
      root.removeEventListener("dblclick", onDoubleClick);
      root.removeEventListener("blur", onBlur);
      ownerDocument.defaultView?.removeEventListener("blur", onWindowBlur);
      detail.window.removeEventListener("click", onDetailClick);
      minimap.root.removeEventListener("click", onMinimapClick);
      localeHost.removeEventListener?.("workbench-locale-change", onLocaleChange);
      resizeObserver?.disconnect();
      if (minimapAnimationFrame !== null) {
        ownerDocument.defaultView?.cancelAnimationFrame(minimapAnimationFrame);
        minimapAnimationFrame = null;
      }
      root.remove();
      nodeElements.clear();
      edgeElements.clear();
      edgeHitElements.clear();
      virtualEdgeElements.clear();
      draftNodeElements.clear();
      detailDraftNodeId = null;
    },
  });
}

export function normalizeFlowCanvasViewState(
  projection: FlowProjection,
  candidate: FlowViewState | null | undefined,
): FlowViewState {
  const knownIds = new Set(projection.nodes.map((node) => node.id));
  const sameSource = candidate?.sourceFingerprint === projection.sourceFingerprint;
  const positions: Record<string, FlowPoint> = {};
  for (const node of projection.nodes) {
    const candidatePosition = sameSource ? candidate?.positions[node.id] : undefined;
    positions[node.id] = isFinitePoint(candidatePosition)
      ? point(candidatePosition.x, candidatePosition.y)
      : point(node.defaultPosition.x, node.defaultPosition.y);
  }
  const selectedNodeIds = sameSource
    ? [...new Set(candidate?.selectedNodeIds.filter((id) => knownIds.has(id)) ?? [])]
    : [];
  const detailNodeId =
    sameSource &&
    candidate?.detailNodeId !== null &&
    candidate?.detailNodeId !== undefined &&
    knownIds.has(candidate.detailNodeId)
      ? candidate.detailNodeId
      : null;
  const candidateViewport = sameSource ? candidate?.viewport : undefined;
  return Object.freeze({
    schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
    sourceFingerprint: projection.sourceFingerprint,
    viewport: Object.freeze({
      x: finiteOr(candidateViewport?.x, 0),
      y: finiteOr(candidateViewport?.y, 0),
      zoom: clamp(finiteOr(candidateViewport?.zoom, 1), MIN_ZOOM, MAX_ZOOM),
    }),
    positions: Object.freeze(positions),
    selectedNodeIds: Object.freeze(selectedNodeIds),
    detailNodeId,
  });
}

export function recoverDisconnectedFlowCanvasViewport(
  projection: FlowProjection,
  state: FlowViewState,
  canvas: FlowCanvasSize,
): FlowViewState["viewport"] {
  if (
    !Number.isFinite(canvas.width) ||
    !Number.isFinite(canvas.height) ||
    canvas.width < 64 ||
    canvas.height < 64
  ) {
    return state.viewport;
  }
  const visible = visibleWorldBounds(state, canvas);
  const positions = projection.nodes.map(
    (node) => state.positions[node.id] ?? node.defaultPosition,
  );
  const hasVisibleNode = positions.some((position) =>
    rectanglesIntersect(visible, {
      left: position.x,
      top: position.y,
      right: position.x + NODE_WIDTH,
      bottom: position.y + NODE_HEIGHT,
    }),
  );
  if (hasVisibleNode) return state.viewport;
  const bounds = positionsToBounds(positions);
  return bounds === null
    ? state.viewport
    : fitFlowCanvasViewport(bounds, canvas, VIEWPORT_FIT_PADDING, 1);
}

export interface FlowCanvasAlignItem {
  readonly id: string;
  readonly position: FlowPoint;
}

function selectedPositions(
  projection: FlowProjection | null,
  viewState: FlowViewState,
  draftState: FlowCanvasDraftVisualState | null,
): readonly FlowCanvasAlignItem[] {
  const selectedProjection = new Set(viewState.selectedNodeIds);
  const selectedDrafts = new Set(draftState?.selectedNodeIds ?? []);
  return Object.freeze([
    ...(projection?.nodes ?? [])
      .filter((node) => selectedProjection.has(node.id))
      .map((node) =>
        Object.freeze({
          id: node.id,
          position: viewState.positions[node.id] ?? node.defaultPosition,
        }),
      ),
    ...(draftState?.nodes ?? [])
      .filter((node) => selectedDrafts.has(node.id))
      .map((node) => Object.freeze({ id: node.id, position: node.position })),
  ]);
}

export function alignFlowCanvasPositions(
  selected: readonly FlowCanvasAlignItem[],
  mode: "left" | "distribute-y",
): ReadonlyMap<string, FlowPoint> {
  const minimum = mode === "left" ? 2 : 3;
  if (selected.length < minimum) {
    throw new RangeError(`${mode} 至少需要 ${minimum} 个节点`);
  }
  if (new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new TypeError("对齐节点 id 必须唯一");
  }
  if (selected.some((item) => item.id.length === 0 || !isFinitePoint(item.position))) {
    throw new TypeError("对齐节点必须包含非空 id 与有限坐标");
  }
  const result = new Map<string, FlowPoint>();
  if (mode === "left") {
    const x = Math.min(...selected.map((item) => item.position.x));
    for (const item of selected) result.set(item.id, point(x, item.position.y));
    return result;
  }
  const ordered = [...selected].sort(
    (left, right) => left.position.y - right.position.y || left.id.localeCompare(right.id),
  );
  const first = ordered[0]!.position.y;
  const last = ordered.at(-1)!.position.y;
  const step = (last - first) / (ordered.length - 1);
  ordered.forEach((item, index) =>
    result.set(item.id, point(item.position.x, first + step * index)),
  );
  return result;
}

function flowWireLane(edge: FlowEdge): number {
  if (edge.kind === "branch-true") return -1;
  if (edge.kind === "branch-false") return 1;
  if (edge.kind === "continue" || edge.kind === "goto") return 2 + Math.min(2, edge.slot);
  if (edge.kind === "return" || edge.kind === "terminate") return -2;
  return Math.min(3, edge.slot);
}

/**
 * Accepts a gesture that began at either end, but always publishes the semantic control edge as
 * output -> input. Drag direction never changes C control-flow direction or edge kind.
 */
export function canonicalizeFlowCanvasWireEndpoints(
  first: FlowCanvasWireEndpoint,
  second: FlowCanvasWireEndpoint,
): FlowCanvasCanonicalWireConnection | null {
  if (
    first.channel !== "control" ||
    second.channel !== "control" ||
    first.direction === second.direction
  ) {
    return null;
  }
  const from = first.direction === "output" ? first : second;
  const to = first.direction === "input" ? first : second;
  if (from.edgeKind === null) return null;
  return Object.freeze({ from, to, edgeKind: from.edgeKind });
}

/**
 * Models grabbing a physical cable. Unconnected sockets anchor a new cable. Either endpoint of a
 * uniquely identified connected cable may be unplugged while the opposite endpoint stays fixed;
 * the source-level preflight still decides whether that move has a safe C rewrite. Multiple cables
 * are never guessed.
 */
export function resolveFlowCanvasWireStart(
  projection: FlowProjection | null,
  requested: FlowCanvasWireEndpoint,
  selectedEdgeId: string | null,
): FlowCanvasWireStart {
  if (projection === null || requested.source !== "projection") {
    return Object.freeze({
      status: "new" as const,
      anchor: requested,
      detached: null,
      replaceEdgeId: null,
    });
  }
  const incident = projection.edges.filter(
    (edge) =>
      edge.editable &&
      ((edge.from.nodeId === requested.nodeId && edge.from.portId === requested.portId) ||
        (edge.to.nodeId === requested.nodeId && edge.to.portId === requested.portId)),
  );
  if (incident.length === 0) {
    return Object.freeze({
      status: "new" as const,
      anchor: requested,
      detached: null,
      replaceEdgeId: null,
    });
  }
  const selected =
    selectedEdgeId === null
      ? undefined
      : incident.find((candidate) => candidate.id === selectedEdgeId);
  if (selected === undefined && incident.length !== 1) {
    return Object.freeze({
      status: "ambiguous" as const,
      edgeIds: Object.freeze(incident.map((edge) => edge.id)),
    });
  }
  const edge = selected ?? incident[0]!;
  const grabbedFrom =
    edge.from.nodeId === requested.nodeId && edge.from.portId === requested.portId;
  const fixedReference = grabbedFrom ? edge.to : edge.from;
  const fixedNode = projection.nodes.find((node) => node.id === fixedReference.nodeId);
  const fixedPort = fixedNode?.ports.find((port) => port.id === fixedReference.portId);
  if (fixedNode === undefined || fixedPort === undefined) {
    return Object.freeze({ status: "ambiguous" as const, edgeIds: Object.freeze([edge.id]) });
  }
  return Object.freeze({
    status: "reconnect" as const,
    anchor: wireEndpoint("projection", fixedNode.id, fixedPort),
    detached: requested,
    replaceEdgeId: edge.id,
  });
}

function wireEndpoint(
  source: FlowCanvasWireEndpoint["source"],
  nodeId: string,
  port: FlowPort | FlowCanvasDraftPort,
): FlowCanvasWireEndpoint {
  return Object.freeze({
    source,
    nodeId,
    portId: port.id,
    direction: port.direction,
    channel: port.channel,
    edgeKind: port.edgeKind,
  });
}

function virtualEndpoint(endpoint: FlowCanvasWireEndpoint): FlowCanvasVirtualEndpoint {
  return Object.freeze({
    source: endpoint.source === "projection" ? "projection" : "virtual",
    nodeId: endpoint.nodeId,
    portId: endpoint.portId,
  });
}

export function createFlowCanvasDraftConnectionIntent(
  projection: FlowProjection,
  draftNode: FlowCanvasDraftNode,
  draftPort: FlowCanvasDraftPort,
  targetNode: FlowNode,
  targetPort: FlowPort,
): FlowCanvasDraftConnectionIntent | null {
  if (
    draftNode.status === "invalid" ||
    !draftPort.editable ||
    draftPort.direction !== "output" ||
    draftPort.channel !== "control" ||
    draftPort.edgeKind === null ||
    targetNode.locked ||
    !targetPort.editable ||
    targetPort.direction !== "input" ||
    targetPort.channel !== "control" ||
    !(draftNode.ports ?? []).some((port) => port.id === draftPort.id) ||
    !projection.nodes.some((node) => node.id === targetNode.id) ||
    !targetNode.ports.some((port) => port.id === targetPort.id)
  ) {
    return null;
  }
  return Object.freeze({
    sourceFingerprint: projection.sourceFingerprint,
    draftNodeId: draftNode.id,
    draftPortId: draftPort.id,
    presetId: draftNode.presetId ?? null,
    sourceText: draftNode.sourceText ?? null,
    toNodeId: targetNode.id,
    toPortId: targetPort.id,
    edgeKind: draftPort.edgeKind,
  });
}

function renderNode(
  ownerDocument: Document,
  node: FlowNode,
  edges: readonly FlowEdge[],
  english = false,
): HTMLElement {
  const element = ownerDocument.createElement("article");
  element.className = "flow-node";
  element.dataset.flowNodeId = node.id;
  element.dataset.nodeKind = node.kind;
  element.dataset.reachable = String(node.reachable);
  element.dataset.locked = String(node.locked);
  element.setAttribute("role", "button");
  const presentation = flowCanvasNodePresentation(node, english ? "en" : "zh-CN");
  const nodeLabel = presentation.label;
  element.setAttribute(
    "aria-label",
    `${nodeLabel}${node.locked ? (english ? ", locked" : "，已锁定") : ""}${node.reachable ? "" : english ? ", unreachable" : "，不可达"}`,
  );
  element.setAttribute("aria-selected", "false");
  element.setAttribute("aria-disabled", String(node.locked));
  element.tabIndex = -1;
  element.style.width = `${String(NODE_WIDTH)}px`;
  element.style.minHeight = `${String(NODE_HEIGHT)}px`;

  const kind = ownerDocument.createElement("span");
  kind.className = "flow-node__kind";
  kind.textContent = presentation.kind;
  const label = ownerDocument.createElement("span");
  label.className = "flow-node__label";
  label.textContent = nodeLabel;
  const status = ownerDocument.createElement("span");
  status.className = "flow-node__status";
  status.textContent = node.locked
    ? english
      ? "LOCK"
      : "锁"
    : node.reachable
      ? ""
      : english
        ? "UNREACHABLE"
        : "不可达";
  element.append(kind, label, status);

  for (const [portIndex, port] of node.ports.entries()) {
    const portElement = ownerDocument.createElement("button");
    portElement.className = `flow-node__port flow-node__port--${port.direction}`;
    portElement.type = "button";
    portElement.tabIndex = -1;
    portElement.dataset.flowNodeId = node.id;
    portElement.dataset.flowPortId = port.id;
    portElement.dataset.channel = port.channel;
    portElement.dataset.editable = String(port.editable);
    portElement.dataset.fanOut = String(port.allowsFanOut);
    portElement.dataset.edgeKind = port.edgeKind ?? "input";
    portElement.style.left = `calc(50% + ${String(portHorizontalOffset(node.ports, port))}px)`;
    const connected = edges.some((edge) =>
      port.direction === "output"
        ? edge.from.nodeId === node.id && edge.from.portId === port.id
        : edge.to.nodeId === node.id && edge.to.portId === port.id,
    );
    portElement.dataset.connected = String(connected);
    const connectionAffordance = !connected ? "new" : "reconnect";
    portElement.dataset.connectionAffordance = connectionAffordance;
    // Read-only CFG outputs may still be used as playback-overlay anchors. Dropping them on
    // another projected node remains blocked; only virtual nodes accept these anchors.
    portElement.disabled = !port.editable && port.direction !== "output";
    const portLabel = presentation.portLabels[portIndex] ?? localizedFlowPortLabel(port, english);
    const connectionInstruction =
      connectionAffordance === "reconnect"
        ? english
          ? ", connected; drag this plug to rewire"
          : "，已连接，拖动可拔出并改接"
        : english
          ? ", unconnected; drag to plug in"
          : "，未连接，拖动可插接";
    portElement.setAttribute(
      "aria-label",
      `${nodeLabel}${english ? ": " : "："}${portLabel}${connectionInstruction}`,
    );
    portElement.title =
      connectionAffordance === "reconnect"
        ? `${portLabel} · ${english ? "drag this plug to rewire" : "拖动此插头改接"}`
        : `${portLabel} · ${english ? "drag to connect" : "拖动插接"}`;
    element.append(portElement);
  }
  if (node.lockReasons.length > 0) {
    element.title = presentation.lockReasons.join("\n");
  }
  return element;
}

function flowPortPoint(node: FlowNode, port: FlowPort, position: FlowPoint): FlowPoint {
  return point(
    position.x + NODE_WIDTH / 2 + portHorizontalOffset(node.ports, port),
    position.y + (port.direction === "output" ? NODE_HEIGHT : 0),
  );
}

function draftPortPoint(node: FlowCanvasDraftNode, port: FlowCanvasDraftPort): FlowPoint {
  return point(
    node.position.x + NODE_WIDTH / 2 + portHorizontalOffset(node.ports ?? [], port),
    node.position.y + (port.direction === "output" ? NODE_HEIGHT : 0),
  );
}

function portHorizontalOffset(
  ports: readonly (FlowPort | FlowCanvasDraftPort)[],
  port: FlowPort | FlowCanvasDraftPort,
): number {
  const peers = ports.filter(
    (candidate) => candidate.direction === port.direction && candidate.channel === port.channel,
  );
  const index = Math.max(
    0,
    peers.findIndex((candidate) => candidate.id === port.id),
  );
  return peers.length <= 1 ? 0 : (index - (peers.length - 1) / 2) * 24;
}

function renderDefaultDetail(
  ownerDocument: Document,
  body: HTMLElement,
  node: FlowNode,
  english = false,
): void {
  const presentation = flowCanvasNodePresentation(node, english ? "en" : "zh-CN");
  const meta = ownerDocument.createElement("div");
  meta.className = "flow-detail__meta";
  meta.textContent = `${presentation.kind} · ${node.reachable ? (english ? "reachable" : "可达") : english ? "unreachable" : "不可达"}`;
  const code = ownerDocument.createElement("pre");
  code.className = "flow-detail__code";
  const codeValue = ownerDocument.createElement("code");
  codeValue.textContent =
    node.sourceText.length > 0
      ? node.sourceText
      : english
        ? "This node does not generate standalone C source."
        : "此节点不生成独立 C 源码。";
  code.append(codeValue);
  const ports = ownerDocument.createElement("section");
  ports.className = "flow-detail__ports";
  const portsTitle = ownerDocument.createElement("h3");
  portsTitle.textContent = english ? "Connection ports" : "连接端口";
  const portsValue = ownerDocument.createElement("p");
  portsValue.textContent =
    node.ports.length === 0
      ? english
        ? "None"
        : "无"
      : node.ports
          .map(
            (port, index) =>
              `${port.direction === "input" ? (english ? "Input" : "输入") : english ? "Output" : "输出"}${english ? ": " : "："}${presentation.portLabels[index] ?? localizedFlowPortLabel(port, english)}`,
          )
          .join(" · ");
  ports.append(portsTitle, portsValue);
  body.append(meta, code, ports);
  if (node.lockReasons.length > 0) {
    const lock = ownerDocument.createElement("section");
    lock.className = "flow-detail__lock";
    const title = ownerDocument.createElement("h3");
    title.textContent = english ? "Why rewiring is unavailable" : "为何不能改线";
    const message = ownerDocument.createElement("p");
    message.textContent = presentation.lockReasons.join(english ? "; " : "；");
    lock.append(title, message);
    body.append(lock);
  }
}

function renderDefaultDraftDetail(
  ownerDocument: Document,
  body: HTMLElement,
  node: FlowCanvasDraftNode,
  english: boolean,
  onSave: (sourceText: string) => void,
): void {
  const meta = ownerDocument.createElement("div");
  meta.className = "flow-detail__meta";
  meta.textContent = `${
    node.blockKind === "virtual"
      ? english
        ? "Virtual playback node"
        : "虚拟回放节点"
      : english
        ? "Detached source draft"
        : "未接入源码草稿"
  } · ${english ? "Template" : "模板"} ${node.presetId ?? (english ? "custom" : "自定义")}@${node.presetVersion ?? "snapshot"}`;

  const lifecycle = ownerDocument.createElement("section");
  lifecycle.className = "flow-detail__lifecycle";
  const lifecycleTitle = ownerDocument.createElement("h3");
  lifecycleTitle.textContent = english ? "Project-pinned snapshot" : "项目固定快照";
  const lifecycleText = ownerDocument.createElement("p");
  lifecycleText.textContent = english
    ? `Placed: ${node.placedAt ?? "unknown"}. Later template updates, deprecation, or retirement will not rewrite this draft's source or port snapshot.`
    : `放置时间：${node.placedAt ?? "未知"}。模板后续更新、弃用或退休不会改写此草稿的源码与端口快照。`;
  lifecycle.append(lifecycleTitle, lifecycleText);

  const ports = ownerDocument.createElement("section");
  ports.className = "flow-detail__ports";
  const portsTitle = ownerDocument.createElement("h3");
  portsTitle.textContent = english ? "Port snapshot" : "端口快照";
  const portsText = ownerDocument.createElement("p");
  portsText.textContent =
    (node.ports?.length ?? 0) === 0
      ? english
        ? "None"
        : "无"
      : (node.ports ?? [])
          .map(
            (port) =>
              `${port.direction === "input" ? (english ? "Input" : "输入") : english ? "Output" : "输出"}${english ? ": " : "："}${localizedDraftPortLabel(port, english)}${port.editable ? "" : english ? " (read-only)" : "（只读）"}`,
          )
          .join(" · ");
  ports.append(portsTitle, portsText);

  const editor = ownerDocument.createElement("section");
  editor.className = "flow-detail__editor";
  const editorTitle = ownerDocument.createElement("h3");
  editorTitle.textContent =
    node.blockKind === "virtual"
      ? english
        ? "Playback semantics"
        : "回放语义"
      : english
        ? "Draft C source"
        : "草稿 C 源码";
  const textarea = ownerDocument.createElement("textarea");
  textarea.value =
    node.blockKind === "virtual"
      ? english
        ? "This node controls teaching and replay only; it does not generate or rewrite C statements."
        : "该节点只控制教学/回放，不生成或改写 C 语句。"
      : (node.sourceText ?? "");
  textarea.disabled = node.blockKind === "virtual";
  textarea.spellcheck = false;
  if (!textarea.disabled) installCodeTextareaIndentation(textarea);
  textarea.setAttribute("aria-label", `${node.label}${english ? " draft source" : " 草稿源码"}`);
  const save = ownerDocument.createElement("button");
  save.type = "button";
  save.className = "button button--primary";
  save.textContent = english ? "Save draft snapshot" : "保存草稿快照";
  save.disabled = textarea.disabled;
  save.addEventListener("click", () => onSave(textarea.value));
  editor.append(editorTitle, textarea, save);
  body.append(meta, lifecycle, ports, editor);
}

function createMinimap(ownerDocument: Document, english = false) {
  const root = ownerDocument.createElement("aside");
  root.className = "flow-minimap";
  root.dataset.flowMinimap = "true";
  root.dataset.collapsed = "false";
  root.setAttribute("aria-label", english ? "Canvas overview" : "画布概览");
  const toggle = ownerDocument.createElement("button");
  toggle.className = "flow-minimap__toggle";
  toggle.type = "button";
  toggle.dataset.flowMinimapToggle = "true";
  toggle.textContent = english ? "Overview" : "概览";
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-label", english ? "Collapse canvas overview" : "收起画布概览");
  const svg = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("flow-minimap__map");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    english ? "Nodes, runtime path, and current viewport" : "节点、运行路径与当前视口",
  );
  svg.setAttribute("preserveAspectRatio", "none");
  const edges = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  edges.classList.add("flow-minimap__edges");
  const nodes = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  nodes.classList.add("flow-minimap__nodes");
  const viewport = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
  viewport.classList.add("flow-minimap__viewport");
  viewport.dataset.flowMinimapViewport = "true";
  svg.append(edges, nodes, viewport);
  root.append(toggle, svg);
  return { root, toggle, svg, edges, nodes, viewport };
}

function createDetailWindow(ownerDocument: Document, english = false) {
  const windowElement = ownerDocument.createElement("aside");
  windowElement.className = "flow-detail";
  windowElement.dataset.flowDetailWindow = "true";
  windowElement.dataset.tourTarget = "node-detail";
  windowElement.setAttribute("role", "region");
  windowElement.setAttribute("aria-label", english ? "Node details" : "节点详情");
  windowElement.hidden = true;
  windowElement.style.left = "24px";
  windowElement.style.top = "24px";
  windowElement.style.width = "360px";
  windowElement.style.height = "320px";
  const header = ownerDocument.createElement("header");
  header.className = "flow-detail__header";
  header.dataset.flowDetailHandle = "true";
  header.tabIndex = 0;
  header.setAttribute("aria-label", english ? "Move node details" : "移动节点详情");
  header.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");
  const title = ownerDocument.createElement("strong");
  title.className = "flow-detail__title";
  const actions = ownerDocument.createElement("div");
  actions.className = "flow-detail__actions";
  const minimize = ownerDocument.createElement("button");
  minimize.type = "button";
  minimize.textContent = english ? "Collapse" : "收起";
  minimize.dataset.flowDetailMinimize = "true";
  minimize.setAttribute("aria-expanded", "true");
  const close = ownerDocument.createElement("button");
  close.type = "button";
  close.textContent = english ? "Close" : "关闭";
  close.dataset.flowDetailClose = "true";
  actions.append(minimize, close);
  header.append(title, actions);
  const body = ownerDocument.createElement("div");
  body.className = "flow-detail__body";
  const resize = ownerDocument.createElement("div");
  resize.className = "flow-detail__resize";
  resize.dataset.flowDetailResize = "true";
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-label", english ? "Resize node details" : "调整节点详情大小");
  resize.setAttribute("aria-orientation", "vertical");
  resize.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");
  resize.tabIndex = 0;
  windowElement.append(header, body, resize);
  return { window: windowElement, header, title, body, minimize, close, resize };
}

function emptyViewState(sourceFingerprint: string): FlowViewState {
  return Object.freeze({
    schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
    sourceFingerprint,
    viewport: Object.freeze({ x: 0, y: 0, zoom: 1 }),
    positions: Object.freeze({}),
    selectedNodeIds: Object.freeze([]),
    detailNodeId: null,
  });
}

function cloneViewState(
  source: FlowViewState,
  changes: Partial<
    Pick<FlowViewState, "viewport" | "positions" | "selectedNodeIds" | "detailNodeId">
  > = {},
): FlowViewState {
  const viewport = changes.viewport ?? source.viewport;
  const positions = changes.positions ?? source.positions;
  const selectedNodeIds = changes.selectedNodeIds ?? source.selectedNodeIds;
  return Object.freeze({
    schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
    sourceFingerprint: source.sourceFingerprint,
    viewport: Object.freeze({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
    positions: Object.freeze(
      Object.fromEntries(
        Object.entries(positions).map(([id, value]) => [
          id,
          Object.freeze(point(value.x, value.y)),
        ]),
      ),
    ),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    detailNodeId: changes.detailNodeId === undefined ? source.detailNodeId : changes.detailNodeId,
  });
}

function emptyActivePath(): FlowCanvasActivePath {
  return Object.freeze({
    nodeIds: Object.freeze([]),
    edgeIds: Object.freeze([]),
    currentNodeId: null,
    mode: "real",
  });
}

function normalizeActivePathForCanvas(
  path: FlowCanvasActivePath,
  projection: FlowProjection | null,
  draftState: FlowCanvasDraftVisualState | null,
): FlowCanvasActivePath {
  const nodeIds = new Set([
    ...(projection?.nodes.map((node) => node.id) ?? []),
    ...(draftState?.nodes.map((node) => node.id) ?? []),
  ]);
  const edgeIds = new Set([
    ...(projection?.edges.map((edge) => edge.id) ?? []),
    ...(draftState?.virtualEdges?.map((edge) => edge.id) ?? []),
  ]);
  const visibleNodeIds = path.nodeIds.filter((nodeId) => nodeIds.has(nodeId));
  const visibleEdgeIds = path.edgeIds.filter((edgeId) => edgeIds.has(edgeId));
  const currentNodeId =
    path.currentNodeId !== null && nodeIds.has(path.currentNodeId)
      ? path.currentNodeId
      : (visibleNodeIds.at(-1) ?? null);
  return Object.freeze({
    nodeIds: Object.freeze(visibleNodeIds),
    edgeIds: Object.freeze(visibleEdgeIds),
    currentNodeId,
    mode: path.mode,
  });
}

function freezeActivePath(path: FlowCanvasActivePath): FlowCanvasActivePath {
  return Object.freeze({
    nodeIds: Object.freeze([...path.nodeIds]),
    edgeIds: Object.freeze([...path.edgeIds]),
    currentNodeId: path.currentNodeId,
    mode: path.mode,
  });
}

function draftStatusLabel(
  status: FlowCanvasDraftNode["status"],
  english = false,
  compact = false,
): string {
  if (status === "valid") return english ? "Connected" : "已接入";
  if (status === "invalid")
    return english ? (compact ? "Invalid" : "Invalid draft") : compact ? "无效" : "无效草稿";
  return english ? (compact ? "Detached" : "Detached draft") : compact ? "未接入" : "未接入草稿";
}

export function normalizeFlowCanvasDraftState(
  state: FlowCanvasDraftVisualState,
): FlowCanvasDraftVisualState {
  const seenNodeIds = new Set<string>();
  const nodes = state.nodes.map((node) => {
    if (node.id.trim().length === 0 || seenNodeIds.has(node.id) || !isFinitePoint(node.position)) {
      throw new TypeError("草稿节点必须具有唯一非空 id 和有限坐标");
    }
    seenNodeIds.add(node.id);
    const seenPortIds = new Set<string>();
    const ports = (node.ports ?? []).map((port) => {
      if (
        port.id.trim().length === 0 ||
        seenPortIds.has(port.id) ||
        (port.channel === "control" && port.direction === "output" && port.edgeKind === null)
      ) {
        throw new TypeError("草稿控制端口必须唯一，且输出端口必须声明 edgeKind");
      }
      seenPortIds.add(port.id);
      return Object.freeze({ ...port });
    });
    return Object.freeze({
      ...node,
      position: Object.freeze(point(node.position.x, node.position.y)),
      ports: Object.freeze(ports),
    });
  });
  const selectedNodeIds = Object.freeze(
    [...new Set(state.selectedNodeIds ?? [])].filter((nodeId) => seenNodeIds.has(nodeId)),
  );
  if (
    state.connection !== null &&
    (!isFinitePoint(state.connection.from) || !isFinitePoint(state.connection.to))
  ) {
    throw new TypeError("草稿连线必须使用有限坐标");
  }
  const seenVirtualEdgeIds = new Set<string>();
  const virtualEdges = (state.virtualEdges ?? []).map((edge) => {
    if (
      edge.id.trim().length === 0 ||
      seenVirtualEdgeIds.has(edge.id) ||
      (edge.status !== "pending" && edge.status !== "valid") ||
      edge.from.source === edge.to.source ||
      edge.from.nodeId === edge.to.nodeId ||
      edge.from.nodeId.trim().length === 0 ||
      edge.from.portId.trim().length === 0 ||
      edge.to.nodeId.trim().length === 0 ||
      edge.to.portId.trim().length === 0
    ) {
      throw new TypeError("虚拟覆盖边必须唯一，并连接真实投影与虚拟节点");
    }
    const virtualEndpoint = edge.from.source === "virtual" ? edge.from : edge.to;
    const virtualNode = nodes.find((node) => node.id === virtualEndpoint.nodeId);
    const virtualPort = virtualNode?.ports?.find((port) => port.id === virtualEndpoint.portId);
    if (virtualNode?.blockKind !== "virtual" || virtualPort === undefined) {
      throw new TypeError("虚拟覆盖边引用了未知虚拟节点或端口");
    }
    seenVirtualEdgeIds.add(edge.id);
    return Object.freeze({
      ...edge,
      from: Object.freeze({ ...edge.from }),
      to: Object.freeze({ ...edge.to }),
      sourceEdgeIds: Object.freeze([...new Set(edge.sourceEdgeIds)]),
    });
  });
  return Object.freeze({
    nodes: Object.freeze(nodes),
    connection:
      state.connection === null
        ? null
        : Object.freeze({
            ...state.connection,
            from: Object.freeze(point(state.connection.from.x, state.connection.from.y)),
            to: Object.freeze(point(state.connection.to.x, state.connection.to.y)),
          }),
    selectedNodeIds,
    virtualEdges: Object.freeze(virtualEdges),
  });
}

function freezeDraftState(state: FlowCanvasDraftVisualState): FlowCanvasDraftVisualState {
  return normalizeFlowCanvasDraftState(state);
}

function renderMarquee(root: HTMLElement, element: HTMLElement, gesture: MarqueeGesture): void {
  const bounds = normalizedBounds(gesture.startClient, gesture.currentClient);
  const rootBounds = root.getBoundingClientRect();
  element.style.left = `${String(bounds.left - rootBounds.left)}px`;
  element.style.top = `${String(bounds.top - rootBounds.top)}px`;
  element.style.width = `${String(bounds.right - bounds.left)}px`;
  element.style.height = `${String(bounds.bottom - bounds.top)}px`;
}

export interface FlowCanvasBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface FlowCanvasSize {
  readonly width: number;
  readonly height: number;
}

type Bounds = FlowCanvasBounds;

function normalizedBounds(from: FlowPoint, to: FlowPoint): Bounds {
  return {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    right: Math.max(from.x, to.x),
    bottom: Math.max(from.y, to.y),
  };
}

function rectanglesIntersect(left: Bounds, right: Bounds): boolean {
  return (
    left.left <= right.right &&
    left.right >= right.left &&
    left.top <= right.bottom &&
    left.bottom >= right.top
  );
}

export function fitFlowCanvasViewport(
  bounds: FlowCanvasBounds,
  canvas: FlowCanvasSize,
  padding = VIEWPORT_FIT_PADDING,
  maximumZoom = 1.5,
): FlowViewState["viewport"] {
  if (
    !isFiniteBounds(bounds) ||
    !Number.isFinite(canvas.width) ||
    !Number.isFinite(canvas.height) ||
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    !Number.isFinite(padding) ||
    padding < 0 ||
    !Number.isFinite(maximumZoom) ||
    maximumZoom <= 0
  ) {
    throw new TypeError("画布适配需要有限边界、正尺寸、非负留白与正缩放上限");
  }
  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, canvas.width - padding * 2);
  const availableHeight = Math.max(1, canvas.height - padding * 2);
  const zoom = clamp(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight, maximumZoom),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return Object.freeze({
    x: canvas.width / 2 - centerX * zoom,
    y: canvas.height / 2 - centerY * zoom,
    zoom,
  });
}

function canvasPixelSize(element: HTMLElement): FlowCanvasSize {
  const bounds = element.getBoundingClientRect();
  return {
    width: Math.max(1, element.clientWidth || bounds.width || 1),
    height: Math.max(1, element.clientHeight || bounds.height || 1),
  };
}

function visibleWorldBounds(state: FlowViewState, canvas: FlowCanvasSize): Bounds {
  return {
    left: -state.viewport.x / state.viewport.zoom,
    top: -state.viewport.y / state.viewport.zoom,
    right: (canvas.width - state.viewport.x) / state.viewport.zoom,
    bottom: (canvas.height - state.viewport.y) / state.viewport.zoom,
  };
}

function flowItemBounds(
  projection: FlowProjection | null,
  state: FlowViewState,
  drafts: FlowCanvasDraftVisualState | null,
): Bounds | null {
  const positions = [
    ...(projection?.nodes ?? []).map((node) => state.positions[node.id] ?? node.defaultPosition),
    ...(drafts?.nodes ?? []).map((node) => node.position),
  ];
  return positionsToBounds(positions);
}

function selectedItemBounds(
  projection: FlowProjection | null,
  state: FlowViewState,
  drafts: FlowCanvasDraftVisualState | null,
): Bounds | null {
  const selectedNodes = new Set(state.selectedNodeIds);
  const selectedDrafts = new Set(drafts?.selectedNodeIds ?? []);
  const positions = [
    ...(projection?.nodes ?? [])
      .filter((node) => selectedNodes.has(node.id))
      .map((node) => state.positions[node.id] ?? node.defaultPosition),
    ...(drafts?.nodes ?? [])
      .filter((node) => selectedDrafts.has(node.id))
      .map((node) => node.position),
  ];
  return positionsToBounds(positions);
}

function positionsToBounds(positions: readonly FlowPoint[]): Bounds | null {
  if (positions.length === 0) return null;
  return {
    left: Math.min(...positions.map((position) => position.x)),
    top: Math.min(...positions.map((position) => position.y)),
    right: Math.max(...positions.map((position) => position.x + NODE_WIDTH)),
    bottom: Math.max(...positions.map((position) => position.y + NODE_HEIGHT)),
  };
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    left: bounds.left - amount,
    top: bounds.top - amount,
    right: bounds.right + amount,
    bottom: bounds.bottom + amount,
  };
}

function isFiniteBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.bottom) &&
    bounds.right >= bounds.left &&
    bounds.bottom >= bounds.top
  );
}

function clientToWorld(
  root: HTMLElement,
  state: FlowViewState,
  clientX: number,
  clientY: number,
): FlowPoint {
  const bounds = root.getBoundingClientRect();
  return point(
    (clientX - bounds.left - state.viewport.x) / state.viewport.zoom,
    (clientY - bounds.top - state.viewport.y) / state.viewport.zoom,
  );
}

export function exceedsFlowCanvasDragThreshold(
  start: FlowPoint,
  current: FlowPoint,
  threshold = NODE_DRAG_THRESHOLD,
): boolean {
  if (
    !isFinitePoint(start) ||
    !isFinitePoint(current) ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    throw new TypeError("拖动阈值需要有限坐标与非负距离");
  }
  return Math.hypot(current.x - start.x, current.y - start.y) > threshold;
}

function dispatchCanvasEvent(target: HTMLElement, name: string, detail: unknown): void {
  const CustomEventConstructor = target.ownerDocument.defaultView?.CustomEvent;
  if (CustomEventConstructor === undefined) return;
  target.dispatchEvent(new CustomEventConstructor(name, { bubbles: true, detail }));
}

function focusPresetSearch(ownerDocument: Document): void {
  const search = ownerDocument.querySelector<HTMLInputElement>(".block-palette__search");
  if (search === null) return;
  search.focus({ preventScroll: true });
  search.select();
}

function keyboardDelta(key: string, amount: number): FlowPoint | null {
  if (key === "ArrowLeft") return point(-amount, 0);
  if (key === "ArrowRight") return point(amount, 0);
  if (key === "ArrowUp") return point(0, -amount);
  if (key === "ArrowDown") return point(0, amount);
  return null;
}

function shortNodeKind(kind: FlowNode["kind"], english = false): string {
  if (kind === "start") return english ? "Start" : "开始";
  if (kind === "end") return english ? "End" : "结束";
  if (kind === "branch") return english ? "Branch" : "分支";
  if (kind === "loop") return english ? "Loop" : "循环";
  if (kind === "switch") return english ? "Switch" : "选择";
  if (kind === "assert") return english ? "Assert" : "断言";
  if (kind === "declaration") return english ? "Declaration" : "声明";
  if (kind === "raw") return english ? "Raw" : "原始";
  if (kind === "control") return english ? "Control" : "控制";
  if (kind === "module") return english ? "Module" : "模块";
  return english ? "Statement" : "语句";
}

function localizedFlowNodeLabel(node: FlowNode, english: boolean): string {
  if (!english || node.kind !== "raw") return node.label;
  if (node.label.includes("解析恢复")) return "Raw · parser recovery";
  if (node.label.includes("未结构化")) return "Raw · unstructured";
  return node.label;
}

function localizedFlowPortLabel(port: FlowPort, english: boolean): string {
  if (!english) return port.label;
  if (port.direction === "input") return "Input";
  const labels: Readonly<Record<NonNullable<FlowPort["edgeKind"]>, string>> = Object.freeze({
    entry: "Enter",
    next: "Next",
    "branch-true": "Condition true",
    "branch-false": "Condition false",
    "switch-case": "case",
    "switch-default": "default",
    "switch-miss": "No match",
    break: "break",
    continue: "continue",
    goto: "goto",
    return: "return",
    terminate: "Terminate",
  });
  return port.edgeKind === null ? port.label : labels[port.edgeKind];
}

function localizedDraftPortLabel(port: FlowCanvasDraftPort, english: boolean): string {
  if (!english) return port.label;
  if (!/[\u3400-\u9fff]/u.test(port.label)) return port.label;
  if (port.direction === "input") return "Input";
  const edgeKind = port.edgeKind;
  if (edgeKind === "branch-true") return "Condition true";
  if (edgeKind === "branch-false") return "Condition false";
  if (edgeKind === "switch-miss") return "No match";
  if (edgeKind === "terminate") return "Terminate";
  return edgeKind === null ? "Output" : edgeKind;
}

function localizedFlowLockReason(reason: FlowLockReason, english: boolean): string {
  if (!english) return reason.message;
  if (reason.code === "partial-cfg") {
    return `Incomplete CFG${reason.partialCode === null ? "" : `: ${reason.partialCode}`}`;
  }
  if (reason.code === "raw-block") {
    return `The raw source region cannot be safely rewired${reason.rawReason === null ? "" : `: ${reason.rawReason}`}`;
  }
  return "Source outside a function belongs to the Translation Unit. It can be viewed and run, but its control flow cannot be rewired.";
}

/**
 * Pure presentation projection used by the canvas and locale regression tests. Source-backed
 * labels stay untouched; only workbench-owned semantic labels are translated.
 */
export function flowCanvasNodePresentation(
  node: FlowNode,
  locale: "zh-CN" | "en",
): FlowCanvasNodePresentation {
  const english = locale === "en";
  return Object.freeze({
    kind: shortNodeKind(node.kind, english),
    label: localizedFlowNodeLabel(node, english),
    portLabels: Object.freeze(node.ports.map((port) => localizedFlowPortLabel(port, english))),
    lockReasons: Object.freeze(
      node.lockReasons.map((reason) => localizedFlowLockReason(reason, english)),
    ),
  });
}

function point(x: number, y: number): FlowPoint {
  return { x, y };
}

function isFinitePoint(value: FlowPoint | null | undefined): value is FlowPoint {
  return (
    value !== null && value !== undefined && Number.isFinite(value.x) && Number.isFinite(value.y)
  );
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function closestElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function isFlowDetailInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      "button, input, select, textarea, a[href], summary, [contenteditable='true'], [role='button']",
    ) !== null
  );
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("Flow canvas 已销毁");
}
