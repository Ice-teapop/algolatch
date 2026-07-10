export const ONBOARDING_FLOW_VERSION = 2;
export const ONBOARDING_STORAGE_KEY = "c-block-algorithm-panel.onboarding";

export type OnboardingLearner = "new" | "experienced";
export type OnboardingCompletion = "completed" | "skipped";
export type OnboardingPlacement = "top" | "right" | "bottom" | "left" | "center";
export type OnboardingStepId =
  | "welcome"
  | "dashboard-modules"
  | "dashboard-create"
  | "dock"
  | "import-source"
  | "build-presets"
  | "assembly"
  | "code"
  | "local-save"
  | "explanation"
  | "edit"
  | "run"
  | "block-library"
  | "software-library";

const STEP_IDS: readonly OnboardingStepId[] = Object.freeze([
  "welcome",
  "dashboard-modules",
  "dashboard-create",
  "dock",
  "import-source",
  "build-presets",
  "assembly",
  "code",
  "local-save",
  "explanation",
  "edit",
  "run",
  "block-library",
  "software-library",
]);

export interface OnboardingCheckpoint {
  readonly stepId: OnboardingStepId;
  readonly learner: OnboardingLearner | null;
}

export interface OnboardingState {
  readonly version: typeof ONBOARDING_FLOW_VERSION;
  readonly status: "open" | "closed";
  readonly completion: OnboardingCompletion | null;
  readonly stepId: OnboardingStepId;
  readonly learner: OnboardingLearner | null;
  readonly history: readonly OnboardingCheckpoint[];
}

export interface OnboardingChoice {
  readonly id: string;
  readonly label: string;
}

export interface OnboardingScene {
  readonly stepId: OnboardingStepId;
  readonly pageId: string;
  readonly targetId: string;
  readonly placement: OnboardingPlacement;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly speaker: string;
  readonly dialogue: string;
  readonly choices: readonly OnboardingChoice[];
  readonly canGoBack: boolean;
}

export type OnboardingEvent =
  | { readonly type: "choose"; readonly choiceId: string }
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "skip" }
  | { readonly type: "reopen" };

export type OnboardingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface OnboardingFlowOptions {
  readonly storage?: OnboardingStorage | undefined;
}

export interface OnboardingFlow {
  getState(): OnboardingState;
  choose(choiceId: string): OnboardingState;
  next(): OnboardingState;
  back(): OnboardingState;
  skip(): OnboardingState;
  reopen(): OnboardingState;
}

export function createOnboardingFlow(options: OnboardingFlowOptions = {}): OnboardingFlow {
  const storage = options.storage ?? defaultStorage();
  const storedCompletion = readCompletion(storage);
  let state = initialState(storedCompletion, storedCompletion === null);

  const apply = (event: OnboardingEvent): OnboardingState => {
    state = transitionOnboarding(state, event);
    if (state.status === "closed" && state.completion !== null) {
      writeCompletion(storage, state.completion);
    }
    return state;
  };

  return Object.freeze({
    getState: () => state,
    choose: (choiceId: string) => apply({ type: "choose", choiceId }),
    next: () => apply({ type: "next" }),
    back: () => apply({ type: "back" }),
    skip: () => apply({ type: "skip" }),
    reopen: () => apply({ type: "reopen" }),
  });
}

/** Pure deterministic transition: the same state and event always produce the same result. */
export function transitionOnboarding(
  state: OnboardingState,
  event: OnboardingEvent,
): OnboardingState {
  assertState(state);
  if (event.type === "reopen") return initialState(state.completion, true);
  if (state.status !== "open") throw new Error("新手引导当前未打开");
  if (event.type === "back") return previousState(state);
  if (event.type === "skip") {
    return freezeState({ ...state, status: "closed", completion: state.completion ?? "skipped" });
  }
  return chooseNextState(state, event.type === "next" ? "next" : event.choiceId);
}

export function getOnboardingScene(state: OnboardingState): OnboardingScene {
  assertState(state);
  const content = sceneContent(state);
  const stepIndex = STEP_IDS.indexOf(state.stepId) + 1;
  return Object.freeze({
    ...content,
    stepIndex,
    stepCount: STEP_IDS.length,
    canGoBack: state.history.length > 0,
  });
}

function chooseNextState(state: OnboardingState, choiceId: string): OnboardingState {
  if (!getOnboardingScene(state).choices.some((choice) => choice.id === choiceId)) {
    throw new RangeError(`当前对白不支持选择：${choiceId}`);
  }
  if (choiceId === "learner-new" || choiceId === "learner-experienced") {
    return advance(state, "dashboard-modules", {
      learner: choiceId === "learner-new" ? "new" : "experienced",
    });
  }
  if (choiceId === "finish") {
    return freezeState({ ...state, status: "closed", completion: "completed" });
  }
  if (choiceId === "next") return advance(state, requireNextStep(state.stepId));
  throw new RangeError(`未知新手引导选择：${choiceId}`);
}

function requireNextStep(stepId: OnboardingStepId): OnboardingStepId {
  const currentIndex = STEP_IDS.indexOf(stepId);
  const next = STEP_IDS[currentIndex + 1];
  if (next === undefined) throw new RangeError("新手引导已到最后一步");
  return next;
}

function advance(
  state: OnboardingState,
  stepId: OnboardingStepId,
  patch: Partial<Pick<OnboardingState, "learner">> = {},
): OnboardingState {
  const checkpoint = Object.freeze({
    stepId: state.stepId,
    learner: state.learner,
  });
  return freezeState({
    ...state,
    ...patch,
    stepId,
    history: [...state.history, checkpoint],
  });
}

function previousState(state: OnboardingState): OnboardingState {
  const checkpoint = state.history.at(-1);
  if (checkpoint === undefined) return state;
  return freezeState({
    ...state,
    ...checkpoint,
    history: state.history.slice(0, -1),
  });
}

function initialState(completion: OnboardingCompletion | null, open: boolean): OnboardingState {
  return freezeState({
    version: ONBOARDING_FLOW_VERSION,
    status: open ? "open" : "closed",
    completion,
    stepId: "welcome",
    learner: null,
    history: [],
  });
}

function freezeState(state: OnboardingState): OnboardingState {
  return Object.freeze({
    ...state,
    history: Object.freeze(state.history.map((checkpoint) => Object.freeze({ ...checkpoint }))),
  });
}

function sceneContent(
  state: OnboardingState,
): Omit<OnboardingScene, "stepIndex" | "stepCount" | "canGoBack"> {
  switch (state.stepId) {
    case "welcome":
      return scene(
        "welcome",
        "dashboard",
        "dashboard",
        "center",
        "工作台导师",
        "先确认你的经验。两条路线都会走完全部核心功能，只调整说明密度。",
        [choice("learner-new", "我是初学者"), choice("learner-experienced", "我写过 C / 算法")],
      );
    case "dashboard-modules":
      return scene(
        state.stepId,
        "dashboard",
        "dashboard-modules",
        "right",
        "工作台导师",
        personalized(
          state,
          "首页按项目、沙箱、测试组织学习文件；它们都保存在 Documents 专属目录中。",
          "Dashboard 把持久项目、临时沙箱和测试夹具分开管理，并映射到本地 Documents。",
        ),
        nextChoice(),
      );
    case "dashboard-create":
      return scene(
        state.stepId,
        "dashboard",
        "create-entry",
        "bottom",
        "工作台导师",
        "新建条目会创建独立子文件夹并启用自动保存；创建完成后直接进入搭建工作区。",
        nextChoice(),
      );
    case "dock":
      return scene(
        state.stepId,
        "dashboard",
        "dock",
        "bottom",
        "导航员",
        "Dock 按文件、构建、检查、执行、学习分组。新算法工具可注册为独立页面继续扩展。",
        nextChoice(),
      );
    case "import-source":
      return scene(
        state.stepId,
        "dashboard",
        "import-actions",
        "bottom",
        "解析器",
        "已有 C 可以通过文件选择、磁盘拖放或粘贴载入；外部源码保持为临时文档，不会被静默覆盖。",
        nextChoice(),
      );
    case "build-presets":
      return scene(
        state.stepId,
        "build",
        "preset-blocks",
        "right",
        "装配员",
        "预制积木按学习阶段分类，可直接拖入或调用；以后也能加入课程模板和自定义片段。",
        nextChoice(),
      );
    case "assembly":
      return scene(
        state.stepId,
        "build",
        "assembly-canvas",
        "left",
        "装配员",
        "在组装画布拖动、排序和嵌套代码块；自己编写的片段也能保存后参与组装。",
        nextChoice(),
      );
    case "code":
      return scene(
        state.stepId,
        "build",
        "code-pane",
        "left",
        "同步器",
        "代码与积木共享同一份 C 源码并实时同步；导入的 C 会反向拆解，无法安全拆解处保留原文。",
        nextChoice(),
      );
    case "local-save":
      return scene(
        state.stepId,
        "build",
        "local-save",
        "top",
        "同步器",
        "托管条目修改后会在 300 ms 防抖后写入 Documents；底栏明确显示待保存、保存中、已保存或错误。",
        nextChoice(),
      );
    case "explanation":
      return scene(
        state.stepId,
        "explanation",
        "explanation",
        "left",
        "工作台导师",
        "解释页说明选中区块的作用、原理与上下文，后续可扩展复杂度分析和课程知识链接。",
        nextChoice(),
      );
    case "edit":
      return scene(
        state.stepId,
        "edit",
        "edit",
        "left",
        "审校员",
        "编辑页提供受控结构修改；语义可能变化时先确认 diff，并可撤销或重做。",
        nextChoice(),
      );
    case "run":
      return scene(
        state.stepId,
        "run",
        "run",
        "left",
        "执行器",
        "运行页负责构建、输入、输出和失败定位，后续可接入课程测试集与性能实验。",
        nextChoice(),
      );
    case "block-library":
      return scene(
        state.stepId,
        "block-library",
        "block-library-lifecycle",
        "left",
        "版本管理员",
        "积木库管理创建、弃用、恢复与退休；库生命周期不会偷偷改写已经生成的源码。",
        nextChoice(),
      );
    case "software-library":
      return scene(
        state.stepId,
        "software-library",
        "software-library",
        "left",
        "工作台导师",
        "Software Library 汇总每个区块的职责、使用入口和扩展边界，可随平台能力持续补充。",
        [choice("finish", "完成引导")],
      );
  }
}

function scene(
  stepId: OnboardingStepId,
  pageId: string,
  targetId: string,
  placement: OnboardingPlacement,
  speaker: string,
  dialogue: string,
  choices: readonly OnboardingChoice[],
): Omit<OnboardingScene, "stepIndex" | "stepCount" | "canGoBack"> {
  return Object.freeze({
    stepId,
    pageId,
    targetId,
    placement,
    speaker,
    dialogue,
    choices: Object.freeze([...choices]),
  });
}

function personalized(
  state: OnboardingState,
  beginnerDialogue: string,
  experiencedDialogue: string,
): string {
  return state.learner === "experienced" ? experiencedDialogue : beginnerDialogue;
}

function nextChoice(): readonly OnboardingChoice[] {
  return [choice("next", "下一步")];
}

function choice(id: string, label: string): OnboardingChoice {
  return Object.freeze({ id, label });
}

function readCompletion(storage: OnboardingStorage | undefined): OnboardingCompletion | null {
  if (storage === undefined) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(ONBOARDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      value !== null &&
      typeof value === "object" &&
      "version" in value &&
      value.version === ONBOARDING_FLOW_VERSION &&
      "completion" in value &&
      (value.completion === "completed" || value.completion === "skipped")
    ) {
      return value.completion;
    }
  } catch {
    // Invalid persisted data is removed below and treated as a first launch.
  }
  try {
    storage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // A blocked storage backend must not block the deterministic in-memory flow.
  }
  return null;
}

function writeCompletion(
  storage: OnboardingStorage | undefined,
  completion: OnboardingCompletion,
): void {
  try {
    storage?.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ version: ONBOARDING_FLOW_VERSION, completion }),
    );
  } catch {
    // Completion still applies for this session when persistence is unavailable.
  }
}

function defaultStorage(): OnboardingStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function assertState(state: OnboardingState): void {
  if (state.version !== ONBOARDING_FLOW_VERSION) {
    throw new TypeError("新手引导状态版本不受支持");
  }
}
