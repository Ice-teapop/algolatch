import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramAnalysisSnapshot } from "../../src/analysis/index.js";
import {
  createCCommandWorkspaceController,
  type CCommandWriteOutcome,
  type CCommandWorkspaceController,
} from "../../src/app/c-command-workspace-controller.js";
import { buildCCommandProjection } from "../../src/app/c-command-controller.js";
import { analyzeProgramSnapshot } from "../../src/app/program-analysis-session.js";
import type {
  ProgramAnalysisWorkerCallbacks,
  ProgramAnalysisWorkerClient,
} from "../../src/app/program-analysis-worker-client.js";
import { applyTextPatches, type CParser } from "../../src/core/index.js";
import type { TextPatch } from "../../src/core/index.js";
import type { FlowProjection } from "../../src/flow/index.js";
import type { PanelApi, RunResult } from "../../src/shared/api.js";
import { fingerprintSource } from "../../src/shared/source-snapshot.js";
import type { CCommandSurface, CCommandSurfaceOptions } from "../../src/ui/c-command-surface.js";
import type { EditConfirmationPlan } from "../../src/ui/edit-panel.js";
import { createTestParser } from "../core/parser-fixture.js";

const MAIN_SOURCE = "int main(void) {\n  return 0;\n}\n";
const CELL_SOURCE = "int main(void) {\n  int value = 7;\n  return value;\n}\n";

describe("C Cell workspace controller", () => {
  let parser: CParser;
  let controllers: CCommandWorkspaceController[];

  beforeEach(async () => {
    parser = await createTestParser();
    controllers = [];
  });

  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.destroy()));
    parser.dispose();
  });

  it("clears entry-bound projection and transcript when the active workspace changes", () => {
    const clear = vi.fn();
    const harness = createHarness(verifiedApi([]), { clear });

    harness.controller.setWorkspaceEntry("workspace-2");

    expect(clear).toHaveBeenCalledOnce();
    expect(harness.surface.clearTranscript).toHaveBeenCalledOnce();
    expect(harness.surface.setValue).toHaveBeenCalledWith("");
    expect(harness.surface.focus).toHaveBeenCalledOnce();
  });

  it("polls Verified Run, forwards each live event, and records first-result timing", async () => {
    const output = vi.fn();
    const api = verifiedApi([
      runBatch("running", [runEvent(1, "stdout", "one")]),
      runBatch("completed", [runEvent(2, "stderr", "two")], runResult()),
    ]);
    let clock = 100;
    const harness = createHarness(api, { now: () => clock });
    const signal = new AbortController().signal;

    const compiled = await harness.surfaceOptions.hooks.compile({
      submissionId: "submission-1",
      source: CELL_SOURCE,
      sourceName: "c-cell.c",
      signal,
    });
    expect(compiled).toMatchObject({ ok: true, artifactId: "artifact-1" });
    harness.surfaceOptions.onExecutionStateChange?.({
      submissionId: "submission-1",
      phase: "compiling",
      projection: requiredProjection(CELL_SOURCE),
      compileResult: null,
      runResult: null,
      liveOutput: Object.freeze({ stdout: "", stderr: "", truncated: false }),
      message: null,
    });

    const result = await harness.surfaceOptions.hooks.run({
      submissionId: "submission-1",
      artifactId: "artifact-1",
      signal,
      onOutput: output,
    });

    expect(output.mock.calls.map(([event]) => [event.stream, decode(event.data)])).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
    ]);
    expect(api.readRun).toHaveBeenNthCalledWith(1, "verified-1", 0);
    expect(api.readRun).toHaveBeenNthCalledWith(2, "verified-1", 1);
    expect(result).toMatchObject({ ok: true, exitCode: 0, termination: "process-exit" });

    clock = 180;
    harness.surfaceOptions.onExecutionStateChange?.({
      submissionId: "submission-1",
      phase: "running",
      projection: requiredProjection(CELL_SOURCE),
      compileResult: compiled,
      runResult: null,
      liveOutput: Object.freeze({ stdout: "one", stderr: "", truncated: false }),
      message: null,
    });
    expect(harness.element.dataset.firstOutputMs).toBe("80");

    clock = 437;
    harness.surfaceOptions.onExecutionStateChange?.({
      submissionId: "submission-1",
      phase: "succeeded",
      projection: requiredProjection(CELL_SOURCE),
      compileResult: compiled,
      runResult: result,
      liveOutput: Object.freeze({ stdout: "one", stderr: "two", truncated: false }),
      message: null,
    });
    expect(harness.element.dataset.firstResultMs).toBe("337");
  });

  it("passes the selected case stdin, args, and fixtures to Verified Run", async () => {
    const api = verifiedApi([runBatch("completed", [], runResult())]);
    const harness = createHarness(api);
    const signal = new AbortController().signal;

    await harness.surfaceOptions.hooks.run({
      submissionId: "submission-input",
      artifactId: "artifact-1",
      stdin: "3\n3 2 1\n",
      args: ["--ascending"],
      fixtures: [{ path: "cases/expected.txt", contents: "1 2 3\n" }],
      signal,
      onOutput: vi.fn(),
    });

    expect(api.startRun).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      stdin: "3\n3 2 1\n",
      args: ["--ascending"],
      fixtures: [{ path: "cases/expected.txt", contents: "1 2 3\n" }],
    });
  });

  it("drains every terminal event page before returning the final result", async () => {
    const output = vi.fn();
    const result = runResult();
    const api = verifiedApi([
      runBatch("completed", [runEvent(1, "stdout", "one")], result, 2),
      runBatch("completed", [runEvent(2, "stderr", "two")], result, 2),
    ]);
    const harness = createHarness(api);

    await expect(
      harness.surfaceOptions.hooks.run({
        submissionId: "submission-terminal-pages",
        artifactId: "artifact-1",
        signal: new AbortController().signal,
        onOutput: output,
      }),
    ).resolves.toMatchObject({ ok: true, exitCode: 0, termination: "process-exit" });

    expect(output.mock.calls.map(([event]) => [event.stream, decode(event.data)])).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
    ]);
    expect(api.readRun).toHaveBeenNthCalledWith(1, "verified-1", 0);
    expect(api.readRun).toHaveBeenNthCalledWith(2, "verified-1", 1);
  });

  it("cancels the exact owned session once while a poll is in flight", async () => {
    let settleRead!: (value: ReturnType<typeof runBatch>) => void;
    const read = new Promise<ReturnType<typeof runBatch>>((resolve) => {
      settleRead = resolve;
    });
    const api = verifiedApi([]);
    api.readRun.mockImplementationOnce(() => read);
    const harness = createHarness(api);
    const abort = new AbortController();
    const running = harness.surfaceOptions.hooks.run({
      submissionId: "submission-cancel",
      artifactId: "artifact-1",
      signal: abort.signal,
      onOutput: vi.fn(),
    });

    await vi.waitFor(() => expect(api.readRun).toHaveBeenCalledOnce());
    abort.abort();
    await harness.surfaceOptions.hooks.cancel("submission-cancel");
    settleRead(runBatch("cancelled", []));

    await expect(running).resolves.toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
    expect(api.cancelRun).toHaveBeenCalledOnce();
    expect(api.cancelRun).toHaveBeenCalledWith("verified-1");
  });

  it("holds the last valid Flow while typing invalid C and rejects stale worker snapshots", async () => {
    const worker = new FakeProgramWorker();
    const preview = vi.fn();
    const clear = vi.fn();
    const api = verifiedApi([]);
    const harness = createHarness(api, { worker, preview, clear });
    const first = requiredProjection(CELL_SOURCE);

    expect(await harness.surfaceOptions.assessProjection?.(first)).toEqual({
      status: "valid",
      errorCoverageRatio: 0,
    });
    harness.surfaceOptions.onProjectionChange?.(first);
    expect(worker.requests).toHaveLength(1);

    const unfinished = requiredProjection("int value =");
    expect(await harness.surfaceOptions.assessProjection?.(unfinished)).toMatchObject({
      status: "incomplete",
    });
    worker.emit(0, analyze(worker.requests[0]!));
    expect(preview).not.toHaveBeenCalled();

    const second = requiredProjection("int main(void) {\n  int total = 1;\n  return total;\n}\n");
    await harness.surfaceOptions.assessProjection?.(second);
    harness.surfaceOptions.onProjectionChange?.(second);
    worker.emit(1, analyze(worker.requests[1]!));
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0].sourceFingerprint).toBe(
      worker.requests[1]?.sourceFingerprint,
    );

    harness.controller.setActive(false);
    expect(clear).toHaveBeenCalledOnce();
    worker.emit(1, analyze(worker.requests[1]!));
    expect(preview).toHaveBeenCalledOnce();
    harness.controller.setActive(true);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("writes one full-source patch only after exact validation and diff confirmation", async () => {
    let mainSource = MAIN_SOURCE;
    const confirm = vi.fn((_plan: EditConfirmationPlan) => true);
    const outcomes = vi.fn((_outcome: string) => undefined);
    const patches = vi.fn((nextPatches: readonly TextPatch[]) => {
      mainSource = applyTextPatches(mainSource, nextPatches).source;
      return true;
    });
    const harness = createHarness(verifiedApi([]), {
      getMainSource: () => mainSource,
      confirm,
      applyPatches: patches,
      onWriteOutcome: outcomes,
    });
    const projection = requiredProjection(CELL_SOURCE);

    await harness.surfaceOptions.onRequestWriteSource?.({
      source: projection.source,
      originalInput: projection.input,
      projection,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]?.diffs).toEqual([
      {
        beforeRange: { from: 0, to: MAIN_SOURCE.length },
        afterRange: { from: 0, to: CELL_SOURCE.length },
        beforeText: MAIN_SOURCE,
        afterText: CELL_SOURCE,
      },
    ]);
    expect(patches).toHaveBeenCalledOnce();
    expect(patches.mock.calls[0]?.[0]).toHaveLength(1);
    expect(mainSource).toBe(CELL_SOURCE);
    expect(outcomes).toHaveBeenCalledWith("written");
  });

  it("fails closed for invalid or stale writes without changing main.c", async () => {
    let mainSource = MAIN_SOURCE;
    const confirm = vi.fn(async (_plan: EditConfirmationPlan) => {
      mainSource = `${MAIN_SOURCE}// external edit\n`;
      return true;
    });
    const patches = vi.fn((_patches: readonly TextPatch[]) => true);
    const outcomes = vi.fn((_outcome: string) => undefined);
    const harness = createHarness(verifiedApi([]), {
      getMainSource: () => mainSource,
      confirm,
      applyPatches: patches,
      onWriteOutcome: outcomes,
    });
    const valid = requiredProjection(CELL_SOURCE);
    await harness.surfaceOptions.onRequestWriteSource?.({
      source: valid.source,
      originalInput: valid.input,
      projection: valid,
    });
    expect(outcomes).toHaveBeenLastCalledWith("stale");
    expect(patches).not.toHaveBeenCalled();

    const invalid = requiredProjection("int value =");
    await harness.surfaceOptions.onRequestWriteSource?.({
      source: invalid.source,
      originalInput: invalid.input,
      projection: invalid,
    });
    expect(outcomes).toHaveBeenLastCalledWith("invalid");
    expect(confirm).toHaveBeenCalledOnce();
    expect(patches).not.toHaveBeenCalled();
  });

  function analyze(request: WorkerRequest): ProgramAnalysisSnapshot {
    return analyzeProgramSnapshot(
      parser,
      request.source,
      request.revision,
      request.projectedBlockCount,
    );
  }

  function createHarness(
    api: ReturnType<typeof verifiedApi>,
    overrides: {
      readonly now?: () => number;
      readonly worker?: FakeProgramWorker;
      readonly preview?: (projection: FlowProjection, analysis: ProgramAnalysisSnapshot) => void;
      readonly clear?: () => void;
      readonly getMainSource?: () => string;
      readonly confirm?: (plan: EditConfirmationPlan) => boolean | Promise<boolean>;
      readonly applyPatches?: (patches: readonly TextPatch[]) => boolean;
      readonly onWriteOutcome?: (outcome: CCommandWriteOutcome) => void;
    } = {},
  ) {
    let surfaceOptions!: CCommandSurfaceOptions;
    let surface!: CCommandSurface;
    const element = { dataset: {} } as unknown as HTMLElement;
    const worker = overrides.worker ?? new FakeProgramWorker();
    let revision = 0;
    const controller = createCCommandWorkspaceController({
      host: {} as HTMLElement,
      api,
      parser,
      nextRevision: () => ++revision,
      previewProjection: overrides.preview ?? vi.fn((_projection, _analysis) => undefined),
      clearProjectionPreview: overrides.clear ?? vi.fn(() => undefined),
      getMainSource: overrides.getMainSource ?? (() => MAIN_SOURCE),
      confirmWrite: overrides.confirm ?? vi.fn((_plan: EditConfirmationPlan) => true),
      applyPatches: overrides.applyPatches ?? vi.fn((_patches: readonly TextPatch[]) => true),
      onWriteOutcome: overrides.onWriteOutcome,
      pollIntervalMs: 0,
      worker,
      now: overrides.now,
      createSurface(_host, options) {
        surfaceOptions = options;
        surface = {
          element,
          editor: {} as CCommandSurface["editor"],
          focus: vi.fn(),
          setLocale: vi.fn(),
          setValue: vi.fn(),
          clearTranscript: vi.fn(),
          submit: vi.fn(),
          cancel: vi.fn(async () => false),
          destroy: vi.fn(async () => undefined),
        };
        return surface;
      },
    });
    controllers.push(controller);
    return { controller, element, surfaceOptions, surface, worker };
  }
});

interface WorkerRequest {
  readonly source: string;
  readonly sourceFingerprint: string;
  readonly revision: number;
  readonly projectedBlockCount: number;
  readonly callbacks: ProgramAnalysisWorkerCallbacks;
}

class FakeProgramWorker implements ProgramAnalysisWorkerClient {
  readonly requests: WorkerRequest[] = [];
  readonly destroy = vi.fn();

  analyze(
    source: string,
    revision: number,
    projectedBlockCount: number,
    callbacks: ProgramAnalysisWorkerCallbacks,
  ): number {
    this.requests.push(
      Object.freeze({
        source,
        sourceFingerprint: fingerprintSource(source),
        revision,
        projectedBlockCount,
        callbacks,
      }),
    );
    return this.requests.length;
  }

  emit(index: number, analysis: ProgramAnalysisSnapshot): void {
    this.requests[index]?.callbacks.onSnapshot(analysis, true);
  }
}

function verifiedApi(batches: ReturnType<typeof runBatch>[]) {
  return {
    compile: vi.fn(async () => ({
      ok: true as const,
      artifactId: "artifact-1",
      expiresAtMs: Date.now() + 1_000,
      diagnostics: "",
      compileDurationMs: 3,
    })),
    startRun: vi.fn(async () => ({
      ok: true as const,
      sessionId: "verified-1",
      status: "preparing" as const,
    })),
    readRun: vi.fn(async () => batches.shift() ?? runBatch("cancelled", [])),
    cancelRun: vi.fn(async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      status: "cancelled" as const,
    })),
  } satisfies Pick<PanelApi, "compile" | "startRun" | "readRun" | "cancelRun">;
}

function runEvent(sequence: number, stream: "stdout" | "stderr", data: string) {
  return Object.freeze({
    sequence,
    stream,
    data: new TextEncoder().encode(data),
  });
}

function runBatch(
  status: "running" | "completed" | "cancelled",
  events: readonly ReturnType<typeof runEvent>[],
  result: RunResult | null = null,
  totalEventCount = events.length,
) {
  const nextSequence = events.at(-1)?.sequence ?? 0;
  return Object.freeze({
    ok: true as const,
    sessionId: "verified-1",
    status,
    afterSequence: 0,
    nextSequence,
    events: Object.freeze([...events]),
    totalEventCount,
    totalEventBytes: events.reduce((sum, event) => sum + event.data.byteLength, 0),
    truncated: false,
    result,
    error: null,
  });
}

function runResult(): RunResult {
  return Object.freeze({
    ok: true,
    stdout: new TextEncoder().encode("one"),
    stderr: new TextEncoder().encode("two"),
    exitCode: 0,
    signal: null,
    termination: "process-exit",
    durationMs: 8,
  });
}

function requiredProjection(source: string) {
  const projection = buildCCommandProjection(source);
  if (projection === null) throw new Error("fixture projection is empty");
  return projection;
}

function decode(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}
