import {
  mapCCommandDiagnostics,
  type CCommandExecutionState,
  type CCommandLiveOutput,
  type CCommandRunResult,
} from "../app/c-command-controller.js";
import type { CCommandCopy } from "./c-command-copy.js";

const outputDecoder = new TextDecoder("utf-8", { fatal: false });

export interface RenderedCCommandSubmission {
  readonly article: HTMLElement & { articleState?: CCommandExecutionState | undefined };
  readonly stateLabel: HTMLElement;
  readonly resultBody: HTMLElement;
  readonly writeButton: HTMLButtonElement;
  readonly editButton: HTMLButtonElement;
  readonly clearButton: HTMLButtonElement;
}

export function createCCommandSubmissionArticle(
  ownerDocument: Document,
  state: CCommandExecutionState,
  copy: CCommandCopy,
  onContinueEditing: () => void,
  onWrite: () => void | Promise<void>,
  onClear: () => void,
): RenderedCCommandSubmission {
  const article = ownerDocument.createElement("article") as RenderedCCommandSubmission["article"];
  article.className = "c-command__submission";
  article.dataset.submissionId = state.submissionId;
  const header = ownerDocument.createElement("header");
  header.className = "c-command__submission-header";
  const source = ownerDocument.createElement("pre");
  source.className = "c-command__submitted-source";
  source.textContent = state.projection.input;
  const stateLabel = ownerDocument.createElement("span");
  stateLabel.className = "c-command__state";
  header.append(source, stateLabel);
  const resultBody = ownerDocument.createElement("div");
  resultBody.className = "c-command__result";
  const actions = ownerDocument.createElement("div");
  actions.className = "c-command__actions";
  const editButton = textButton(ownerDocument, copy.continueEditing, onContinueEditing);
  editButton.dataset.commandAction = "continue-editing";
  const writeButton = textButton(ownerDocument, copy.writeToMain, () => void onWrite());
  writeButton.dataset.commandAction = "write-main";
  const clearButton = textButton(ownerDocument, copy.clearResult, onClear);
  clearButton.dataset.commandAction = "clear-result";
  actions.append(editButton, writeButton, clearButton);
  article.append(header, resultBody, actions);
  return { article, stateLabel, resultBody, writeButton, editButton, clearButton };
}

export function updateCCommandSubmissionArticle(
  rendered: RenderedCCommandSubmission,
  state: CCommandExecutionState,
  copy: CCommandCopy,
): void {
  rendered.article.articleState = state;
  rendered.article.dataset.state = state.phase;
  rendered.stateLabel.textContent = phaseLabel(state.phase, copy);
  rendered.writeButton.disabled = state.phase === "compiling" || state.phase === "running";
  rendered.writeButton.textContent = copy.writeToMain;
  rendered.editButton.textContent = copy.continueEditing;
  rendered.clearButton.textContent = copy.clearResult;
  rendered.resultBody.replaceChildren();

  if (state.phase === "compiling" || state.phase === "running") {
    const progress = rendered.resultBody.ownerDocument.createElement("p");
    progress.className = "c-command__progress";
    progress.textContent = phaseLabel(state.phase, copy);
    rendered.resultBody.append(progress);
    if (state.phase === "running") {
      appendLiveOutput(rendered.resultBody, state.liveOutput, copy);
    }
    return;
  }

  if (state.projection.wrapperMapping.generated) {
    const wrapper = rendered.resultBody.ownerDocument.createElement("details");
    wrapper.className = "c-command__wrapper";
    const summary = rendered.resultBody.ownerDocument.createElement("summary");
    summary.textContent = copy.wrapperLabel;
    const note = rendered.resultBody.ownerDocument.createElement("p");
    note.textContent = copy.wrapperHint;
    const source = rendered.resultBody.ownerDocument.createElement("pre");
    source.textContent = state.projection.source;
    wrapper.append(summary, note, source);
    rendered.resultBody.append(wrapper);
  }

  const diagnostics = mapCCommandDiagnostics(
    state.compileResult?.diagnostics.trim() ?? "",
    state.projection,
    {
      inputSource: copy.cellDiagnosticSource,
      generatedWrapperSource: copy.generatedWrapperDiagnosticSource,
    },
  );
  if (diagnostics.length > 0) {
    appendOutput(rendered.resultBody, copy.diagnostics, diagnostics, "diagnostics");
  }
  const publicError = publicRunnerError(state, copy);
  if (publicError !== null) {
    appendOutput(rendered.resultBody, copy.internalError, publicError, "error");
  }
  if (state.runResult !== null) {
    appendRunResult(rendered.resultBody, state.runResult, copy);
  } else {
    appendLiveOutput(rendered.resultBody, state.liveOutput, copy);
  }
}

function publicRunnerError(state: CCommandExecutionState, copy: CCommandCopy): string | null {
  const error = state.runResult?.error ?? state.compileResult?.error ?? null;
  if (error !== null) {
    const message = copy.runnerErrors[error.code] ?? copy.runnerErrors.INTERNAL_ERROR;
    return `${error.code} · ${message ?? copy.internalError}`;
  }
  if (state.phase !== "internal-error" || state.message === null) return null;
  return copy.runnerErrors.INTERNAL_ERROR ?? copy.internalError;
}

function appendLiveOutput(host: HTMLElement, output: CCommandLiveOutput, copy: CCommandCopy): void {
  if (output.stdout.length > 0) appendOutput(host, copy.stdout, output.stdout, "stdout");
  if (output.stderr.length > 0) appendOutput(host, copy.stderr, output.stderr, "stderr");
  if (output.truncated) {
    const notice = host.ownerDocument.createElement("p");
    notice.className = "c-command__output-limit";
    notice.textContent = copy.outputTruncated;
    host.append(notice);
  }
}

function appendRunResult(host: HTMLElement, result: CCommandRunResult, copy: CCommandCopy): void {
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);
  if (stdout.length > 0) appendOutput(host, copy.stdout, stdout, "stdout");
  if (stderr.length > 0) appendOutput(host, copy.stderr, stderr, "stderr");

  const evidence = host.ownerDocument.createElement("dl");
  evidence.className = "c-command__evidence";
  appendEvidence(evidence, copy.exitCode, result.exitCode === null ? "—" : String(result.exitCode));
  appendEvidence(
    evidence,
    copy.runTime,
    finiteNonNegative(result.durationMs)
      ? `${formatNumber(result.durationMs)} ms`
      : copy.unavailable,
  );
  appendEvidence(
    evidence,
    copy.peakMemory,
    Number.isSafeInteger(result.peakRssBytes) && (result.peakRssBytes ?? 0) > 0
      ? formatBytes(result.peakRssBytes ?? 0)
      : copy.unavailable,
  );
  host.append(evidence);
}

function appendOutput(
  host: HTMLElement,
  label: string,
  value: string,
  kind: "stdout" | "stderr" | "diagnostics" | "error",
): void {
  const section = host.ownerDocument.createElement("section");
  section.className = "c-command__output";
  section.dataset.outputKind = kind;
  const heading = host.ownerDocument.createElement("h3");
  heading.textContent = label;
  const output = host.ownerDocument.createElement("pre");
  output.textContent = value;
  section.append(heading, output);
  host.append(section);
}

function appendEvidence(host: HTMLDListElement, label: string, value: string): void {
  const term = host.ownerDocument.createElement("dt");
  term.textContent = label;
  const description = host.ownerDocument.createElement("dd");
  description.textContent = value;
  host.append(term, description);
}

function textButton(ownerDocument: Document, label: string, action: () => void): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function phaseLabel(phase: CCommandExecutionState["phase"], copy: CCommandCopy): string {
  switch (phase) {
    case "compiling":
      return copy.compiling;
    case "running":
      return copy.running;
    case "compile-failed":
      return copy.compileFailed;
    case "run-failed":
      return copy.runFailed;
    case "succeeded":
      return copy.succeeded;
    case "cancelled":
      return copy.cancelled;
    case "internal-error":
      return copy.internalError;
  }
}

function decodeOutput(value: string | Uint8Array): string {
  return typeof value === "string" ? value : outputDecoder.decode(value);
}

function finiteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let amount = value;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index] ?? unit;
  }
  return `${formatNumber(amount)} ${unit}`;
}
