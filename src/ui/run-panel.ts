import type {
  Capabilities,
  ClangDiagnostic,
  CompileResult,
  RunResult,
  TerminationReason,
} from "../shared/api.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import { fingerprintSource } from "../shared/source-snapshot.js";

const RUNNER_SOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.c$/u;
const MAX_RUNNER_SOURCE_NAME_LENGTH = 128;
const SOURCE_EXTENSION_LENGTH = 2;
const outputDecoder = new TextDecoder("utf-8", { fatal: false });

let nextRunPanelId = 1;

export interface RunPanelOptions {
  readonly getSource: () => string;
  readonly getDisplayName: () => string;
  readonly getManualScenario?: (() => ManualRunScenario | null) | undefined;
  readonly onDiagnostics?: (source: string, diagnostics: readonly ClangDiagnostic[]) => void;
  readonly onRunComplete?: ((completion: RunPanelCompletion) => void) | undefined;
}

export interface ManualRunScenario {
  readonly id: string;
  readonly version: string;
  readonly mode: "real" | "simulation";
  readonly stdin: string;
  readonly arguments: readonly string[];
  readonly inputSize: number | null;
}

export interface RunPanelCompletion {
  readonly source: string;
  readonly sourceFingerprint: string;
  readonly compileResult: CompileResult;
  readonly runResult: RunResult | null;
  readonly capabilities: Capabilities;
  readonly scenario: ManualRunScenario | null;
}

export interface RunPanel {
  refreshCapabilities(): Promise<void>;
  runCurrent(): Promise<RunPanelCompletion | null>;
  invalidateSource(): void;
  destroy(): void;
}

export interface RunEvidencePresentation {
  readonly runDuration: string;
  readonly peakRss: string;
  readonly peakProcessCount: string;
  readonly outputBytes: string;
  readonly executedNodeCount: string;
  readonly operationCount: string;
}

const RUN_SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RUN_SCENARIO_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export function normalizeManualRunScenario(
  value: ManualRunScenario | null,
): ManualRunScenario | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new TypeError("运行情景必须是对象或 null");
  if (!RUN_SCENARIO_ID_PATTERN.test(value.id)) {
    throw new TypeError("运行情景 id 必须是稳定标识符");
  }
  if (!RUN_SCENARIO_VERSION_PATTERN.test(value.version)) {
    throw new TypeError("运行情景 version 必须是语义化版本");
  }
  if (value.mode !== "real" && value.mode !== "simulation") {
    throw new TypeError("运行情景 mode 必须是 real 或 simulation");
  }
  if (typeof value.stdin !== "string" || value.stdin.includes("\0")) {
    throw new TypeError("运行情景 stdin 必须是无 NUL 的字符串");
  }
  if (
    !Array.isArray(value.arguments) ||
    value.arguments.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new TypeError("运行情景 arguments 必须是无 NUL 的字符串数组");
  }
  if (
    value.inputSize !== null &&
    (!Number.isSafeInteger(value.inputSize) || value.inputSize <= 0)
  ) {
    throw new TypeError("运行情景 inputSize 必须是正安全整数或 null");
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    mode: value.mode,
    stdin: value.stdin,
    arguments: Object.freeze([...value.arguments]),
    inputSize: value.inputSize,
  });
}

export function toRunnerSourceName(displayName: string): string {
  const leafName = displayName.trim().split(/[\\/]/u).at(-1) ?? "";
  const stemWithoutExtension = leafName.replace(/\.c$/iu, "");
  const asciiStem = stemWithoutExtension
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/[._-]+$/u, "");
  const fallbackStem = asciiStem.length > 0 ? asciiStem : "main";
  const maxStemLength = MAX_RUNNER_SOURCE_NAME_LENGTH - SOURCE_EXTENSION_LENGTH;
  const sourceName = `${fallbackStem.slice(0, maxStemLength)}.c`;

  if (!RUNNER_SOURCE_NAME_PATTERN.test(sourceName)) {
    return "main.c";
  }
  return sourceName;
}

export function formatCompileDurationEvidence(
  value: number | undefined,
  locale: InterfaceLocale = "zh-CN",
): string {
  return isNonNegativeFinite(value)
    ? `${formatMetricNumber(value)} ms`
    : localized(locale, "不可用", "Unavailable");
}

export function formatRunEvidence(
  result: RunResult,
  locale: InterfaceLocale = "zh-CN",
): RunEvidencePresentation {
  const sampled = isNonNegativeSafeInteger(result.peakProcessCount) && result.peakProcessCount > 0;
  const capturedOutput = isNonNegativeSafeInteger(result.outputBytes)
    ? result.outputBytes
    : result.stdout.byteLength + result.stderr.byteLength;
  return Object.freeze({
    runDuration: isNonNegativeFinite(result.durationMs)
      ? `${formatMetricNumber(result.durationMs)} ms`
      : localized(locale, "不可用", "Unavailable"),
    peakRss:
      sampled && isNonNegativeSafeInteger(result.peakRssBytes)
        ? localized(
            locale,
            `${formatByteCount(result.peakRssBytes)}（采样峰值）`,
            `${formatByteCount(result.peakRssBytes)} (sampled peak)`,
          )
        : localized(locale, "未取得有效样本", "No valid sample"),
    peakProcessCount: sampled
      ? localized(
          locale,
          `${String(result.peakProcessCount)}（采样峰值）`,
          `${String(result.peakProcessCount)} (sampled peak)`,
        )
      : localized(locale, "未取得有效样本", "No valid sample"),
    outputBytes: localized(
      locale,
      `${formatByteCount(capturedOutput)}（stdout + stderr 已捕获）`,
      `${formatByteCount(capturedOutput)} (captured stdout + stderr)`,
    ),
    executedNodeCount: formatInstrumentedCount(result.executedNodeCount, locale),
    operationCount: formatInstrumentedCount(result.operationCount, locale),
  });
}

export function createRunPanel(host: HTMLElement, options: RunPanelOptions): RunPanel {
  const panelId = nextRunPanelId;
  nextRunPanelId += 1;
  const advancedDisclosure =
    typeof host.closest === "function"
      ? host.closest<HTMLDetailsElement>("details.runtime-advanced")
      : null;
  const localeHost =
    typeof host.closest === "function" ? host.closest<HTMLElement>("#workbench-shell") : null;
  let locale: InterfaceLocale = localeHost?.dataset.locale === "en" ? "en" : "zh-CN";

  const root = createElement("div", "run-panel");
  root.dataset.state = "loading";

  const safetyNotice = createElement(
    "p",
    "run-panel__safety-notice",
    "仅运行你编写或逐行审阅过的代码。可信执行没有文件或网络隔离。",
  );
  safetyNotice.hidden = true;
  const runButton = createElement("button", "run-panel__run-button", "直接执行当前代码");
  runButton.type = "button";
  runButton.disabled = true;
  const diagnoseButton = createElement("button", "run-panel__diagnose-button", "静态诊断");
  diagnoseButton.type = "button";
  diagnoseButton.disabled = true;
  const memoryButton = createElement("button", "run-panel__diagnose-button", "完整内存诊断");
  memoryButton.type = "button";
  memoryButton.disabled = true;
  const operationStatus = createElement(
    "output",
    "run-panel__operation-status",
    "正在检查本地运行能力…",
  );
  operationStatus.setAttribute("aria-live", "polite");
  const action = createElement("div", "run-panel__action");
  const toolDisclosure = createElement("details", "run-panel__tools");
  const toolSummary = createElement("summary", "run-panel__tools-summary", "手动运行与诊断");
  const actionButtons = createElement("div", "run-panel__action-buttons");
  actionButtons.append(runButton, diagnoseButton, memoryButton);
  toolDisclosure.append(toolSummary, actionButtons);
  action.append(toolDisclosure, operationStatus);

  const capabilityDetails = createElement("details", "run-panel__capability-details");
  const capabilitySummary = createElement("summary", "run-panel__capability-summary", "运行环境");
  const capabilityList = createElement("dl", "run-panel__capabilities");
  const modeRow = appendDescriptionRow(capabilityList, "安全模式", "mode");
  const isolationRow = appendDescriptionRow(capabilityList, "执行隔离", "isolation");
  const memoryCapabilityRow = appendDescriptionRow(
    capabilityList,
    "完整内存诊断",
    "memory-diagnostics",
  );
  const trustRow = appendDescriptionRow(capabilityList, "可信确认", "trust-confirmation");
  const modeValue = modeRow.value;
  const isolationValue = isolationRow.value;
  const memoryCapabilityValue = memoryCapabilityRow.value;
  const trustValue = trustRow.value;
  modeValue.textContent = "正在检查";
  isolationValue.textContent = "正在检查";
  memoryCapabilityValue.textContent = "正在检查";
  trustValue.textContent = "正在检查";
  capabilityDetails.append(capabilitySummary, capabilityList);

  const result = createElement("section", "run-panel__result");
  result.hidden = true;
  const resultHeading = createElement("h3", "run-panel__result-title", "结果");
  const resultStatus = createElement("output", "run-panel__result-status", "尚未运行");

  const diagnosticsHeading = createElement("h4", "run-panel__section-title", "编译诊断");
  const diagnostics = createOutputBlock("diagnostics", diagnosticsHeading, panelId);
  const stdoutHeading = createElement("h4", "run-panel__section-title", "标准输出 stdout");
  const stdout = createOutputBlock("stdout", stdoutHeading, panelId);
  const stderrHeading = createElement("h4", "run-panel__section-title", "标准错误 stderr");
  const stderr = createOutputBlock("stderr", stderrHeading, panelId);
  const sanitizerHeading = createElement("h4", "run-panel__section-title", "ASan / UBSan");
  const sanitizer = createOutputBlock("sanitizer", sanitizerHeading, panelId);
  const leaksHeading = createElement("h4", "run-panel__section-title", "独立 leaks");
  const leaks = createOutputBlock("leaks", leaksHeading, panelId);

  const processList = createElement("dl", "run-panel__process-result");
  processList.hidden = true;
  const evidenceNotice = createElement(
    "p",
    "run-panel__evidence-notice",
    "分项数据来自本次本机受限进程；不代表 Big-O，也不合成为评分。",
  );
  evidenceNotice.hidden = true;
  const compileDurationRow = appendDescriptionRow(processList, "编译进程耗时", "compile-duration");
  const exitRow = appendDescriptionRow(processList, "退出码", "exit-code");
  const signalRow = appendDescriptionRow(processList, "信号", "signal");
  const terminationRow = appendDescriptionRow(processList, "终止原因", "termination");
  const durationRow = appendDescriptionRow(processList, "运行墙钟耗时", "duration");
  const peakRssRow = appendDescriptionRow(processList, "进程组峰值内存", "peak-rss");
  const peakProcessRow = appendDescriptionRow(processList, "进程组峰值数量", "peak-process-count");
  const outputBytesRow = appendDescriptionRow(processList, "捕获输出量", "output-bytes");
  const executedNodesRow = appendDescriptionRow(processList, "执行节点数", "executed-node-count");
  const operationCountRow = appendDescriptionRow(processList, "操作计数", "operation-count");
  const compileDurationValue = compileDurationRow.value;
  const exitValue = exitRow.value;
  const signalValue = signalRow.value;
  const terminationValue = terminationRow.value;
  const durationValue = durationRow.value;
  const peakRssValue = peakRssRow.value;
  const peakProcessValue = peakProcessRow.value;
  const outputBytesValue = outputBytesRow.value;
  const executedNodesValue = executedNodesRow.value;
  const operationCountValue = operationCountRow.value;
  let compileDurationEvidence: number | undefined | null = null;
  let runEvidence: RunResult | null = null;
  resetProcessDetails();
  setOutput(diagnosticsHeading, diagnostics, "");
  setOutput(stdoutHeading, stdout, "");
  setOutput(stderrHeading, stderr, "");
  setOutput(sanitizerHeading, sanitizer, "");
  setOutput(leaksHeading, leaks, "");

  result.append(
    resultHeading,
    resultStatus,
    diagnosticsHeading,
    diagnostics,
    stdoutHeading,
    stdout,
    stderrHeading,
    stderr,
    sanitizerHeading,
    sanitizer,
    leaksHeading,
    leaks,
    evidenceNotice,
    processList,
  );
  root.append(safetyNotice, action, capabilityDetails, result);
  host.append(root);

  let destroyed = false;
  let busy = false;
  let capabilities: Capabilities | undefined;
  let capabilityRequestId = 0;
  let runRequestId = 0;
  let capabilityFailed = false;
  let operationMessage = bilingual("正在检查本地运行能力…", "Checking local runner…");
  let resultMessage = bilingual("尚未运行", "Not run yet");

  function renderMessages(): void {
    operationStatus.textContent = messageForLocale(operationMessage, locale);
    resultStatus.textContent = messageForLocale(resultMessage, locale);
  }

  function setOperationMessage(zh: string, en: string): void {
    operationMessage = bilingual(zh, en);
    operationStatus.textContent = messageForLocale(operationMessage, locale);
  }

  function setResultMessage(zh: string, en: string): void {
    resultMessage = bilingual(zh, en);
    resultStatus.textContent = messageForLocale(resultMessage, locale);
  }

  function setBothMessages(zh: string, en: string): void {
    setOperationMessage(zh, en);
    setResultMessage(zh, en);
  }

  function updateRunButton(): void {
    const disabled = destroyed || busy || capabilities?.runnerEnabled !== true;
    runButton.disabled = disabled;
    diagnoseButton.disabled = disabled;
    memoryButton.disabled = disabled || capabilities?.memoryDiagnostics.available !== true;
    memoryButton.title = capabilities?.memoryDiagnostics.detail ?? "";
  }

  function renderAvailability(): void {
    if (busy || destroyed) {
      return;
    }
    delete root.dataset.failureReason;
    if (capabilities?.runnerEnabled === true) {
      root.dataset.state = "ready";
      setOperationMessage("本地运行器可用。", "Local runner available.");
      return;
    }
    root.dataset.state = "disabled";
    setOperationMessage(
      "运行器当前不可用；其他学习功能不受影响。",
      "The runner is unavailable; other learning features still work.",
    );
  }

  function renderCapabilities(snapshot: Capabilities): void {
    safetyNotice.hidden = !snapshot.requiresNativeTrustConfirmation;
    modeValue.textContent = runnerModeLabel(snapshot, locale);
    isolationValue.textContent = isolationStatusLabel(snapshot, locale);
    memoryCapabilityValue.textContent = `${localized(
      locale,
      snapshot.memoryDiagnostics.available ? "可用" : "不可用",
      snapshot.memoryDiagnostics.available ? "Available" : "Unavailable",
    )}${snapshot.memoryDiagnostics.detail.trim().length > 0 ? `: ${snapshot.memoryDiagnostics.detail}` : ""}`;
    trustValue.textContent = snapshot.requiresNativeTrustConfirmation
      ? localized(
          locale,
          "需要；完整内存诊断整套流程仅确认一次",
          "Required; the full memory-diagnostic flow asks only once",
        )
      : localized(
          locale,
          "当前模式不需要原生可信确认",
          "Native trust confirmation is not required in this mode",
        );
  }

  async function refreshCapabilities(): Promise<void> {
    if (destroyed) {
      return;
    }
    const requestId = capabilityRequestId + 1;
    capabilityRequestId = requestId;
    if (!busy) {
      root.dataset.state = "loading";
      setOperationMessage("正在检查本地运行能力…", "Checking local runner…");
    }
    capabilityFailed = false;
    capabilities = undefined;
    renderCapabilityPlaceholders();
    updateRunButton();

    try {
      const snapshot = await window.panelApi.capabilities();
      if (destroyed || requestId !== capabilityRequestId) {
        return;
      }
      capabilities = snapshot;
      renderCapabilities(snapshot);
      updateRunButton();
      renderAvailability();
    } catch {
      if (destroyed || requestId !== capabilityRequestId) {
        return;
      }
      capabilities = undefined;
      capabilityFailed = true;
      renderCapabilityPlaceholders();
      updateRunButton();
      if (!busy) {
        root.dataset.state = "error";
        setOperationMessage(
          "无法连接本地运行器；编译与运行已停用。",
          "Cannot connect to the local runner; compile and run are disabled.",
        );
      }
    }
  }

  async function compileAndRun(): Promise<RunPanelCompletion | null> {
    if (destroyed || busy) {
      return null;
    }
    if (capabilities?.runnerEnabled !== true) {
      root.dataset.state = capabilityFailed ? "error" : "disabled";
      root.dataset.failureReason = "runner-unavailable";
      result.hidden = false;
      setBothMessages(
        capabilities === undefined && !capabilityFailed
          ? "无法运行：本地运行器尚未就绪。"
          : "无法运行：本地运行器当前不可用。",
        capabilities === undefined && !capabilityFailed
          ? "Cannot run: the local runner is not ready yet."
          : "Cannot run: the local runner is currently unavailable.",
      );
      return null;
    }

    const runCapabilities = snapshotCapabilities(capabilities);
    if (advancedDisclosure !== null) advancedDisclosure.open = true;
    busy = true;
    const requestId = runRequestId + 1;
    runRequestId = requestId;
    root.dataset.state = "running";
    delete root.dataset.failureReason;
    setBothMessages("正在编译…", "Compiling…");
    result.hidden = false;
    setOutput(diagnosticsHeading, diagnostics, "");
    setOutput(stdoutHeading, stdout, "");
    setOutput(stderrHeading, stderr, "");
    setOutput(sanitizerHeading, sanitizer, "");
    setOutput(leaksHeading, leaks, "");
    setProcessEvidenceVisible(false);
    resetProcessDetails();
    updateRunButton();

    let source: string;
    let displayName: string;
    let scenario: ManualRunScenario | null;
    try {
      source = options.getSource();
      displayName = options.getDisplayName();
      if (typeof source !== "string" || typeof displayName !== "string") {
        throw new TypeError("source callbacks must return strings");
      }
      scenario = normalizeManualRunScenario(options.getManualScenario?.() ?? null);
    } catch {
      finishFailure(
        requestId,
        bilingual(
          "本次运行失败：无法取得当前源码或有效运行情景，未启动编译。",
          "Run failed: current source or a valid run case is unavailable; compilation was not started.",
        ),
        "source-unavailable",
      );
      finishRun(requestId);
      return null;
    }

    let completedCompile: CompileResult | null = null;
    let completionDelivered = false;
    let deliveredCompletion: RunPanelCompletion | null = null;
    const deliverCompletion = (runResult: RunResult | null): void => {
      if (completionDelivered) return;
      const compileResult = completedCompile;
      if (compileResult === null) return;
      completionDelivered = true;
      try {
        deliveredCompletion = Object.freeze({
          source,
          sourceFingerprint: fingerprintSource(source),
          compileResult,
          runResult,
          capabilities: runCapabilities,
          scenario,
        });
        options.onRunComplete?.(deliveredCompletion);
      } catch {
        // Evidence consumers are isolated from the compile/run interaction.
      }
    };

    try {
      const compileResult = await window.panelApi.compile({
        source,
        sourceName: toRunnerSourceName(displayName),
      });
      completedCompile = compileResult;
      if (!isCurrentRun(requestId)) {
        return null;
      }
      if (!isCurrentSource(source)) {
        finishStale(requestId);
        return null;
      }
      setOutput(diagnosticsHeading, diagnostics, compileResult.diagnostics);
      compileDurationEvidence = compileResult.compileDurationMs;
      renderProcessDetails();
      setProcessEvidenceVisible(true);
      if (!compileResult.ok) {
        deliverCompletion(null);
        finishFailure(
          requestId,
          bilingual(
            `本次运行失败：编译未通过（${compileResult.error.code}：${compileResult.error.message}）`,
            `Run failed: compilation did not pass (${compileResult.error.code}: ${compileResult.error.message})`,
          ),
          "compile-failed",
        );
        return deliveredCompletion;
      }

      setBothMessages("编译完成，正在运行…", "Compilation complete; running…");
      const runResult = await window.panelApi.run({
        artifactId: compileResult.artifactId,
        ...(scenario === null
          ? {}
          : {
              args: scenario.arguments,
              stdin: scenario.stdin,
            }),
      });
      if (!isCurrentRun(requestId)) {
        return null;
      }
      if (!isCurrentSource(source)) {
        finishStale(requestId);
        return null;
      }

      setOutput(stdoutHeading, stdout, decodeOutput(runResult.stdout));
      setOutput(stderrHeading, stderr, decodeOutput(runResult.stderr));
      exitValue.textContent = runResult.exitCode === null ? "—" : String(runResult.exitCode);
      signalValue.textContent = runResult.signal ?? "—";
      runEvidence = runResult;
      renderProcessDetails();
      setProcessEvidenceVisible(true);
      deliverCompletion(runResult);

      if (runResult.ok) {
        root.dataset.state = "success";
        setOperationMessage("本次运行成功。", "Run completed successfully.");
        setResultMessage("本次运行成功", "Run completed successfully");
      } else {
        const reason = runResult.error
          ? `${runResult.error.code}：${runResult.error.message}`
          : "程序返回了非成功状态";
        const reasonEn = runResult.error
          ? `${runResult.error.code}: ${runResult.error.message}`
          : "The program returned a non-success status";
        finishFailure(
          requestId,
          bilingual(`本次运行失败：${reason}`, `Run failed: ${reasonEn}`),
          "run-failed",
        );
      }
      return deliveredCompletion;
    } catch {
      if (isCurrentSource(source)) {
        deliverCompletion(null);
        finishFailure(
          requestId,
          bilingual(
            "本次运行失败：无法完成本地运行器 IPC 调用。",
            "Run failed: the local runner IPC call could not be completed.",
          ),
          "ipc-failed",
        );
      } else {
        finishStale(requestId);
      }
      return deliveredCompletion;
    } finally {
      finishRun(requestId);
    }
  }

  async function diagnoseSource(includeMemory: boolean): Promise<void> {
    if (destroyed || busy || capabilities?.runnerEnabled !== true) return;
    if (includeMemory && capabilities.memoryDiagnostics.available !== true) return;
    if (advancedDisclosure !== null) advancedDisclosure.open = true;
    busy = true;
    const requestId = runRequestId + 1;
    runRequestId = requestId;
    root.dataset.state = "running";
    delete root.dataset.failureReason;
    if (includeMemory) {
      setBothMessages(
        "正在运行静态与双闸内存诊断…",
        "Running static and two-gate memory diagnostics…",
      );
    } else {
      setBothMessages("正在运行 clang 静态诊断…", "Running clang static diagnostics…");
    }
    result.hidden = false;
    setProcessEvidenceVisible(false);
    setOutput(diagnosticsHeading, diagnostics, "");
    setOutput(stdoutHeading, stdout, "");
    setOutput(stderrHeading, stderr, "");
    setOutput(sanitizerHeading, sanitizer, "");
    setOutput(leaksHeading, leaks, "");
    updateRunButton();

    let source: string;
    let displayName: string;
    try {
      source = options.getSource();
      displayName = options.getDisplayName();
      if (typeof source !== "string" || typeof displayName !== "string") {
        throw new TypeError("source callbacks must return strings");
      }
    } catch {
      finishFailure(
        requestId,
        bilingual("诊断失败：无法取得当前源码。", "Diagnostics failed: source is unavailable."),
        "source-unavailable",
      );
      finishRun(requestId);
      return;
    }

    try {
      const diagnoseResult = await window.panelApi.diagnose({
        source,
        sourceName: toRunnerSourceName(displayName),
        ...(includeMemory ? { runtime: {} } : {}),
      });
      if (!isCurrentRun(requestId)) return;
      if (!isCurrentSource(source)) {
        finishStale(requestId);
        return;
      }
      setOutput(diagnosticsHeading, diagnostics, diagnoseResult.rawDiagnostics);
      if (!diagnoseResult.ok) {
        options.onDiagnostics?.(source, Object.freeze([]));
        finishFailure(
          requestId,
          bilingual(
            `诊断失败：${diagnoseResult.error.code}：${diagnoseResult.error.message}`,
            `Diagnostics failed: ${diagnoseResult.error.code}: ${diagnoseResult.error.message}`,
          ),
          "diagnose-failed",
        );
        return;
      }
      options.onDiagnostics?.(source, diagnoseResult.diagnostics);
      const memory = diagnoseResult.memory;
      if (memory?.status === "completed") {
        setOutput(sanitizerHeading, sanitizer, memory.sanitizer.summary);
        setOutput(leaksHeading, leaks, memory.leaks.summary);
      }
      const findingCount = diagnoseResult.diagnostics.filter(
        (entry) => entry.severity !== "note",
      ).length;
      const memoryFinding =
        memory?.status === "completed" &&
        (memory.sanitizer.verdict !== "clean" || memory.leaks.verdict !== "clean");
      const staticErrors = diagnoseResult.hasErrors;
      if (staticErrors || memoryFinding) {
        root.dataset.state = "finding";
        if (staticErrors) {
          setOperationMessage(
            includeMemory
              ? `静态诊断完成：发现 ${String(findingCount)} 条问题；内存运行已跳过。`
              : `静态诊断完成：发现 ${String(findingCount)} 条问题。`,
            includeMemory
              ? `Static diagnostics found ${String(findingCount)} issues; the memory run was skipped.`
              : `Static diagnostics found ${String(findingCount)} issues.`,
          );
        } else {
          setOperationMessage(
            "完整诊断完成：内存风险面板发现需要检查的结果。",
            "Full diagnostics complete; the memory panel found results that need review.",
          );
        }
      } else {
        root.dataset.state = "success";
        setOperationMessage(
          includeMemory
            ? `完整诊断完成：${String(findingCount)} 条 clang 提示，双闸未报告内存问题。`
            : `静态诊断完成：${String(findingCount)} 条提示。`,
          includeMemory
            ? `Full diagnostics complete: ${String(findingCount)} clang findings and no memory issue from either gate.`
            : `Static diagnostics complete: ${String(findingCount)} findings.`,
        );
      }
      resultMessage = operationMessage;
      renderMessages();
    } catch {
      if (isCurrentSource(source)) {
        finishFailure(
          requestId,
          bilingual(
            "诊断失败：无法完成本地运行器 IPC 调用。",
            "Diagnostics failed: the local runner IPC call could not be completed.",
          ),
          "ipc-failed",
        );
      } else {
        finishStale(requestId);
      }
    } finally {
      finishRun(requestId);
    }
  }

  function isCurrentRun(requestId: number): boolean {
    return !destroyed && requestId === runRequestId;
  }

  function isCurrentSource(expectedSource: string): boolean {
    if (destroyed) return false;
    try {
      return options.getSource() === expectedSource;
    } catch {
      return false;
    }
  }

  function finishStale(requestId: number): void {
    if (!isCurrentRun(requestId)) return;
    root.dataset.state = capabilities?.runnerEnabled === true ? "ready" : "disabled";
    delete root.dataset.failureReason;
    setBothMessages(
      "源码已改变；旧运行或诊断结果已丢弃。",
      "Source changed; stale run or diagnostic results were discarded.",
    );
    result.hidden = true;
  }

  function finishFailure(requestId: number, message: BilingualText, reason: string): void {
    if (!isCurrentRun(requestId)) {
      return;
    }
    root.dataset.state = "failure";
    root.dataset.failureReason = reason;
    result.hidden = false;
    operationMessage = message;
    resultMessage = message;
    renderMessages();
  }

  function finishRun(requestId: number): void {
    if (!isCurrentRun(requestId)) {
      return;
    }
    busy = false;
    updateRunButton();
  }

  function resetProcessDetails(): void {
    compileDurationEvidence = null;
    runEvidence = null;
    renderProcessDetails();
  }

  function renderProcessDetails(): void {
    const dash = "—";
    compileDurationValue.textContent =
      compileDurationEvidence === null
        ? dash
        : formatCompileDurationEvidence(compileDurationEvidence, locale);
    if (runEvidence === null) {
      exitValue.textContent = dash;
      signalValue.textContent = dash;
      terminationValue.textContent = dash;
      durationValue.textContent = dash;
      peakRssValue.textContent = dash;
      peakProcessValue.textContent = dash;
      outputBytesValue.textContent = dash;
      executedNodesValue.textContent = dash;
      operationCountValue.textContent = dash;
      return;
    }
    exitValue.textContent = runEvidence.exitCode === null ? dash : String(runEvidence.exitCode);
    signalValue.textContent = runEvidence.signal ?? dash;
    terminationValue.textContent = terminationLabel(runEvidence.termination, locale);
    const evidence = formatRunEvidence(runEvidence, locale);
    durationValue.textContent = evidence.runDuration;
    peakRssValue.textContent = evidence.peakRss;
    peakProcessValue.textContent = evidence.peakProcessCount;
    outputBytesValue.textContent = evidence.outputBytes;
    executedNodesValue.textContent = evidence.executedNodeCount;
    operationCountValue.textContent = evidence.operationCount;
  }

  function setProcessEvidenceVisible(visible: boolean): void {
    processList.hidden = !visible;
    evidenceNotice.hidden = !visible;
  }

  function renderCapabilityPlaceholders(): void {
    if (capabilityFailed) {
      modeValue.textContent = localized(locale, "无法获取", "Unavailable");
      isolationValue.textContent = localized(locale, "无法确认", "Unknown");
      memoryCapabilityValue.textContent = localized(locale, "无法确认", "Unknown");
      trustValue.textContent = localized(locale, "无法确认", "Unknown");
      return;
    }
    const checking = localized(locale, "正在检查", "Checking");
    modeValue.textContent = checking;
    isolationValue.textContent = checking;
    memoryCapabilityValue.textContent = checking;
    trustValue.textContent = checking;
  }

  function renderLocale(): void {
    safetyNotice.textContent = localized(
      locale,
      "仅运行你编写或逐行审阅过的代码。可信执行没有文件或网络隔离。",
      "Run only code you wrote or reviewed line by line. Trusted execution has no file or network isolation.",
    );
    runButton.textContent = localized(locale, "直接执行当前代码", "Run current code");
    runButton.setAttribute("aria-label", runButton.textContent);
    diagnoseButton.textContent = localized(locale, "静态诊断", "Static diagnostics");
    diagnoseButton.setAttribute("aria-label", diagnoseButton.textContent);
    memoryButton.textContent = localized(locale, "完整内存诊断", "Full memory diagnostics");
    memoryButton.setAttribute("aria-label", memoryButton.textContent);
    toolSummary.textContent = localized(locale, "手动运行与诊断", "Manual run and diagnostics");
    capabilitySummary.textContent = localized(locale, "运行环境", "Run environment");
    modeRow.label.textContent = localized(locale, "安全模式", "Safety mode");
    isolationRow.label.textContent = localized(locale, "执行隔离", "Execution isolation");
    memoryCapabilityRow.label.textContent = localized(
      locale,
      "完整内存诊断",
      "Full memory diagnostics",
    );
    trustRow.label.textContent = localized(locale, "可信确认", "Trust confirmation");
    resultHeading.textContent = localized(locale, "结果", "Result");
    diagnosticsHeading.textContent = localized(locale, "编译诊断", "Compiler diagnostics");
    stdoutHeading.textContent = localized(locale, "标准输出 stdout", "Standard output (stdout)");
    stderrHeading.textContent = localized(locale, "标准错误 stderr", "Standard error (stderr)");
    sanitizerHeading.textContent = "ASan / UBSan";
    leaksHeading.textContent = localized(locale, "独立 leaks", "Standalone leaks");
    evidenceNotice.textContent = localized(
      locale,
      "分项数据来自本次本机受限进程；不代表 Big-O，也不合成为评分。",
      "Metrics come from this local constrained process; they are not Big-O and are not combined into a score.",
    );
    compileDurationRow.label.textContent = localized(locale, "编译进程耗时", "Compile duration");
    exitRow.label.textContent = localized(locale, "退出码", "Exit code");
    signalRow.label.textContent = localized(locale, "信号", "Signal");
    terminationRow.label.textContent = localized(locale, "终止原因", "Termination reason");
    durationRow.label.textContent = localized(locale, "运行墙钟耗时", "Wall-clock runtime");
    peakRssRow.label.textContent = localized(locale, "进程组峰值内存", "Peak process-group memory");
    peakProcessRow.label.textContent = localized(
      locale,
      "进程组峰值数量",
      "Peak process-group size",
    );
    outputBytesRow.label.textContent = localized(locale, "捕获输出量", "Captured output");
    executedNodesRow.label.textContent = localized(locale, "执行节点数", "Executed nodes");
    operationCountRow.label.textContent = localized(locale, "操作计数", "Operation count");
    if (capabilities === undefined) renderCapabilityPlaceholders();
    else renderCapabilities(capabilities);
    renderMessages();
    renderProcessDetails();
  }

  const onLocaleChange = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    locale =
      typeof detail === "object" && detail !== null && "locale" in detail && detail.locale === "en"
        ? "en"
        : localeHost?.dataset.locale === "en"
          ? "en"
          : "zh-CN";
    renderLocale();
  };

  const onRunClick = (): void => {
    void compileAndRun();
  };
  const onDiagnoseClick = (): void => void diagnoseSource(false);
  const onMemoryClick = (): void => void diagnoseSource(true);
  runButton.addEventListener("click", onRunClick);
  diagnoseButton.addEventListener("click", onDiagnoseClick);
  memoryButton.addEventListener("click", onMemoryClick);
  localeHost?.addEventListener("workbench-locale-change", onLocaleChange);
  renderLocale();
  void refreshCapabilities();

  return Object.freeze({
    refreshCapabilities,
    runCurrent: compileAndRun,
    invalidateSource(): void {
      if (destroyed) return;
      result.hidden = true;
      setOutput(diagnosticsHeading, diagnostics, "");
      setOutput(stdoutHeading, stdout, "");
      setOutput(stderrHeading, stderr, "");
      setOutput(sanitizerHeading, sanitizer, "");
      setOutput(leaksHeading, leaks, "");
      setProcessEvidenceVisible(false);
      resetProcessDetails();
      if (busy) {
        setOperationMessage(
          "源码已改变；当前任务结束后将丢弃旧结果。",
          "Source changed; stale results will be discarded when the current task ends.",
        );
      } else {
        root.dataset.state = capabilities?.runnerEnabled === true ? "ready" : "disabled";
        delete root.dataset.failureReason;
        setOperationMessage(
          "源码已改变；旧运行或诊断结果已清除。",
          "Source changed; stale run or diagnostic results were cleared.",
        );
      }
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      capabilityRequestId += 1;
      runRequestId += 1;
      busy = false;
      runButton.removeEventListener("click", onRunClick);
      diagnoseButton.removeEventListener("click", onDiagnoseClick);
      memoryButton.removeEventListener("click", onMemoryClick);
      localeHost?.removeEventListener("workbench-locale-change", onLocaleChange);
      root.remove();
    },
  });
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function appendDescriptionRow(
  list: HTMLDListElement,
  label: string,
  field: string,
): { readonly label: HTMLElement; readonly value: HTMLElement } {
  const row = createElement("div", "run-panel__detail-row");
  const term = createElement("dt", "run-panel__detail-label", label);
  const value = createElement("dd", "run-panel__detail-value");
  value.dataset.runField = field;
  row.append(term, value);
  list.append(row);
  return Object.freeze({ label: term, value });
}

function createOutputBlock(
  field: string,
  heading: HTMLHeadingElement,
  panelId: number,
): HTMLPreElement {
  const block = createElement("pre", "run-panel__output");
  block.dataset.runField = field;
  const headingId = `run-panel-${field}-heading-${panelId}`;
  heading.id = headingId;
  block.setAttribute("aria-labelledby", headingId);
  return block;
}

function setOutput(heading: HTMLHeadingElement, block: HTMLPreElement, text: string): void {
  block.textContent = text;
  const empty = text.length === 0;
  heading.hidden = empty;
  block.hidden = empty;
}

function runnerModeLabel(capabilities: Capabilities, locale: InterfaceLocale): string {
  switch (capabilities.mode) {
    case "seatbelt-best-effort":
      return "Seatbelt best-effort";
    case "trusted-only":
      return localized(
        locale,
        "可信代码模式（无文件与网络隔离）",
        "Trusted-code mode (no file or network isolation)",
      );
    case "disabled":
      return localized(locale, "运行器已禁用", "Runner disabled");
  }
}

function isolationStatusLabel(capabilities: Capabilities, locale: InterfaceLocale): string {
  const probe = capabilities.isolationProbe;
  const kind =
    probe.kind === "macos-seatbelt"
      ? "macOS Seatbelt"
      : probe.kind === "windows-job-object"
        ? "Windows Job Object"
        : localized(locale, "无", "None");
  const detail = probe.detail.trim();
  const suffix = detail.length > 0 ? localized(locale, `：${detail}`, `: ${detail}`) : "";
  switch (probe.status) {
    case "probe-succeeded":
      return `${kind} · ${localized(locale, "可用", "Available")}${suffix}`;
    case "unavailable":
      return `${kind} · ${localized(locale, "不可用", "Unavailable")}${suffix}`;
    case "not-checked":
      return `${kind} · ${localized(locale, "尚未检查", "Not checked")}${suffix}`;
  }
}

function decodeOutput(bytes: Uint8Array): string {
  return outputDecoder.decode(bytes);
}

function terminationLabel(reason: TerminationReason, locale: InterfaceLocale): string {
  const labels: Readonly<Record<InterfaceLocale, Readonly<Record<TerminationReason, string>>>> = {
    "zh-CN": {
      "not-started": "未启动",
      "process-exit": "进程退出",
      "spawn-error": "启动失败",
      "input-error": "标准输入失败",
      "wall-time-limit": "超过墙钟时间限制",
      "output-limit": "超过输出限制",
      "rss-limit": "超过内存限制",
      "process-count-limit": "超过进程数限制",
      "rss-monitor-error": "内存看门狗失败",
    },
    en: {
      "not-started": "Not started",
      "process-exit": "Process exited",
      "spawn-error": "Spawn failed",
      "input-error": "Standard input failed",
      "wall-time-limit": "Wall-clock limit exceeded",
      "output-limit": "Output limit exceeded",
      "rss-limit": "Memory limit exceeded",
      "process-count-limit": "Process-count limit exceeded",
      "rss-monitor-error": "Memory watchdog failed",
    },
  };
  return localized(
    locale,
    `${labels[locale][reason]}（${reason}）`,
    `${labels[locale][reason]} (${reason})`,
  );
}

function formatInstrumentedCount(
  value: number | null | undefined,
  locale: InterfaceLocale,
): string {
  if (value === null) return localized(locale, "未启用轨迹插桩", "Trace instrumentation disabled");
  return isNonNegativeSafeInteger(value)
    ? String(value)
    : localized(locale, "不可用", "Unavailable");
}

interface BilingualText {
  readonly "zh-CN": string;
  readonly en: string;
}

function bilingual(zh: string, en: string): BilingualText {
  return Object.freeze({ "zh-CN": zh, en });
}

function messageForLocale(message: BilingualText, locale: InterfaceLocale): string {
  return message[locale];
}

function localized(locale: InterfaceLocale, zh: string, en: string): string {
  return locale === "en" ? en : zh;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${formatMetricNumber(bytes / 1_024)} KiB`;
  return `${formatMetricNumber(bytes / (1_024 * 1_024))} MiB`;
}

function formatMetricNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function snapshotCapabilities(value: Capabilities): Capabilities {
  return Object.freeze({
    mode: value.mode,
    runnerEnabled: value.runnerEnabled,
    toolchainId: value.toolchainId,
    isolationProbe: Object.freeze({
      kind: value.isolationProbe.kind,
      status: value.isolationProbe.status,
      detail: value.isolationProbe.detail,
    }),
    memoryDiagnostics: Object.freeze({ ...value.memoryDiagnostics }),
    requiresNativeTrustConfirmation: value.requiresNativeTrustConfirmation,
  });
}
