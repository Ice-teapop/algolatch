import { buildCCommandProjection, type CCommandProjection } from "./c-command-source.js";
import type { FixtureInput } from "../shared/api.js";

export {
  assessCCommandDraft,
  buildCCommandProjection,
  canPublishCCommandProjection,
  mapCCommandDiagnostics,
  mapGeneratedLineToCommandInput,
  type CCommandDiagnosticLabels,
  type CCommandInputKind,
  type CCommandProjection,
  type CCommandProjectionAssessment,
  type CCommandWrapperMapping,
} from "./c-command-source.js";

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_LIVE_OUTPUT_BYTES = 1_048_576;
const outputEncoder = new TextEncoder();

export interface CCommandCompileRequest {
  readonly submissionId: string;
  readonly source: string;
  readonly sourceName: string;
  readonly signal: AbortSignal;
}

export interface CCommandCompileResult {
  readonly ok: boolean;
  readonly artifactId?: string | undefined;
  readonly diagnostics: string;
  readonly durationMs?: number | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

export interface CCommandRunRequest {
  readonly submissionId: string;
  readonly artifactId: string;
  readonly args?: readonly string[] | undefined;
  readonly stdin?: string | undefined;
  readonly fixtures?: readonly FixtureInput[] | undefined;
  readonly signal: AbortSignal;
  readonly onOutput: (event: CCommandOutputEvent) => void;
}

export interface CCommandRuntimeInput {
  readonly args?: readonly string[] | undefined;
  readonly stdin?: string | undefined;
  readonly fixtures?: readonly FixtureInput[] | undefined;
}

export type CCommandOutputStream = "stdout" | "stderr";

export interface CCommandOutputEvent {
  readonly stream: CCommandOutputStream;
  readonly data: string | Uint8Array;
}

export interface CCommandLiveOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface CCommandRunResult {
  readonly ok: boolean;
  readonly stdout: string | Uint8Array;
  readonly stderr: string | Uint8Array;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly termination: string;
  readonly durationMs?: number | undefined;
  readonly peakRssBytes?: number | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

export interface CCommandExecutionHooks {
  compile(request: CCommandCompileRequest): Promise<CCommandCompileResult>;
  run(request: CCommandRunRequest): Promise<CCommandRunResult>;
  cancel(submissionId: string): void | Promise<void>;
}

export type CCommandExecutionPhase =
  | "compiling"
  | "running"
  | "compile-failed"
  | "run-failed"
  | "succeeded"
  | "cancelled"
  | "internal-error";

export interface CCommandExecutionState {
  readonly submissionId: string;
  readonly phase: CCommandExecutionPhase;
  readonly projection: CCommandProjection;
  readonly compileResult: CCommandCompileResult | null;
  readonly runResult: CCommandRunResult | null;
  readonly liveOutput: CCommandLiveOutput;
  readonly message: string | null;
}

export interface CCommandControllerOptions {
  readonly hooks: CCommandExecutionHooks;
  readonly getRuntimeInput?: (() => CCommandRuntimeInput | null) | undefined;
  readonly onStateChange?: ((state: CCommandExecutionState) => void) | undefined;
  readonly historyLimit?: number | undefined;
  readonly sourceName?: string | undefined;
}

export interface CCommandController {
  submit(input: string): Promise<CCommandExecutionState | null>;
  cancel(): Promise<boolean>;
  historyPrevious(currentDraft: string): string | null;
  historyNext(): string | null;
  resetHistoryNavigation(): void;
  isRunning(): boolean;
  destroy(): Promise<void>;
}

export function createCCommandController(options: CCommandControllerOptions): CCommandController {
  const historyLimit = normalizeHistoryLimit(options.historyLimit);
  const sourceName = options.sourceName;
  const history: string[] = [];
  let historyCursor = 0;
  let historyDraft = "";
  let destroyed = false;
  let active: {
    readonly submissionId: string;
    readonly abortController: AbortController;
  } | null = null;
  let lastState: CCommandExecutionState | null = null;
  let nextSubmissionId = 1;

  const emit = (state: CCommandExecutionState): CCommandExecutionState => {
    const frozen = freezeExecutionState(state);
    lastState = frozen;
    options.onStateChange?.(frozen);
    return frozen;
  };

  const submit = async (input: string): Promise<CCommandExecutionState | null> => {
    if (destroyed) throw new Error("C Command controller has been destroyed");
    if (active !== null) throw new Error("A C Command submission is already running");
    const projection = buildCCommandProjection(input, sourceName);
    if (projection === null) return null;

    rememberHistory(history, projection.input, historyLimit);
    historyCursor = history.length;
    historyDraft = "";
    const submissionId = `c-command-${String(nextSubmissionId)}`;
    nextSubmissionId += 1;
    const abortController = new AbortController();
    active = Object.freeze({ submissionId, abortController });
    lastState = null;

    let compileResult: CCommandCompileResult | null = null;
    let runResult: CCommandRunResult | null = null;
    let runtimeInput: CCommandRuntimeInput = Object.freeze({});
    let liveOutput = emptyLiveOutput();
    const liveOutputCollector = createLiveOutputCollector((nextOutput) => {
      if (
        abortController.signal.aborted ||
        !isCurrentSubmission(active, submissionId) ||
        lastState?.phase !== "running"
      ) {
        return;
      }
      liveOutput = nextOutput;
      emit({
        submissionId,
        phase: "running",
        projection,
        compileResult,
        runResult,
        liveOutput,
        message: null,
      });
    });
    emit({
      submissionId,
      phase: "compiling",
      projection,
      compileResult,
      runResult,
      liveOutput,
      message: null,
    });

    try {
      runtimeInput = snapshotRuntimeInput(options.getRuntimeInput?.() ?? null);
      compileResult = await options.hooks.compile({
        submissionId,
        source: projection.source,
        sourceName: projection.sourceName,
        signal: abortController.signal,
      });
      if (!isCurrentSubmission(active, submissionId) || abortController.signal.aborted) {
        return cancelledStateOrEmit(
          lastState,
          submissionId,
          projection,
          compileResult,
          runResult,
          liveOutput,
          emit,
        );
      }
      if (!compileResult.ok) {
        active = null;
        return emit({
          submissionId,
          phase: "compile-failed",
          projection,
          compileResult,
          runResult,
          liveOutput,
          message: compileResult.error?.message ?? null,
        });
      }
      if (typeof compileResult.artifactId !== "string" || compileResult.artifactId.length === 0) {
        active = null;
        return emit({
          submissionId,
          phase: "internal-error",
          projection,
          compileResult,
          runResult,
          liveOutput,
          message: "Compiler succeeded without returning an artifact.",
        });
      }

      emit({
        submissionId,
        phase: "running",
        projection,
        compileResult,
        runResult,
        liveOutput,
        message: null,
      });
      runResult = await options.hooks.run({
        submissionId,
        artifactId: compileResult.artifactId,
        ...runtimeInput,
        signal: abortController.signal,
        onOutput: liveOutputCollector.append,
      });
      liveOutput = liveOutputCollector.finish();
      if (!isCurrentSubmission(active, submissionId) || abortController.signal.aborted) {
        return cancelledStateOrEmit(
          lastState,
          submissionId,
          projection,
          compileResult,
          runResult,
          liveOutput,
          emit,
        );
      }
      active = null;
      return emit({
        submissionId,
        phase: runResult.ok ? "succeeded" : "run-failed",
        projection,
        compileResult,
        runResult,
        liveOutput,
        message: runResult.error?.message ?? null,
      });
    } catch (error) {
      if (abortController.signal.aborted || !isCurrentSubmission(active, submissionId)) {
        return cancelledStateOrEmit(
          lastState,
          submissionId,
          projection,
          compileResult,
          runResult,
          liveOutput,
          emit,
        );
      }
      liveOutput = liveOutputCollector.finish();
      active = null;
      return emit({
        submissionId,
        phase: "internal-error",
        projection,
        compileResult,
        runResult,
        liveOutput,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const cancel = async (): Promise<boolean> => {
    const current = active;
    if (current === null) return false;
    active = null;
    current.abortController.abort();
    if (lastState?.submissionId === current.submissionId) {
      emit({
        ...lastState,
        phase: "cancelled",
        message: null,
      });
    }
    await options.hooks.cancel(current.submissionId);
    return true;
  };

  return Object.freeze({
    submit,
    cancel,
    historyPrevious(currentDraft: string): string | null {
      if (history.length === 0) return null;
      if (historyCursor === history.length) historyDraft = currentDraft;
      historyCursor = Math.max(0, historyCursor - 1);
      return history[historyCursor] ?? null;
    },
    historyNext(): string | null {
      if (historyCursor >= history.length) return null;
      historyCursor += 1;
      return historyCursor === history.length ? historyDraft : (history[historyCursor] ?? null);
    },
    resetHistoryNavigation(): void {
      historyCursor = history.length;
      historyDraft = "";
    },
    isRunning(): boolean {
      return active !== null;
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await cancel();
    },
  });
}

function snapshotRuntimeInput(input: CCommandRuntimeInput | null): CCommandRuntimeInput {
  if (input === null) return Object.freeze({});
  if (typeof input !== "object") throw new TypeError("C Cell runtime input must be an object");
  if (
    input.stdin !== undefined &&
    (typeof input.stdin !== "string" || input.stdin.includes("\0"))
  ) {
    throw new TypeError("C Cell stdin must be text without NUL");
  }
  if (
    input.args !== undefined &&
    (!Array.isArray(input.args) ||
      input.args.some((argument) => typeof argument !== "string" || argument.includes("\0")))
  ) {
    throw new TypeError("C Cell arguments must be text without NUL");
  }
  if (
    input.fixtures !== undefined &&
    (!Array.isArray(input.fixtures) ||
      input.fixtures.some(
        (fixture) =>
          fixture === null ||
          typeof fixture !== "object" ||
          typeof fixture.path !== "string" ||
          (typeof fixture.contents !== "string" && !(fixture.contents instanceof Uint8Array)),
      ))
  ) {
    throw new TypeError("C Cell fixtures must be valid file inputs");
  }
  return Object.freeze({
    ...(input.args === undefined ? {} : { args: Object.freeze([...input.args]) }),
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    ...(input.fixtures === undefined
      ? {}
      : {
          fixtures: Object.freeze(
            input.fixtures.map((fixture) =>
              Object.freeze({
                path: fixture.path,
                contents:
                  typeof fixture.contents === "string"
                    ? fixture.contents
                    : new Uint8Array(fixture.contents),
              }),
            ),
          ),
        }),
  });
}

function emitCancelled(
  submissionId: string,
  projection: CCommandProjection,
  compileResult: CCommandCompileResult | null,
  runResult: CCommandRunResult | null,
  liveOutput: CCommandLiveOutput,
  emit: (state: CCommandExecutionState) => CCommandExecutionState,
): CCommandExecutionState {
  return emit({
    submissionId,
    phase: "cancelled",
    projection,
    compileResult,
    runResult,
    liveOutput,
    message: null,
  });
}

function cancelledStateOrEmit(
  lastState: CCommandExecutionState | null,
  submissionId: string,
  projection: CCommandProjection,
  compileResult: CCommandCompileResult | null,
  runResult: CCommandRunResult | null,
  liveOutput: CCommandLiveOutput,
  emit: (state: CCommandExecutionState) => CCommandExecutionState,
): CCommandExecutionState {
  if (lastState?.submissionId === submissionId && lastState.phase === "cancelled") return lastState;
  return emitCancelled(submissionId, projection, compileResult, runResult, liveOutput, emit);
}

function freezeExecutionState(state: CCommandExecutionState): CCommandExecutionState {
  return Object.freeze({
    ...state,
    compileResult: state.compileResult === null ? null : Object.freeze({ ...state.compileResult }),
    runResult: state.runResult === null ? null : Object.freeze({ ...state.runResult }),
    liveOutput: Object.freeze({ ...state.liveOutput }),
  });
}

function isCurrentSubmission(
  active: { readonly submissionId: string } | null,
  submissionId: string,
): boolean {
  return active?.submissionId === submissionId;
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new TypeError("historyLimit must be a safe integer between 1 and 1000");
  }
  return value;
}

function rememberHistory(history: string[], input: string, limit: number): void {
  if (history.at(-1) !== input) history.push(input);
  if (history.length > limit) history.splice(0, history.length - limit);
}

function emptyLiveOutput(): CCommandLiveOutput {
  return Object.freeze({ stdout: "", stderr: "", truncated: false });
}

function createLiveOutputCollector(onChange: (output: CCommandLiveOutput) => void): {
  readonly append: (event: CCommandOutputEvent) => void;
  readonly finish: () => CCommandLiveOutput;
} {
  const decoders: Record<CCommandOutputStream, TextDecoder> = {
    stdout: new TextDecoder("utf-8", { fatal: false }),
    stderr: new TextDecoder("utf-8", { fatal: false }),
  };
  const byteCounts: Record<CCommandOutputStream, number> = { stdout: 0, stderr: 0 };
  let output = emptyLiveOutput();
  let finished = false;

  const publish = (
    stream: CCommandOutputStream,
    text: string,
    truncated = output.truncated,
  ): void => {
    output = Object.freeze({
      stdout: stream === "stdout" ? `${output.stdout}${text}` : output.stdout,
      stderr: stream === "stderr" ? `${output.stderr}${text}` : output.stderr,
      truncated: output.truncated || truncated,
    });
    onChange(output);
  };

  return Object.freeze({
    append(event: CCommandOutputEvent): void {
      if (finished) return;
      if (
        (event.stream !== "stdout" && event.stream !== "stderr") ||
        (typeof event.data !== "string" && !(event.data instanceof Uint8Array))
      ) {
        throw new TypeError("C Cell output events must contain a valid stream and text data");
      }
      const remaining = MAX_LIVE_OUTPUT_BYTES - byteCounts[event.stream];
      if (remaining <= 0) {
        if (!output.truncated) publish(event.stream, "", true);
        return;
      }
      if (typeof event.data === "string") {
        const bounded = takeStringWithinUtf8Bytes(event.data, remaining);
        byteCounts[event.stream] += bounded.bytes;
        publish(event.stream, bounded.text, bounded.bytes < bounded.totalBytes);
        return;
      }
      const accepted = event.data.subarray(0, remaining);
      byteCounts[event.stream] += accepted.byteLength;
      publish(
        event.stream,
        decoders[event.stream].decode(accepted, { stream: true }),
        accepted.byteLength < event.data.byteLength,
      );
    },
    finish(): CCommandLiveOutput {
      if (finished) return output;
      finished = true;
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders[stream].decode();
        if (tail.length > 0) {
          output = Object.freeze({
            stdout: stream === "stdout" ? `${output.stdout}${tail}` : output.stdout,
            stderr: stream === "stderr" ? `${output.stderr}${tail}` : output.stderr,
            truncated: output.truncated,
          });
        }
      }
      return output;
    },
  });
}

function takeStringWithinUtf8Bytes(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly bytes: number; readonly totalBytes: number } {
  const encoded = outputEncoder.encode(value);
  if (encoded.byteLength <= maximumBytes) {
    return Object.freeze({
      text: value,
      bytes: encoded.byteLength,
      totalBytes: encoded.byteLength,
    });
  }
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = outputEncoder.encode(character).length;
    if (bytes + characterBytes > maximumBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return Object.freeze({ text, bytes, totalBytes: encoded.byteLength });
}
