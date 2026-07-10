import type { Capabilities, TerminationReason } from "../shared/api.js";

const RUNNER_SOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.c$/u;
const MAX_RUNNER_SOURCE_NAME_LENGTH = 128;
const SOURCE_EXTENSION_LENGTH = 2;
const outputDecoder = new TextDecoder("utf-8", { fatal: false });

let nextRunPanelId = 1;

export interface RunPanelOptions {
  readonly getSource: () => string;
  readonly getDisplayName: () => string;
}

export interface RunPanel {
  refreshCapabilities(): Promise<void>;
  destroy(): void;
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

export function createRunPanel(host: HTMLElement, options: RunPanelOptions): RunPanel {
  const panelId = nextRunPanelId;
  nextRunPanelId += 1;

  const root = createElement("div", "run-panel");
  root.dataset.state = "loading";

  const safetyNotice = createElement(
    "p",
    "run-panel__safety-notice",
    "仅运行你编写或逐行审阅过的代码。可信模式没有 Seatbelt 文件或网络隔离。",
  );
  const runButton = createElement("button", "run-panel__run-button", "编译并运行");
  runButton.type = "button";
  runButton.disabled = true;
  const operationStatus = createElement(
    "output",
    "run-panel__operation-status",
    "正在检查本地运行能力…",
  );
  operationStatus.setAttribute("aria-live", "polite");
  const action = createElement("div", "run-panel__action");
  action.append(runButton, operationStatus);

  const capabilityDetails = createElement("details", "run-panel__capability-details");
  const capabilitySummary = createElement("summary", "run-panel__capability-summary", "运行环境");
  const capabilityList = createElement("dl", "run-panel__capabilities");
  const modeValue = appendDescriptionRow(capabilityList, "安全模式", "mode");
  const seatbeltValue = appendDescriptionRow(capabilityList, "Seatbelt", "seatbelt");
  const trustValue = appendDescriptionRow(capabilityList, "可信确认", "trust-confirmation");
  modeValue.textContent = "正在检查";
  seatbeltValue.textContent = "正在检查";
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

  const processList = createElement("dl", "run-panel__process-result");
  processList.hidden = true;
  const exitValue = appendDescriptionRow(processList, "退出码", "exit-code");
  const signalValue = appendDescriptionRow(processList, "信号", "signal");
  const terminationValue = appendDescriptionRow(processList, "终止原因", "termination");
  const durationValue = appendDescriptionRow(processList, "耗时", "duration");
  resetProcessDetails();
  setOutput(diagnosticsHeading, diagnostics, "");
  setOutput(stdoutHeading, stdout, "");
  setOutput(stderrHeading, stderr, "");

  result.append(
    resultHeading,
    resultStatus,
    diagnosticsHeading,
    diagnostics,
    stdoutHeading,
    stdout,
    stderrHeading,
    stderr,
    processList,
  );
  root.append(safetyNotice, action, capabilityDetails, result);
  host.append(root);

  let destroyed = false;
  let busy = false;
  let capabilities: Capabilities | undefined;
  let capabilityRequestId = 0;
  let runRequestId = 0;

  function updateRunButton(): void {
    runButton.disabled = destroyed || busy || capabilities?.runnerEnabled !== true;
  }

  function renderAvailability(): void {
    if (busy || destroyed) {
      return;
    }
    delete root.dataset.failureReason;
    if (capabilities?.runnerEnabled === true) {
      root.dataset.state = "ready";
      operationStatus.textContent = "本地运行器可用。";
      return;
    }
    root.dataset.state = "disabled";
    operationStatus.textContent = "运行器当前不可用；其他学习功能不受影响。";
  }

  function renderCapabilities(snapshot: Capabilities): void {
    modeValue.textContent = runnerModeLabel(snapshot);
    seatbeltValue.textContent = seatbeltStatusLabel(snapshot);
    trustValue.textContent = snapshot.requiresNativeTrustConfirmation
      ? "需要，每次编译和运行分别由原生确认框授权"
      : "当前模式不需要原生可信确认";
  }

  async function refreshCapabilities(): Promise<void> {
    if (destroyed) {
      return;
    }
    const requestId = capabilityRequestId + 1;
    capabilityRequestId = requestId;
    if (!busy) {
      root.dataset.state = "loading";
      operationStatus.textContent = "正在检查本地运行能力…";
    }
    capabilities = undefined;
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
      modeValue.textContent = "无法获取";
      seatbeltValue.textContent = "无法确认";
      trustValue.textContent = "无法确认";
      updateRunButton();
      if (!busy) {
        root.dataset.state = "error";
        operationStatus.textContent = "无法连接本地运行器；编译与运行已停用。";
      }
    }
  }

  async function compileAndRun(): Promise<void> {
    if (destroyed || busy || capabilities?.runnerEnabled !== true) {
      return;
    }

    busy = true;
    const requestId = runRequestId + 1;
    runRequestId = requestId;
    root.dataset.state = "running";
    delete root.dataset.failureReason;
    operationStatus.textContent = "正在编译…";
    resultStatus.textContent = "正在编译…";
    result.hidden = false;
    setOutput(diagnosticsHeading, diagnostics, "");
    setOutput(stdoutHeading, stdout, "");
    setOutput(stderrHeading, stderr, "");
    processList.hidden = true;
    resetProcessDetails();
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
        "本次运行失败：无法取得当前源码，未启动编译。",
        "source-unavailable",
      );
      finishRun(requestId);
      return;
    }

    try {
      const compileResult = await window.panelApi.compile({
        source,
        sourceName: toRunnerSourceName(displayName),
      });
      if (!isCurrentRun(requestId)) {
        return;
      }
      setOutput(diagnosticsHeading, diagnostics, compileResult.diagnostics);
      if (!compileResult.ok) {
        finishFailure(
          requestId,
          `本次运行失败：编译未通过（${compileResult.error.code}：${compileResult.error.message}）`,
          "compile-failed",
        );
        return;
      }

      operationStatus.textContent = "编译完成，正在运行…";
      resultStatus.textContent = "编译完成，正在运行…";
      const runResult = await window.panelApi.run({ artifactId: compileResult.artifactId });
      if (!isCurrentRun(requestId)) {
        return;
      }

      setOutput(stdoutHeading, stdout, decodeOutput(runResult.stdout));
      setOutput(stderrHeading, stderr, decodeOutput(runResult.stderr));
      exitValue.textContent = runResult.exitCode === null ? "—" : String(runResult.exitCode);
      signalValue.textContent = runResult.signal ?? "—";
      terminationValue.textContent = terminationLabel(runResult.termination);
      durationValue.textContent = `${runResult.durationMs} ms`;
      processList.hidden = false;

      if (runResult.ok) {
        root.dataset.state = "success";
        operationStatus.textContent = "本次运行成功。";
        resultStatus.textContent = "本次运行成功";
      } else {
        const reason = runResult.error
          ? `${runResult.error.code}：${runResult.error.message}`
          : "程序返回了非成功状态";
        finishFailure(requestId, `本次运行失败：${reason}`, "run-failed");
      }
    } catch {
      finishFailure(requestId, "本次运行失败：无法完成本地运行器 IPC 调用。", "ipc-failed");
    } finally {
      finishRun(requestId);
    }
  }

  function isCurrentRun(requestId: number): boolean {
    return !destroyed && requestId === runRequestId;
  }

  function finishFailure(requestId: number, message: string, reason: string): void {
    if (!isCurrentRun(requestId)) {
      return;
    }
    root.dataset.state = "failure";
    root.dataset.failureReason = reason;
    result.hidden = false;
    operationStatus.textContent = message;
    resultStatus.textContent = message;
  }

  function finishRun(requestId: number): void {
    if (!isCurrentRun(requestId)) {
      return;
    }
    busy = false;
    updateRunButton();
  }

  function resetProcessDetails(): void {
    exitValue.textContent = "—";
    signalValue.textContent = "—";
    terminationValue.textContent = "—";
    durationValue.textContent = "—";
  }

  const onRunClick = (): void => {
    void compileAndRun();
  };
  runButton.addEventListener("click", onRunClick);
  void refreshCapabilities();

  return Object.freeze({
    refreshCapabilities,
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      capabilityRequestId += 1;
      runRequestId += 1;
      busy = false;
      runButton.removeEventListener("click", onRunClick);
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

function appendDescriptionRow(list: HTMLDListElement, label: string, field: string): HTMLElement {
  const row = createElement("div", "run-panel__detail-row");
  const term = createElement("dt", "run-panel__detail-label", label);
  const value = createElement("dd", "run-panel__detail-value");
  value.dataset.runField = field;
  row.append(term, value);
  list.append(row);
  return value;
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

function runnerModeLabel(capabilities: Capabilities): string {
  switch (capabilities.mode) {
    case "seatbelt-best-effort":
      return "Seatbelt best-effort";
    case "trusted-only":
      return "可信代码模式（无 Seatbelt 文件与网络隔离）";
    case "disabled":
      return "运行器已禁用";
  }
}

function seatbeltStatusLabel(capabilities: Capabilities): string {
  const detail = capabilities.seatbeltProbe.detail.trim();
  const suffix = detail.length > 0 ? `：${detail}` : "";
  switch (capabilities.seatbeltProbe.status) {
    case "probe-succeeded":
      return `可用${suffix}`;
    case "unavailable":
      return `不可用${suffix}`;
    case "not-checked":
      return `尚未检查${suffix}`;
  }
}

function decodeOutput(bytes: Uint8Array): string {
  return outputDecoder.decode(bytes);
}

function terminationLabel(reason: TerminationReason): string {
  const labels: Readonly<Record<TerminationReason, string>> = {
    "not-started": "未启动",
    "process-exit": "进程退出",
    "spawn-error": "启动失败",
    "input-error": "标准输入失败",
    "wall-time-limit": "超过墙钟时间限制",
    "output-limit": "超过输出限制",
    "rss-limit": "超过内存限制",
    "process-count-limit": "超过进程数限制",
    "rss-monitor-error": "内存看门狗失败",
  };
  return `${labels[reason]}（${reason}）`;
}
