import type { ProgramAnalysisSnapshot } from "../analysis/index.js";
import {
  createBlockIndex,
  createTextPatch,
  renderSourceDoc,
  textRange,
  type CParser,
  type TextPatch,
} from "../core/index.js";
import { createFlowProjection, type FlowProjection } from "../flow/index.js";
import type { PanelApi } from "../shared/api.js";
import { assertValidSourceText } from "../shared/source-import.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import { isTerminalVerifiedRunStatus } from "../shared/verified-run.js";
import {
  assessCCommandDraft,
  type CCommandCompileRequest,
  type CCommandExecutionHooks,
  type CCommandExecutionState,
  type CCommandProjection,
  type CCommandProjectionAssessment,
  type CCommandRuntimeInput,
  type CCommandRunRequest,
} from "./c-command-controller.js";
import { assessParseStability } from "./parse-stability.js";
import {
  createProgramAnalysisWorkerClient,
  type ProgramAnalysisWorkerClient,
} from "./program-analysis-worker-client.js";
import {
  createCCommandSurface,
  type CCommandSurface,
  type CCommandSurfaceOptions,
  type CCommandWriteRequest,
} from "../ui/c-command-surface.js";
import { createCCommandWorkbenchSidebars } from "../ui/c-command-workbench-sidebars.js";
import type { EditConfirmationPlan } from "../ui/edit-panel.js";

const DEFAULT_POLL_INTERVAL_MS = 50;
const SOURCE_NAME = "c-cell.c";

type CCommandApi = Pick<PanelApi, "compile" | "startRun" | "readRun" | "cancelRun">;
type CreateCCommandSurface = (
  host: HTMLElement,
  options: CCommandSurfaceOptions,
) => CCommandSurface;

export type CCommandWriteOutcome =
  "written" | "unchanged" | "cancelled" | "stale" | "invalid" | "apply-failed";

export interface CCommandWorkspaceControllerOptions {
  readonly host: HTMLElement;
  readonly api: CCommandApi;
  readonly parser: CParser;
  readonly nextRevision: () => number;
  readonly previewProjection: (
    projection: FlowProjection,
    analysis: ProgramAnalysisSnapshot,
  ) => void;
  readonly clearProjectionPreview: () => void;
  readonly getMainSource: () => string;
  readonly getRuntimeInput?: (() => CCommandRuntimeInput | null) | undefined;
  readonly confirmWrite: (plan: EditConfirmationPlan) => boolean | Promise<boolean>;
  readonly applyPatches: (patches: readonly TextPatch[]) => boolean;
  readonly onExecutionStateChange?: ((state: CCommandExecutionState) => void) | undefined;
  readonly onWriteOutcome?: ((outcome: CCommandWriteOutcome) => void) | undefined;
  readonly onProjectionError?: ((error: Error) => void) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly worker?: ProgramAnalysisWorkerClient | undefined;
  readonly createSurface?: CreateCCommandSurface | undefined;
}

export interface CCommandWorkspaceController {
  readonly surface: CCommandSurface;
  /** Keeps the latest valid C Cell preview in memory but removes it from the shared Flow panel. */
  setActive(active: boolean): void;
  setWorkspaceEntry(entryId: string | null): void;
  clearPreview(): void;
  restorePreview(): void;
  destroy(): Promise<void>;
}

interface AssessedProjection {
  readonly projection: CCommandProjection;
  readonly revision: number;
  readonly document: ReturnType<CParser["analyze"]>["document"];
  readonly generation: number;
}

interface PreviewSnapshot {
  readonly projection: FlowProjection;
  readonly analysis: ProgramAnalysisSnapshot;
  readonly generation: number;
}

/**
 * Connects the renderer-only C Cell surface to the existing verified runner and
 * source-authoritative Flow/editor boundaries. It owns no project or sidecar data.
 */
export function createCCommandWorkspaceController(
  options: CCommandWorkspaceControllerOptions,
): CCommandWorkspaceController {
  assertOptions(options);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("C Cell pollIntervalMs must be a non-negative safe integer");
  }

  const worker = options.worker ?? createProgramAnalysisWorkerClient();
  const createSurface = options.createSurface ?? createCCommandSurface;
  const now = options.now ?? defaultNow;
  const activeSessions = new Map<string, string>();
  const submissionStartedAt = new Map<string, number>();
  const submissionsWithFirstOutput = new Set<string>();
  const sidebars = createCCommandWorkbenchSidebars(options.host);
  let destroyed = false;
  let active = true;
  let assessmentGeneration = 0;
  let lastAssessed: AssessedProjection | null = null;
  let lastPreview: PreviewSnapshot | null = null;
  let surface: CCommandSurface;

  const assessProjection = (projection: CCommandProjection): CCommandProjectionAssessment => {
    assessmentGeneration += 1;
    const generation = assessmentGeneration;
    try {
      const revision = options.nextRevision();
      const analysis = options.parser.analyze(projection.source, revision);
      if (renderSourceDoc(analysis.document) !== projection.source) {
        throw new Error("C Cell projection failed exact source roundtrip");
      }
      const stability = assessParseStability(analysis.document.parse, projection.source.length);
      if (analysis.document.parse.hasError) {
        lastAssessed = null;
        const draftAssessment = assessCCommandDraft(projection.input);
        return Object.freeze({
          status: draftAssessment.status === "incomplete" ? "incomplete" : "invalid",
          errorCoverageRatio: stability.affectedRatio,
        });
      }
      lastAssessed = Object.freeze({
        projection,
        revision,
        document: analysis.document,
        generation,
      });
      return Object.freeze({ status: "valid", errorCoverageRatio: stability.affectedRatio });
    } catch (error) {
      lastAssessed = null;
      options.onProjectionError?.(asError(error));
      return Object.freeze({ status: "invalid", errorCoverageRatio: 1 });
    }
  };

  const publishProjection = (projection: CCommandProjection | null): void => {
    if (destroyed || projection === null) return;
    const assessed =
      lastAssessed?.projection.source === projection.source
        ? lastAssessed
        : assessAndReadValidProjection(projection);
    if (assessed === null) return;
    const { generation, revision, document } = assessed;
    const projectedBlockCount = createBlockIndex(document).entries.length;
    worker.analyze(projection.source, revision, projectedBlockCount, {
      onSnapshot(analysis) {
        if (
          destroyed ||
          generation !== assessmentGeneration ||
          analysis.revision !== revision ||
          analysis.sourceFingerprint !== fingerprintSource(projection.source)
        ) {
          return;
        }
        try {
          const flow = createFlowProjection(analysis, document);
          lastPreview = Object.freeze({ projection: flow, analysis, generation });
          if (active) options.previewProjection(flow, analysis);
        } catch (error) {
          options.onProjectionError?.(asError(error));
        }
      },
      onError(error) {
        if (!destroyed && generation === assessmentGeneration) {
          options.onProjectionError?.(error);
        }
      },
    });
  };

  const assessAndReadValidProjection = (
    projection: CCommandProjection,
  ): AssessedProjection | null => {
    const assessment = assessProjection(projection);
    return assessment.status === "valid" ? lastAssessed : null;
  };

  const writeSource = async (request: CCommandWriteRequest): Promise<void> => {
    const outcome = await writeProjectionToMain(options, request);
    options.onWriteOutcome?.(outcome);
  };

  const executionHooks: CCommandExecutionHooks = Object.freeze({
    async compile(request: CCommandCompileRequest) {
      if (request.signal.aborted) {
        return cancelledCompileResult();
      }
      const result = await options.api.compile({
        source: request.source,
        sourceName: request.sourceName,
      });
      if (request.signal.aborted) {
        return cancelledCompileResult();
      }
      return result.ok
        ? Object.freeze({
            ok: true,
            artifactId: result.artifactId,
            diagnostics: result.diagnostics,
            durationMs: result.compileDurationMs,
          })
        : Object.freeze({
            ok: false,
            diagnostics: result.diagnostics,
            durationMs: result.compileDurationMs,
            error: result.error,
          });
    },
    async run(request: CCommandRunRequest) {
      return runVerifiedSession(options.api, request, activeSessions, pollIntervalMs);
    },
    async cancel(submissionId: string) {
      const sessionId = activeSessions.get(submissionId);
      if (sessionId === undefined) return;
      activeSessions.delete(submissionId);
      await options.api.cancelRun(sessionId);
    },
  });

  const onExecutionStateChange = (state: CCommandExecutionState): void => {
    if (state.phase === "compiling") {
      submissionStartedAt.set(state.submissionId, now());
      submissionsWithFirstOutput.delete(state.submissionId);
      delete surface.element.dataset.firstOutputMs;
      delete surface.element.dataset.firstResultMs;
    }
    const startedAt = submissionStartedAt.get(state.submissionId);
    if (
      startedAt !== undefined &&
      !submissionsWithFirstOutput.has(state.submissionId) &&
      state.phase === "running" &&
      (state.liveOutput.stdout.length > 0 || state.liveOutput.stderr.length > 0)
    ) {
      submissionsWithFirstOutput.add(state.submissionId);
      surface.element.dataset.firstOutputMs = String(Math.max(0, Math.round(now() - startedAt)));
    }
    if (startedAt !== undefined && isMeasuredTerminalState(state)) {
      surface.element.dataset.firstResultMs = String(Math.max(0, Math.round(now() - startedAt)));
    }
    if (isTerminalExecutionState(state)) {
      submissionStartedAt.delete(state.submissionId);
      submissionsWithFirstOutput.delete(state.submissionId);
    }
    sidebars.record(state);
    options.onExecutionStateChange?.(state);
  };

  surface = createSurface(options.host, {
    hooks: executionHooks,
    sourceName: SOURCE_NAME,
    getRuntimeInput: () => sidebars.getSelectedRunInput() ?? options.getRuntimeInput?.() ?? null,
    assessProjection,
    onProjectionChange: publishProjection,
    onRequestWriteSource: writeSource,
    onExecutionStateChange,
  });
  const localeHost =
    typeof options.host.closest === "function"
      ? options.host.closest<HTMLElement>("[data-locale]")
      : null;
  const syncLocale = (): void => {
    surface.setLocale(localeHost?.dataset.locale === "en" ? "en" : "zh-CN");
  };
  localeHost?.addEventListener("workbench-locale-change", syncLocale);
  syncLocale();

  const setActive = (nextActive: boolean): void => {
    if (destroyed || active === nextActive) return;
    active = nextActive;
    if (!active) {
      options.clearProjectionPreview();
      return;
    }
    const preview = lastPreview;
    if (preview !== null) {
      options.previewProjection(preview.projection, preview.analysis);
    }
  };
  const onCommandViewChange = (event: Event): void => {
    const viewId = (event as CustomEvent<{ readonly viewId?: unknown }>).detail?.viewId;
    if (viewId === "command" || viewId === "source") setActive(viewId === "command");
  };
  const setWorkspaceEntry = (entryId: string | null): void => {
    if (destroyed) return;
    sidebars.setWorkspaceEntry(entryId);
    assessmentGeneration += 1;
    lastAssessed = null;
    lastPreview = null;
    if (active) options.clearProjectionPreview();
    // Results belong to the entry that produced them. Without this, opening a tutorial after your
    // own file leaves the previous file's result card on screen — diagnostics, output and timings
    // all describing a program that is no longer open. setValue("") alone cannot do it: the editor
    // returns early when the text is unchanged (c-command-editor.ts:112), and after a submission
    // the composer is already empty, so the stale red 请输入 C 代码后再运行 survived too.
    surface.clearTranscript();
    surface.setValue("");
    // Opening a workspace entry puts the caret in the prompt, the way opening a terminal
    // tab does. The surface claims focus on its first layout box, but the entry-open flow
    // tears down its dialog afterwards and that drops focus back to the document.
    if (active) surface.focus();
  };
  localeHost?.addEventListener("workbench-command-view-change", onCommandViewChange);
  setActive(localeHost?.dataset.commandView !== "source");

  return Object.freeze({
    surface,
    setActive,
    setWorkspaceEntry,
    clearPreview(): void {
      setActive(false);
    },
    restorePreview(): void {
      setActive(true);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      assessmentGeneration += 1;
      localeHost?.removeEventListener("workbench-locale-change", syncLocale);
      localeHost?.removeEventListener("workbench-command-view-change", onCommandViewChange);
      await surface.destroy();
      sidebars.destroy();
      for (const sessionId of activeSessions.values()) {
        await options.api.cancelRun(sessionId);
      }
      activeSessions.clear();
      submissionStartedAt.clear();
      submissionsWithFirstOutput.clear();
      worker.destroy();
      if (active) options.clearProjectionPreview();
      lastAssessed = null;
      lastPreview = null;
    },
  });
}

async function runVerifiedSession(
  api: CCommandApi,
  request: CCommandRunRequest,
  activeSessions: Map<string, string>,
  pollIntervalMs: number,
): Promise<{
  readonly ok: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly termination: string;
  readonly durationMs?: number | undefined;
  readonly peakRssBytes?: number | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}> {
  const started = await api.startRun({
    artifactId: request.artifactId,
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    ...(request.fixtures === undefined ? {} : { fixtures: request.fixtures }),
  });
  if (!started.ok) return failedRunResult(started.error);
  const sessionId = started.sessionId;
  activeSessions.set(request.submissionId, sessionId);
  if (request.signal.aborted) {
    await cancelOwnedSession(api, activeSessions, request.submissionId, sessionId);
    return cancelledRunResult();
  }

  let afterSequence = 0;
  try {
    while (true) {
      const batch = await api.readRun(sessionId, afterSequence);
      if (!batch.ok) return failedRunResult(batch.error);
      afterSequence = batch.nextSequence;
      for (const event of batch.events) {
        request.onOutput(event);
      }
      const hasUnreadEvents = batch.nextSequence < batch.totalEventCount;
      if (!hasUnreadEvents && batch.result !== null) {
        return Object.freeze({
          ok: batch.result.ok,
          stdout: batch.result.stdout,
          stderr: batch.result.stderr,
          exitCode: batch.result.exitCode,
          signal: batch.result.signal,
          termination: batch.result.termination,
          durationMs: batch.result.durationMs,
          peakRssBytes: batch.result.peakRssBytes,
        });
      }
      if (!hasUnreadEvents && isTerminalVerifiedRunStatus(batch.status) && batch.error !== null) {
        return failedRunResult(batch.error);
      }
      if (request.signal.aborted) {
        await cancelOwnedSession(api, activeSessions, request.submissionId, sessionId);
        return cancelledRunResult();
      }
      await waitForNextPoll(pollIntervalMs, request.signal);
    }
  } finally {
    activeSessions.delete(request.submissionId);
  }
}

async function cancelOwnedSession(
  api: CCommandApi,
  activeSessions: Map<string, string>,
  submissionId: string,
  sessionId: string,
): Promise<void> {
  if (activeSessions.get(submissionId) !== sessionId) return;
  activeSessions.delete(submissionId);
  await api.cancelRun(sessionId);
}

async function writeProjectionToMain(
  options: CCommandWorkspaceControllerOptions,
  request: CCommandWriteRequest,
): Promise<CCommandWriteOutcome> {
  try {
    assertValidSourceText(request.source);
    const analysis = options.parser.analyze(request.source, options.nextRevision());
    if (analysis.document.parse.hasError || renderSourceDoc(analysis.document) !== request.source) {
      return "invalid";
    }
    const before = options.getMainSource();
    if (before === request.source) return "unchanged";
    const plan: EditConfirmationPlan = Object.freeze({
      diffs: Object.freeze([
        Object.freeze({
          beforeRange: Object.freeze({ from: 0, to: before.length }),
          afterRange: Object.freeze({ from: 0, to: request.source.length }),
          beforeText: before,
          afterText: request.source,
        }),
      ]),
    });
    if (!(await options.confirmWrite(plan))) return "cancelled";
    if (options.getMainSource() !== before) return "stale";
    const patch = createTextPatch(textRange(0, before.length), request.source);
    return options.applyPatches(Object.freeze([patch])) ? "written" : "apply-failed";
  } catch {
    return "invalid";
  }
}

function cancelledCompileResult(): {
  readonly ok: false;
  readonly diagnostics: "";
  readonly error: { readonly code: "CANCELLED"; readonly message: "Cancelled." };
} {
  return Object.freeze({
    ok: false,
    diagnostics: "",
    error: Object.freeze({ code: "CANCELLED", message: "Cancelled." }),
  });
}

function failedRunResult(error: { readonly code: string; readonly message: string }) {
  return Object.freeze({
    ok: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    exitCode: null,
    signal: null,
    termination: "not-started",
    error,
  });
}

function cancelledRunResult() {
  return Object.freeze({
    ok: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    exitCode: null,
    signal: null,
    termination: "not-started",
    error: Object.freeze({ code: "CANCELLED", message: "Cancelled." }),
  });
}

function waitForNextPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (intervalMs === 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isMeasuredTerminalState(state: CCommandExecutionState): boolean {
  return (
    state.phase === "succeeded" || state.phase === "compile-failed" || state.phase === "run-failed"
  );
}

function isTerminalExecutionState(state: CCommandExecutionState): boolean {
  return (
    isMeasuredTerminalState(state) ||
    state.phase === "cancelled" ||
    state.phase === "internal-error"
  );
}

function defaultNow(): number {
  return typeof performance === "object" ? performance.now() : Date.now();
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function assertOptions(options: CCommandWorkspaceControllerOptions): void {
  for (const callback of [
    options.nextRevision,
    options.previewProjection,
    options.clearProjectionPreview,
    options.getMainSource,
    options.confirmWrite,
    options.applyPatches,
  ]) {
    if (typeof callback !== "function") {
      throw new TypeError("C Cell workspace controller options are invalid");
    }
  }
}
