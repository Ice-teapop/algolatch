import type { MentorHintTarget } from "../mentor/index.js";
import type { PanelApi } from "../shared/api.js";
import type { AiProviderPublicConfig } from "../shared/ai-provider.js";
import type { MentorRemoteContext } from "./mentor-panel.js";
import { AI_PROVIDER_CONFIG_CHANGE_EVENT } from "./ai-provider-events.js";
import type { InterfaceLocale } from "./interface-preferences.js";

export type AnalysisMetric = "duration" | "operations";
export type AnalysisEvidenceState = "passed" | "failed" | "pending";

export interface AnalysisTrendPoint {
  readonly inputSize: number;
  readonly sampleCount: number;
  readonly medianDurationMs: number | null;
  readonly minDurationMs: number | null;
  readonly maxDurationMs: number | null;
  readonly medianOperationCount: number | null;
  readonly minOperationCount: number | null;
  readonly maxOperationCount: number | null;
  readonly medianPeakRssBytes: number | null;
  readonly referenceOperationCount: number | null;
}

export interface AnalysisEvidenceCriterion {
  readonly id: string;
  readonly label: string;
  readonly state: AnalysisEvidenceState;
  readonly detail: string;
}

export interface AnalysisHotspot {
  readonly nodeId: string;
  readonly label: string;
  readonly count: number;
  readonly share: number;
  readonly target: MentorHintTarget;
}

export interface AnalysisDashboardState {
  readonly sourceFingerprint: string | null;
  readonly statusMessage: string;
  readonly scenarioLabel: string;
  readonly referenceLabel: string | null;
  readonly trendEvidence: string;
  readonly trendPoints: readonly AnalysisTrendPoint[];
  readonly criteria: readonly AnalysisEvidenceCriterion[];
  readonly branchCovered: number;
  readonly branchTotal: number;
  readonly hotspots: readonly AnalysisHotspot[];
}

type AnalysisRemoteApi = Pick<
  PanelApi,
  "getAiProviderConfig" | "startAiMentor" | "readAiMentor" | "cancelAiMentor"
>;

export interface AnalysisDashboardOptions {
  readonly remoteApi?: AnalysisRemoteApi | undefined;
  readonly onLocate?: ((target: MentorHintTarget) => void) | undefined;
  readonly onOpenAiSettings?: (() => void) | undefined;
}

export interface AnalysisDashboard {
  readonly element: HTMLElement;
  setState(state: AnalysisDashboardState): void;
  setRemoteContext(context: MentorRemoteContext | null): void;
  destroy(): void;
}

interface AiAssessment {
  readonly status: "complete" | "partial" | "not-ready";
  readonly confidence: "low" | "medium" | "high";
  readonly observation: string;
  readonly evidence: readonly string[];
  readonly gaps: readonly string[];
  readonly nextExperiment: string;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 760;
const CHART_HEIGHT = 286;
const CHART_MARGIN = Object.freeze({ top: 20, right: 22, bottom: 42, left: 62 });
const AI_POLL_INTERVAL_MS = 180;

interface AnalysisUiCopy {
  readonly summary: Readonly<Record<"completion" | "sizes" | "coverage" | "reference", string>>;
  readonly sections: Readonly<
    Record<"trend" | "completion" | "path" | "memory" | "ai", readonly [string, string]>
  >;
  readonly duration: string;
  readonly operations: string;
  readonly chartAria: string;
  readonly coverageAria: string;
  readonly memoryAria: string;
  readonly aiPurpose: string;
  readonly needsAttention: (count: number) => string;
  readonly insufficientData: string;
  readonly groupCount: (count: number) => string;
  readonly noStructuredBranches: string;
  readonly unconfirmed: string;
  readonly durationEmpty: string;
  readonly operationsEmpty: string;
  readonly operationCaveat: string;
  readonly durationCaveat: string;
  readonly pointTitle: (inputSize: number, metric: string, sampleCount: number) => string;
  readonly criterionPassed: string;
  readonly criterionFailed: string;
  readonly criterionPending: string;
  readonly coverageNone: string;
  readonly coverageValue: (covered: number, total: number) => string;
  readonly hotspotEmpty: string;
  readonly hotspotValue: (count: number, share: number) => string;
  readonly memoryEmpty: string;
  readonly xAxis: string;
  readonly aiActions: Readonly<
    Record<"reviewing" | "unavailable" | "loading" | "retry" | "connect" | "review", string>
  >;
  readonly aiStatus: Readonly<{
    unavailable: string;
    loading: string;
    loadFailed: string;
    setup: string;
    connectedWaiting: (model: string) => string;
    connectedReady: (model: string) => string;
    stale: string;
    cancelled: string;
    invalid: string;
    assessment: (status: string, confidence: string) => string;
    readFailed: string;
    needsEvidence: string;
    confirming: string;
    reviewing: string;
    startFailed: string;
    sourceChanged: string;
  }>;
  readonly confidence: Readonly<Record<AiAssessment["confidence"], string>>;
  readonly assessmentStatus: Readonly<Record<AiAssessment["status"], string>>;
  readonly assessmentLabels: readonly (readonly [
    string,
    keyof Omit<AiAssessment, "status" | "confidence">,
  ])[];
  readonly assessmentUncertaintyLabel: string;
  readonly noExtraEvidence: string;
  readonly noExtraGaps: string;
  readonly uncertainty: (confidence: string) => string;
  readonly heading: string;
  readonly initialStatus: string;
  readonly initialScenario: string;
  readonly initialTrend: string;
}

const ANALYSIS_COPY: Readonly<Record<InterfaceLocale, AnalysisUiCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    summary: Object.freeze({
      completion: "确定性证据",
      sizes: "输入规模",
      coverage: "分支覆盖",
      reference: "参考增长",
    }),
    sections: Object.freeze({
      trend: Object.freeze(["性能增长", "输入规模 n → 中位实测值"] as const),
      completion: Object.freeze(["问题完成度", "确定性结果与 AI 建议分开"] as const),
      path: Object.freeze(["路径与热点", "真实 Trace 证据"] as const),
      memory: Object.freeze(["内存趋势", "峰值 RSS，不等同于堆内存"] as const),
      ai: Object.freeze(["AI 复核（可选）", "用户触发 · 只读建议"] as const),
    }),
    duration: "耗时",
    operations: "操作次数",
    chartAria: "输入规模与运行指标趋势",
    coverageAria: "真实分支覆盖",
    memoryAria: "各输入规模的峰值内存趋势",
    aiPurpose:
      "结合 main / 首个可分析函数、诊断、分支覆盖和运行数据，查找可能的语义缺口、边界遗漏与下一步实验；不判定数学正确性。",
    needsAttention: (count: number) => ` · ${String(count)} 待处理`,
    insufficientData: "数据不足",
    groupCount: (count: number) => `${String(count)} 组`,
    noStructuredBranches: "无结构分支",
    unconfirmed: "未确认",
    durationEmpty: "至少运行一个带输入规模的真实案例后显示耗时趋势。",
    operationsEmpty: "至少运行三个输入规模的 Benchmark 后判断操作增长。",
    operationCaveat: " 实测拟合不等于 Big-O 证明。",
    durationCaveat: " 墙钟耗时会受到系统负载影响。",
    pointTitle: (inputSize: number, metric: string, sampleCount: number) =>
      `n=${String(inputSize)} · 中位数 ${metric} · ${String(sampleCount)} 个样本`,
    criterionPassed: "通过",
    criterionFailed: "处理",
    criterionPending: "待证",
    coverageNone: "分析函数没有结构分支",
    coverageValue: (covered: number, total: number) =>
      `真实经过 ${String(covered)} / ${String(total)} 条分支出口`,
    hotspotEmpty: "完成一次真实 Trace 后显示热点节点。",
    hotspotValue: (count: number, share: number) => `${String(count)} 次 · ${share.toFixed(1)}%`,
    memoryEmpty: "尚未取得跨规模 RSS 样本。",
    xAxis: "输入规模 n",
    aiActions: Object.freeze({
      reviewing: "正在复核",
      unavailable: "远程 AI 不可用",
      loading: "读取 AI 连接状态",
      retry: "重试连接状态",
      connect: "连接 AI 助手",
      review: "复核当前证据",
    }),
    aiStatus: Object.freeze({
      unavailable: "当前构建未提供远程 AI；本地确定性分析仍可使用。",
      loading: "正在读取 AI 连接状态…",
      loadFailed: "无法读取 AI 连接状态。",
      setup: "连接模型后可进行可选的证据复核；本地确定性分析不受影响。",
      connectedWaiting: (model: string) =>
        `${model} · 已连接；打开包含可分析函数的 C 项目后可复核。`,
      connectedReady: (model: string) =>
        `${model} · 已连接；将复核 main / 首个可分析函数、诊断、分支覆盖和运行证据。`,
      stale: "源码已变化，旧 AI 评估已丢弃。",
      cancelled: "AI 评估已取消。",
      invalid: "AI 返回格式无效，已拒绝作为完成度证据。",
      assessment: (status: string, confidence: string) =>
        `AI 语义状态：${status} · ${confidence}置信度`,
      readFailed: "无法读取 AI 评估。",
      needsEvidence: "需要 main / 首个可分析函数和运行证据后才能请求 AI 复核。",
      confirming: "正在确认 AI 连接…",
      reviewing: "AI 正在复核运行证据；不会修改源码。",
      startFailed: "无法启动 AI 评估。",
      sourceChanged: "源码已变化；等待新的 AI 复核。",
    }),
    confidence: Object.freeze({ low: "低", medium: "中", high: "高" }),
    assessmentStatus: Object.freeze({
      complete: "语义上基本完整",
      partial: "仍有语义缺口",
      "not-ready": "证据不足",
    }),
    assessmentLabels: Object.freeze([
      Object.freeze(["观察", "observation"] as const),
      Object.freeze(["数据证据", "evidence"] as const),
      Object.freeze(["缺口", "gaps"] as const),
      Object.freeze(["下一步实验", "nextExperiment"] as const),
    ]),
    assessmentUncertaintyLabel: "不确定性",
    noExtraEvidence: "AI 未指出额外证据",
    noExtraGaps: "AI 未指出额外缺口",
    uncertainty: (confidence: string) => `${confidence}置信度；AI 结论不覆盖确定性测试`,
    initialStatus: "打开项目并运行案例后生成分析。",
    initialScenario: "尚未选择情景",
    initialTrend: "没有跨规模运行证据。",
    heading: "分析",
  }),
  en: Object.freeze({
    summary: Object.freeze({
      completion: "Deterministic evidence",
      sizes: "Input sizes",
      coverage: "Branch coverage",
      reference: "Reference growth",
    }),
    sections: Object.freeze({
      trend: Object.freeze(["Performance growth", "Input size n → measured median"] as const),
      completion: Object.freeze([
        "Problem completion",
        "Deterministic results and AI advice stay separate",
      ] as const),
      path: Object.freeze(["Paths and hotspots", "Real Trace evidence"] as const),
      memory: Object.freeze(["Memory trend", "Peak RSS, not heap usage"] as const),
      ai: Object.freeze(["AI review (optional)", "User initiated · read-only advice"] as const),
    }),
    duration: "Duration",
    operations: "Operations",
    chartAria: "Trend of input size and runtime metrics",
    coverageAria: "Real branch coverage",
    memoryAria: "Peak memory trend by input size",
    aiPurpose:
      "Uses main or the first analyzable function, diagnostics, branch coverage and run data to find semantic gaps, missed edge cases and the next experiment; it does not prove mathematical correctness.",
    needsAttention: (count: number) => ` · ${String(count)} need attention`,
    insufficientData: "Insufficient data",
    groupCount: (count: number) => `${String(count)} groups`,
    noStructuredBranches: "No structured branches",
    unconfirmed: "Unconfirmed",
    durationEmpty: "Run at least one real scenario with an input size to show duration growth.",
    operationsEmpty: "Benchmark at least three input sizes to assess operation growth.",
    operationCaveat: " An empirical fit is not a Big-O proof.",
    durationCaveat: " Wall-clock time is affected by system load.",
    pointTitle: (inputSize: number, metric: string, sampleCount: number) =>
      `n=${String(inputSize)} · median ${metric} · ${String(sampleCount)} samples`,
    criterionPassed: "Passed",
    criterionFailed: "Action needed",
    criterionPending: "Pending",
    coverageNone: "The analyzed function has no structured branches",
    coverageValue: (covered: number, total: number) =>
      `Actually traversed ${String(covered)} / ${String(total)} branch exits`,
    hotspotEmpty: "Run a real Trace to show hotspot nodes.",
    hotspotValue: (count: number, share: number) =>
      `${String(count)} visits · ${share.toFixed(1)}%`,
    memoryEmpty: "No cross-size RSS samples yet.",
    xAxis: "Input size n",
    aiActions: Object.freeze({
      reviewing: "Reviewing",
      unavailable: "Remote AI unavailable",
      loading: "Check AI connection",
      retry: "Retry connection check",
      connect: "Connect AI assistant",
      review: "Review current evidence",
    }),
    aiStatus: Object.freeze({
      unavailable:
        "Remote AI is not available in this build; deterministic local analysis still works.",
      loading: "Checking the AI connection…",
      loadFailed: "Could not read the AI connection state.",
      setup:
        "Connect a model for optional evidence review; deterministic local analysis is unaffected.",
      connectedWaiting: (model: string) =>
        `${model} · connected; open a C project with an analyzable function to review it.`,
      connectedReady: (model: string) =>
        `${model} · connected; review will use main or the first analyzable function, diagnostics, branch coverage and run evidence.`,
      stale: "The source changed, so the previous AI assessment was discarded.",
      cancelled: "AI assessment cancelled.",
      invalid: "The AI response format was invalid and was rejected as completion evidence.",
      assessment: (status: string, confidence: string) =>
        `AI semantic status: ${status} · ${confidence} confidence`,
      readFailed: "Could not read the AI assessment.",
      needsEvidence:
        "An analyzable function and run evidence are required before requesting AI review.",
      confirming: "Confirming the AI connection…",
      reviewing: "AI is reviewing the run evidence and will not modify source code.",
      startFailed: "Could not start the AI assessment.",
      sourceChanged: "The source changed; waiting for a new AI review.",
    }),
    confidence: Object.freeze({ low: "low", medium: "medium", high: "high" }),
    assessmentStatus: Object.freeze({
      complete: "semantically complete",
      partial: "semantic gaps remain",
      "not-ready": "insufficient evidence",
    }),
    assessmentLabels: Object.freeze([
      Object.freeze(["Observation", "observation"] as const),
      Object.freeze(["Data evidence", "evidence"] as const),
      Object.freeze(["Gaps", "gaps"] as const),
      Object.freeze(["Next experiment", "nextExperiment"] as const),
    ]),
    assessmentUncertaintyLabel: "Uncertainty",
    noExtraEvidence: "AI identified no additional evidence",
    noExtraGaps: "AI identified no additional gaps",
    uncertainty: (confidence: string) =>
      `${confidence} confidence; AI conclusions do not override deterministic tests`,
    initialStatus: "Open a project and run a scenario to generate analysis.",
    initialScenario: "No scenario selected",
    initialTrend: "No cross-size run evidence.",
    heading: "Analysis",
  }),
});

const ANALYSIS_CRITERION_ENGLISH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  analysis: "Structural analysis",
  "compile-run": "Compile and run",
  "expected-output": "Scenario output",
  "boundary-cases": "Input sizes and boundary cases",
  branches: "Reachable branches",
  diagnostics: "Blocking diagnostics",
  growth: "Complexity growth evidence",
});

const ANALYSIS_SCENARIO_ENGLISH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  整数排序: "Integer sorting",
  线性搜索: "Linear search",
  递归阶乘: "Recursive factorial",
  链表逆序遍历: "Reverse linked-list traversal",
  二叉树中序遍历: "Binary-tree inorder traversal",
  "链式图 BFS": "Chain-graph BFS",
  "动态规划 Fibonacci": "Dynamic-programming Fibonacci",
  扫描求最大值: "Scan for maximum",
  扫描求最小值: "Scan for minimum",
  手动运行: "Manual run",
  尚未选择情景: "No scenario selected",
});

export function localizeAnalysisDashboardState(
  state: AnalysisDashboardState,
  locale: InterfaceLocale,
): AnalysisDashboardState {
  if (locale === "zh-CN") return freezeState(state);
  const trendPointCount = state.trendPoints.length;
  return freezeState({
    ...state,
    statusMessage: localizeAnalysisStatusMessage(state.statusMessage),
    scenarioLabel:
      ANALYSIS_SCENARIO_ENGLISH_LABELS[state.scenarioLabel] ??
      safeEnglishFallback(state.scenarioLabel, "Custom scenario"),
    referenceLabel: localizeAnalysisReferenceLabel(state.referenceLabel),
    trendEvidence:
      trendPointCount === 0
        ? "No comparable real runs across input sizes are available for the current source."
        : `${String(trendPointCount)} input-size groups come from comparable real runs. This empirical growth evidence is not a Big-O proof.`,
    criteria: Object.freeze(
      state.criteria.map((criterion) =>
        Object.freeze({
          ...criterion,
          label:
            ANALYSIS_CRITERION_ENGLISH_LABELS[criterion.id] ??
            safeEnglishFallback(criterion.label, "Evidence criterion"),
          detail: localizeAnalysisCriterionDetail(criterion, state),
        }),
      ),
    ),
  });
}

export function localizedSafeErrorMessage(
  message: string,
  locale: InterfaceLocale,
  fallback: string,
): string {
  if (locale === "zh-CN" || !containsHan(message)) return message || fallback;
  return fallback;
}

export function localizeAnalysisStatusMessage(message: string): string {
  const exact: Readonly<Record<string, string>> = Object.freeze({
    "尚未关联项目，真实运行不会写入 sidecar。":
      "No project is linked, so real runs will not be written to the sidecar.",
    "正在解除项目关联…": "Unlinking the project…",
    "正在载入运行历史…": "Loading run history…",
    "运行历史 sidecar 无效，已仅重置历史视图；main.c 未改动。":
      "The run-history sidecar was invalid. Only the history view was reset; main.c was not changed.",
    "运行证据的源码指纹不一致；已拒绝写入历史。":
      "The run evidence used a different source fingerprint and was not added to history.",
    "编译未通过；已显示编译证据，但未写入可比较性能历史。":
      "Compilation failed. Compile evidence is shown, but no comparable performance entry was saved.",
    "编译已完成，但运行器未返回结果；未写入性能历史。":
      "Compilation completed, but the runner returned no result. Performance history was not updated.",
    "教学模拟错误地通过了真实历史门禁；已拒绝继续。":
      "A teaching simulation crossed the real-history gate and was rejected.",
    "教学模拟结果仅用于回放；未写入真实性能历史。":
      "Teaching simulation results are for replay only and were not written to real performance history.",
    "真实运行已记录在当前会话；未关联项目，因此尚未持久化。":
      "The real run was recorded for this session but was not persisted because no project is linked.",
    "真实运行已记录；性能比较严格限定为同源码、同情景、同工具链。":
      "The real run was recorded. Comparisons are restricted to the same source, scenario, and toolchain.",
    "真实运行失败已留档用于诊断，但不会进入成功性能中位数。":
      "The failed real run was retained for diagnostics but excluded from successful performance medians.",
  });
  const direct = exact[message];
  if (direct !== undefined) return direct;
  const loaded = /^已载入\s+(\d+)\s+条真实运行记录/u.exec(message);
  if (loaded !== null) {
    const stale = message.includes("旧源码记录")
      ? " Older-source entries remain isolated by source fingerprint."
      : "";
    return `Loaded ${loaded[1]} real run records.${stale}`;
  }
  if (/^(?:无法载入运行历史|运行历史保存失败)[:：]/u.test(message)) {
    return "Could not access run history. Existing source code was not changed.";
  }
  if (/^(?:运行证据无效|教学模拟证据无效)/u.test(message)) {
    return "The run evidence was invalid and was not added to history.";
  }
  return safeEnglishFallback(message, "Runtime evidence was updated.");
}

function localizeAnalysisReferenceLabel(label: string | null): string | null {
  if (label === null) return null;
  const normalized = label
    .replace(/（线性扫描）/gu, " (linear scan)")
    .replace(/参考工作量/gu, "reference work")
    .replace(/已有 3\+ 规模证据/gu, "3+ input sizes available")
    .replace(/数据不足/gu, "insufficient data")
    .replace(/参考未确认/gu, "reference unconfirmed");
  return safeEnglishFallback(normalized, "Reference available");
}

function localizeAnalysisCriterionDetail(
  criterion: AnalysisEvidenceCriterion,
  dashboard: AnalysisDashboardState,
): string {
  const numbers = criterion.detail.match(/\d+/gu)?.map(Number) ?? [];
  if (criterion.id === "analysis") {
    if (criterion.state === "passed") {
      const count = numbers[0] ?? 1;
      return `${String(count)} function${count === 1 ? " has" : "s have"} a complete CFG`;
    }
    return criterion.detail.includes("partial")
      ? "A partial CFG remains locked against unsafe rewiring"
      : "Waiting for analysis of the current source";
  }
  if (criterion.id === "compile-run") {
    if (criterion.state === "passed") return "The process completed normally";
    if (criterion.detail.includes("编译")) return "Compilation did not pass";
    if (criterion.state === "failed") return "The run did not complete normally";
    return "No run has been recorded for the current source";
  }
  if (criterion.id === "expected-output") {
    if (criterion.state === "passed") {
      return "Scenario output was checked byte for byte before history was updated";
    }
    return criterion.detail.includes("手动")
      ? "A manual run has no bound expected output"
      : "Waiting for a real scenario run";
  }
  if (criterion.id === "boundary-cases") {
    const count = numbers[0] ?? dashboard.trendPoints.length;
    return count === 0
      ? "Waiting for Benchmark evidence"
      : `${String(count)} input sizes available; at least 3 sizes with 3 runs each are required`;
  }
  if (criterion.id === "branches") {
    return dashboard.branchTotal === 0
      ? "The current CFG has no structured branches"
      : `Real coverage includes ${String(dashboard.branchCovered)} / ${String(dashboard.branchTotal)} branch exits`;
  }
  if (criterion.id === "diagnostics") {
    const count = numbers[0] ?? 0;
    if (criterion.state === "passed") return "No certain findings remain";
    if (criterion.state === "failed") return `${String(count)} certain findings need attention`;
    return "Waiting for static diagnostics";
  }
  if (criterion.id === "growth") {
    return dashboard.trendPoints.length === 0
      ? "Waiting for operation counts across input sizes"
      : `${String(dashboard.trendPoints.length)} input-size groups provide empirical operation-growth evidence`;
  }
  return safeEnglishFallback(criterion.detail, "Evidence is waiting for verification");
}

function safeEnglishFallback(value: string, fallback: string): string {
  return containsHan(value) ? fallback : value;
}

function containsHan(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

interface AnalysisChartGuideCopy {
  readonly summary: string;
  readonly items: readonly (readonly [string, string])[];
}

const ANALYSIS_CHART_GUIDE_COPY: Readonly<Record<InterfaceLocale, AnalysisChartGuideCopy>> =
  Object.freeze({
    "zh-CN": Object.freeze({
      summary: "怎么看",
      items: Object.freeze([
        Object.freeze(["横轴", "输入规模 n；比较规模时必须保持源码、情景和工具链一致。"] as const),
        Object.freeze(["圆点", "同一规模多次真实运行的中位数。"] as const),
        Object.freeze(["竖线", "该组样本的最小值—最大值范围；越长表示波动越大。"] as const),
        Object.freeze(["实线", "连接各输入规模的实测中位数。"] as const),
        Object.freeze(["虚线", "操作次数视图中的归一化参考增长，不是性能目标。"] as const),
        Object.freeze([
          "证据边界",
          "有限规模的实测只能支持增长解释；Big-O 仍需分析代码结构。",
        ] as const),
      ]),
    }),
    en: Object.freeze({
      summary: "How to read",
      items: Object.freeze([
        Object.freeze([
          "Horizontal",
          "Input size n; source, scenario, and toolchain must stay comparable.",
        ] as const),
        Object.freeze(["Point", "Median of repeated real runs at the same size."] as const),
        Object.freeze([
          "Vertical range",
          "Minimum-to-maximum sample range; a longer range means more variation.",
        ] as const),
        Object.freeze(["Solid line", "Connects measured medians across input sizes."] as const),
        Object.freeze([
          "Dashed line",
          "Normalized reference growth in Operations view, not a performance target.",
        ] as const),
        Object.freeze([
          "Evidence limit",
          "Finite measurements support a growth model; Big-O still requires code analysis.",
        ] as const),
      ]),
    }),
  });

export function createAnalysisDashboard(
  host: HTMLElement,
  options: AnalysisDashboardOptions = {},
): AnalysisDashboard {
  const document = host.ownerDocument;
  const documentElement = document.documentElement as HTMLElement | undefined;
  const localeHost =
    typeof host.closest === "function"
      ? (host.closest<HTMLElement>("[data-locale]") ?? documentElement ?? host)
      : (documentElement ?? host);
  let locale = resolveAnalysisLocale(localeHost.dataset.locale ?? documentElement?.lang);
  let copy = ANALYSIS_COPY[locale];
  const root = document.createElement("section");
  root.className = "analysis-dashboard";
  root.dataset.locale = locale;

  const heading = document.createElement("h1");
  heading.className = "analysis-dashboard__heading";
  heading.textContent = copy.heading;

  const summary = document.createElement("dl");
  summary.className = "analysis-dashboard__summary";
  const summaryFields = new Map<string, HTMLElement>();
  const summaryTerms = new Map<string, HTMLElement>();
  for (const id of ["completion", "sizes", "coverage", "reference"] as const) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    value.dataset.analysisSummary = id;
    row.append(term, value);
    summary.append(row);
    summaryFields.set(id, value);
    summaryTerms.set(id, term);
  }

  const main = document.createElement("div");
  main.className = "analysis-dashboard__main";
  const trendSection = analysisSection(document);
  trendSection.root.classList.add("analysis-dashboard__trend");
  trendSection.root.tabIndex = -1;
  const metricTabs = document.createElement("div");
  metricTabs.className = "analysis-dashboard__metric-tabs";
  metricTabs.setAttribute("role", "tablist");
  const durationTab = metricButton(document, "duration", true);
  const operationsTab = metricButton(document, "operations", false);
  metricTabs.append(durationTab, operationsTab);
  trendSection.header.append(metricTabs);
  const chartFrame = document.createElement("div");
  chartFrame.className = "analysis-dashboard__chart-frame";
  const chart = svg(document, "svg");
  chart.classList.add("analysis-dashboard__chart");
  chart.setAttribute("viewBox", `0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`);
  chart.setAttribute("role", "img");
  const chartEmpty = document.createElement("p");
  chartEmpty.className = "analysis-dashboard__empty";
  chartFrame.append(chart, chartEmpty);
  const trendEvidence = document.createElement("p");
  trendEvidence.className = "analysis-dashboard__evidence";
  const chartGuide = document.createElement("details");
  chartGuide.className = "analysis-dashboard__chart-guide";
  chartGuide.dataset.chartGuide = "analysis";
  const chartGuideSummary = document.createElement("summary");
  const chartGuideList = document.createElement("dl");
  chartGuide.append(chartGuideSummary, chartGuideList);
  trendSection.body.append(chartFrame, chartGuide, trendEvidence);

  const lower = document.createElement("div");
  lower.className = "analysis-dashboard__lower";
  const completionSection = analysisSection(document);
  const completionList = document.createElement("ol");
  completionList.className = "analysis-dashboard__criteria";
  completionSection.body.append(completionList);

  const pathSection = analysisSection(document);
  const coverage = document.createElement("div");
  coverage.className = "analysis-dashboard__coverage";
  const coverageLabel = document.createElement("span");
  const coverageProgress = document.createElement("progress");
  coverageProgress.max = 1;
  coverageProgress.value = 0;
  coverage.append(coverageLabel, coverageProgress);
  const hotspotList = document.createElement("ol");
  hotspotList.className = "analysis-dashboard__hotspots";
  pathSection.body.append(coverage, hotspotList);

  const memorySection = analysisSection(document);
  const memoryBars = document.createElement("div");
  memoryBars.className = "analysis-dashboard__memory-bars";
  memoryBars.setAttribute("role", "group");
  memorySection.body.append(memoryBars);

  const aiSection = analysisSection(document);
  aiSection.root.classList.add("analysis-dashboard__ai");
  const aiStatus = document.createElement("output");
  aiStatus.className = "analysis-dashboard__ai-status";
  aiStatus.setAttribute("aria-live", "polite");
  const aiPurpose = document.createElement("p");
  aiPurpose.className = "analysis-dashboard__ai-purpose";
  const aiAction = document.createElement("button");
  aiAction.type = "button";
  aiAction.className = "analysis-dashboard__ai-action";
  const aiResult = document.createElement("div");
  aiResult.className = "analysis-dashboard__ai-result";
  aiResult.hidden = true;
  aiSection.body.append(aiPurpose, aiStatus, aiAction, aiResult);

  main.append(trendSection.root, lower);
  lower.append(completionSection.root, pathSection.root, memorySection.root, aiSection.root);
  root.append(heading, summary, main);
  host.replaceChildren(root);

  let rawState = emptyAnalysisDashboardState(locale);
  let state = localizeAnalysisDashboardState(rawState, locale);
  let hasExternalState = false;
  let metric: AnalysisMetric = "duration";
  let remoteContext: MentorRemoteContext | null = null;
  let remoteConfig: AiProviderPublicConfig | null = null;
  let activeSessionId: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let requestGeneration = 0;
  let availabilityGeneration = 0;
  let nextSequence = 0;
  let answer = "";
  let aiAvailability: "loading" | "ready" | "setup" | "error" | "unavailable" =
    options.remoteApi === undefined ? "unavailable" : "loading";
  let aiAvailabilityError = "";
  let lastAssessment: AiAssessment | null = null;
  let destroyed = false;

  const applyStaticCopy = (): void => {
    copy = ANALYSIS_COPY[locale];
    root.dataset.locale = locale;
    heading.textContent = copy.heading;
    for (const id of ["completion", "sizes", "coverage", "reference"] as const) {
      summaryTerms.get(id)!.textContent = copy.summary[id];
    }
    setSectionCopy(trendSection, copy.sections.trend);
    setSectionCopy(completionSection, copy.sections.completion);
    setSectionCopy(pathSection, copy.sections.path);
    setSectionCopy(memorySection, copy.sections.memory);
    setSectionCopy(aiSection, copy.sections.ai);
    durationTab.textContent = copy.duration;
    operationsTab.textContent = copy.operations;
    chart.setAttribute("aria-label", copy.chartAria);
    const chartGuideCopy = ANALYSIS_CHART_GUIDE_COPY[locale];
    chartGuideSummary.textContent = chartGuideCopy.summary;
    renderAnalysisChartGuide(document, chartGuideList, chartGuideCopy.items);
    coverageProgress.setAttribute("aria-label", copy.coverageAria);
    memoryBars.setAttribute("aria-label", copy.memoryAria);
    aiPurpose.textContent = copy.aiPurpose;
  };

  const render = (): void => {
    const passed = state.criteria.filter((criterion) => criterion.state === "passed").length;
    const failed = state.criteria.filter((criterion) => criterion.state === "failed").length;
    summaryFields.get("completion")!.textContent =
      `${String(passed)} / ${String(state.criteria.length)}${failed > 0 ? copy.needsAttention(failed) : ""}`;
    summaryFields.get("sizes")!.textContent =
      state.trendPoints.length === 0
        ? copy.insufficientData
        : copy.groupCount(state.trendPoints.length);
    summaryFields.get("coverage")!.textContent =
      state.branchTotal === 0
        ? copy.noStructuredBranches
        : `${String(state.branchCovered)} / ${String(state.branchTotal)}`;
    summaryFields.get("reference")!.textContent = state.referenceLabel ?? copy.unconfirmed;
    renderTrend();
    renderCriteria();
    renderCoverageAndHotspots();
    renderMemory();
  };

  const renderTrend = (): void => {
    durationTab.setAttribute("aria-selected", String(metric === "duration"));
    operationsTab.setAttribute("aria-selected", String(metric === "operations"));
    chart.replaceChildren();
    const values = state.trendPoints.flatMap((point) => {
      const value = metric === "duration" ? point.medianDurationMs : point.medianOperationCount;
      if (value === null || !Number.isFinite(value) || value < 0) return [];
      const minimum =
        metric === "duration" ? (point.minDurationMs ?? value) : (point.minOperationCount ?? value);
      const maximum =
        metric === "duration" ? (point.maxDurationMs ?? value) : (point.maxOperationCount ?? value);
      return [{ point, value, minimum, maximum }];
    });
    chartEmpty.hidden = values.length > 0;
    chartEmpty.textContent = metric === "duration" ? copy.durationEmpty : copy.operationsEmpty;
    trendEvidence.textContent = `${state.trendEvidence}${metric === "operations" ? copy.operationCaveat : copy.durationCaveat}`;
    if (values.length === 0) return;

    const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
    const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const minX = Math.min(...values.map(({ point }) => point.inputSize));
    const maxX = Math.max(...values.map(({ point }) => point.inputSize));
    const referenceValues =
      metric === "operations"
        ? values.flatMap(({ point }) =>
            point.referenceOperationCount === null ? [] : [point.referenceOperationCount],
          )
        : [];
    const maxY = Math.max(1, ...values.map(({ maximum }) => maximum), ...referenceValues);
    const x = (value: number): number =>
      CHART_MARGIN.left +
      (maxX === minX ? plotWidth / 2 : ((value - minX) / (maxX - minX)) * plotWidth);
    const y = (value: number): number =>
      CHART_MARGIN.top + plotHeight - (value / maxY) * plotHeight;

    appendAxes(document, chart, maxY, metric, plotWidth, plotHeight, copy.xAxis);
    for (const { point, value, minimum, maximum } of values) {
      const range = svg(document, "line");
      range.classList.add("analysis-dashboard__range");
      setSvgAttributes(range, {
        x1: x(point.inputSize),
        x2: x(point.inputSize),
        y1: y(minimum),
        y2: y(maximum),
      });
      chart.append(range);
      const label = svg(document, "text");
      label.classList.add("analysis-dashboard__axis-label");
      label.textContent = String(point.inputSize);
      setSvgAttributes(label, { x: x(point.inputSize), y: CHART_HEIGHT - 17 });
      chart.append(label);
      const dot = svg(document, "circle");
      dot.classList.add("analysis-dashboard__point");
      setSvgAttributes(dot, { cx: x(point.inputSize), cy: y(value), r: 4 });
      const title = svg(document, "title");
      title.textContent = copy.pointTitle(
        point.inputSize,
        formatMetric(value, metric),
        point.sampleCount,
      );
      dot.append(title);
      chart.append(dot);
    }
    const measured = svg(document, "polyline");
    measured.classList.add("analysis-dashboard__line");
    measured.setAttribute(
      "points",
      values
        .map(({ point, value }) => `${String(x(point.inputSize))},${String(y(value))}`)
        .join(" "),
    );
    chart.append(measured);

    if (metric === "operations" && referenceValues.length >= 2) {
      const reference = svg(document, "polyline");
      reference.classList.add("analysis-dashboard__reference-line");
      reference.setAttribute(
        "points",
        values
          .flatMap(({ point }) =>
            point.referenceOperationCount === null
              ? []
              : [`${String(x(point.inputSize))},${String(y(point.referenceOperationCount))}`],
          )
          .join(" "),
      );
      chart.append(reference);
    }
  };

  const renderCriteria = (): void => {
    completionList.replaceChildren();
    for (const criterion of state.criteria) {
      const item = document.createElement("li");
      item.dataset.state = criterion.state;
      const marker = document.createElement("span");
      marker.className = "analysis-dashboard__criterion-marker";
      marker.textContent =
        criterion.state === "passed"
          ? copy.criterionPassed
          : criterion.state === "failed"
            ? copy.criterionFailed
            : copy.criterionPending;
      const criterionCopy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = criterion.label;
      const detail = document.createElement("span");
      detail.textContent = criterion.detail;
      criterionCopy.append(title, detail);
      item.append(marker, criterionCopy);
      completionList.append(item);
    }
  };

  const renderCoverageAndHotspots = (): void => {
    coverageLabel.textContent =
      state.branchTotal === 0
        ? copy.coverageNone
        : copy.coverageValue(state.branchCovered, state.branchTotal);
    coverageProgress.max = Math.max(1, state.branchTotal);
    coverageProgress.value = Math.min(state.branchCovered, state.branchTotal);
    hotspotList.replaceChildren();
    if (state.hotspots.length === 0) {
      const empty = document.createElement("li");
      empty.className = "analysis-dashboard__empty";
      empty.textContent = copy.hotspotEmpty;
      hotspotList.append(empty);
      return;
    }
    for (const hotspot of state.hotspots.slice(0, 6)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "analysis-dashboard__hotspot";
      button.addEventListener("click", () => options.onLocate?.(hotspot.target));
      const label = document.createElement("span");
      label.textContent = hotspot.label;
      const value = document.createElement("span");
      value.textContent = copy.hotspotValue(hotspot.count, hotspot.share * 100);
      const bar = document.createElement("span");
      bar.className = "analysis-dashboard__hotspot-bar";
      bar.style.setProperty(
        "--hotspot-share",
        `${String(Math.max(0, Math.min(1, hotspot.share)) * 100)}%`,
      );
      button.append(label, value, bar);
      item.append(button);
      hotspotList.append(item);
    }
  };

  const renderMemory = (): void => {
    memoryBars.replaceChildren();
    const points = state.trendPoints.filter(
      (point): point is AnalysisTrendPoint & { readonly medianPeakRssBytes: number } =>
        point.medianPeakRssBytes !== null && point.medianPeakRssBytes >= 0,
    );
    if (points.length === 0) {
      const empty = document.createElement("p");
      empty.className = "analysis-dashboard__empty";
      empty.textContent = copy.memoryEmpty;
      memoryBars.append(empty);
      return;
    }
    const max = Math.max(1, ...points.map((point) => point.medianPeakRssBytes));
    for (const point of points) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `n=${String(point.inputSize)}`;
      const bar = document.createElement("span");
      bar.className = "analysis-dashboard__memory-bar";
      bar.style.setProperty("--memory-share", `${String((point.medianPeakRssBytes / max) * 100)}%`);
      const value = document.createElement("span");
      value.textContent = formatBytes(point.medianPeakRssBytes);
      row.append(label, bar, value);
      memoryBars.append(row);
    }
  };

  const stopPoll = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const cancelAi = (): void => {
    requestGeneration += 1;
    stopPoll();
    const sessionId = activeSessionId;
    activeSessionId = null;
    nextSequence = 0;
    answer = "";
    aiAction.disabled = false;
    if (sessionId !== null && options.remoteApi !== undefined) {
      void options.remoteApi.cancelAiMentor({ sessionId });
    }
  };

  const renderAiAvailability = (): void => {
    if (activeSessionId !== null) {
      aiAction.textContent = copy.aiActions.reviewing;
      aiAction.disabled = true;
      aiStatus.textContent = copy.aiStatus.reviewing;
      aiStatus.dataset.state = "working";
      return;
    }
    if (aiAvailability === "unavailable") {
      aiAction.textContent = copy.aiActions.unavailable;
      aiAction.disabled = true;
      aiStatus.textContent = copy.aiStatus.unavailable;
      aiStatus.dataset.state = "idle";
      return;
    }
    if (aiAvailability === "loading") {
      aiAction.textContent = copy.aiActions.loading;
      aiAction.disabled = true;
      aiStatus.textContent = copy.aiStatus.loading;
      aiStatus.dataset.state = "working";
      return;
    }
    if (aiAvailability === "error") {
      aiAction.textContent = copy.aiActions.retry;
      aiAction.disabled = false;
      aiStatus.textContent = localizedSafeErrorMessage(
        aiAvailabilityError,
        locale,
        copy.aiStatus.loadFailed,
      );
      aiStatus.dataset.state = "error";
      return;
    }
    if (aiAvailability === "setup" || !aiConfigReady(remoteConfig)) {
      aiAction.textContent = copy.aiActions.connect;
      aiAction.disabled = false;
      aiStatus.textContent = copy.aiStatus.setup;
      aiStatus.dataset.state = "idle";
      return;
    }
    aiAction.textContent = copy.aiActions.review;
    aiAction.disabled = remoteContext === null || state.sourceFingerprint === null;
    const model = remoteConfig.model ?? "AI";
    aiStatus.textContent =
      remoteContext === null || state.sourceFingerprint === null
        ? copy.aiStatus.connectedWaiting(model)
        : copy.aiStatus.connectedReady(model);
    aiStatus.dataset.state = "ready";
  };

  const refreshAiAvailability = async (): Promise<void> => {
    const generation = ++availabilityGeneration;
    if (options.remoteApi === undefined) {
      remoteConfig = null;
      aiAvailability = "unavailable";
      renderAiAvailability();
      return;
    }
    aiAvailability = "loading";
    renderAiAvailability();
    try {
      const result = await options.remoteApi.getAiProviderConfig();
      if (destroyed || generation !== availabilityGeneration) return;
      if (result.status === "failed") {
        remoteConfig = null;
        aiAvailability = "error";
        aiAvailabilityError = result.error.message;
      } else {
        remoteConfig = result.status === "ready" ? result.config : null;
        aiAvailability = aiConfigReady(remoteConfig) ? "ready" : "setup";
        aiAvailabilityError = "";
      }
      renderAiAvailability();
    } catch {
      if (destroyed || generation !== availabilityGeneration) return;
      remoteConfig = null;
      aiAvailability = "error";
      aiAvailabilityError = "";
      renderAiAvailability();
    }
  };

  const pollAi = async (generation: number, fingerprint: string): Promise<void> => {
    if (
      destroyed ||
      generation !== requestGeneration ||
      activeSessionId === null ||
      options.remoteApi === undefined
    ) {
      return;
    }
    const sessionId = activeSessionId;
    try {
      const result = await options.remoteApi.readAiMentor({
        sessionId,
        afterSequence: nextSequence,
      });
      if (
        destroyed ||
        generation !== requestGeneration ||
        activeSessionId !== sessionId ||
        remoteContext?.sourceFingerprint !== fingerprint
      ) {
        return;
      }
      if (result.status === "failed") {
        aiStatus.textContent = localizedSafeErrorMessage(
          result.error.message,
          locale,
          copy.aiStatus.readFailed,
        );
        aiStatus.dataset.state = "error";
        cancelAi();
        return;
      }
      if (result.sourceFingerprint !== fingerprint) {
        aiStatus.textContent = copy.aiStatus.stale;
        aiStatus.dataset.state = "error";
        cancelAi();
        return;
      }
      nextSequence = result.nextSequence;
      for (const event of result.events) if (event.kind === "answer") answer += event.text;
      if (result.status === "running") {
        pollTimer = setTimeout(() => void pollAi(generation, fingerprint), AI_POLL_INTERVAL_MS);
        return;
      }
      activeSessionId = null;
      renderAiAvailability();
      if (result.status === "cancelled") {
        aiStatus.textContent = copy.aiStatus.cancelled;
        return;
      }
      const assessment = parseAiAssessment(answer);
      if (assessment === null) {
        aiStatus.textContent = copy.aiStatus.invalid;
        aiStatus.dataset.state = "error";
        return;
      }
      lastAssessment = assessment;
      aiStatus.textContent = copy.aiStatus.assessment(
        copy.assessmentStatus[assessment.status],
        copy.confidence[assessment.confidence],
      );
      aiStatus.dataset.state = "ready";
      renderAiAssessment(document, aiResult, assessment, copy);
    } catch {
      if (!destroyed && generation === requestGeneration) {
        aiStatus.textContent = copy.aiStatus.readFailed;
        aiStatus.dataset.state = "error";
        cancelAi();
      }
    }
  };

  const requestAiAssessment = async (): Promise<void> => {
    if (aiAvailability === "setup") {
      options.onOpenAiSettings?.();
      return;
    }
    if (aiAvailability === "error") {
      await refreshAiAvailability();
      return;
    }
    if (aiAvailability !== "ready") return;
    if (
      options.remoteApi === undefined ||
      remoteContext === null ||
      state.sourceFingerprint === null
    ) {
      aiStatus.textContent = copy.aiStatus.needsEvidence;
      aiStatus.dataset.state = "error";
      return;
    }
    cancelAi();
    aiResult.hidden = true;
    lastAssessment = null;
    aiStatus.textContent = copy.aiStatus.confirming;
    aiStatus.dataset.state = "working";
    aiAction.textContent = copy.aiActions.reviewing;
    aiAction.disabled = true;
    const generation = requestGeneration;
    const fingerprint = remoteContext.sourceFingerprint;
    try {
      const configResult = await options.remoteApi.getAiProviderConfig();
      if (destroyed || generation !== requestGeneration) return;
      if (configResult.status === "failed") {
        remoteConfig = null;
        aiAvailability = "error";
        aiAvailabilityError = configResult.error.message;
        renderAiAvailability();
        return;
      }
      remoteConfig = configResult.status === "ready" ? configResult.config : null;
      if (!aiConfigReady(remoteConfig)) {
        aiAvailability = "setup";
        renderAiAvailability();
        options.onOpenAiSettings?.();
        return;
      }
      aiAvailability = "ready";
      const startResult = await options.remoteApi.startAiMentor({
        sourceFingerprint: fingerprint,
        sourceRevision: remoteContext.sourceRevision,
        providerRevision: remoteConfig.revision,
        contextMode: "current-function",
        locale,
        prompt: buildAssessmentPrompt(state, locale),
        history: Object.freeze([]),
        context: {
          currentFunction: remoteContext.currentFunction,
          diagnosticSummary: remoteContext.diagnosticSummary,
          controlFlowSummary: remoteContext.controlFlowSummary,
          runEvidence: remoteContext.runEvidence,
        },
      });
      if (startResult.status === "failed") {
        if (!destroyed && generation === requestGeneration) {
          renderAiAvailability();
          aiStatus.textContent = localizedSafeErrorMessage(
            startResult.error.message,
            locale,
            copy.aiStatus.startFailed,
          );
          aiStatus.dataset.state = "error";
        }
        return;
      }
      if (
        destroyed ||
        generation !== requestGeneration ||
        remoteContext?.sourceFingerprint !== fingerprint
      ) {
        await options.remoteApi.cancelAiMentor({ sessionId: startResult.sessionId });
        return;
      }
      activeSessionId = startResult.sessionId;
      nextSequence = 0;
      answer = "";
      aiStatus.textContent = copy.aiStatus.reviewing;
      void pollAi(generation, fingerprint);
    } catch {
      if (!destroyed && generation === requestGeneration) {
        renderAiAvailability();
        aiStatus.textContent = copy.aiStatus.startFailed;
        aiStatus.dataset.state = "error";
      }
    }
  };

  durationTab.addEventListener("click", () => {
    metric = "duration";
    renderTrend();
  });
  operationsTab.addEventListener("click", () => {
    metric = "operations";
    renderTrend();
  });
  aiAction.addEventListener("click", () => void requestAiAssessment());
  const onAiProviderConfigChange = (): void => {
    cancelAi();
    void refreshAiAvailability();
  };
  const renderLocale = (nextLocale: InterfaceLocale): void => {
    if (destroyed) return;
    locale = nextLocale;
    if (!hasExternalState) rawState = emptyAnalysisDashboardState(locale);
    state = localizeAnalysisDashboardState(rawState, locale);
    applyStaticCopy();
    render();
    renderAiAvailability();
    if (lastAssessment !== null && !aiResult.hidden && activeSessionId === null) {
      renderAiAssessment(document, aiResult, lastAssessment, copy);
      aiStatus.textContent = copy.aiStatus.assessment(
        copy.assessmentStatus[lastAssessment.status],
        copy.confidence[lastAssessment.confidence],
      );
      aiStatus.dataset.state = "ready";
    }
  };
  const onLocaleChange = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    const candidate =
      typeof detail === "object" && detail !== null && "locale" in detail
        ? detail.locale
        : localeHost.dataset.locale;
    renderLocale(resolveAnalysisLocale(candidate));
  };
  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const localeObserver =
    MutationObserverConstructor === undefined
      ? null
      : new MutationObserverConstructor(() => {
          renderLocale(resolveAnalysisLocale(localeHost.dataset.locale));
        });
  localeObserver?.observe(localeHost, {
    attributes: true,
    attributeFilter: ["data-locale"],
  });
  document.defaultView?.addEventListener(AI_PROVIDER_CONFIG_CHANGE_EVENT, onAiProviderConfigChange);
  localeHost.addEventListener("workbench-locale-change", onLocaleChange);
  applyStaticCopy();
  render();
  renderAiAvailability();
  void refreshAiAvailability();

  return Object.freeze({
    element: root,
    setState(next: AnalysisDashboardState): void {
      assertAlive(destroyed);
      if (next.sourceFingerprint !== rawState.sourceFingerprint) {
        cancelAi();
        aiResult.hidden = true;
        lastAssessment = null;
        aiStatus.textContent = copy.aiStatus.sourceChanged;
      }
      hasExternalState = true;
      rawState = freezeState(next);
      state = localizeAnalysisDashboardState(rawState, locale);
      render();
      renderAiAvailability();
    },
    setRemoteContext(context: MentorRemoteContext | null): void {
      assertAlive(destroyed);
      if (context?.sourceFingerprint !== remoteContext?.sourceFingerprint) {
        cancelAi();
        aiResult.hidden = true;
        lastAssessment = null;
      }
      remoteContext = context === null ? null : Object.freeze({ ...context });
      renderAiAvailability();
    },
    destroy(): void {
      if (destroyed) return;
      cancelAi();
      destroyed = true;
      availabilityGeneration += 1;
      durationTab.replaceWith(durationTab.cloneNode(true));
      operationsTab.replaceWith(operationsTab.cloneNode(true));
      aiAction.replaceWith(aiAction.cloneNode(true));
      document.defaultView?.removeEventListener(
        AI_PROVIDER_CONFIG_CHANGE_EVENT,
        onAiProviderConfigChange,
      );
      localeHost.removeEventListener("workbench-locale-change", onLocaleChange);
      localeObserver?.disconnect();
      host.replaceChildren();
    },
  });
}

export function parseAiAssessment(value: string): AiAssessment | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 24_000) return null;
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join("|") !== "confidence|evidence|gaps|nextExperiment|observation|status") return null;
  if (
    !["complete", "partial", "not-ready"].includes(String(parsed.status)) ||
    !["low", "medium", "high"].includes(String(parsed.confidence)) ||
    !validAssessmentText(parsed.observation, 1_200) ||
    !validAssessmentText(parsed.nextExperiment, 1_200) ||
    !validAssessmentList(parsed.evidence) ||
    !validAssessmentList(parsed.gaps)
  ) {
    return null;
  }
  return Object.freeze({
    status: parsed.status as AiAssessment["status"],
    confidence: parsed.confidence as AiAssessment["confidence"],
    observation: parsed.observation,
    evidence: Object.freeze([...parsed.evidence]),
    gaps: Object.freeze([...parsed.gaps]),
    nextExperiment: parsed.nextExperiment,
  });
}

export function resolveAnalysisLocale(value: unknown): InterfaceLocale {
  if (typeof value !== "string") return "zh-CN";
  return value.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function analysisSection(document: Document) {
  const root = document.createElement("section");
  root.className = "analysis-dashboard__section";
  const header = document.createElement("header");
  const title = document.createElement("h2");
  const note = document.createElement("span");
  header.append(title, note);
  const body = document.createElement("div");
  body.className = "analysis-dashboard__section-body";
  root.append(header, body);
  return { root, header, title, note, body };
}

function setSectionCopy(
  section: ReturnType<typeof analysisSection>,
  [title, note]: readonly [string, string],
): void {
  section.title.textContent = title;
  section.note.textContent = note;
}

function renderAnalysisChartGuide(
  document: Document,
  list: HTMLDListElement,
  items: readonly (readonly [string, string])[],
): void {
  list.replaceChildren();
  for (const [label, description] of items) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = description;
    row.append(term, detail);
    list.append(row);
  }
}

function metricButton(
  document: Document,
  metric: AnalysisMetric,
  selected: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.analysisMetric = metric;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(selected));
  return button;
}

function appendAxes(
  document: Document,
  chart: SVGSVGElement,
  maxY: number,
  metric: AnalysisMetric,
  plotWidth: number,
  plotHeight: number,
  xAxisTitle: string,
): void {
  const xAxis = svg(document, "line");
  xAxis.classList.add("analysis-dashboard__axis");
  setSvgAttributes(xAxis, {
    x1: CHART_MARGIN.left,
    x2: CHART_MARGIN.left + plotWidth,
    y1: CHART_MARGIN.top + plotHeight,
    y2: CHART_MARGIN.top + plotHeight,
  });
  const yAxis = svg(document, "line");
  yAxis.classList.add("analysis-dashboard__axis");
  setSvgAttributes(yAxis, {
    x1: CHART_MARGIN.left,
    x2: CHART_MARGIN.left,
    y1: CHART_MARGIN.top,
    y2: CHART_MARGIN.top + plotHeight,
  });
  chart.append(xAxis, yAxis);
  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const y = CHART_MARGIN.top + plotHeight - ratio * plotHeight;
    const grid = svg(document, "line");
    grid.classList.add("analysis-dashboard__grid-line");
    setSvgAttributes(grid, {
      x1: CHART_MARGIN.left,
      x2: CHART_MARGIN.left + plotWidth,
      y1: y,
      y2: y,
    });
    const label = svg(document, "text");
    label.classList.add("analysis-dashboard__y-label");
    label.textContent = formatMetric(maxY * ratio, metric);
    setSvgAttributes(label, { x: CHART_MARGIN.left - 8, y: y + 3 });
    chart.append(grid, label);
  }
  const xTitle = svg(document, "text");
  xTitle.classList.add("analysis-dashboard__axis-title");
  xTitle.textContent = xAxisTitle;
  setSvgAttributes(xTitle, { x: CHART_MARGIN.left + plotWidth / 2, y: CHART_HEIGHT - 2 });
  chart.append(xTitle);
}

function svg<K extends keyof SVGElementTagNameMap>(
  document: Document,
  tag: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tag);
}

function setSvgAttributes(element: SVGElement, values: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(values)) element.setAttribute(name, String(value));
}

function renderAiAssessment(
  document: Document,
  host: HTMLElement,
  assessment: AiAssessment,
  uiCopy: AnalysisUiCopy,
): void {
  host.replaceChildren();
  host.hidden = false;
  const listSeparator = uiCopy === ANALYSIS_COPY.en ? "; " : "；";
  for (const [label, key] of uiCopy.assessmentLabels) {
    const rawValue = assessment[key];
    const value =
      typeof rawValue === "string"
        ? rawValue
        : rawValue.join(listSeparator) ||
          (key === "evidence" ? uiCopy.noExtraEvidence : uiCopy.noExtraGaps);
    const section = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = label;
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    section.append(title, paragraph);
    host.append(section);
  }
  const uncertaintySection = document.createElement("section");
  const uncertaintyTitle = document.createElement("h3");
  uncertaintyTitle.textContent = uiCopy.assessmentUncertaintyLabel;
  const uncertaintyCopy = document.createElement("p");
  uncertaintyCopy.textContent = uiCopy.uncertainty(uiCopy.confidence[assessment.confidence]);
  uncertaintySection.append(uncertaintyTitle, uncertaintyCopy);
  host.append(uncertaintySection);
}

function buildAssessmentPrompt(state: AnalysisDashboardState, locale: InterfaceLocale): string {
  const criteria = state.criteria
    .map((criterion) => `${criterion.label}: ${criterion.state}; ${criterion.detail}`)
    .join("\n");
  const schema =
    '{"status":"complete|partial|not-ready","confidence":"low|medium|high","observation":"...","evidence":["..."],"gaps":["..."],"nextExperiment":"..."}';
  return locale === "en"
    ? [
        "You are a read-only reviewer for an algorithms course. Assess semantic completion using only the supplied function, static diagnostics, CFG summary and real run evidence.",
        "Do not claim mathematical correctness, invent metrics or suggest automatic source edits.",
        `Problem/scenario: ${state.scenarioLabel}`,
        `Deterministic evidence:\n${criteria}`,
        `Growth evidence: ${state.trendEvidence}`,
        "Return only one JSON object with no Markdown. Use exactly these fields:",
        schema,
      ].join("\n")
    : [
        "你是算法课程的只读审查员。只依据提供的分析函数、静态诊断、CFG 摘要和真实运行证据评估语义完成情况。",
        "不得宣称数学正确性，不得虚构指标，不得建议自动修改源码。",
        `问题/情景：${state.scenarioLabel}`,
        `确定性证据：\n${criteria}`,
        `增长证据：${state.trendEvidence}`,
        "只返回一个 JSON 对象，不要 Markdown。严格字段：",
        schema,
      ].join("\n");
}

function aiConfigReady(config: AiProviderPublicConfig | null): config is AiProviderPublicConfig {
  return (
    config !== null &&
    config.state === "connected" &&
    config.providerId !== null &&
    config.model !== null &&
    config.credentialUsable
  );
}

function validAssessmentText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function validAssessmentList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every((item) => validAssessmentText(item, 600))
  );
}

function freezeState(state: AnalysisDashboardState): AnalysisDashboardState {
  return Object.freeze({
    ...state,
    trendPoints: Object.freeze(state.trendPoints.map((point) => Object.freeze({ ...point }))),
    criteria: Object.freeze(state.criteria.map((criterion) => Object.freeze({ ...criterion }))),
    hotspots: Object.freeze(state.hotspots.map((hotspot) => Object.freeze({ ...hotspot }))),
  });
}

function emptyAnalysisDashboardState(locale: InterfaceLocale): AnalysisDashboardState {
  const copy = ANALYSIS_COPY[locale];
  return Object.freeze({
    sourceFingerprint: null,
    statusMessage: copy.initialStatus,
    scenarioLabel: copy.initialScenario,
    referenceLabel: null,
    trendEvidence: copy.initialTrend,
    trendPoints: Object.freeze([]),
    criteria: Object.freeze([]),
    branchCovered: 0,
    branchTotal: 0,
    hotspots: Object.freeze([]),
  });
}

function formatMetric(value: number, metric: AnalysisMetric): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return metric === "duration" ? `${String(rounded)} ms` : String(rounded);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${String(value)} B`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAlive(destroyed: boolean): void {
  if (destroyed) throw new Error("分析视图已销毁");
}
