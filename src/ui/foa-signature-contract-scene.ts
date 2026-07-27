import type { FoaLocale } from "../tutorials/foa-contracts.js";
import type { FoaRuntimeFrame } from "../tutorials/foa-runtime-frames.js";

interface SignatureContractCopy {
  readonly title: string;
  readonly instruction: string;
  readonly prototype: string;
  readonly call: string;
  readonly definition: string;
  readonly returnType: string;
  readonly parameters: string;
  readonly arguments: string;
  readonly result: string;
  readonly pending: string;
  readonly valid: string;
  readonly routes: readonly string[];
}

const COPY: Readonly<Record<FoaLocale, SignatureContractCopy>> = Object.freeze({
  zh: Object.freeze({
    title: "函数签名核对",
    instruction: "拖动蓝点连接；单击也可。",
    prototype: "函数原型",
    call: "函数调用",
    definition: "函数定义",
    returnType: "返回类型",
    parameters: "参数类型",
    arguments: "实参类型",
    result: "返回值",
    pending: "待核对",
    valid: "四项核对通过",
    routes: Object.freeze([
      "连接原型与调用的返回类型",
      "连接参数类型与实参类型",
      "核对原型与定义的返回类型",
      "执行 add(7, 5)，返回 12",
    ]),
  }),
  en: Object.freeze({
    title: "Function signature check",
    instruction: "Drag the blue port to connect; click also works.",
    prototype: "Prototype",
    call: "Call",
    definition: "Definition",
    returnType: "Return type",
    parameters: "Parameter types",
    arguments: "Argument types",
    result: "Return value",
    pending: "To check",
    valid: "Four checks passed",
    routes: Object.freeze([
      "Connect prototype and call return types",
      "Connect parameter and argument types",
      "Check prototype and definition return types",
      "Run add(7, 5) and return 12",
    ]),
  }),
});

interface ContractRouteDefinition {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
}

const ROUTES: readonly ContractRouteDefinition[] = Object.freeze([
  Object.freeze({
    id: "prototype-call",
    sourceId: "prototype-return",
    targetId: "call-return",
  }),
  Object.freeze({
    id: "prototype-call-parameters",
    sourceId: "prototype-parameters",
    targetId: "call-arguments",
  }),
  Object.freeze({
    id: "prototype-definition",
    sourceId: "prototype-return",
    targetId: "definition-return",
  }),
  Object.freeze({
    id: "definition-return",
    sourceId: "definition-result",
    targetId: "call-result",
  }),
]);

interface ContractEndpoint {
  readonly root: HTMLButtonElement;
  readonly row: HTMLElement;
  readonly label: HTMLElement;
  readonly value: HTMLElement;
}

interface ContractDragGesture {
  readonly pointerId: number;
  readonly source: HTMLButtonElement;
  readonly routeIndex: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

export interface FoaSignatureContractState {
  readonly displayIndex: number;
  readonly confirmedCount: number;
  readonly previewing: boolean;
  readonly completed: boolean;
  readonly locked: boolean;
}

export interface FoaSignatureContractScene {
  readonly root: HTMLElement;
  setLocale(locale: FoaLocale): void;
  setReducedMotion(reducedMotion: boolean): void;
  setPlaybackRate(rate: number): void;
  setState(state: FoaSignatureContractState): void;
  animateTransition(fromIndex: number, preview: boolean): Promise<void> | null;
  cancelAnimation(): void;
  focusActive(): void;
  destroy(): void;
}

interface SignatureContractOptions {
  readonly locale: FoaLocale;
  readonly reducedMotion: boolean;
  readonly frames: readonly FoaRuntimeFrame[];
  readonly stdout: string;
  readonly onAttempt: (routeId: string) => void;
}

interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Course 33's three stable semantic objects. The state owns which contract edge is current;
 * animation only interpolates between those deterministic states.
 */
export function createFoaSignatureContractScene(
  ownerDocument: Document,
  options: SignatureContractOptions,
): FoaSignatureContractScene {
  if (
    options.frames.length !== ROUTES.length ||
    options.frames.some((frame, index) => frame.evidence.activeMemoryLinkId !== ROUTES[index]?.id)
  ) {
    throw new RangeError("FOA signature contract routes must match the four authored frames");
  }
  let locale = options.locale;
  let reducedMotion = options.reducedMotion;
  let playbackRate = 1;
  let state: FoaSignatureContractState = Object.freeze({
    displayIndex: 0,
    confirmedCount: 0,
    previewing: false,
    completed: false,
    locked: false,
  });
  let destroyed = false;
  let dragGesture: ContractDragGesture | null = null;
  let suppressClickUntil = 0;
  let layoutFrame: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let activeAnimations: Animation[] = [];
  let animationEpoch = 0;

  const root = element(ownerDocument, "section", "foa-signature-contract");
  root.dataset.motionBlueprint = "signature-contract-v1";
  const header = element(ownerDocument, "header", "foa-signature-contract__header");
  const heading = element(ownerDocument, "strong", "foa-signature-contract__title");
  const instruction = element(ownerDocument, "span", "foa-signature-contract__instruction");
  const stepLabel = element(ownerDocument, "span", "foa-signature-contract__step");
  header.append(heading, instruction, stepLabel);

  const canvas = element(ownerDocument, "div", "foa-signature-contract__canvas");
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("foa-signature-contract__routes");
  svg.setAttribute("aria-hidden", "true");
  const routePaths = ROUTES.map((route, index) => {
    const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("foa-signature-contract__route");
    path.dataset.routeId = route.id;
    path.dataset.step = String(index);
    path.setAttribute("pathLength", "1");
    svg.append(path);
    return path;
  });
  const dragPath = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  dragPath.classList.add("foa-signature-contract__drag-route");
  dragPath.dataset.active = "false";
  svg.append(dragPath);

  const endpoints = new Map<string, ContractEndpoint>();
  const stations = new Map<string, HTMLElement>();
  const signatures = new Map<string, HTMLElement>();
  const localizedElements: Array<{
    readonly root: HTMLElement;
    readonly key:
      "prototype" | "call" | "definition" | "returnType" | "parameters" | "arguments" | "result";
  }> = [];
  const fieldValues = new Map<string, HTMLElement>();
  const prototype = station("prototype", "int add(int, int)", [
    row("prototype-return", "returnType", "int", "source"),
    row("prototype-parameters", "parameters", "int · int", "source"),
  ]);
  const call = station("call", "add(7, 5)", [
    row("call-return", "returnType", "int", "target"),
    row("call-arguments", "arguments", "7:int · 5:int", "target"),
    row("call-result", "result", "—", "target"),
  ]);
  const definition = station("definition", "int add(int a, int b)", [
    row("definition-return", "returnType", "int", "target"),
    row("definition-result", "result", "12", "source"),
  ]);
  canvas.append(svg, prototype, call, definition);

  const travelLayer = element(ownerDocument, "div", "foa-signature-contract__travel-layer");
  travelLayer.setAttribute("aria-hidden", "true");
  const leftArgument = travelToken("7");
  const rightArgument = travelToken("5");
  const resultToken = travelToken("12");
  travelLayer.append(leftArgument, rightArgument, resultToken);
  canvas.append(travelLayer);
  root.append(header, canvas);

  applyLocale();
  render();
  requestLayout();

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(requestLayout);
    resizeObserver.observe(canvas);
    for (const endpoint of endpoints.values()) resizeObserver.observe(endpoint.root);
  }

  return Object.freeze({
    root,
    setLocale(nextLocale: FoaLocale): void {
      assertLive();
      cancelAnimation();
      locale = nextLocale;
      applyLocale();
      render();
    },
    setReducedMotion(nextReducedMotion: boolean): void {
      assertLive();
      reducedMotion = nextReducedMotion;
      root.dataset.reducedMotion = String(reducedMotion);
      if (reducedMotion) cancelAnimation();
    },
    setPlaybackRate(nextRate: number): void {
      assertLive();
      if (!Number.isFinite(nextRate) || nextRate <= 0) return;
      playbackRate = nextRate;
      for (const animation of activeAnimations) animation.playbackRate = playbackRate;
    },
    setState(nextState: FoaSignatureContractState): void {
      assertLive();
      state = Object.freeze({ ...nextState });
      render();
    },
    animateTransition(fromIndex: number, preview: boolean): Promise<void> | null {
      assertLive();
      return animateTransition(fromIndex, preview);
    },
    cancelAnimation(): void {
      assertLive();
      cancelAnimation();
    },
    focusActive(): void {
      assertLive();
      activeSource()?.focus();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelDrag();
      cancelAnimation();
      cancelLayout();
      resizeObserver?.disconnect();
      resizeObserver = null;
      root.parentElement?.removeChild(root);
    },
  });

  function station(
    id: "prototype" | "call" | "definition",
    signature: string,
    rows: readonly HTMLElement[],
  ): HTMLElement {
    const stationRoot = element(ownerDocument, "article", "foa-signature-contract__station");
    stationRoot.dataset.stationId = id;
    const stationName = element(ownerDocument, "span", "foa-signature-contract__station-name");
    stationName.dataset.copyKey = id;
    localizedElements.push({ root: stationName, key: id });
    const stationSignature = element(ownerDocument, "code", "foa-signature-contract__signature");
    stationSignature.textContent = signature;
    stationRoot.append(stationName, stationSignature, ...rows);
    stations.set(id, stationRoot);
    signatures.set(id, stationSignature);
    return stationRoot;
  }

  function row(
    endpointId: string,
    copyKey: "returnType" | "parameters" | "arguments" | "result",
    value: string,
    direction: "source" | "target",
  ): HTMLElement {
    const rowRoot = element(ownerDocument, "div", "foa-signature-contract__field");
    rowRoot.dataset.endpointId = endpointId;
    const label = element(ownerDocument, "span", "foa-signature-contract__field-label");
    label.dataset.copyKey = copyKey;
    localizedElements.push({ root: label, key: copyKey });
    const output = element(ownerDocument, "code", "foa-signature-contract__field-value");
    output.textContent = value;
    const port = ownerDocument.createElement("button");
    port.type = "button";
    port.className = `foa-runtime-scene__memory-link foa-signature-contract__port foa-signature-contract__port--${direction}`;
    port.dataset.endpointId = endpointId;
    port.dataset.portDirection = direction;
    port.dataset.compatible = "false";
    port.addEventListener("pointerdown", beginDrag);
    port.addEventListener("pointermove", moveDrag);
    port.addEventListener("pointerup", endDrag);
    port.addEventListener("pointercancel", cancelDrag);
    port.addEventListener("click", () => {
      if (Date.now() < suppressClickUntil || !portIsActive(port)) return;
      options.onAttempt(ROUTES[boundedIndex(state.displayIndex)]!.id);
    });
    rowRoot.append(label, output, port);
    endpoints.set(endpointId, { root: port, row: rowRoot, label, value: output });
    fieldValues.set(endpointId, output);
    return rowRoot;
  }

  function travelToken(value: string): HTMLElement {
    const token = element(ownerDocument, "span", "foa-signature-contract__travel-token");
    token.textContent = value;
    token.hidden = true;
    return token;
  }

  function applyLocale(): void {
    const copy = COPY[locale];
    heading.textContent = copy.title;
    instruction.textContent = copy.instruction;
    for (const item of localizedElements) {
      item.root.textContent = copy[item.key];
    }
    root.setAttribute("aria-label", copy.title);
    signatures.get("prototype")!.textContent =
      options.frames[0]!.evidence.stateValues.prototype![locale];
    signatures.get("call")!.textContent = options.frames[1]!.evidence.stateValues.call![locale];
    signatures.get("definition")!.textContent =
      options.frames[2]!.evidence.stateValues.definition![locale];
    const result = options.stdout.trim() || "12";
    fieldValues.get("definition-result")!.textContent = result;
  }

  function render(): void {
    const copy = COPY[locale];
    const activeIndex = boundedIndex(state.displayIndex);
    const confirmedEndpoints = new Set(
      ROUTES.slice(0, state.confirmedCount).flatMap((route) => [route.sourceId, route.targetId]),
    );
    root.dataset.activeStep = String(activeIndex);
    root.dataset.confirmedCount = String(state.confirmedCount);
    root.dataset.previewing = String(state.previewing);
    root.dataset.completed = String(state.completed);
    root.dataset.locked = String(state.locked);
    root.dataset.reducedMotion = String(reducedMotion);
    const activeRouteLabel = copy.routes[activeIndex]!;
    stepLabel.textContent = state.completed
      ? copy.valid
      : `${String(activeIndex + 1)} / ${String(ROUTES.length)} · ${activeRouteLabel}`;

    routePaths.forEach((path, index) => {
      path.dataset.state =
        index < state.confirmedCount
          ? "done"
          : index === activeIndex
            ? state.previewing
              ? "preview"
              : "active"
            : "pending";
    });
    for (const [endpointId, endpoint] of endpoints) {
      const activeRoute = ROUTES[activeIndex]!;
      const isSource = endpointId === activeRoute.sourceId;
      const isTarget = endpointId === activeRoute.targetId;
      endpoint.root.dataset.compatible = String(isSource && !state.locked && !state.previewing);
      endpoint.root.dataset.targetCompatible = String(isTarget && dragGesture !== null);
      endpoint.root.disabled = !isSource || state.locked || state.previewing || state.completed;
      endpoint.root.tabIndex = isSource && !state.locked && !state.previewing ? 0 : -1;
      endpoint.root.setAttribute(
        "aria-label",
        isSource
          ? activeRouteLabel
          : `${copy.pending}: ${endpoint.label.textContent ?? ""} ${endpoint.value.textContent ?? ""}`.trim(),
      );
      endpoint.row.dataset.state =
        isSource || isTarget ? "active" : confirmedEndpoints.has(endpointId) ? "done" : "idle";
    }
    const callResult = fieldValues.get("call-result");
    if (callResult !== undefined) {
      callResult.textContent =
        state.completed || state.confirmedCount >= 4 ? options.stdout.trim() || "12" : "—";
    }
    stations.get("prototype")!.dataset.state = state.confirmedCount >= 3 ? "verified" : "current";
    stations.get("call")!.dataset.state = state.confirmedCount >= 2 ? "verified" : "current";
    stations.get("definition")!.dataset.state =
      state.confirmedCount >= 4 ? "verified" : activeIndex >= 2 ? "current" : "pending";
    heading.dataset.status = state.completed ? "valid" : "checking";
    heading.title = state.completed ? copy.valid : activeRouteLabel;
    // Step copy can wrap differently at intermediate widths, changing the
    // canvas height and re-centering every port. Recompute in the same state
    // update so routes never spend a frame attached to the previous geometry.
    layoutRoutes();
    requestLayout();
  }

  function beginDrag(event: PointerEvent): void {
    const source = event.currentTarget as HTMLButtonElement;
    if (event.button !== 0 || !portIsActive(source)) return;
    cancelDrag();
    const routeIndex = boundedIndex(state.displayIndex);
    dragGesture = {
      pointerId: event.pointerId,
      source,
      routeIndex,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    source.dataset.pressed = "true";
    source.setPointerCapture?.(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    const gesture = dragGesture;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (!gesture.moved && distance < 4) return;
    gesture.moved = true;
    event.preventDefault();
    const route = ROUTES[gesture.routeIndex]!;
    const canvasRect = canvas.getBoundingClientRect();
    const sourceRect = endpoints.get(route.sourceId)!.root.getBoundingClientRect();
    const start = center(sourceRect, canvasRect);
    const end = { x: event.clientX - canvasRect.left, y: event.clientY - canvasRect.top };
    dragPath.setAttribute("d", curve(start, end));
    dragPath.dataset.active = "true";
    root.dataset.dragging = "true";
    const target = endpoints.get(route.targetId)!;
    target.root.dataset.targetCompatible = String(
      pointInside(event.clientX, event.clientY, expanded(target.root.getBoundingClientRect(), 12)),
    );
  }

  function endDrag(event: PointerEvent): void {
    const gesture = dragGesture;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const route = ROUTES[gesture.routeIndex]!;
    const targetRect = expanded(endpoints.get(route.targetId)!.root.getBoundingClientRect(), 12);
    const accepted = gesture.moved && pointInside(event.clientX, event.clientY, targetRect);
    if (gesture.moved) suppressClickUntil = Date.now() + 180;
    clearDrag(gesture);
    if (accepted) options.onAttempt(route.id);
  }

  function cancelDrag(event?: PointerEvent): void {
    if (event !== undefined && dragGesture?.pointerId !== event.pointerId) return;
    if (dragGesture !== null) clearDrag(dragGesture);
  }

  function clearDrag(gesture: ContractDragGesture): void {
    if (gesture.source.hasPointerCapture?.(gesture.pointerId)) {
      gesture.source.releasePointerCapture?.(gesture.pointerId);
    }
    gesture.source.dataset.pressed = "false";
    dragGesture = null;
    dragPath.dataset.active = "false";
    dragPath.setAttribute("d", "");
    delete root.dataset.dragging;
    render();
  }

  function portIsActive(port: HTMLButtonElement): boolean {
    return port.dataset.compatible === "true" && !port.disabled;
  }

  function activeSource(): HTMLButtonElement | undefined {
    const route = ROUTES[boundedIndex(state.displayIndex)]!;
    return endpoints.get(route.sourceId)?.root;
  }

  function animateTransition(fromIndex: number, preview: boolean): Promise<void> | null {
    cancelAnimation();
    const epoch = ++animationEpoch;
    const index = boundedIndex(fromIndex);
    const route = ROUTES[index]!;
    const path = routePaths[index]!;
    root.dataset.animatingStep = String(index);
    root.dataset.animationMode = preview ? "preview" : "execute";

    if (reducedMotion) {
      const fade = animate(path, [{ opacity: 0.45 }, { opacity: 1 }], 160);
      if (fade === null) return finishWithoutAnimation(epoch);
      activeAnimations = [fade];
      applyPlaybackRate(activeAnimations);
      return settleAnimations([fade], epoch);
    }

    const source = endpoints.get(route.sourceId)!;
    const target = endpoints.get(route.targetId)!;
    const routeAnimation = animate(
      path,
      [
        { opacity: 0.35, strokeDasharray: "1", strokeDashoffset: "1" },
        { opacity: 1, strokeDasharray: "1", strokeDashoffset: "0" },
      ],
      index === 3 ? 280 : 340,
    );
    const sourceAnimation = animate(
      source.row,
      [
        { opacity: 0.72, transform: "translateY(0)" },
        { opacity: 1, transform: "translateY(-2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      220,
    );
    const targetAnimation = animate(
      target.row,
      [
        { opacity: 0.62, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      260,
    );
    const animations = [routeAnimation, sourceAnimation, targetAnimation].filter(
      (candidate): candidate is Animation => candidate !== null,
    );
    if (animations.length === 0) return finishWithoutAnimation(epoch);
    activeAnimations = animations;
    applyPlaybackRate(activeAnimations);

    if (index !== 3) return settleAnimations(animations, epoch);
    return Promise.all(animations.map(animationFinished))
      .then(() => animateReturnValue(epoch))
      .finally(() => clearAnimation(epoch));
  }

  async function animateReturnValue(epoch: number): Promise<void> {
    if (epoch !== animationEpoch) return;
    const canvasRect = canvas.getBoundingClientRect();
    const callRect = stations.get("call")!.getBoundingClientRect();
    const definitionRect = stations.get("definition")!.getBoundingClientRect();
    const callPoint = center(callRect, canvasRect);
    const definitionPoint = center(definitionRect, canvasRect);
    leftArgument.hidden = false;
    rightArgument.hidden = false;
    const argumentAnimations = [
      animateTravel(
        leftArgument,
        offset(callPoint, -24, -5),
        offset(definitionPoint, -24, -5),
        300,
      ),
      animateTravel(rightArgument, offset(callPoint, 24, 5), offset(definitionPoint, 24, 5), 320),
    ].filter((candidate): candidate is Animation => candidate !== null);
    activeAnimations = argumentAnimations;
    applyPlaybackRate(activeAnimations);
    await Promise.all(argumentAnimations.map(animationFinished));
    leftArgument.hidden = true;
    rightArgument.hidden = true;
    if (epoch !== animationEpoch) return;
    resultToken.hidden = false;
    const resultAnimation = animateTravel(resultToken, definitionPoint, callPoint, 340);
    if (resultAnimation !== null) {
      activeAnimations = [resultAnimation];
      applyPlaybackRate(activeAnimations);
      await animationFinished(resultAnimation);
    }
    resultToken.hidden = true;
  }

  function animateTravel(
    token: HTMLElement,
    from: ScenePoint,
    to: ScenePoint,
    duration: number,
  ): Animation | null {
    return animate(
      token,
      [
        { opacity: 0, transform: translate(from) },
        { opacity: 1, offset: 0.18, transform: translate(from) },
        { opacity: 1, offset: 0.82, transform: translate(to) },
        { opacity: 0, transform: translate(to) },
      ],
      duration,
    );
  }

  function settleAnimations(animations: readonly Animation[], epoch: number): Promise<void> {
    return Promise.all(animations.map(animationFinished))
      .then(() => undefined)
      .finally(() => clearAnimation(epoch));
  }

  function applyPlaybackRate(animations: readonly Animation[]): void {
    for (const animation of animations) animation.playbackRate = playbackRate;
  }

  function finishWithoutAnimation(epoch: number): null {
    clearAnimation(epoch);
    return null;
  }

  function cancelAnimation(): void {
    animationEpoch += 1;
    for (const animation of activeAnimations) animation.cancel();
    activeAnimations = [];
    clearTravelTokens();
    delete root.dataset.animatingStep;
    delete root.dataset.animationMode;
  }

  function clearAnimation(epoch: number): void {
    if (epoch !== animationEpoch) return;
    activeAnimations = [];
    clearTravelTokens();
    delete root.dataset.animatingStep;
    delete root.dataset.animationMode;
  }

  function clearTravelTokens(): void {
    for (const token of [leftArgument, rightArgument, resultToken]) {
      token.hidden = true;
      token.style.transform = "";
    }
  }

  function requestLayout(): void {
    const view = ownerDocument.defaultView;
    if (view === null || typeof view.requestAnimationFrame !== "function") {
      layoutRoutes();
      return;
    }
    if (layoutFrame !== null) return;
    layoutFrame = view.requestAnimationFrame(() => {
      layoutFrame = null;
      layoutRoutes();
    });
  }

  function cancelLayout(): void {
    if (layoutFrame === null) return;
    ownerDocument.defaultView?.cancelAnimationFrame?.(layoutFrame);
    layoutFrame = null;
  }

  function layoutRoutes(): void {
    if (destroyed || !root.isConnected) return;
    if (!routeGeometryAvailable()) return;
    const canvasRect = canvas.getBoundingClientRect();
    const width = Math.max(canvas.clientWidth, canvas.scrollWidth, canvasRect.width);
    const height = Math.max(canvas.clientHeight, canvas.scrollHeight, canvasRect.height);
    svg.setAttribute("viewBox", `0 0 ${String(width)} ${String(height)}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    ROUTES.forEach((route, index) => {
      const source = endpoints.get(route.sourceId)!.root.getBoundingClientRect();
      const target = endpoints.get(route.targetId)!.root.getBoundingClientRect();
      const start = center(source, canvasRect);
      const end = center(target, canvasRect);
      routePaths[index]!.setAttribute("d", authoredCurve(route, start, end, canvasRect));
    });
  }

  function routeGeometryAvailable(): boolean {
    if (typeof canvas.getBoundingClientRect !== "function") return false;
    for (const endpoint of endpoints.values()) {
      if (
        typeof endpoint.root.getBoundingClientRect !== "function" ||
        typeof endpoint.row.closest !== "function"
      ) {
        return false;
      }
      const stationRoot = endpoint.row.closest<HTMLElement>(".foa-signature-contract__station");
      if (stationRoot === null || typeof stationRoot.getBoundingClientRect !== "function") {
        return false;
      }
    }
    return true;
  }

  function authoredCurve(
    route: ContractRouteDefinition,
    start: ScenePoint,
    end: ScenePoint,
    canvasRect: DOMRect,
  ): string {
    const sourceStationRect = endpoints
      .get(route.sourceId)!
      .row.closest<HTMLElement>(".foa-signature-contract__station")!
      .getBoundingClientRect();
    const targetStationRect = endpoints
      .get(route.targetId)!
      .row.closest<HTMLElement>(".foa-signature-contract__station")!
      .getBoundingClientRect();
    const stacked = Math.abs(targetStationRect.top - sourceStationRect.top) > 80;
    if (stacked && route.id !== "prototype-definition") {
      const movingDown = end.y > start.y;
      const laneY = movingDown
        ? (sourceStationRect.bottom + targetStationRect.top) / 2 - canvasRect.top
        : (sourceStationRect.top + targetStationRect.bottom) / 2 - canvasRect.top;
      const turn = movingDown ? 14 : -14;
      return `M ${String(start.x)} ${String(start.y)} C ${String(start.x)} ${String(start.y + turn)}, ${String(start.x)} ${String(laneY - turn)}, ${String(start.x)} ${String(laneY)} L ${String(end.x)} ${String(laneY)} C ${String(end.x)} ${String(laneY + turn)}, ${String(end.x)} ${String(end.y - turn)}, ${String(end.x)} ${String(end.y)}`;
    }
    if (route.id !== "prototype-definition") {
      return curve(start, end);
    }
    const callRect = stations.get("call")!.getBoundingClientRect();
    if (stacked) {
      const laneX = Math.min(
        canvasRect.width - 8,
        Math.max(start.x, end.x, callRect.right - canvasRect.left) + 24,
      );
      const targetLaneY = targetStationRect.top - canvasRect.top - 22;
      return `M ${String(start.x)} ${String(start.y)} C ${String(start.x + 14)} ${String(start.y)}, ${String(laneX)} ${String(start.y + 14)}, ${String(laneX)} ${String(start.y + 28)} L ${String(laneX)} ${String(targetLaneY)} L ${String(end.x)} ${String(targetLaneY)} C ${String(end.x)} ${String(targetLaneY + 12)}, ${String(end.x)} ${String(end.y - 12)}, ${String(end.x)} ${String(end.y)}`;
    }
    const laneY = Math.min(canvasRect.height - 10, callRect.bottom - canvasRect.top + 24);
    const startTurnX = start.x + 30;
    const endTurnX = end.x - 30;
    return `M ${String(start.x)} ${String(start.y)} C ${String(startTurnX - 14)} ${String(start.y)}, ${String(startTurnX - 14)} ${String(laneY)}, ${String(startTurnX)} ${String(laneY)} L ${String(endTurnX)} ${String(laneY)} C ${String(endTurnX + 14)} ${String(laneY)}, ${String(endTurnX + 14)} ${String(end.y)}, ${String(end.x)} ${String(end.y)}`;
  }

  function assertLive(): void {
    if (destroyed) throw new Error("FOA signature contract scene has been destroyed");
  }
}

function boundedIndex(index: number): number {
  return Math.max(0, Math.min(ROUTES.length - 1, index));
}

function animate(target: Element, keyframes: Keyframe[], duration: number): Animation | null {
  if (typeof target.animate !== "function") return null;
  return target.animate(keyframes, {
    duration,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    fill: "none",
  });
}

function animationFinished(animation: Animation): Promise<void> {
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}

function center(rect: DOMRect, origin: DOMRect): ScenePoint {
  return {
    x: rect.left - origin.left + rect.width / 2,
    y: rect.top - origin.top + rect.height / 2,
  };
}

function offset(point: ScenePoint, x: number, y: number): ScenePoint {
  return { x: point.x + x, y: point.y + y };
}

function curve(start: ScenePoint, end: ScenePoint): string {
  const control = Math.max(32, Math.abs(end.x - start.x) * 0.42);
  const direction = end.x >= start.x ? 1 : -1;
  return `M ${String(start.x)} ${String(start.y)} C ${String(start.x + control * direction)} ${String(start.y)}, ${String(end.x - control * direction)} ${String(end.y)}, ${String(end.x)} ${String(end.y)}`;
}

function translate(point: ScenePoint): string {
  return `translate(${String(point.x)}px, ${String(point.y)}px) translate(-50%, -50%)`;
}

function expanded(rect: DOMRect, amount: number): DOMRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
    toJSON: () => ({}),
  };
}

function pointInside(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function element<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const value = ownerDocument.createElement(tag);
  if (className.length > 0) value.className = className;
  return value;
}
