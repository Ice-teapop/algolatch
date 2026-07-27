import type { FoaLessonDefinition, FoaLocale } from "../tutorials/foa-contracts.js";
import type { FoaInteractiveRun } from "../tutorials/foa-interactive-inputs.js";
import type { FoaSceneProfile, FoaSceneSlot } from "../tutorials/foa-scene-profile.js";

export interface FoaSemanticSceneState {
  readonly displayIndex: number;
  readonly confirmedCount: number;
  readonly previewing: boolean;
  readonly completed: boolean;
  readonly runtimeState?: "ready" | "running" | "paused" | "completed";
}

export interface FoaSemanticSceneOptions {
  readonly locale: FoaLocale;
  readonly reducedMotion: boolean;
  readonly onAttempt: (eventId: string) => void;
  readonly onChangeInput?: (() => void) | undefined;
}

export interface FoaSemanticSceneController {
  readonly root: HTMLElement;
  setLocale(locale: FoaLocale): void;
  setReducedMotion(reducedMotion: boolean): void;
  setState(state: FoaSemanticSceneState): void;
  setRuntimeCase?(run: FoaInteractiveRun | null): void;
  setPlaybackRate?(rate: number): void;
  animateAdvance(fromIndex: number, toIndex: number | null): Promise<void> | null;
  animatePreviewAdvance?(fromIndex: number, toIndex: number): Promise<void> | null;
  cancelAnimation(): void;
  focusActive(): void;
  destroy(): void;
}

interface SceneCopy {
  readonly fixedCase: string;
  readonly interactiveCase: string;
  readonly changeInput: string;
  readonly noInput: string;
  readonly input: string;
  readonly output: string;
  readonly hiddenOutput: string;
  readonly current: string;
  readonly done: string;
  readonly pending: string;
  readonly preview: string;
  readonly fixedCaseBoundary: string;
  readonly interactiveCaseBoundary: string;
  readonly ready: string;
  readonly running: string;
  readonly paused: string;
  readonly completed: string;
}

interface SceneTransition {
  readonly from: number;
  readonly to: number;
}

interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

let semanticSceneSequence = 0;

const COPY: Readonly<Record<FoaLocale, SceneCopy>> = Object.freeze({
  zh: {
    fixedCase: "本课案例",
    interactiveCase: "当前输入",
    changeInput: "更换输入",
    noInput: "无输入",
    input: "输入",
    output: "输出",
    hiddenOutput: "完成后显示",
    current: "点击执行",
    done: "已执行",
    pending: "待执行",
    preview: "预览",
    fixedCaseBoundary: "固定案例推演；不冒充真实变量采样。",
    interactiveCaseBoundary: "当前输入驱动的教学推演；不冒充真实变量采样。",
    ready: "就绪",
    running: "运行中",
    paused: "已暂停",
    completed: "已完成",
  },
  en: {
    fixedCase: "Lesson case",
    interactiveCase: "Current input",
    changeInput: "Change input",
    noInput: "No input",
    input: "Input",
    output: "Output",
    hiddenOutput: "Shown on completion",
    current: "Run this step",
    done: "Executed",
    pending: "Pending",
    preview: "Preview",
    fixedCaseBoundary: "Fixed-case replay; it is not sampled runtime state.",
    interactiveCaseBoundary: "Current-input teaching replay; it is not sampled runtime state.",
    ready: "Ready",
    running: "Running",
    paused: "Paused",
    completed: "Completed",
  },
});

const SLOT_COPY: Readonly<Record<FoaLocale, Readonly<Record<FoaSceneSlot, string>>>> =
  Object.freeze({
    zh: Object.freeze({
      entry: "入口",
      input: "输入",
      gate: "验证",
      state: "状态",
      operation: "计算",
      decision: "判断",
      "true-path": "成立",
      "false-path": "不成立",
      merge: "汇合",
      condition: "条件",
      body: "循环体",
      update: "更新",
      call: "调用",
      frame: "栈帧",
      "base-case": "基例",
      return: "返回",
      scope: "作用域",
      object: "对象",
      pointer: "指针",
      array: "数组",
      cursor: "光标",
      output: "输出",
      evidence: "证据",
    }),
    en: Object.freeze({
      entry: "Entry",
      input: "Input",
      gate: "Gate",
      state: "State",
      operation: "Compute",
      decision: "Decide",
      "true-path": "True",
      "false-path": "False",
      merge: "Merge",
      condition: "Condition",
      body: "Body",
      update: "Update",
      call: "Call",
      frame: "Frame",
      "base-case": "Base case",
      return: "Return",
      scope: "Scope",
      object: "Object",
      pointer: "Pointer",
      array: "Array",
      cursor: "Cursor",
      output: "Output",
      evidence: "Evidence",
    }),
  });

const INTERACTIVE_STEP_COPY: Readonly<Record<FoaLocale, Readonly<Record<FoaSceneSlot, string>>>> =
  Object.freeze({
    zh: Object.freeze({
      entry: "开始处理当前输入",
      input: "读取当前输入",
      gate: "检查输入是否有效",
      state: "更新当前状态",
      operation: "执行本步计算",
      decision: "判断当前条件",
      "true-path": "进入成立分支",
      "false-path": "进入不成立分支",
      merge: "汇合分支结果",
      condition: "检查循环条件",
      body: "执行循环体",
      update: "更新循环变量",
      call: "调用当前函数",
      frame: "建立当前栈帧",
      "base-case": "检查递归基例",
      return: "返回当前结果",
      scope: "进入当前作用域",
      object: "访问当前对象",
      pointer: "沿指针访问",
      array: "访问数组元素",
      cursor: "移动当前位置",
      output: "输出计算结果",
      evidence: "记录运行证据",
    }),
    en: Object.freeze({
      entry: "Start processing this input",
      input: "Read the current input",
      gate: "Validate the input",
      state: "Update the current state",
      operation: "Perform this computation",
      decision: "Evaluate the condition",
      "true-path": "Take the true branch",
      "false-path": "Take the false branch",
      merge: "Merge the branch result",
      condition: "Check the loop condition",
      body: "Execute the loop body",
      update: "Update the loop variable",
      call: "Call the current function",
      frame: "Create the current stack frame",
      "base-case": "Check the base case",
      return: "Return the current result",
      scope: "Enter the current scope",
      object: "Access the current object",
      pointer: "Follow the pointer",
      array: "Access the array element",
      cursor: "Move the current position",
      output: "Output the result",
      evidence: "Record runtime evidence",
    }),
  });

function interactiveStepLabel(slot: FoaSceneSlot, locale: FoaLocale): string {
  return INTERACTIVE_STEP_COPY[locale][slot];
}

/**
 * Stable semantic scene for the fixed-case lessons. Unlike the former token bank, this component
 * keeps one persistent visual object per authored event and gives each lesson an explicit scene
 * kind. Interactive input-driven lessons keep using their dedicated flow models.
 */
export function createFoaSemanticScene(
  ownerDocument: Document,
  lesson: FoaLessonDefinition,
  profile: FoaSceneProfile,
  options: FoaSemanticSceneOptions,
): FoaSemanticSceneController {
  if (profile.order !== lesson.order) {
    throw new TypeError(
      `FOA scene profile ${String(profile.order)} does not match lesson ${String(lesson.order)}`,
    );
  }
  if (profile.slots.length !== lesson.semanticEvents.length) {
    throw new RangeError(`FOA scene profile ${String(profile.order)} has an invalid slot count`);
  }

  let locale = options.locale;
  let reducedMotion = options.reducedMotion;
  let destroyed = false;
  let state: FoaSemanticSceneState = Object.freeze({
    displayIndex: 0,
    confirmedCount: 0,
    previewing: false,
    completed: false,
  });
  let resizeObserver: ResizeObserver | null = null;
  let animation: Animation | null = null;
  let activeTransition: SceneTransition | null = null;
  let layoutFrameId: number | null = null;
  let runtimeCase: FoaInteractiveRun | null = null;

  const root = element(ownerDocument, "section", "foa-semantic-scene");
  root.dataset.sceneKind = profile.kind;
  root.dataset.connection = profile.connection;
  root.dataset.special = String(profile.special);
  root.dataset.caseMode = profile.caseMode;

  const evidence = element(ownerDocument, "header", "foa-semantic-scene__evidence");
  const caseIdentity = element(ownerDocument, "strong");
  const boundary = element(ownerDocument, "span", "foa-semantic-scene__boundary");
  const channels = element(ownerDocument, "dl", "foa-semantic-scene__channels");
  const inputTerm = element(ownerDocument, "dt");
  const inputValue = element(ownerDocument, "dd");
  const outputTerm = element(ownerDocument, "dt");
  const outputValue = element(ownerDocument, "dd");
  channels.append(inputTerm, inputValue, outputTerm, outputValue);
  const runStatus = element(ownerDocument, "span", "foa-semantic-scene__run-status");
  const changeInput = ownerDocument.createElement("button");
  changeInput.type = "button";
  changeInput.className = "foa-semantic-scene__change-input";
  changeInput.dataset.taskLessonAction = "change-input";
  changeInput.hidden = true;
  changeInput.addEventListener("click", () => options.onChangeInput?.());
  evidence.append(caseIdentity, boundary, channels, runStatus, changeInput);

  const diagram = element(ownerDocument, "div", "foa-semantic-scene__diagram");
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("foa-semantic-scene__edges");
  svg.setAttribute("aria-hidden", "true");
  const markerId = `foa-scene-arrow-${String(lesson.order)}-${String(++semanticSceneSequence)}`;
  const defs = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.id = markerId;
  marker.setAttribute("viewBox", "0 0 8 8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const markerPath = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  markerPath.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
  marker.append(markerPath);
  defs.append(marker);
  svg.append(defs);
  diagram.append(svg);

  const nodes = lesson.semanticEvents.map((event, index) => {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "foa-semantic-scene__node";
    button.dataset.eventId = event.id;
    button.dataset.sceneSlot = profile.slots[index]!;
    button.dataset.index = String(index);
    const role = element(ownerDocument, "span", "foa-semantic-scene__node-order");
    const label = element(ownerDocument, "strong");
    const status = element(ownerDocument, "span", "foa-semantic-scene__node-status");
    const detail = element(ownerDocument, "span", "foa-semantic-scene__node-detail");
    button.append(role, label, status, detail);
    button.addEventListener("click", () => options.onAttempt(event.id));
    diagram.append(button);
    return { button, detail, label, role, status };
  });

  const edgePaths = buildEdgePairs(profile, lesson.semanticEvents.length).map(
    ([from, to], index) => {
      const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.dataset.edgeIndex = String(index);
      path.dataset.fromIndex = String(from);
      path.dataset.toIndex = String(to);
      path.dataset.route = "ports";
      path.setAttribute("marker-end", `url(#${markerId})`);
      svg.append(path);
      return path;
    },
  );
  const travelToken = element(ownerDocument, "span", "foa-semantic-scene__travel-token");
  travelToken.hidden = true;
  diagram.append(travelToken);
  root.append(evidence, diagram);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => requestLayout());
    resizeObserver.observe(diagram);
    for (const node of nodes) resizeObserver.observe(node.button);
  }
  requestLayout();
  applyLocale();
  render();

  return Object.freeze({
    root,
    setLocale(nextLocale: FoaLocale): void {
      assertLive();
      locale = nextLocale;
      applyLocale();
      render();
    },
    setReducedMotion(nextReducedMotion: boolean): void {
      assertLive();
      reducedMotion = nextReducedMotion;
      if (reducedMotion) cancelAnimation();
      root.dataset.reducedMotion = String(reducedMotion);
    },
    setState(nextState: FoaSemanticSceneState): void {
      assertLive();
      if (nextState.confirmedCount !== state.confirmedCount) clearActiveTransition();
      state = Object.freeze({ ...nextState });
      render();
    },
    setRuntimeCase(nextRuntimeCase: FoaInteractiveRun | null): void {
      assertLive();
      runtimeCase = nextRuntimeCase;
      if (runtimeCase === null) delete root.dataset.inputGroup;
      else root.dataset.inputGroup = runtimeCase.group;
      applyLocale();
      render();
    },
    animateAdvance(fromIndex: number, toIndex: number | null): Promise<void> | null {
      assertLive();
      cancelAnimation();
      const fromNode = nodes[fromIndex]?.button;
      if (fromNode === undefined || reducedMotion || typeof fromNode.animate !== "function") {
        return null;
      }
      let nextAnimation: Animation;
      if (toIndex === null) {
        nextAnimation = fromNode.animate(
          [
            { opacity: 0.72, transform: "scale(0.985)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      } else {
        layoutEdges();
        const path = edgePaths.find(
          (candidate) =>
            Number(candidate.dataset.fromIndex) === fromIndex &&
            Number(candidate.dataset.toIndex) === toIndex,
        );
        if (path === undefined || path.getTotalLength() <= 0) return null;
        activeTransition = Object.freeze({ from: fromIndex, to: toIndex });
        root.dataset.transitionFrom = String(fromIndex);
        root.dataset.transitionTo = String(toIndex);
        renderEdgeStates();
        const samples = 18;
        const length = path.getTotalLength();
        const keyframes: Keyframe[] = [];
        for (let index = 0; index <= samples; index += 1) {
          const point = path.getPointAtLength((length * index) / samples);
          keyframes.push({
            transform: `translate(${String(point.x)}px, ${String(point.y)}px) translate(-50%, -50%)`,
            opacity: index === 0 || index === samples ? 0.72 : 1,
          });
        }
        travelToken.hidden = false;
        nextAnimation = travelToken.animate(keyframes, {
          duration: 520,
          easing: "linear",
          fill: "forwards",
        });
      }
      animation = nextAnimation;
      return nextAnimation.finished
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (animation !== nextAnimation) return;
          animation = null;
          travelToken.hidden = true;
          travelToken.style.transform = "";
          clearActiveTransition();
          renderEdgeStates();
        });
    },
    cancelAnimation(): void {
      assertLive();
      cancelAnimation();
    },
    focusActive(): void {
      assertLive();
      nodes[Math.min(state.confirmedCount, nodes.length - 1)]?.button.focus();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimation();
      cancelLayout();
      resizeObserver?.disconnect();
      resizeObserver = null;
      root.parentElement?.removeChild(root);
    },
  });

  function applyLocale(): void {
    const copy = COPY[locale];
    caseIdentity.textContent = runtimeCase === null ? copy.fixedCase : copy.interactiveCase;
    boundary.textContent = profile.rationale[locale];
    boundary.title = `${profile.rationale[locale]} ${
      runtimeCase === null ? copy.fixedCaseBoundary : copy.interactiveCaseBoundary
    }`;
    inputTerm.textContent = copy.input;
    outputTerm.textContent = copy.output;
    const visibleInput = visibleCaseValue(runtimeCase?.stdin ?? lesson.case.stdin, copy.noInput);
    inputValue.textContent = visibleInput;
    inputValue.title = visibleInput;
    inputValue.setAttribute("aria-label", `${copy.input}: ${visibleInput}`);
    changeInput.textContent = copy.changeInput;
    changeInput.hidden = runtimeCase === null || options.onChangeInput === undefined;
    root.setAttribute(
      "aria-label",
      `${lesson.title[locale]} · ${lesson.experience.visualModel[locale]}`,
    );
    nodes.forEach((node, index) => {
      node.role.textContent = SLOT_COPY[locale][profile.slots[index]!];
      node.label.textContent =
        runtimeCase === null
          ? lesson.semanticEvents[index]!.label[locale]
          : interactiveStepLabel(profile.slots[index]!, locale);
    });
  }

  function render(): void {
    const copy = COPY[locale];
    root.dataset.previewing = String(state.previewing);
    root.dataset.completed = String(state.completed);
    root.dataset.reducedMotion = String(reducedMotion);
    root.dataset.displayIndex = String(state.displayIndex);
    root.dataset.confirmedCount = String(state.confirmedCount);
    const runtimeState = state.runtimeState ?? (state.completed ? "completed" : "ready");
    root.dataset.runState = runtimeState;
    runStatus.dataset.state = runtimeState;
    runStatus.textContent = copy[runtimeState];
    const visibleOutput = state.completed
      ? visibleCaseValue(runtimeCase?.stdout ?? lesson.case.stdout, "∅")
      : copy.hiddenOutput;
    outputValue.textContent = visibleOutput;
    outputValue.title = visibleOutput;
    outputValue.setAttribute("aria-label", `${copy.output}: ${visibleOutput}`);
    channels.setAttribute(
      "aria-label",
      `${copy.input}: ${inputValue.textContent ?? ""}; ${copy.output}: ${visibleOutput}`,
    );
    nodes.forEach((node, index) => {
      const nodeState = state.previewing
        ? index === state.displayIndex
          ? "preview"
          : index < state.confirmedCount
            ? "done"
            : "pending"
        : index < state.confirmedCount
          ? "done"
          : index === state.confirmedCount
            ? "active"
            : "pending";
      node.button.dataset.state = nodeState;
      node.button.disabled = state.previewing || index < state.confirmedCount || state.completed;
      node.button.setAttribute(
        "aria-current",
        nodeState === "active" || nodeState === "preview" ? "step" : "false",
      );
      node.status.textContent =
        nodeState === "active"
          ? copy.current
          : nodeState === "done"
            ? copy.done
            : nodeState === "preview"
              ? copy.preview
              : copy.pending;
      const detail = runtimeCase?.eventDetails[index]?.[locale] ?? "";
      const mayRevealDetail = nodeState === "done" || state.completed;
      node.detail.textContent = mayRevealDetail ? detail : "";
      node.detail.hidden = !mayRevealDetail || detail.length === 0;
      node.button.title =
        mayRevealDetail && detail.length > 0
          ? `${node.label.textContent ?? ""} — ${detail}`
          : (node.label.textContent ?? "");
    });
    renderEdgeStates();
    requestLayout();
  }

  function renderEdgeStates(): void {
    edgePaths.forEach((path) => {
      const from = Number(path.dataset.fromIndex);
      const to = Number(path.dataset.toIndex);
      const isActive = activeTransition?.from === from && activeTransition.to === to;
      const isDone = to === from + 1 && from < Math.min(state.confirmedCount, nodes.length - 1);
      path.dataset.state = isActive ? "active" : isDone ? "done" : "pending";
    });
  }

  function requestLayout(): void {
    const view = ownerDocument.defaultView;
    if (view !== null && typeof view.requestAnimationFrame === "function") {
      if (layoutFrameId !== null) return;
      layoutFrameId = view.requestAnimationFrame(() => {
        layoutFrameId = null;
        layoutEdges();
      });
      return;
    }
    layoutEdges();
  }

  function cancelLayout(): void {
    if (layoutFrameId === null) return;
    const view = ownerDocument.defaultView;
    if (view !== null && typeof view.cancelAnimationFrame === "function") {
      view.cancelAnimationFrame(layoutFrameId);
    }
    layoutFrameId = null;
  }

  function layoutEdges(): void {
    if (destroyed || !root.isConnected) return;
    const diagramRect = diagram.getBoundingClientRect();
    const contentWidth = Math.max(diagram.clientWidth, diagram.scrollWidth, diagramRect.width);
    const contentHeight = Math.max(diagram.clientHeight, diagram.scrollHeight, diagramRect.height);
    svg.setAttribute("viewBox", `0 0 ${String(contentWidth)} ${String(contentHeight)}`);
    svg.setAttribute("width", String(contentWidth));
    svg.setAttribute("height", String(contentHeight));
    svg.style.width = `${String(contentWidth)}px`;
    svg.style.height = `${String(contentHeight)}px`;
    const origin = {
      left: diagramRect.left - diagram.scrollLeft,
      top: diagramRect.top - diagram.scrollTop,
    };
    for (const path of edgePaths) {
      const from = nodes[Number(path.dataset.fromIndex)]?.button.getBoundingClientRect();
      const to = nodes[Number(path.dataset.toIndex)]?.button.getBoundingClientRect();
      if (from === undefined || to === undefined) continue;
      path.setAttribute(
        "d",
        edgePath(
          profile,
          Number(path.dataset.fromIndex),
          Number(path.dataset.toIndex),
          from,
          to,
          origin,
        ),
      );
    }
  }

  function cancelAnimation(): void {
    animation?.cancel();
    animation = null;
    travelToken.hidden = true;
    travelToken.style.transform = "";
    clearActiveTransition();
    if (!destroyed) renderEdgeStates();
  }

  function clearActiveTransition(): void {
    activeTransition = null;
    delete root.dataset.transitionFrom;
    delete root.dataset.transitionTo;
  }

  function assertLive(): void {
    if (destroyed) throw new Error("FOA semantic scene has been destroyed");
  }
}

function buildEdgePairs(
  profile: FoaSceneProfile,
  count: number,
): readonly (readonly [number, number])[] {
  if (profile.edges !== undefined) return profile.edges;
  const pairs: Array<readonly [number, number]> = [];
  for (let index = 0; index < count - 1; index += 1) pairs.push([index, index + 1]);
  if (profile.connection === "cycle" && count > 2) pairs.push([count - 1, 1]);
  if (profile.connection === "grid" && count > 2) pairs.push([count - 1, 0]);
  if (profile.connection === "unwind") {
    const call = profile.slots.indexOf("call");
    const returning = profile.slots.indexOf("return");
    if (call >= 0 && returning > call) pairs.push([returning, call]);
  }
  if (profile.connection === "alias") {
    const object = profile.slots.indexOf("object");
    if (object >= 0) {
      profile.slots.forEach((slot, index) => {
        if (slot === "pointer") pairs.push([index, object]);
      });
    }
  }
  if (profile.connection === "branch" && count === 4) {
    const decision = profile.slots.indexOf("decision");
    const merge = profile.slots.indexOf("merge");
    const terminal = merge >= 0 ? merge : count - 1;
    if (decision >= 0 && terminal > decision + 1) pairs.push([decision, terminal]);
  }
  return Object.freeze(uniqueEdges(pairs));
}

function uniqueEdges(
  edges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const seen = new Set<string>();
  return edges.filter(([from, to]) => {
    const key = `${String(from)}:${String(to)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function edgePath(
  profile: FoaSceneProfile,
  fromIndex: number,
  toIndex: number,
  from: DOMRect,
  to: DOMRect,
  origin: Readonly<{ left: number; top: number }>,
): string {
  const fromCenter = rectCenter(from, origin);
  const toCenter = rectCenter(to, origin);
  if (profile.connection === "unwind" && toIndex < fromIndex) {
    const fromPort = horizontalPort(from, origin, "right");
    const toPort = horizontalPort(to, origin, "right");
    const lane = Math.max(fromPort.x, toPort.x) + 34;
    return `M ${String(fromPort.x)} ${String(fromPort.y)} C ${String(lane)} ${String(fromPort.y)}, ${String(lane)} ${String(toPort.y)}, ${String(toPort.x)} ${String(toPort.y)}`;
  }
  if (
    profile.connection === "alias" &&
    toIndex === profile.slots.indexOf("object") &&
    toIndex < fromIndex
  ) {
    const fromTop = from.top - origin.top;
    const toTop = to.top - origin.top;
    const laneTop = Math.min(fromTop, toTop) - 24;
    const fromPort = verticalPort(from, origin, "top");
    const toPort = verticalPort(to, origin, "top");
    if (Math.abs(fromCenter.y - toCenter.y) < Math.max(from.height, to.height)) {
      return `M ${String(fromPort.x)} ${String(fromPort.y)} C ${String(fromPort.x)} ${String(laneTop)}, ${String(toPort.x)} ${String(laneTop)}, ${String(toPort.x)} ${String(toPort.y)}`;
    }
    const sideFrom = horizontalPort(from, origin, "right");
    const sideTo = horizontalPort(to, origin, "right");
    const laneRight = Math.max(sideFrom.x, sideTo.x) + 34;
    return `M ${String(sideFrom.x)} ${String(sideFrom.y)} C ${String(laneRight)} ${String(sideFrom.y)}, ${String(laneRight)} ${String(laneTop)}, ${String(toPort.x)} ${String(laneTop)} L ${String(toPort.x)} ${String(toPort.y)}`;
  }
  if (profile.connection === "cycle" && (toCenter.y < fromCenter.y || toCenter.x < fromCenter.x)) {
    const fromPort = horizontalPort(from, origin, "right");
    const toPort = horizontalPort(to, origin, "right");
    const lane = Math.max(fromPort.x, toPort.x) + 34;
    return `M ${String(fromPort.x)} ${String(fromPort.y)} C ${String(lane)} ${String(fromPort.y)}, ${String(lane)} ${String(toPort.y)}, ${String(toPort.x)} ${String(toPort.y)}`;
  }
  const [fromPort, toPort] = facingPorts(from, to, origin);
  if (
    profile.connection === "branch" ||
    profile.connection === "alias" ||
    profile.connection === "unwind"
  ) {
    if (Math.abs(toPort.x - fromPort.x) >= Math.abs(toPort.y - fromPort.y)) {
      const controlX = (fromPort.x + toPort.x) / 2;
      return `M ${String(fromPort.x)} ${String(fromPort.y)} C ${String(controlX)} ${String(fromPort.y)}, ${String(controlX)} ${String(toPort.y)}, ${String(toPort.x)} ${String(toPort.y)}`;
    }
    const controlY = (fromPort.y + toPort.y) / 2;
    return `M ${String(fromPort.x)} ${String(fromPort.y)} C ${String(fromPort.x)} ${String(controlY)}, ${String(toPort.x)} ${String(controlY)}, ${String(toPort.x)} ${String(toPort.y)}`;
  }
  return `M ${String(fromPort.x)} ${String(fromPort.y)} L ${String(toPort.x)} ${String(toPort.y)}`;
}

function facingPorts(
  from: DOMRect,
  to: DOMRect,
  origin: Readonly<{ left: number; top: number }>,
): readonly [ScenePoint, ScenePoint] {
  const fromCenter = rectCenter(from, origin);
  const toCenter = rectCenter(to, origin);
  const deltaX = toCenter.x - fromCenter.x;
  const deltaY = toCenter.y - fromCenter.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? [horizontalPort(from, origin, "right"), horizontalPort(to, origin, "left")]
      : [horizontalPort(from, origin, "left"), horizontalPort(to, origin, "right")];
  }
  return deltaY >= 0
    ? [verticalPort(from, origin, "bottom"), verticalPort(to, origin, "top")]
    : [verticalPort(from, origin, "top"), verticalPort(to, origin, "bottom")];
}

function rectCenter(rect: DOMRect, origin: Readonly<{ left: number; top: number }>): ScenePoint {
  return {
    x: rect.left - origin.left + rect.width / 2,
    y: rect.top - origin.top + rect.height / 2,
  };
}

function horizontalPort(
  rect: DOMRect,
  origin: Readonly<{ left: number; top: number }>,
  side: "left" | "right",
): ScenePoint {
  return {
    x: (side === "left" ? rect.left : rect.right) - origin.left,
    y: rect.top - origin.top + rect.height / 2,
  };
}

function verticalPort(
  rect: DOMRect,
  origin: Readonly<{ left: number; top: number }>,
  side: "top" | "bottom",
): ScenePoint {
  return {
    x: rect.left - origin.left + rect.width / 2,
    y: (side === "top" ? rect.top : rect.bottom) - origin.top,
  };
}

function visibleCaseValue(value: string, empty: string): string {
  if (value.length === 0) return empty;
  return value.replaceAll("\n", " ↵ ").trim();
}

function element(ownerDocument: Document, tag: string, className = ""): HTMLElement {
  const value = ownerDocument.createElement(tag);
  if (className.length > 0) value.className = className;
  return value;
}
