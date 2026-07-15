import type { MentorHint, MentorHintTarget } from "../mentor/index.js";
import type { PanelApi } from "../shared/api.js";
import {
  AI_MENTOR_HISTORY_MAX_LENGTH,
  AI_MENTOR_HISTORY_MAX_TURNS,
  AI_MENTOR_TURN_MAX_LENGTH,
  type AiMentorTurn,
  type AiProviderPublicConfig,
} from "../shared/ai-provider.js";
import { AI_PROVIDER_CONFIG_CHANGE_EVENT } from "./ai-provider-events.js";

export interface MentorRemoteContext {
  readonly workspaceId: string;
  readonly sourceFingerprint: string;
  readonly sourceRevision: number;
  readonly currentFunction: string;
  readonly diagnosticSummary: readonly string[];
  readonly controlFlowSummary: string;
  readonly runEvidence: readonly string[];
  readonly fullSource: string;
}

export interface MentorPresetQuestion {
  readonly label: string;
  readonly prompt: string;
}

export const MENTOR_PRESET_QUESTIONS: readonly MentorPresetQuestion[] = Object.freeze([
  Object.freeze({
    label: "解释算法",
    prompt: "这段代码实现了什么算法？请按目标、输入输出和关键步骤解释。",
  }),
  Object.freeze({
    label: "逐步跑一遍",
    prompt: "请选一个小输入，逐步说明关键变量、判断和分支；不要把推演冒充成真实 Trace。",
  }),
  Object.freeze({
    label: "找边界遗漏",
    prompt: "这段算法可能漏掉哪些边界条件？请区分已确认问题和待验证风险。",
  }),
  Object.freeze({
    label: "设计测试",
    prompt: "请为当前算法设计最值得先跑的边界测试，并给出输入、预期结果和测试目的。",
  }),
  Object.freeze({
    label: "分析复杂度",
    prompt: "请分析时间和空间复杂度，说明依据，并把 Big-O 与实测数据分开。",
  }),
  Object.freeze({
    label: "比较优化",
    prompt: "如何让当前算法更清晰或更高效？最多比较两种方案并说明代价，不要自动改码。",
  }),
]);

type MentorLocale = "zh-CN" | "en";

interface MentorCopy {
  readonly presets: readonly MentorPresetQuestion[];
  readonly heading: string;
  readonly boundary: string;
  readonly purpose: string;
  readonly modeTabsAria: string;
  readonly remoteTab: string;
  readonly localTab: string;
  readonly localScope: string;
  readonly localListAria: string;
  readonly localEmpty: string;
  readonly sourceChangedMarker: string;
  readonly assistantWorking: string;
  readonly assistantStopped: string;
  readonly assistantFailed: string;
  readonly assistantNotSent: string;
  readonly answerComplete: string;
  readonly answerStopped: string;
  readonly answerReadFailed: string;
  readonly staleAnswer: string;
  readonly configLoading: string;
  readonly configMissing: string;
  readonly configReadFailed: string;
  readonly configChanged: string;
  readonly conversationCleared: string;
  readonly emptyQuestion: string;
  readonly answering: string;
  readonly staleRequest: string;
  readonly requestStartFailed: string;
  readonly sourceAnalyzing: string;
  readonly sourceUpdated: string;
  readonly openProject: string;
  readonly setupCopy: string;
  readonly connectModel: string;
  readonly remoteScope: string;
  readonly presetHeading: string;
  readonly presetListAria: string;
  readonly transcriptAria: string;
  readonly chatEmpty: string;
  readonly composerLabel: string;
  readonly composerPlaceholder: string;
  readonly send: string;
  readonly cancel: string;
  readonly clear: string;
  readonly contextFunction: string;
  readonly contextFull: string;
  readonly contextLabel: string;
  readonly contextModeAria: string;
  readonly functionOption: string;
  readonly fullSourceOption: string;
  readonly contextBoundary: string;
  readonly userRole: string;
  readonly historyTruncated: string;
  readonly noSourceLocation: string;
  readonly locateSource: string;
  readonly nextStep: string;
  readonly noAutomaticEdits: string;
  readonly confidence: Readonly<Record<MentorHint["confidence"], string>>;
  readonly level: Readonly<Record<MentorHint["level"], string>>;
  evidenceCount(count: number): string;
  evidenceSummary(count: number, labels: string): string;
  connected(model: string): string;
  connectedNeedsProject(model: string): string;
  questionTooLong(maxLength: number): string;
}

const ENGLISH_MENTOR_PRESET_QUESTIONS: readonly MentorPresetQuestion[] = Object.freeze([
  Object.freeze({
    label: "Explain algorithm",
    prompt:
      "What algorithm does this code implement? Explain its goal, inputs and outputs, and key steps.",
  }),
  Object.freeze({
    label: "Walk through it",
    prompt:
      "Choose a small input and walk through the key variables, decisions, and branches. Do not present a simulation as a real Trace.",
  }),
  Object.freeze({
    label: "Find edge cases",
    prompt:
      "Which edge cases might this algorithm miss? Separate confirmed issues from risks that still need verification.",
  }),
  Object.freeze({
    label: "Design tests",
    prompt:
      "Design the highest-value edge-case tests for this algorithm. Include each input, expected result, and purpose.",
  }),
  Object.freeze({
    label: "Analyze complexity",
    prompt:
      "Analyze the time and space complexity and explain the evidence. Keep Big-O separate from measured runtime data.",
  }),
  Object.freeze({
    label: "Compare improvements",
    prompt:
      "How could this algorithm be clearer or more efficient? Compare at most two options and their trade-offs. Do not edit the code automatically.",
  }),
]);

const MENTOR_COPY: Readonly<Record<MentorLocale, MentorCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    presets: MENTOR_PRESET_QUESTIONS,
    heading: "AI 助手",
    boundary: "只读建议 · 不自动改码 · 不替代测试",
    purpose:
      "识别并解释当前算法、提示可能的边界缺口、比较设计与优化方案，并结合诊断与运行证据建议下一步实验。",
    modeTabsAria: "AI 助手模式",
    remoteTab: "AI 对话",
    localTab: "本地检查",
    localScope: "无需 API · 根据静态诊断、Trace 路径和运行历史生成可定位建议。",
    localListAria: "本地证据提示",
    localEmpty: "运行或 Trace 后，这里会显示问题位置、证据和下一步操作。",
    sourceChangedMarker: "源码已更新。旧对话仅供查看；新问题将基于当前版本。",
    assistantWorking: "正在回答…",
    assistantStopped: "回答已停止。",
    assistantFailed: "回答失败；可重新发送这个问题。",
    assistantNotSent: "未发送成功。问题已放回输入框。",
    answerComplete: "回答完成，可继续追问。",
    answerStopped: "回答已停止，可继续提问。",
    answerReadFailed: "无法读取 AI 回答。",
    staleAnswer: "源码已变化，旧回答已丢弃。",
    configLoading: "正在读取 AI 配置…",
    configMissing: "尚未连接模型；本地证据仍可直接使用。",
    configReadFailed: "无法读取 AI 配置。",
    configChanged: "AI 配置已变化，当前回答已停止。",
    conversationCleared: "当前窗口的对话已清空。",
    emptyQuestion: "请输入想讨论的问题。",
    answering: "正在回答，可随时停止。",
    staleRequest: "源码已变化，旧请求已取消。",
    requestStartFailed: "无法启动 AI 请求。",
    sourceAnalyzing: "源码正在重新分析，当前回答已停止。",
    sourceUpdated: "源码已更新，当前回答已停止。",
    openProject: "先打开一个 C 项目；本地检查无需连接模型。",
    setupCopy:
      "连接模型后，可基于 main / 首个可分析函数和运行证据询问算法含义、可疑逻辑与优化代价。",
    connectModel: "连接 AI 模型",
    remoteScope: "回答只作建议；对话仅保留在当前窗口，不写入项目或日志。",
    presetHeading: "常用问题 · 点击即提问",
    presetListAria: "常用问题",
    transcriptAria: "AI 对话记录",
    chatEmpty: "选择一个常用问题，或直接输入。Enter 发送，Shift+Enter 换行。",
    composerLabel: "问当前算法",
    composerPlaceholder: "输入问题…",
    send: "发送",
    cancel: "停止",
    clear: "清空对话",
    contextFunction: "发送范围 · 分析函数与证据",
    contextFull: "发送范围 · 完整 main.c",
    contextLabel: "附带内容 ",
    contextModeAria: "发送给 AI 的源码范围",
    functionOption: "main / 首个可分析函数与证据",
    fullSourceOption: "完整 main.c（显式发送）",
    contextBoundary: "始终不发送文件路径、stdin 或 args。完整源码只有在这里明确选择后才会附带。",
    userRole: "你",
    historyTruncated: "\n[较早回答已截断]",
    noSourceLocation: "无源码定位",
    locateSource: "定位源码",
    nextStep: "下一步：",
    noAutomaticEdits: "不会自动改码",
    confidence: Object.freeze({ certain: "确定", likely: "可能", hint: "提示" }),
    level: Object.freeze({
      verification: "事实核对",
      elaboration: "原因说明",
      strategy: "策略提示",
    }),
    evidenceCount: (count: number) => `${String(count)} 条证据提示`,
    evidenceSummary: (count: number, labels: string) =>
      `${String(count)} 项证据${labels.length === 0 ? "" : ` · ${labels}`} · 不会自动改码`,
    connected: (model: string) => `${model} · 已连接 · 对话不保存`,
    connectedNeedsProject: (model: string) => `${model} · 已连接；请先打开包含可分析函数的 C 项目`,
    questionTooLong: (maxLength: number) =>
      `问题最多 ${String(maxLength)} 个字符，请缩短后再发送。`,
  }),
  en: Object.freeze({
    presets: ENGLISH_MENTOR_PRESET_QUESTIONS,
    heading: "AI Assistant",
    boundary: "Read-only advice · No automatic edits · Does not replace testing",
    purpose:
      "Explain the current algorithm, flag possible edge-case gaps, compare designs and improvements, and suggest the next experiment using diagnostics and runtime evidence.",
    modeTabsAria: "AI assistant modes",
    remoteTab: "AI Chat",
    localTab: "Local Checks",
    localScope:
      "No API required · Uses static diagnostics, Trace paths, and run history to produce locatable suggestions.",
    localListAria: "Local evidence suggestions",
    localEmpty: "Run the program or a Trace to see issue locations, evidence, and next steps here.",
    sourceChangedMarker:
      "The source changed. Previous messages remain for reference; new questions will use the current version.",
    assistantWorking: "Answering…",
    assistantStopped: "Answer stopped.",
    assistantFailed: "The answer failed. You can send this question again.",
    assistantNotSent: "The message was not sent. The question was restored to the input.",
    answerComplete: "Answer complete. You can ask a follow-up.",
    answerStopped: "Answer stopped. You can ask another question.",
    answerReadFailed: "Could not read the AI response.",
    staleAnswer: "The source changed, so the previous answer was discarded.",
    configLoading: "Loading AI configuration…",
    configMissing: "No model is connected. Local evidence is still available.",
    configReadFailed: "Could not load the AI configuration.",
    configChanged: "The AI configuration changed, so the current answer was stopped.",
    conversationCleared: "The conversation in this window was cleared.",
    emptyQuestion: "Enter a question to discuss.",
    answering: "Answering. You can stop at any time.",
    staleRequest: "The source changed, so the previous request was cancelled.",
    requestStartFailed: "Could not start the AI request.",
    sourceAnalyzing: "The source is being reanalyzed, so the current answer was stopped.",
    sourceUpdated: "The source changed, so the current answer was stopped.",
    openProject: "Open a C project first. Local Checks do not require a model.",
    setupCopy:
      "Connect a model to ask about the algorithm, suspicious logic, and optimization trade-offs using main (or the first analyzable function) and runtime evidence.",
    connectModel: "Connect AI Model",
    remoteScope:
      "Answers are suggestions only. This conversation stays in the current window and is not written to the project or logs.",
    presetHeading: "Suggested questions · Click to ask",
    presetListAria: "Suggested questions",
    transcriptAria: "AI conversation",
    chatEmpty:
      "Choose a suggested question or type your own. Enter sends; Shift+Enter adds a line.",
    composerLabel: "Ask about this algorithm",
    composerPlaceholder: "Type a question…",
    send: "Send",
    cancel: "Stop",
    clear: "Clear Conversation",
    contextFunction: "Shared context · Function and evidence",
    contextFull: "Shared context · Full main.c",
    contextLabel: "Include ",
    contextModeAria: "Source context sent to AI",
    functionOption: "main / first analyzable function and evidence",
    fullSourceOption: "Full main.c (explicitly shared)",
    contextBoundary:
      "File paths, stdin, and args are never sent. Full source is included only when explicitly selected here.",
    userRole: "You",
    historyTruncated: "\n[Earlier response truncated]",
    noSourceLocation: "no source location",
    locateSource: "locate in source",
    nextStep: "Next step: ",
    noAutomaticEdits: "No automatic edits",
    confidence: Object.freeze({ certain: "Confirmed", likely: "Likely", hint: "Hint" }),
    level: Object.freeze({
      verification: "Fact check",
      elaboration: "Explanation",
      strategy: "Strategy",
    }),
    evidenceCount: (count: number) =>
      `${String(count)} evidence suggestion${count === 1 ? "" : "s"}`,
    evidenceSummary: (count: number, labels: string) =>
      `${String(count)} evidence item${count === 1 ? "" : "s"}${labels.length === 0 ? "" : ` · ${labels}`} · No automatic edits`,
    connected: (model: string) => `${model} · Connected · Conversation not saved`,
    connectedNeedsProject: (model: string) =>
      `${model} · Connected; open a C project with an analyzable function first`,
    questionTooLong: (maxLength: number) =>
      `Questions are limited to ${String(maxLength)} characters. Shorten this one before sending.`,
  }),
});

const CHAT_QUESTION_MAX_LENGTH = AI_MENTOR_TURN_MAX_LENGTH;

type MentorRemoteApi = Pick<
  PanelApi,
  "getAiProviderConfig" | "startAiMentor" | "readAiMentor" | "cancelAiMentor"
>;

export interface MentorPanelOptions {
  readonly onLocate?: ((target: MentorHintTarget, hint: MentorHint) => void) | undefined;
  readonly remoteApi?: MentorRemoteApi | undefined;
  readonly onOpenAiSettings?: (() => void) | undefined;
}

export interface MentorPanel {
  readonly element: HTMLElement;
  setHints(hints: readonly MentorHint[]): void;
  setStatus(message: string, state?: "ready" | "working" | "error"): void;
  setRemoteContext(context: MentorRemoteContext | null): void;
  destroy(): void;
}

export function createMentorPanel(
  host: HTMLElement,
  options: MentorPanelOptions = {},
): MentorPanel {
  const ownerDocument = host.ownerDocument;
  const localeHost =
    typeof host.closest === "function"
      ? (host.closest<HTMLElement>("[data-locale]") ?? host)
      : host;
  const documentElement = ownerDocument.documentElement;
  let locale = resolveMentorLocale(
    localeHost.dataset.locale ?? documentElement?.dataset.locale ?? documentElement?.lang,
  );
  const copy = (): MentorCopy => MENTOR_COPY[locale];
  const root = ownerDocument.createElement("section");
  root.className = "mentor-panel";
  root.dataset.state = "ready";

  const headingRow = ownerDocument.createElement("header");
  headingRow.className = "mentor-panel__header";
  const heading = ownerDocument.createElement("h2");
  heading.className = "mentor-panel__title";
  heading.textContent = "AI 助手";
  const boundary = ownerDocument.createElement("span");
  boundary.className = "mentor-panel__boundary";
  boundary.textContent = "只读建议 · 不自动改码 · 不替代测试";
  headingRow.append(heading, boundary);

  const purpose = ownerDocument.createElement("p");
  purpose.className = "mentor-panel__purpose";
  purpose.textContent =
    "识别并解释当前算法、提示可能的边界缺口、比较设计与优化方案，并结合诊断与运行证据建议下一步实验。";

  const tabs = ownerDocument.createElement("div");
  tabs.className = "mentor-panel__tabs";
  tabs.setAttribute("role", "tablist");
  const defaultRemote = options.remoteApi !== undefined;
  const remoteTab = tabButton(ownerDocument, "AI 对话", defaultRemote);
  const localTab = tabButton(ownerDocument, "本地检查", !defaultRemote);
  remoteTab.disabled = options.remoteApi === undefined;
  remoteTab.hidden = options.remoteApi === undefined;
  tabs.append(remoteTab, localTab);

  const localView = ownerDocument.createElement("section");
  localView.className = "mentor-panel__view";
  localView.dataset.view = "local";
  localView.hidden = defaultRemote;
  const localScope = ownerDocument.createElement("p");
  localScope.className = "mentor-panel__scope";
  localScope.textContent = "无需 API · 根据静态诊断、Trace 路径和运行历史生成可定位建议。";
  const status = ownerDocument.createElement("output");
  status.className = "mentor-panel__status";
  status.setAttribute("aria-live", "polite");
  status.textContent = "等待分析证据";
  const list = ownerDocument.createElement("div");
  list.className = "mentor-panel__list";
  list.setAttribute("role", "list");
  localView.append(localScope, status, list);

  const remoteView = createRemoteView(ownerDocument, options.onOpenAiSettings);
  remoteView.root.hidden = !defaultRemote;
  root.append(headingRow, purpose, tabs, localView, remoteView.root);
  host.replaceChildren(root);

  let destroyed = false;
  let remoteContext: MentorRemoteContext | null = null;
  let remoteConfig: AiProviderPublicConfig | null = null;
  let activeSessionId: string | null = null;
  let activeFingerprint: string | null = null;
  let nextSequence = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let requestGeneration = 0;
  let configGeneration = 0;
  let startPending = false;
  let chatHistory: AiMentorTurn[] = [];
  let chatWorkspaceId: string | null = null;
  let chatSourceFingerprint: string | null = null;
  let sourceChangeMarkerVisible = false;
  let transcriptHasMessages = false;
  let activeQuestion: string | null = null;
  let activeAssistantBody: HTMLElement | null = null;
  let currentHints: readonly MentorHint[] = Object.freeze([]);
  let localStatusIsEvidenceCount = true;
  let localStatusMessage: string | null = null;
  const localizedText = new Map<HTMLElement, () => string>();
  const chatRoleLabels: Array<{
    readonly role: "user" | "assistant";
    readonly element: HTMLElement;
  }> = [];

  const setLocalizedText = (element: HTMLElement, value: () => string): void => {
    localizedText.set(element, value);
    element.textContent = value();
  };

  const setRawText = (element: HTMLElement, value: string): void => {
    localizedText.delete(element);
    element.textContent = value;
  };

  const renderStaticLocale = (): void => {
    const value = copy();
    root.setAttribute("aria-label", value.heading);
    heading.textContent = options.remoteApi === undefined ? value.localTab : value.heading;
    boundary.textContent =
      options.remoteApi === undefined ? value.localScope.split(" · ")[0]! : value.boundary;
    purpose.textContent = options.remoteApi === undefined ? value.localScope : value.purpose;
    tabs.setAttribute("aria-label", value.modeTabsAria);
    remoteTab.textContent = value.remoteTab;
    localTab.textContent = value.localTab;
    localScope.textContent = value.localScope;
    list.setAttribute("aria-label", value.localListAria);
    remoteView.missingCopy.textContent = value.setupCopy;
    remoteView.openSettings.textContent = value.connectModel;
    remoteView.scope.textContent = value.remoteScope;
    remoteView.presetHeading.textContent = value.presetHeading;
    remoteView.presetList.setAttribute("aria-label", value.presetListAria);
    for (const [index, button] of remoteView.presets.entries()) {
      const preset = value.presets[index];
      if (preset === undefined) continue;
      button.textContent = preset.label;
      button.title = preset.prompt;
    }
    remoteView.transcript.setAttribute("aria-label", value.transcriptAria);
    remoteView.empty.textContent = value.chatEmpty;
    remoteView.composerLabel.textContent = value.composerLabel;
    remoteView.prompt.placeholder = value.composerPlaceholder;
    remoteView.prompt.setAttribute("aria-label", value.composerLabel);
    remoteView.send.textContent = value.send;
    remoteView.cancel.textContent = value.cancel;
    remoteView.clear.textContent = value.clear;
    remoteView.contextLabelText.textContent = value.contextLabel;
    remoteView.contextMode.setAttribute("aria-label", value.contextModeAria);
    remoteView.functionOption.textContent = value.functionOption;
    remoteView.fullSourceOption.textContent = value.fullSourceOption;
    remoteView.contextBoundary.textContent = value.contextBoundary;
    remoteView.contextSummary.textContent =
      remoteView.contextMode.value === "full-source" ? value.contextFull : value.contextFunction;
    for (const entry of chatRoleLabels) {
      entry.element.textContent = entry.role === "user" ? value.userRole : "AI";
    }
    for (const [element, render] of localizedText) element.textContent = render();
  };

  const render = (hints: readonly MentorHint[]): void => {
    list.replaceChildren();
    if (hints.length === 0) {
      const empty = ownerDocument.createElement("p");
      empty.className = "mentor-panel__empty";
      empty.textContent = copy().localEmpty;
      list.append(empty);
      status.textContent = localStatusIsEvidenceCount
        ? copy().evidenceCount(0)
        : localizeMentorStatus(localStatusMessage ?? "", locale);
      return;
    }
    for (const hint of hints) {
      list.append(renderHint(ownerDocument, hint, options, copy(), locale));
    }
    status.textContent = localStatusIsEvidenceCount
      ? copy().evidenceCount(hints.length)
      : localizeMentorStatus(localStatusMessage ?? "", locale);
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const scrollTranscript = (): void => {
    remoteView.transcript.scrollTop = remoteView.transcript.scrollHeight;
  };

  const appendChatMessage = (role: "user" | "assistant", text: string): HTMLElement => {
    if (!transcriptHasMessages) {
      remoteView.transcript.replaceChildren();
      transcriptHasMessages = true;
      remoteView.presetSection.open = false;
    }
    const message = mentorChatMessage(ownerDocument, role, text, copy());
    chatRoleLabels.push({ role, element: message.label });
    remoteView.transcript.append(message.item);
    remoteView.clear.hidden = false;
    scrollTranscript();
    return message.body;
  };

  const appendSourceMarker = (): void => {
    if (!transcriptHasMessages || sourceChangeMarkerVisible) return;
    const marker = ownerDocument.createElement("p");
    marker.className = "mentor-panel__context-marker";
    setLocalizedText(marker, () => copy().sourceChangedMarker);
    remoteView.transcript.append(marker);
    sourceChangeMarkerVisible = true;
    scrollTranscript();
  };

  const clearConversation = (): void => {
    chatHistory = [];
    activeQuestion = null;
    activeAssistantBody = null;
    sourceChangeMarkerVisible = false;
    transcriptHasMessages = false;
    chatRoleLabels.splice(0, chatRoleLabels.length);
    for (const element of localizedText.keys()) {
      if (element !== remoteView.status) localizedText.delete(element);
    }
    remoteView.transcript.replaceChildren(remoteView.empty);
    remoteView.clear.hidden = true;
    remoteView.presetSection.open = true;
  };

  const rememberExchange = (question: string, response: string): void => {
    chatHistory.push(
      Object.freeze({
        role: "user",
        content: boundedHistoryText(question, copy().historyTruncated),
      }),
      Object.freeze({
        role: "assistant",
        content: boundedHistoryText(response, copy().historyTruncated),
      }),
    );
    while (
      chatHistory.length > AI_MENTOR_HISTORY_MAX_TURNS ||
      chatHistory.reduce((total, turn) => total + turn.content.length, 0) >
        AI_MENTOR_HISTORY_MAX_LENGTH
    ) {
      chatHistory.splice(0, 2);
    }
  };

  const setRemoteBusy = (busy: boolean): void => {
    remoteView.send.hidden = busy;
    remoteView.cancel.hidden = !busy;
    remoteView.prompt.disabled = busy;
    remoteView.contextMode.disabled = busy;
    remoteView.clear.disabled = busy;
    for (const preset of remoteView.presets) preset.disabled = busy;
    if (!busy) {
      remoteView.send.disabled = remoteContext === null || !remoteReady();
    }
  };

  const cancelRemote = (message?: () => string): void => {
    const hadActiveRequest = activeSessionId !== null || startPending;
    requestGeneration += 1;
    startPending = false;
    stopPolling();
    const sessionId = activeSessionId;
    activeSessionId = null;
    activeFingerprint = null;
    if (hadActiveRequest && activeAssistantBody !== null && message !== undefined) {
      if (activeAssistantBody.dataset.state === "working") {
        setLocalizedText(activeAssistantBody, () => copy().assistantStopped);
      }
      activeAssistantBody.dataset.state = "cancelled";
    }
    activeQuestion = null;
    activeAssistantBody = null;
    setRemoteBusy(false);
    if (hadActiveRequest && message !== undefined) {
      setLocalizedText(remoteView.status, message);
      remoteView.status.dataset.state = "ready";
    }
    if (sessionId !== null && options.remoteApi !== undefined) {
      void options.remoteApi.cancelAiMentor({ sessionId });
    }
  };

  const pollRemote = async (): Promise<void> => {
    if (
      destroyed ||
      options.remoteApi === undefined ||
      activeSessionId === null ||
      activeFingerprint === null
    ) {
      return;
    }
    const sessionId = activeSessionId;
    const fingerprint = activeFingerprint;
    try {
      const result = await options.remoteApi.readAiMentor({
        sessionId,
        afterSequence: nextSequence,
      });
      if (
        destroyed ||
        activeSessionId !== sessionId ||
        remoteContext?.sourceFingerprint !== fingerprint
      ) {
        return;
      }
      if (result.status === "failed") {
        setLocalizedText(remoteView.status, () =>
          locale === "en" && containsHan(result.error.message)
            ? copy().answerReadFailed
            : result.error.message,
        );
        remoteView.status.dataset.state = "error";
        if (activeAssistantBody !== null && activeAssistantBody.dataset.state === "working") {
          setLocalizedText(activeAssistantBody, () => copy().assistantFailed);
          activeAssistantBody.dataset.state = "error";
        }
        cancelRemote();
        return;
      }
      if (result.sourceFingerprint !== fingerprint) {
        setLocalizedText(remoteView.status, () => copy().staleAnswer);
        remoteView.status.dataset.state = "error";
        cancelRemote();
        return;
      }
      nextSequence = result.nextSequence;
      for (const event of result.events) {
        if (event.kind === "answer" && activeAssistantBody !== null) {
          const previous =
            activeAssistantBody.dataset.state === "working" ? "" : activeAssistantBody.textContent;
          setRawText(activeAssistantBody, `${previous}${event.text}`);
          activeAssistantBody.dataset.state = "receiving";
          scrollTranscript();
        }
      }
      if (result.status === "running") {
        pollTimer = setTimeout(() => void pollRemote(), 180);
        return;
      }
      const completedQuestion = activeQuestion;
      const completedAnswer = activeAssistantBody?.textContent.trim() ?? "";
      activeSessionId = null;
      activeFingerprint = null;
      if (
        result.status === "completed" &&
        completedQuestion !== null &&
        completedAnswer.length > 0
      ) {
        rememberExchange(completedQuestion, completedAnswer);
        if (activeAssistantBody !== null) activeAssistantBody.dataset.state = "complete";
      } else if (activeAssistantBody !== null) {
        activeAssistantBody.dataset.state = "cancelled";
      }
      activeQuestion = null;
      activeAssistantBody = null;
      setRemoteBusy(false);
      setLocalizedText(remoteView.status, () =>
        result.status === "completed" ? copy().answerComplete : copy().answerStopped,
      );
      remoteView.status.dataset.state = "ready";
      remoteView.prompt.focus();
    } catch {
      if (!destroyed && activeSessionId === sessionId) {
        setLocalizedText(remoteView.status, () => copy().answerReadFailed);
        remoteView.status.dataset.state = "error";
        cancelRemote();
      }
    }
  };

  const remoteReady = (): boolean =>
    remoteConfig?.state === "connected" &&
    remoteConfig.providerId !== null &&
    remoteConfig.model !== null &&
    remoteConfig.credentialUsable;

  const refreshRemoteConfig = async (): Promise<void> => {
    if (options.remoteApi === undefined) return;
    const generation = ++configGeneration;
    setLocalizedText(remoteView.status, () => copy().configLoading);
    try {
      const result = await options.remoteApi.getAiProviderConfig();
      if (destroyed || generation !== configGeneration) return;
      remoteConfig = result.status === "ready" ? result.config : null;
      const ready = remoteReady();
      remoteView.form.hidden = !ready || remoteContext === null;
      remoteView.missing.hidden = ready;
      setRemoteBusy(activeSessionId !== null || startPending);
      if (result.status === "failed") {
        setLocalizedText(remoteView.status, () =>
          locale === "en" && containsHan(result.error.message)
            ? copy().configReadFailed
            : result.error.message,
        );
      } else if (ready) {
        setLocalizedText(remoteView.status, () =>
          remoteContext === null
            ? copy().connectedNeedsProject(remoteConfig!.model!)
            : copy().connected(remoteConfig!.model!),
        );
      } else {
        setLocalizedText(remoteView.status, () => copy().configMissing);
      }
      remoteView.status.dataset.state = result.status === "failed" ? "error" : "ready";
    } catch {
      if (!destroyed && generation === configGeneration) {
        setLocalizedText(remoteView.status, () => copy().configReadFailed);
        remoteView.status.dataset.state = "error";
      }
    }
  };

  const showView = (view: "local" | "remote"): void => {
    const remote = view === "remote";
    localTab.setAttribute("aria-selected", String(!remote));
    remoteTab.setAttribute("aria-selected", String(remote));
    localView.hidden = remote;
    remoteView.root.hidden = !remote;
    if (remote) void refreshRemoteConfig();
  };

  const onAiProviderConfigChange = (): void => {
    cancelRemote(() => copy().configChanged);
    configGeneration += 1;
    remoteConfig = null;
    if (!remoteView.root.hidden) void refreshRemoteConfig();
  };
  ownerDocument.defaultView?.addEventListener(
    AI_PROVIDER_CONFIG_CHANGE_EVENT,
    onAiProviderConfigChange,
  );

  const onLocaleChange = (event?: Event): void => {
    if (destroyed) return;
    const eventLocale = (event as CustomEvent<{ readonly locale?: unknown }> | undefined)?.detail
      ?.locale;
    locale = resolveMentorLocale(
      eventLocale ??
        localeHost.dataset.locale ??
        documentElement?.dataset.locale ??
        documentElement?.lang,
    );
    renderStaticLocale();
    render(currentHints);
  };
  localeHost.addEventListener("workbench-locale-change", onLocaleChange);
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  const localeObserver =
    MutationObserverConstructor === undefined || documentElement === undefined
      ? null
      : new MutationObserverConstructor(() => onLocaleChange());
  localeObserver?.observe(documentElement, {
    attributes: true,
    attributeFilter: ["data-locale", "lang"],
  });

  localTab.addEventListener("click", () => showView("local"));
  remoteTab.addEventListener("click", () => showView("remote"));
  remoteView.cancel.addEventListener("click", () => cancelRemote(() => copy().answerStopped));
  remoteView.clear.addEventListener("click", () => {
    clearConversation();
    setLocalizedText(remoteView.status, () => copy().conversationCleared);
    remoteView.status.dataset.state = "ready";
    remoteView.prompt.focus();
  });
  remoteView.contextMode.addEventListener("change", () => {
    remoteView.contextSummary.textContent =
      remoteView.contextMode.value === "full-source" ? copy().contextFull : copy().contextFunction;
  });

  const sendQuestion = (rawQuestion: string): void => {
    const remoteApi = options.remoteApi;
    if (
      remoteApi === undefined ||
      remoteConfig?.state !== "connected" ||
      remoteContext === null ||
      activeSessionId !== null ||
      startPending
    ) {
      return;
    }
    const prompt = rawQuestion.trim();
    if (prompt.length === 0) {
      setLocalizedText(remoteView.status, () => copy().emptyQuestion);
      remoteView.status.dataset.state = "error";
      return;
    }
    if (prompt.length > CHAT_QUESTION_MAX_LENGTH) {
      setLocalizedText(remoteView.status, () => copy().questionTooLong(CHAT_QUESTION_MAX_LENGTH));
      remoteView.status.dataset.state = "error";
      return;
    }
    const contextMode =
      remoteView.contextMode.value === "full-source" ? "full-source" : "current-function";
    const fingerprint = remoteContext.sourceFingerprint;
    const requestHistory = Object.freeze(chatHistory.slice(-AI_MENTOR_HISTORY_MAX_TURNS));
    appendChatMessage("user", prompt);
    activeQuestion = prompt;
    activeAssistantBody = appendChatMessage("assistant", copy().assistantWorking);
    setLocalizedText(activeAssistantBody, () => copy().assistantWorking);
    activeAssistantBody.dataset.state = "working";
    sourceChangeMarkerVisible = false;
    remoteView.prompt.value = "";
    setLocalizedText(remoteView.status, () => copy().answering);
    remoteView.status.dataset.state = "working";
    setRemoteBusy(true);
    const currentGeneration = requestGeneration + 1;
    requestGeneration = currentGeneration;
    startPending = true;
    void remoteApi
      .startAiMentor({
        sourceFingerprint: fingerprint,
        sourceRevision: remoteContext.sourceRevision,
        providerRevision: remoteConfig.revision,
        contextMode,
        locale,
        prompt,
        history: requestHistory,
        context: {
          currentFunction: remoteContext.currentFunction,
          diagnosticSummary: remoteContext.diagnosticSummary,
          controlFlowSummary: remoteContext.controlFlowSummary,
          runEvidence: remoteContext.runEvidence,
          ...(contextMode === "full-source" ? { fullSource: remoteContext.fullSource } : {}),
        },
      })
      .then((result) => {
        if (
          destroyed ||
          currentGeneration !== requestGeneration ||
          remoteContext?.sourceFingerprint !== fingerprint
        ) {
          if (result.status === "started") {
            void remoteApi.cancelAiMentor({ sessionId: result.sessionId });
          }
          return;
        }
        startPending = false;
        if (result.status === "failed") {
          setLocalizedText(remoteView.status, () =>
            locale === "en" && containsHan(result.error.message)
              ? copy().requestStartFailed
              : result.error.message,
          );
          remoteView.status.dataset.state = "error";
          if (activeAssistantBody !== null) {
            setLocalizedText(activeAssistantBody, () => copy().assistantNotSent);
            activeAssistantBody.dataset.state = "error";
          }
          activeQuestion = null;
          activeAssistantBody = null;
          remoteView.prompt.value = prompt;
          setRemoteBusy(false);
          remoteView.prompt.focus();
          return;
        }
        if (result.sourceFingerprint !== fingerprint) {
          void remoteApi.cancelAiMentor({ sessionId: result.sessionId });
          setLocalizedText(remoteView.status, () => copy().staleRequest);
          remoteView.status.dataset.state = "error";
          cancelRemote();
          return;
        }
        activeSessionId = result.sessionId;
        activeFingerprint = result.sourceFingerprint;
        nextSequence = 0;
        void pollRemote();
      })
      .catch(() => {
        if (!destroyed && currentGeneration === requestGeneration) {
          startPending = false;
          setLocalizedText(remoteView.status, () => copy().requestStartFailed);
          remoteView.status.dataset.state = "error";
          if (activeAssistantBody !== null) {
            setLocalizedText(activeAssistantBody, () => copy().assistantNotSent);
            activeAssistantBody.dataset.state = "error";
          }
          activeQuestion = null;
          activeAssistantBody = null;
          remoteView.prompt.value = prompt;
          setRemoteBusy(false);
          remoteView.prompt.focus();
        }
      });
  };

  remoteView.form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendQuestion(remoteView.prompt.value);
  });
  remoteView.prompt.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" || keyboardEvent.shiftKey || keyboardEvent.isComposing)
      return;
    keyboardEvent.preventDefault();
    sendQuestion(remoteView.prompt.value);
  });
  for (const [index, presetButton] of remoteView.presets.entries()) {
    presetButton.addEventListener("click", () => {
      const preset = copy().presets[index];
      if (preset !== undefined) sendQuestion(preset.prompt);
    });
  }

  renderStaticLocale();
  render(currentHints);
  if (defaultRemote) void refreshRemoteConfig();

  return Object.freeze({
    element: root,
    setHints(hints: readonly MentorHint[]): void {
      assertAlive(destroyed);
      if (!Array.isArray(hints)) throw new TypeError("mentor hints 必须是数组");
      currentHints = hints;
      localStatusIsEvidenceCount = true;
      localStatusMessage = null;
      render(currentHints);
    },
    setStatus(message: string, state: "ready" | "working" | "error" = "ready"): void {
      assertAlive(destroyed);
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new TypeError("mentor status 必须是非空文本");
      }
      root.dataset.state = state;
      localStatusIsEvidenceCount = false;
      localStatusMessage = message;
      status.textContent = localizeMentorStatus(message, locale);
    },
    setRemoteContext(context: MentorRemoteContext | null): void {
      assertAlive(destroyed);
      if (context === null) {
        cancelRemote(() => copy().sourceAnalyzing);
      } else {
        const workspaceChanged =
          chatWorkspaceId !== null && context.workspaceId !== chatWorkspaceId;
        const sourceChanged =
          !workspaceChanged &&
          chatSourceFingerprint !== null &&
          context.sourceFingerprint !== chatSourceFingerprint;
        if (workspaceChanged) {
          cancelRemote();
          clearConversation();
          remoteView.prompt.value = "";
        } else if (sourceChanged) {
          cancelRemote(() => copy().sourceUpdated);
          chatHistory = [];
          appendSourceMarker();
        }
        chatWorkspaceId = context.workspaceId;
        chatSourceFingerprint = context.sourceFingerprint;
      }
      remoteContext = context;
      setRemoteBusy(activeSessionId !== null || startPending);
      if (context === null) {
        remoteView.form.hidden = true;
        setLocalizedText(remoteView.status, () =>
          remoteReady() ? copy().connectedNeedsProject(remoteConfig!.model!) : copy().openProject,
        );
      } else if (remoteReady()) {
        remoteView.form.hidden = false;
        remoteView.missing.hidden = true;
        setLocalizedText(remoteView.status, () => copy().connected(remoteConfig!.model!));
      }
    },
    destroy(): void {
      if (destroyed) return;
      cancelRemote();
      destroyed = true;
      configGeneration += 1;
      ownerDocument.defaultView?.removeEventListener(
        AI_PROVIDER_CONFIG_CHANGE_EVENT,
        onAiProviderConfigChange,
      );
      if (typeof localeHost.removeEventListener === "function") {
        localeHost.removeEventListener("workbench-locale-change", onLocaleChange);
      }
      localeObserver?.disconnect();
      localizedText.clear();
      chatRoleLabels.splice(0, chatRoleLabels.length);
      host.replaceChildren();
    },
  });
}

function createRemoteView(ownerDocument: Document, onOpenAiSettings?: () => void) {
  const root = ownerDocument.createElement("section");
  root.className = "mentor-panel__view mentor-panel__remote";
  root.dataset.view = "remote";

  const status = ownerDocument.createElement("output");
  status.className = "mentor-panel__status";
  status.setAttribute("aria-live", "polite");

  const missing = ownerDocument.createElement("div");
  missing.className = "mentor-panel__empty mentor-panel__setup";
  const missingCopy = ownerDocument.createElement("p");
  missingCopy.textContent =
    "连接模型后，可基于 main / 首个可分析函数和运行证据询问算法含义、可疑逻辑与优化代价。";
  const openSettings = textButton(ownerDocument, "连接 AI 模型", "button");
  openSettings.hidden = onOpenAiSettings === undefined;
  openSettings.addEventListener("click", () => onOpenAiSettings?.());
  missing.append(missingCopy, openSettings);

  const form = ownerDocument.createElement("form");
  form.className = "mentor-panel__remote-form";
  form.hidden = true;
  const scope = ownerDocument.createElement("p");
  scope.className = "mentor-panel__scope";
  scope.textContent = "回答只作建议；对话仅保留在当前窗口，不写入项目或日志。";

  const presetSection = ownerDocument.createElement("details");
  presetSection.className = "mentor-panel__preset-section";
  presetSection.open = true;
  const presetHeading = ownerDocument.createElement("summary");
  presetHeading.className = "mentor-panel__preset-heading";
  presetHeading.textContent = "常用问题 · 点击即提问";
  const presetList = ownerDocument.createElement("div");
  presetList.className = "mentor-panel__presets";
  const presets = MENTOR_PRESET_QUESTIONS.map((preset) => {
    const button = textButton(ownerDocument, preset.label, "button");
    button.className += " mentor-panel__preset";
    button.title = preset.prompt;
    presetList.append(button);
    return button;
  });
  presetSection.append(presetHeading, presetList);

  const transcript = ownerDocument.createElement("div");
  transcript.className = "mentor-panel__transcript";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-live", "polite");
  const empty = ownerDocument.createElement("p");
  empty.className = "mentor-panel__chat-empty";
  empty.textContent = "选择一个常用问题，或直接输入。Enter 发送，Shift+Enter 换行。";
  transcript.append(empty);

  const composer = ownerDocument.createElement("label");
  composer.className = "mentor-panel__composer";
  const composerLabel = ownerDocument.createElement("span");
  composerLabel.textContent = "问当前算法";
  const prompt = ownerDocument.createElement("textarea");
  prompt.rows = 2;
  prompt.maxLength = CHAT_QUESTION_MAX_LENGTH;
  prompt.placeholder = "输入问题…";
  composer.append(composerLabel, prompt);

  const actions = ownerDocument.createElement("div");
  actions.className = "mentor-panel__remote-actions";
  const send = textButton(ownerDocument, "发送", "submit");
  const cancel = textButton(ownerDocument, "停止", "button");
  cancel.hidden = true;
  const clear = textButton(ownerDocument, "清空对话", "button");
  clear.className += " mentor-panel__clear";
  clear.hidden = true;
  actions.append(send, cancel, clear);

  const contextDetails = ownerDocument.createElement("details");
  contextDetails.className = "mentor-panel__context";
  const contextSummary = ownerDocument.createElement("summary");
  contextSummary.textContent = "发送范围 · 分析函数与证据";
  const contextLabel = ownerDocument.createElement("label");
  const contextLabelText = ownerDocument.createElement("span");
  contextLabelText.textContent = "附带内容 ";
  const contextMode = ownerDocument.createElement("select");
  const functionOption = ownerDocument.createElement("option");
  functionOption.value = "current-function";
  functionOption.textContent = "main / 首个可分析函数与证据";
  const fullSourceOption = ownerDocument.createElement("option");
  fullSourceOption.value = "full-source";
  fullSourceOption.textContent = "完整 main.c（显式发送）";
  contextMode.append(functionOption, fullSourceOption);
  contextLabel.append(contextLabelText, contextMode);
  const contextBoundary = ownerDocument.createElement("p");
  contextBoundary.textContent =
    "始终不发送文件路径、stdin 或 args。完整源码只有在这里明确选择后才会附带。";
  contextDetails.append(contextSummary, contextLabel, contextBoundary);

  form.append(scope, presetSection, transcript, composer, contextDetails, actions);
  root.append(status, missing, form);
  return {
    root,
    status,
    missing,
    missingCopy,
    openSettings,
    form,
    scope,
    transcript,
    empty,
    presetSection,
    presetHeading,
    presetList,
    presets: Object.freeze(presets),
    composerLabel,
    contextDetails,
    contextSummary,
    contextLabelText,
    contextMode,
    functionOption,
    fullSourceOption,
    contextBoundary,
    prompt,
    send,
    cancel,
    clear,
  } as const;
}

function mentorChatMessage(
  ownerDocument: Document,
  role: "user" | "assistant",
  text: string,
  copy: MentorCopy,
): { readonly item: HTMLElement; readonly label: HTMLElement; readonly body: HTMLElement } {
  const item = ownerDocument.createElement("article");
  item.className = `mentor-panel__message mentor-panel__message--${role}`;
  const label = ownerDocument.createElement("span");
  label.className = "mentor-panel__message-role";
  label.textContent = role === "user" ? copy.userRole : "AI";
  const body = ownerDocument.createElement("p");
  body.className = "mentor-panel__message-body";
  body.textContent = text;
  item.append(label, body);
  return Object.freeze({ item, label, body });
}

function boundedHistoryText(value: string, suffix: string): string {
  if (value.length <= AI_MENTOR_TURN_MAX_LENGTH) return value;
  return `${value.slice(0, AI_MENTOR_TURN_MAX_LENGTH - suffix.length)}${suffix}`;
}

function tabButton(ownerDocument: Document, label: string, selected: boolean): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = "mentor-panel__tab";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(selected));
  button.textContent = label;
  return button;
}

function textButton(
  ownerDocument: Document,
  label: string,
  type: "button" | "submit",
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = type;
  button.className = "mentor-panel__text-button";
  button.textContent = label;
  return button;
}

function renderHint(
  ownerDocument: Document,
  hint: MentorHint,
  options: MentorPanelOptions,
  copy: MentorCopy,
  locale: MentorLocale,
): HTMLElement {
  const presentation = mentorHintPresentation(hint, locale);
  const item = ownerDocument.createElement("article");
  item.className = "mentor-hint";
  item.dataset.hintId = hint.id;
  item.dataset.confidence = hint.confidence;
  item.dataset.level = hint.level;
  item.setAttribute("role", "listitem");
  const action = ownerDocument.createElement("button");
  action.className = "mentor-hint__action";
  action.type = "button";
  action.disabled = hint.target === null;
  action.setAttribute(
    "aria-label",
    `${presentation.title}, ${hint.target === null ? copy.noSourceLocation : copy.locateSource}`,
  );
  const title = ownerDocument.createElement("strong");
  title.className = "mentor-hint__title";
  title.textContent = presentation.title;
  const meta = span(
    ownerDocument,
    "mentor-hint__meta",
    `${copy.confidence[hint.confidence]} · ${copy.level[hint.level]}`,
  );
  const summary = ownerDocument.createElement("span");
  summary.className = "mentor-hint__summary";
  summary.textContent = presentation.summary;
  const next = span(ownerDocument, "mentor-hint__next", `${copy.nextStep}${presentation.nextStep}`);
  const evidenceLabels = [...new Set(presentation.evidenceLabels)].join(" / ");
  const evidence = span(
    ownerDocument,
    "mentor-hint__evidence",
    copy.evidenceSummary(hint.evidence.length, evidenceLabels),
  );
  action.append(title, meta, summary, next, evidence);
  const target = hint.target;
  if (target !== null) action.addEventListener("click", () => options.onLocate?.(target, hint));
  item.append(action);
  return item;
}

export interface MentorHintPresentation {
  readonly title: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly evidenceLabels: readonly string[];
}

/** Local hints are provider-owned UI, not user text. Unknown localized providers fail closed. */
export function mentorHintPresentation(
  hint: MentorHint,
  locale: MentorLocale,
): MentorHintPresentation {
  if (locale !== "en" || !hintContainsHan(hint)) {
    return Object.freeze({
      title: hint.title,
      summary: hint.summary,
      nextStep: hint.nextStep,
      evidenceLabels: Object.freeze(hint.evidence.map((entry) => entry.label)),
    });
  }
  const finding = ENGLISH_FINDING_HINTS[hint.title];
  const wording =
    finding ??
    (hint.id.startsWith("mentor.loop.nested.")
      ? ENGLISH_SPECIAL_HINTS.nested
      : hint.id.startsWith("mentor.path.")
        ? ENGLISH_SPECIAL_HINTS.path
        : hint.id.startsWith("mentor.history.median.")
          ? ENGLISH_SPECIAL_HINTS.median
          : hint.id.startsWith("mentor.history.growth.")
            ? ENGLISH_SPECIAL_HINTS.growth
            : ENGLISH_SPECIAL_HINTS.unknown);
  return Object.freeze({
    ...wording,
    evidenceLabels: Object.freeze(
      hint.evidence.map((entry) => ENGLISH_EVIDENCE_LABELS[entry.kind]),
    ),
  });
}

const ENGLISH_FINDING_HINTS: Readonly<
  Record<string, Omit<MentorHintPresentation, "evidenceLabels">>
> = Object.freeze({
  发现不可达路径: Object.freeze({
    title: "Unreachable path detected",
    summary: "The CFG has no path from the function entry to this node.",
    nextStep: "Inspect earlier returns, breaks, and unconditional transfers.",
  }),
  读取前缺少可靠初始化: Object.freeze({
    title: "Read may occur before initialization",
    summary: "Reaching-definition evidence does not prove a write on every reachable path.",
    nextStep: "Check each incoming branch and initialize the value on every required path.",
  }),
  固定下标越过数组范围: Object.freeze({
    title: "Constant index is outside the array bounds",
    summary: "The literal index is inconsistent with the known fixed array length.",
    nextStep: "Check the valid range 0 through length - 1 and correct the index or size.",
  }),
  循环边界可能多走一步: Object.freeze({
    title: "Loop boundary may run one step too far",
    summary: "The loop condition may reach the fixed array length itself.",
    nextStep: "Compare < with <= and run minimum-size and full-size cases.",
  }),
  所有正常出口仍持有分配: Object.freeze({
    title: "Allocation remains owned at every normal exit",
    summary: "The modeled normal exits still retain an allocated object.",
    nextStep:
      "Check ownership at each normal exit and free only where this function still owns it.",
  }),
  部分正常出口可能保留分配: Object.freeze({
    title: "Some normal exits may retain an allocation",
    summary: "Only part of the modeled control-flow paths release the allocation.",
    nextStep: "Compare the leaking and released branches before choosing a cleanup point.",
  }),
  同一所有权可能重复释放: Object.freeze({
    title: "The same ownership may be freed twice",
    summary: "The object is already definitely freed before this release.",
    nextStep: "Trace the allocation and both releases, then keep one release responsibility.",
  }),
  部分路径可能重复释放: Object.freeze({
    title: "Some paths may free the same object twice",
    summary: "The object may already be freed before this release.",
    nextStep: "Compare release behavior before the control-flow merge.",
  }),
  释放后仍被解引用: Object.freeze({
    title: "Object is dereferenced after being freed",
    summary: "The object is definitely freed before this dereference.",
    nextStep: "Move the use before the release or redesign ownership.",
  }),
  部分路径可能释放后使用: Object.freeze({
    title: "Some paths may use an object after free",
    summary: "The object may be freed before this dereference.",
    nextStep: "Compare incoming paths and find where release and later use diverge.",
  }),
  分配大小使用了指针宽度: Object.freeze({
    title: "Allocation size uses the pointer width",
    summary: "The allocation uses sizeof(pointer) instead of the pointed-to object.",
    nextStep: "Bind sizeof to the dereferenced target type and verify the element count.",
  }),
  分配结果未证明非空: Object.freeze({
    title: "Allocation result is not proven non-null",
    summary: "No reliable non-null guard is established before dereference.",
    nextStep: "Handle allocation failure before the first dereference.",
  }),
  运行时下标需要边界证据: Object.freeze({
    title: "Runtime index needs bounds evidence",
    summary: "Current static facts cannot prove that the runtime index is safe.",
    nextStep: "Validate 0 <= index and index < length before access, then add boundary cases.",
  }),
  循环条件没有约束实际下标: Object.freeze({
    title: "Loop condition does not constrain the accessed index",
    summary: "The array index differs from the variable constrained by the loop condition.",
    nextStep: "Constrain the actual index or add a separate bounds check before access.",
  }),
});

const ENGLISH_SPECIAL_HINTS = Object.freeze({
  nested: Object.freeze({
    title: "Measure the nested loop separately",
    summary:
      "This loop is nested inside another analyzable loop; structure alone does not prove complexity or inefficiency.",
    nextStep: "Record operation counts for at least three input sizes before judging growth.",
  }),
  path: Object.freeze({
    title: "The real path visits this node repeatedly",
    summary:
      "The current real execution visits this node more than once; this only describes the current input.",
    nextStep: "Repeat with smaller and larger inputs from the same scenario before optimizing.",
  }),
  median: Object.freeze({
    title: "Median of comparable runs",
    summary:
      "Comparable real runs are available for the same source, scenario, toolchain, size, and case.",
    nextStep: "Compare time, memory, and operation count separately.",
  }),
  growth: Object.freeze({
    title: "Operation-count growth evidence",
    summary: "Multiple input sizes provide empirical operation-count growth evidence.",
    nextStep:
      "Verify the inputs represent the target problem; empirical slope is not a Big-O proof.",
  }),
  unknown: Object.freeze({
    title: "Local evidence suggestion",
    summary: "This provider returned a suggestion without reviewed English wording.",
    nextStep: "Inspect the linked source location and evidence before changing the code.",
  }),
});

const ENGLISH_EVIDENCE_LABELS = Object.freeze({
  "analysis-finding": "Static analysis evidence",
  "loop-structure": "Loop structure evidence",
  "real-path": "Real execution path",
  "run-history": "Comparable run history",
} satisfies Readonly<Record<MentorHint["evidence"][number]["kind"], string>>);

function hintContainsHan(hint: MentorHint): boolean {
  return [
    hint.title,
    hint.summary,
    hint.nextStep,
    ...hint.evidence.map((entry) => entry.label),
  ].some(containsHan);
}

function localizeMentorStatus(message: string, locale: MentorLocale): string {
  if (locale !== "en" || !containsHan(message)) return message;
  if (message === "等待当前源码的静态分析证据") {
    return "Waiting for static analysis evidence from the current source";
  }
  if (message.includes("源码指纹不一致")) {
    return "Static analysis does not match the current source; suggestions are hidden.";
  }
  if (message.includes("本地证据不足")) {
    return "Local evidence is insufficient or invalid; no suggestion was generated.";
  }
  return "Local evidence status is unavailable in this language.";
}

function containsHan(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function span(
  document: Document,
  className: string,
  text: string,
  tag: "span" | "strong" = "span",
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function resolveMentorLocale(value: unknown): MentorLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function assertAlive(destroyed: boolean): void {
  if (destroyed) throw new Error("MentorPanel 已销毁");
}
