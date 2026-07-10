export const ONBOARDING_FLOW_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = "c-block-algorithm-panel.onboarding";

export type OnboardingLearner = "new" | "experienced";
export type OnboardingEntryMode = "presets" | "import";
export type OnboardingCompletion = "completed" | "skipped";
export type OnboardingStepId =
  "welcome" | "entry" | "blocks" | "import" | "sync" | "custom" | "lifecycle" | "safety";

export interface OnboardingCheckpoint {
  readonly stepId: OnboardingStepId;
  readonly learner: OnboardingLearner | null;
  readonly entryMode: OnboardingEntryMode | null;
}

export interface OnboardingState {
  readonly version: typeof ONBOARDING_FLOW_VERSION;
  readonly status: "open" | "closed";
  readonly completion: OnboardingCompletion | null;
  readonly stepId: OnboardingStepId;
  readonly learner: OnboardingLearner | null;
  readonly entryMode: OnboardingEntryMode | null;
  readonly history: readonly OnboardingCheckpoint[];
}

export interface OnboardingChoice {
  readonly id: string;
  readonly label: string;
}

export interface OnboardingScene {
  readonly stepId: OnboardingStepId;
  readonly speaker: string;
  readonly dialogue: string;
  readonly choices: readonly OnboardingChoice[];
  readonly canGoBack: boolean;
}

export type OnboardingEvent =
  | { readonly type: "choose"; readonly choiceId: string }
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
  return chooseNextState(state, event.choiceId);
}

export function getOnboardingScene(state: OnboardingState): OnboardingScene {
  assertState(state);
  const scene = sceneContent(state);
  return Object.freeze({ ...scene, canGoBack: state.history.length > 0 });
}

function chooseNextState(state: OnboardingState, choiceId: string): OnboardingState {
  if (!getOnboardingScene(state).choices.some((choice) => choice.id === choiceId)) {
    throw new RangeError(`当前对白不支持选择：${choiceId}`);
  }

  switch (choiceId) {
    case "learner-new":
      return advance(state, "entry", { learner: "new" });
    case "learner-experienced":
      return advance(state, "entry", { learner: "experienced" });
    case "entry-presets":
    case "import-presets":
      return advance(state, "blocks", { entryMode: "presets" });
    case "entry-import":
    case "blocks-import":
      return advance(state, "import", { entryMode: "import" });
    case "blocks-sync":
    case "import-sync":
    case "custom-sync":
      return advance(state, "sync");
    case "sync-custom":
    case "lifecycle-custom":
      return advance(state, "custom");
    case "sync-lifecycle":
    case "custom-lifecycle":
    case "safety-lifecycle":
      return advance(state, "lifecycle");
    case "lifecycle-safety":
      return advance(state, "safety");
    case "finish":
      return freezeState({ ...state, status: "closed", completion: "completed" });
  }
  throw new RangeError(`未知新手引导选择：${choiceId}`);
}

function advance(
  state: OnboardingState,
  stepId: OnboardingStepId,
  patch: Partial<Pick<OnboardingState, "learner" | "entryMode">> = {},
): OnboardingState {
  const checkpoint = Object.freeze({
    stepId: state.stepId,
    learner: state.learner,
    entryMode: state.entryMode,
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
    entryMode: null,
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
): Omit<OnboardingScene, "stepId" | "canGoBack"> & { readonly stepId: OnboardingStepId } {
  switch (state.stepId) {
    case "welcome":
      return scene("welcome", "工作台导师", "先确认你的经验，我会缩短不需要的说明。", [
        choice("learner-new", "我是初学者"),
        choice("learner-experienced", "我写过 C / 算法"),
      ]);
    case "entry":
      return scene(
        "entry",
        "工作台导师",
        state.learner === "experienced"
          ? "你可以直接导入 C，也可以用预制积木快速装配。"
          : "先选起点：用预制积木搭第一段，或导入现有 C 源码。",
        [choice("entry-presets", "从预制积木开始"), choice("entry-import", "导入 C 源码")],
      );
    case "blocks":
      return scene("blocks", "装配员", "把预制积木拖到高亮插槽；不兼容的位置不会接收。", [
        choice("blocks-sync", "继续看代码同步"),
        choice("blocks-import", "改为导入源码"),
      ]);
    case "import":
      return scene("import", "解析器", "打开、拖入或粘贴 C；无法安全拆解的部分保留原始 C。", [
        choice("import-sync", "继续看代码同步"),
        choice("import-presets", "改用预制积木"),
      ]);
    case "sync":
      return scene("sync", "同步器", "积木和代码共用同一份源码；修改后两侧会实时同步。", [
        choice("sync-custom", "了解自定义积木"),
        choice("sync-lifecycle", "先看弃用与删除"),
      ]);
    case "custom":
      return scene("custom", "积木库", "常用片段可以保存为自定义积木；调用时仍走受控源码补丁。", [
        choice("custom-lifecycle", "了解弃用与删除"),
        choice("custom-sync", "回看实时同步"),
      ]);
    case "lifecycle":
      return scene(
        "lifecycle",
        "版本管理员",
        "弃用或删除库内积木，不会改动已生成源码；删除源码语句会另行确认。",
        [choice("lifecycle-safety", "查看安全修改"), choice("lifecycle-custom", "回看自定义积木")],
      );
    case "safety":
      return scene("safety", "审校员", "可能改变语义的操作先看 diff；确认后仍可撤销或重做。", [
        choice("finish", "完成引导"),
        choice("safety-lifecycle", "回看删除规则"),
      ]);
  }
}

function scene(
  stepId: OnboardingStepId,
  speaker: string,
  dialogue: string,
  choices: readonly OnboardingChoice[],
): Omit<OnboardingScene, "canGoBack"> {
  return Object.freeze({ stepId, speaker, dialogue, choices: Object.freeze([...choices]) });
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
