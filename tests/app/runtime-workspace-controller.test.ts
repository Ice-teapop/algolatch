import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowEdge, FlowNode, FlowProjection } from "../../src/flow/index.js";
import type {
  AlgorithmScenarioDefinition,
  ScenarioProvider,
  ScenarioRunCase,
} from "../../src/mentor/index.js";
import {
  createRuntimeWorkspaceController,
  scenarioCatalogSummaryLabel,
  type RuntimeLearningObservation,
  type RuntimeWorkspaceControllerOptions,
} from "../../src/app/runtime-workspace-controller.js";
import { textRange } from "../../src/core/index.js";
import type { Capabilities, CompileResult, PanelApi, RunResult } from "../../src/shared/api.js";
import { fingerprintSource } from "../../src/shared/source-snapshot.js";
import type { SuccessfulTraceBatch, TraceEvent } from "../../src/shared/trace.js";
import type { TraceScheduler } from "../../src/app/trace-controller.js";
import type { FlowCanvasActivePath } from "../../src/ui/flow-canvas.js";
import type { WorkbenchElements } from "../../src/ui/workbench-shell.js";

const SOURCE = [
  "int main(void) {",
  "  int x;",
  '  scanf("%d", &x);',
  "  if (x > 0) {",
  '    puts("positive");',
  "  } else {",
  '    puts("nonpositive");',
  "  }",
  "  return 0;",
  "}",
].join("\n");
const FINGERPRINT = fingerprintSource(SOURCE);

afterEach(() => vi.unstubAllGlobals());

describe("runtime workspace controller", () => {
  it("localizes the case-management disclosure", () => {
    expect(scenarioCatalogSummaryLabel(false)).toBe("管理案例");
    expect(scenarioCatalogSummaryLabel(true)).toBe("Manage Cases");
  });

  it("mounts all runtime surfaces and keeps teaching simulation out of real APIs", async () => {
    const harness = setup();

    harness.controller.scenario.selectScenario("scenario.test.branch");
    await harness.controller.scenario.simulateForTeaching();

    expect(harness.elements.scenarioHost.children).toHaveLength(1);
    expect(harness.elements.traceHost.children).toHaveLength(1);
    expect(harness.elements.metricsHost.children).toHaveLength(1);
    expect(harness.elements.mentorHost.children).toHaveLength(1);
    expect(harness.api.startTrace).not.toHaveBeenCalled();
    expect(harness.api.compile).not.toHaveBeenCalled();
    expect(harness.api.run).not.toHaveBeenCalled();
    expect(harness.onRevealFlow).toHaveBeenCalledOnce();
    expect(harness.paths.at(-1)).toMatchObject({ mode: "simulation" });
    expect(harness.paths.at(-1)?.nodeIds.length).toBeGreaterThan(0);
    expect(harness.saved.some((request) => request.kind === "run-history")).toBe(false);
    expect(harness.learningObservations).toEqual([]);
    await harness.controller.destroy();
  });

  it("runs a scenario once, then observes its path independently with the exact input", async () => {
    const harness = setup({ traceBranches: [true, false] });
    await harness.controller.setWorkspaceEntry("project-a", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");

    const firstRun = harness.controller.scenario.runReal();
    await firstRun;

    expect(harness.api.startTrace).not.toHaveBeenCalled();
    expect(harness.api.compile).toHaveBeenCalledOnce();
    expect(harness.api.run).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "1\n", args: ["--case", "1"] }),
    );
    expect(
      findElement(harness.elements.runHost, (element) => element.dataset.runField === "stdout")
        .textContent,
    ).toBe("positive\n");
    expect(harness.learningObservations).toEqual([
      expect.objectContaining({
        type: "run-completed",
        workspaceId: "project-a",
        sourceFingerprint: FINGERPRINT,
        stdout: "positive\n",
        expectedStdout: "positive\n",
        expectedMatch: true,
        exitCode: 0,
        termination: "process-exit",
        historyDisposition: "success",
      }),
    ]);
    expect(() => harness.controller.scenario.selectTargetBranch("edge.true")).toThrow(
      /未知目标分支|尚未由真实 Trace/u,
    );

    harness.elements.traceObserveButton.click();
    await driveTrace(harness.scheduler);
    await waitFor(() => harness.learningObservations.length === 2);

    expect(harness.api.startTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "1\n", args: ["--case", "1"] }),
    );
    expect(harness.learningObservations[1]).toMatchObject({
      type: "trace-completed",
      workspaceId: "project-a",
      sourceFingerprint: FINGERPRINT,
      scenarioId: "scenario.test.branch",
      scenarioVersion: "1.0.0",
      size: 1,
      mapped: true,
      truncated: false,
      branchKinds: ["branch-true"],
    });
    harness.controller.scenario.selectTargetBranch("edge.true");
    expect(() => harness.controller.scenario.selectTargetBranch("edge.false")).toThrow(
      /尚未由真实 Trace/u,
    );

    await harness.controller.scenario.runReal();
    expect(harness.api.startTrace).toHaveBeenCalledOnce();
    expect(harness.api.compile).toHaveBeenCalledTimes(2);
    expect(harness.api.run).toHaveBeenCalledTimes(2);
    await harness.controller.flush();
    const scenarios = harness.saved.find((request) => request.kind === "scenarios");
    expect(JSON.parse(scenarios?.serialized ?? "null")).toMatchObject({
      schemaVersion: 1,
      selection: { scenarioId: "scenario.test.branch", targetBranchId: "edge.true" },
      activeCase: { stdin: "1\n", arguments: ["--case", "1"] },
      definitions: [
        {
          id: "scenario.test.branch",
          example: { expected: { stdout: "positive\n" } },
          sizeGenerator: { minimum: 1, maximum: 3, defaultSizes: [1, 2, 3] },
        },
      ],
    });
    expect(harness.saved.some((request) => request.kind === "run-history")).toBe(true);
    const runHistory = harness.saved.find((request) => request.kind === "run-history");
    const persistedHistory = JSON.parse(runHistory?.serialized ?? "null") as {
      entries: Array<{ trace: unknown }>;
    };
    expect(persistedHistory.entries).toHaveLength(2);
    expect(persistedHistory.entries.every((entry) => entry.trace === null)).toBe(true);
    await harness.controller.destroy();
  });

  it("normalizes Windows CRLF only for scenario-output comparison", async () => {
    const harness = setup({ runStdout: "positive\r\n" });
    await harness.controller.setWorkspaceEntry("project-a", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");

    const run = harness.controller.scenario.runReal();
    await run;
    expect(harness.api.startTrace).not.toHaveBeenCalled();

    expect(harness.learningObservations).toContainEqual(
      expect.objectContaining({
        type: "run-completed",
        stdout: "positive\n",
        expectedStdout: "positive\n",
        expectedMatch: true,
      }),
    );
    await harness.controller.destroy();
  });

  it("keeps a normal scenario run available when explicit Trace is unsupported", async () => {
    const harness = setup({ traceUnsupported: true });
    await harness.controller.setWorkspaceEntry("trace-unsupported", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");

    harness.elements.traceObserveButton.click();
    await waitFor(() => harness.api.startTrace.mock.calls.length === 1);
    await waitFor(() => harness.elements.tracePrimaryButton.disabled === false);

    expect(harness.api.compile).not.toHaveBeenCalled();
    expect(harness.api.run).not.toHaveBeenCalled();
    expect(harness.elements.tracePrimaryButton.textContent).toBe("运行");

    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.api.run.mock.calls.length === 1);
    await waitFor(() => harness.elements.tracePrimaryButton.disabled === false);

    expect(harness.api.compile).toHaveBeenCalledOnce();
    expect(harness.api.run).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "1\n", args: ["--case", "1"] }),
    );
    expect(harness.elements.tracePrimaryButton.textContent).toBe("再次运行");
    await harness.controller.destroy();
  });

  it("reports a wrong real output as teaching evidence before rejecting history", async () => {
    const harness = setup({ runStdout: "wrong\n" });
    await harness.controller.setWorkspaceEntry("tutorial-a", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");

    const run = harness.controller.scenario.runReal();
    await expect(run).rejects.toThrow(/实际 "wrong\\n"；期望 "positive\\n"/u);

    expect(
      findElement(harness.elements.runHost, (element) => element.dataset.runField === "stdout")
        .textContent,
    ).toBe("wrong\n");

    expect(harness.learningObservations).toEqual([
      expect.objectContaining({
        type: "run-completed",
        workspaceId: "tutorial-a",
        ok: true,
        stdout: "wrong\n",
        expectedStdout: "positive\n",
        expectedMatch: false,
        historyDisposition: "teaching-failure",
      }),
    ]);
    await harness.controller.flush();
    expect(harness.saved.some((request) => request.kind === "run-history")).toBe(false);
    await harness.controller.destroy();
  });

  it("keeps the primary action unconsumed when the local runner is unavailable", async () => {
    const harness = setup({ runnerEnabled: false });
    await harness.controller.setWorkspaceEntry("runner-disabled", FINGERPRINT);
    await flushAsync();
    harness.controller.scenario.selectScenario("scenario.test.branch");

    await expect(harness.controller.scenario.runReal()).rejects.toThrow(/没有开始执行/u);

    expect(harness.api.compile).not.toHaveBeenCalled();
    expect(harness.api.run).not.toHaveBeenCalled();
    expect(harness.elements.tracePrimaryButton.textContent).toBe("运行");
    expect(
      findElement(
        harness.elements.runHost,
        (element) => element.className === "run-panel__result-status",
      ).textContent,
    ).toMatch(/运行器当前不可用/u);
    await harness.controller.destroy();
  });

  it("keeps Run and Observe separate for an unbound project", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("tutorial-trace", FINGERPRINT);
    await flushAsync();

    expect(() =>
      findElement(harness.elements.traceHost, (element) => element.textContent === "观察路径"),
    ).toThrow(/element not found/u);
    expect(harness.controller.scenario.hasScenarioBinding()).toBe(false);
    expect(harness.elements.tracePrimaryButton.textContent).toBe("运行");
    harness.elements.tracePrimaryButton.click();
    expect(harness.api.run).not.toHaveBeenCalled();
    findElement(
      harness.elements.manualRunInputHost,
      (element) => element.textContent === "无输入运行",
    ).click();
    await waitFor(() => harness.api.run.mock.calls.length === 1);
    expect(harness.api.startTrace).not.toHaveBeenCalled();
    expect(harness.api.run).toHaveBeenCalledWith(expect.objectContaining({ stdin: "", args: [] }));
    expect(harness.elements.tracePrimaryButton.textContent).toBe("再次运行");
    expect(harness.elements.traceObserveButton.textContent).toBe("观察路径");

    harness.elements.traceObserveButton.click();
    expect(harness.elements.focusPanel).toHaveBeenCalledWith("runtime");
    await driveTrace(harness.scheduler);
    await waitFor(() => harness.learningObservations.length === 1);

    expect(harness.learningObservations).toEqual([
      expect.objectContaining({
        type: "trace-completed",
        workspaceId: "tutorial-trace",
        sourceFingerprint: FINGERPRINT,
        scenarioId: "manual.current-source",
        scenarioVersion: "1.0.0",
        size: 1,
        branchKinds: ["branch-true"],
      }),
    ]);
    expect(harness.api.compile).toHaveBeenCalledOnce();
    expect(harness.api.run).toHaveBeenCalledOnce();
    await harness.controller.destroy();
  });

  it("resumes the requested Observe action after collecting manual input", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("manual-observe", FINGERPRINT);

    harness.elements.traceObserveButton.click();
    expect(harness.elements.focusPanel).toHaveBeenCalledWith("runtime");
    expect(harness.api.startTrace).not.toHaveBeenCalled();
    findElement(
      harness.elements.manualRunInputHost,
      (element) => element.textContent === "无输入运行",
    ).click();
    await waitFor(() => harness.api.startTrace.mock.calls.length === 1);
    await driveTrace(harness.scheduler);
    await waitFor(() => harness.learningObservations.length === 1);

    expect(harness.api.compile).not.toHaveBeenCalled();
    expect(harness.api.run).not.toHaveBeenCalled();
    expect(harness.elements.tracePrimaryButton.textContent).toBe("运行");
    expect(harness.learningObservations[0]).toMatchObject({
      type: "trace-completed",
      workspaceId: "manual-observe",
      scenarioId: "manual.current-source",
    });
    await harness.controller.destroy();
  });

  it("binds a tutorial case to the primary run and emits verified course evidence", async () => {
    const harness = setup({ runStdout: "positive\n" });
    await harness.controller.setWorkspaceEntry("tutorial-course", FINGERPRINT);
    harness.controller.configureTutorialCase({
      id: "tutorial.foa.c13.l120",
      version: "1.0.0",
      stdin: "1\n",
      expectedStdout: "positive\n",
    });

    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.api.run.mock.calls.length === 1);

    expect(harness.api.run).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "1\n", args: [] }),
    );
    expect(harness.learningObservations).toContainEqual(
      expect.objectContaining({
        type: "run-completed",
        workspaceId: "tutorial-course",
        scenarioId: "tutorial.foa.c13.l120",
        scenarioVersion: "1.0.0",
        stdout: "positive\n",
        expectedStdout: "positive\n",
        expectedMatch: true,
      }),
    );
    await harness.controller.destroy();
  });

  it("advances a tutorial verification suite only after output and source structure both pass", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("tutorial-suite", FINGERPRINT);
    harness.controller.configureTutorialCase({
      id: "tutorial.foa.c13.l120",
      version: "1.0.0",
      cases: [
        { id: "case-positive", size: 1, stdin: "1\n", expectedStdout: "positive\n" },
        { id: "case-negative", size: 2, stdin: "-1\n", expectedStdout: "nonpositive\n" },
      ],
      sourceContractId: "foa-source:branch+output",
      sourceRequirements: [
        { id: "branch", pattern: "if\\s*\\(" },
        { id: "output", pattern: "puts\\s*\\(" },
      ],
    });

    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.api.run.mock.calls.length === 1);
    await waitFor(() => harness.learningObservations.length === 1);
    expect(harness.elements.tracePrimaryButton.textContent).toBe("运行");
    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.api.run.mock.calls.length === 2);
    await waitFor(() => harness.learningObservations.length === 2);

    expect(harness.api.run.mock.calls.map(([request]) => request.stdin)).toEqual(["1\n", "-1\n"]);
    expect(harness.learningObservations).toEqual([
      expect.objectContaining({
        type: "run-completed",
        caseId: "case-positive",
        sourceContractId: "foa-source:branch+output",
        verifiedSourceRequirementIds: ["branch", "output"],
        expectedMatch: true,
      }),
      expect.objectContaining({
        type: "run-completed",
        caseId: "case-negative",
        sourceContractId: "foa-source:branch+output",
        verifiedSourceRequirementIds: ["branch", "output"],
        expectedMatch: true,
      }),
    ]);
    expect(
      harness.learningObservations.every(
        (item) =>
          item.type !== "run-completed" ||
          /^\d+:[0-9a-f]+:[0-9a-f]+$/u.test(item.sourceStructureFingerprint),
      ),
    ).toBe(true);
    await harness.controller.destroy();
  });

  it("does not advance a tutorial suite when the actual source misses a required structure", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("tutorial-structure", FINGERPRINT);
    harness.controller.configureTutorialCase({
      id: "tutorial.foa.c13.l120",
      version: "1.0.0",
      cases: [
        { id: "case-positive", size: 1, stdin: "1\n", expectedStdout: "positive\n" },
        { id: "case-negative", size: 2, stdin: "-1\n", expectedStdout: "nonpositive\n" },
      ],
      sourceContractId: "foa-source:loop",
      sourceRequirements: [{ id: "loop", pattern: "while\\s*\\(" }],
    });

    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.learningObservations.length === 1);
    expect(harness.learningObservations[0]).toMatchObject({
      type: "run-completed",
      caseId: "case-positive",
      sourceContractId: null,
      verifiedSourceRequirementIds: [],
      expectedMatch: true,
    });
    expect(harness.elements.tracePrimaryButton.textContent).toBe("再次运行");
    await harness.controller.destroy();
  });

  it("persists confirmed manual input for the same source and invalidates it after edits", async () => {
    const first = setup();
    await first.controller.setWorkspaceEntry("manual-persist", FINGERPRINT);
    first.elements.tracePrimaryButton.click();
    findElement(
      first.elements.manualRunInputHost,
      (element) => element.textContent === "无输入运行",
    ).click();
    await waitFor(() => first.api.run.mock.calls.length === 1);
    await first.controller.flush();
    const serialized = first.saved
      .filter((request) => request.kind === "scenarios")
      .at(-1)?.serialized;
    expect(JSON.parse(serialized ?? "null")).toMatchObject({
      sourceFingerprint: FINGERPRINT,
      manualInput: { sourceFingerprint: FINGERPRINT, stdin: "", arguments: [] },
    });
    await first.controller.destroy();

    const restored = setup({ scenarioSidecar: serialized });
    await restored.controller.setWorkspaceEntry("manual-persist", FINGERPRINT);
    await flushAsync();
    restored.elements.tracePrimaryButton.click();
    expect(
      findElement(
        restored.elements.manualRunInputHost,
        (element) => element.className === "manual-run-input__editor",
      ).hidden,
    ).toBe(true);
    await waitFor(() => restored.api.run.mock.calls.length === 1);
    expect(restored.api.run).toHaveBeenCalledWith(expect.objectContaining({ stdin: "", args: [] }));

    restored.source.value = `${SOURCE}\n`;
    restored.controller.invalidateSource();
    await restored.controller.flush();
    const afterEdit = restored.saved
      .filter((request) => request.kind === "scenarios")
      .at(-1)?.serialized;
    expect(JSON.parse(afterEdit ?? "null")).toMatchObject({ manualInput: null });
    await restored.controller.destroy();
  });

  it("exposes the confirmed free stdin and args for the C Cell runtime", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("c-cell-input", FINGERPRINT);
    harness.elements.tracePrimaryButton.click();
    const stdin = findElement(
      harness.elements.manualRunInputHost,
      (element) => element.className === "manual-run-input__stdin",
    );
    const args = findElement(
      harness.elements.manualRunInputHost,
      (element) => element.className === "manual-run-input__args",
    );
    stdin.value = "7\n";
    args.value = "--case\n7";
    const editor = findElement(
      harness.elements.manualRunInputHost,
      (element) => element.className === "manual-run-input__editor",
    );
    editor.dispatch("submit", { preventDefault: vi.fn() });
    await waitFor(() => harness.api.run.mock.calls.length === 1);

    expect(harness.controller.getRuntimeInput()).toEqual({
      stdin: "7\n",
      arguments: ["--case", "7"],
    });
    expect(harness.api.run).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: "7\n", args: ["--case", "7"] }),
    );
    await harness.controller.destroy();
  });

  it("keeps run stable and cycles certain findings only with F8 shortcuts", async () => {
    const analysis = analysisWithCertainFindings();
    const harness = setup({ analysis });
    await harness.controller.setWorkspaceEntry("problem-cycle", FINGERPRINT);
    harness.controller.setAnalysis(analysis);

    harness.elements.tracePrimaryButton.click();
    findElement(
      harness.elements.manualRunInputHost,
      (element) => element.textContent === "无输入运行",
    ).click();
    await waitFor(() => harness.api.run.mock.calls.length === 1);

    expect(harness.elements.tracePrimaryButton.textContent).toBe("再次运行");
    harness.elements.tracePrimaryButton.click();
    await waitFor(() => harness.api.run.mock.calls.length === 2);
    expect(harness.onRevealRange).not.toHaveBeenCalled();

    const next = keyboardEvent("F8");
    harness.elements.shell.dispatch("keydown", next);
    expect(next.preventDefault).toHaveBeenCalledOnce();
    expect(harness.onRevealRange).toHaveBeenLastCalledWith(textRange(1, 2));
    expect(harness.elements.tracePrimaryButton.textContent).toBe("再次运行");

    const second = keyboardEvent("F8");
    harness.elements.shell.dispatch("keydown", second);
    expect(harness.onRevealRange).toHaveBeenLastCalledWith(textRange(3, 4));

    const previous = keyboardEvent("F8", true);
    harness.elements.shell.dispatch("keydown", previous);
    expect(harness.onRevealRange).toHaveBeenLastCalledWith(textRange(3, 4));
    await harness.controller.destroy();
  });

  it("publishes one frozen benchmark completion only after every real run succeeds", async () => {
    const harness = setup();
    await harness.controller.setWorkspaceEntry("benchmark-project", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");
    harness.controller.scenario.configureBenchmark([1, 2, 3], 3);

    const benchmark = harness.controller.scenario.runBenchmark();
    await benchmark;
    expect(harness.api.startTrace).not.toHaveBeenCalled();
    expect(harness.api.compile).toHaveBeenCalledTimes(9);
    expect(harness.api.run).toHaveBeenCalledTimes(9);

    const completed = harness.learningObservations.filter(
      (observation) => observation.type === "benchmark-completed",
    );
    expect(completed).toEqual([
      {
        type: "benchmark-completed",
        workspaceId: "benchmark-project",
        sourceFingerprint: FINGERPRINT,
        scenarioId: "scenario.test.branch",
        scenarioVersion: "1.0.0",
        sizes: [1, 2, 3],
        repetitions: 3,
      },
    ]);
    expect(Object.isFrozen(completed[0])).toBe(true);
    expect(Object.isFrozen(completed[0]?.sizes)).toBe(true);
    await harness.controller.destroy();
  });

  it("stops a real benchmark immediately after the source changes", async () => {
    const secondCompile = deferred<CompileResult>();
    const harness = setup({ deferCompileCall: 2, deferredCompile: secondCompile });
    await harness.controller.setWorkspaceEntry("benchmark-stale", FINGERPRINT);
    harness.controller.scenario.selectScenario("scenario.test.branch");
    harness.controller.scenario.configureBenchmark([1, 2, 3], 3);

    const benchmark = harness.controller.scenario.runBenchmark();
    await waitFor(() => harness.api.compile.mock.calls.length === 2);
    harness.source.value = `${SOURCE}\n`;
    harness.controller.invalidateSource();
    secondCompile.resolve(successfulCompile("artifact-2"));

    await expect(benchmark).rejects.toThrow(/失效|改变/u);
    expect(harness.api.run).toHaveBeenCalledOnce();
    expect(harness.api.compile).toHaveBeenCalledTimes(2);
    expect(
      harness.learningObservations.some(
        (observation) => observation.type === "benchmark-completed",
      ),
    ).toBe(false);
    await harness.controller.destroy();
  });

  it("recovers from a damaged scenarios sidecar without changing source", async () => {
    const harness = setup({ damagedScenarioSidecar: true });

    await expect(
      harness.controller.setWorkspaceEntry("project-a", FINGERPRINT),
    ).resolves.toBeUndefined();
    expect(harness.source.value).toBe(SOURCE);
    expect(harness.controller.scenario.getSnapshot()).toMatchObject({
      scenarioId: "scenario.test.branch",
      size: 1,
      targetBranch: null,
    });
    await harness.controller.destroy();
  });
});

interface SetupOptions {
  readonly traceBranches?: readonly boolean[];
  readonly traceUnsupported?: boolean;
  readonly runStdout?: string;
  readonly runnerEnabled?: boolean;
  readonly deferCompileCall?: number;
  readonly deferredCompile?: Deferred<CompileResult>;
  readonly damagedScenarioSidecar?: boolean;
  readonly scenarioSidecar?: string | undefined;
  readonly analysis?: import("../../src/analysis/index.js").ProgramAnalysisSnapshot | null;
}

function setup(config: SetupOptions = {}) {
  const document = new FakeDocument();
  const elements = workbenchElements(document);
  const scheduler = new FakeScheduler();
  const source = { value: SOURCE };
  const paths: FlowCanvasActivePath[] = [];
  const learningObservations: RuntimeLearningObservation[] = [];
  const onFocusNode = vi.fn();
  const onRevealRange = vi.fn();
  const saved: Array<{ kind: string; serialized: string }> = [];
  const traceBranches = [...(config.traceBranches ?? [true])];
  const traceSessions = new Map<
    string,
    {
      branch: boolean;
      reads: number;
      inputFingerprint: string;
      observationProfileId: SuccessfulTraceBatch["observationProfileId"];
      observationAuthorizationDigest: string | null;
    }
  >();
  let nextSession = 0;
  let compileCalls = 0;

  const api = {
    capabilities: vi.fn(async () => capabilities(config.runnerEnabled ?? true)),
    compile: vi.fn(async () => {
      compileCalls += 1;
      if (compileCalls === config.deferCompileCall && config.deferredCompile !== undefined) {
        return config.deferredCompile.promise;
      }
      return successfulCompile(`artifact-${String(compileCalls)}`);
    }),
    run: vi.fn(async (request: { stdin?: string }) =>
      successfulRun(config.runStdout ?? expectedForInput(request.stdin)),
    ),
    startTrace: vi.fn(
      async (request: {
        sourceFingerprint: string;
        stdin?: string;
        observationProfileId?: SuccessfulTraceBatch["observationProfileId"];
      }) => {
        if (config.traceUnsupported === true) {
          return {
            ok: false as const,
            error: { code: "TRACE_UNSUPPORTED" as const, message: "unsupported layout" },
            unsupported: {
              code: "unsupported-control-layout" as const,
              line: 4,
              message: "无法可靠插桩该控制结构",
            },
          };
        }
        const sessionId = `trace-${String(++nextSession)}`;
        const inputFingerprint = fingerprintSource(request.stdin ?? "");
        const observationProfileId = request.observationProfileId ?? null;
        const observationAuthorizationDigest =
          observationProfileId === null ? null : "a".repeat(64);
        traceSessions.set(sessionId, {
          branch: traceBranches.shift() ?? true,
          reads: 0,
          inputFingerprint,
          observationProfileId,
          observationAuthorizationDigest,
        });
        return {
          ok: true as const,
          sessionId,
          sourceFingerprint: request.sourceFingerprint,
          inputFingerprint,
          observationProfileId,
          observationAuthorizationDigest,
          status: "preparing" as const,
        };
      },
    ),
    readTrace: vi.fn(async (sessionId: string, afterSequence: number) => {
      const session = traceSessions.get(sessionId);
      if (session === undefined) throw new Error("unknown trace");
      session.reads += 1;
      if (session.reads === 1) return traceBatch(sessionId, session.branch, afterSequence, session);
      return traceTerminalBatch(sessionId, afterSequence, session);
    }),
    cancelTrace: vi.fn(async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      status: "cancelled" as const,
    })),
    readWorkspaceSidecar: vi.fn(async (request: { kind: string }) => {
      if (request.kind === "scenarios" && config.damagedScenarioSidecar === true) {
        return {
          status: "ready" as const,
          document: {
            kind: "scenarios" as const,
            revision: 0,
            sourceFingerprint: FINGERPRINT,
            serialized: "{damaged",
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        };
      }
      if (request.kind === "scenarios" && config.scenarioSidecar !== undefined) {
        return {
          status: "ready" as const,
          document: {
            kind: "scenarios" as const,
            revision: 0,
            sourceFingerprint: FINGERPRINT,
            serialized: config.scenarioSidecar,
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        };
      }
      return { status: "missing" as const, kind: request.kind };
    }),
    saveWorkspaceSidecar: vi.fn(
      async (request: { kind: string; serialized: string; sourceFingerprint: string }) => {
        saved.push({ kind: request.kind, serialized: request.serialized });
        return {
          status: "saved" as const,
          document: {
            kind: request.kind,
            revision: 0,
            sourceFingerprint: request.sourceFingerprint,
            serialized: request.serialized,
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        };
      },
    ),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { panelApi: api });
  const onRevealFlow = vi.fn();

  const options: RuntimeWorkspaceControllerOptions = {
    elements: elements as unknown as WorkbenchElements,
    api: api as unknown as PanelApi,
    codePane: {
      setDiagnosticHighlights: vi.fn(),
    } as never,
    blockTree: {
      setDiagnostics: vi.fn(),
    } as never,
    getSource: () => source.value,
    getAnalyzedSource: () => source.value,
    getDisplayName: () => "main.c",
    getAnalysis: () => config.analysis ?? null,
    getProjection: () => (source.value === SOURCE ? projection() : null),
    onSetActivePath: (path) => paths.push(path),
    onRevealFlow,
    onFocusNode,
    onRevealRange,
    onLearningObservation: (observation) => learningObservations.push(observation),
    scenarioProvider: provider(),
    traceScheduler: scheduler,
    tracePollIntervalMs: 50,
    sidecarDelayMs: 60_000,
  };
  return {
    controller: createRuntimeWorkspaceController(options),
    api,
    elements,
    scheduler,
    source,
    paths,
    learningObservations,
    saved,
    onRevealFlow,
    onFocusNode,
    onRevealRange,
  };
}

function analysisWithCertainFindings(): import("../../src/analysis/index.js").ProgramAnalysisSnapshot {
  return {
    revision: 1,
    sourceLength: SOURCE.length,
    sourceFingerprint: FINGERPRINT,
    functions: Object.freeze([]),
    defUse: Object.freeze([]),
    memoryEvents: Object.freeze([]),
    memoryTypestate: Object.freeze([]),
    findings: Object.freeze([
      {
        id: "finding.first",
        functionId: "function.main",
        ruleId: "uninitialized-read",
        reason: "no-reaching-definition",
        confidence: "certain",
        primaryRange: textRange(1, 2),
        ownerNodeId: "start",
        subject: null,
        subjectVariableId: null,
        evidence: Object.freeze([]),
      },
      {
        id: "finding.hint",
        functionId: "function.main",
        ruleId: "uninitialized-read",
        reason: "no-reaching-definition",
        confidence: "likely",
        primaryRange: textRange(2, 3),
        ownerNodeId: "start",
        subject: null,
        subjectVariableId: null,
        evidence: Object.freeze([]),
      },
      {
        id: "finding.second",
        functionId: "function.main",
        ruleId: "uninitialized-read",
        reason: "no-reaching-definition",
        confidence: "certain",
        primaryRange: textRange(3, 4),
        ownerNodeId: "start",
        subject: null,
        subjectVariableId: null,
        evidence: Object.freeze([]),
      },
    ]),
  };
}

function keyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
  };
}

function provider(): ScenarioProvider {
  const definition: AlgorithmScenarioDefinition = Object.freeze({
    id: "scenario.test.branch",
    version: "1.0.0",
    family: "searching",
    label: "分支测试",
    description: "使用正整数经过 true 分支。",
    example: runCase(1),
    sizeGenerator: Object.freeze({
      minimum: 1,
      maximum: 3,
      defaultSizes: Object.freeze([1, 2, 3]),
      inputModel: "stdin integer",
    }),
  });
  return Object.freeze({
    id: "test-provider",
    version: "1.0.0",
    networkAccess: "none",
    list: () => Object.freeze([definition]),
    get: (id: string) => (id === definition.id ? definition : null),
    generate: (id: string, size: number) => {
      if (id !== definition.id) throw new RangeError(id);
      return runCase(size);
    },
  });
}

function runCase(size: number): ScenarioRunCase {
  return Object.freeze({
    scenarioId: "scenario.test.branch",
    scenarioVersion: "1.0.0",
    size,
    stdin: `${String(size)}\n`,
    arguments: Object.freeze(["--case", String(size)]),
    expected: Object.freeze({
      stdout: "positive\n",
      explanation: "all generated inputs are positive",
    }),
  });
}

function projection(): FlowProjection {
  const ranges = lineRanges(SOURCE);
  const nodes = [
    node("start", "start", 0, 0),
    node("read", "statement", ranges[2]!.from, ranges[2]!.to),
    node("branch", "branch", ranges[3]!.from, ranges[3]!.to),
    node("positive", "statement", ranges[4]!.from, ranges[4]!.to),
    node("negative", "statement", ranges[6]!.from, ranges[6]!.to),
    node("return", "statement", ranges[8]!.from, ranges[8]!.to),
    node("end", "end", SOURCE.length, SOURCE.length),
  ];
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: 1,
    sourceFingerprint: FINGERPRINT,
    sourceLength: SOURCE.length,
    documentHasError: false,
    functions: Object.freeze([
      Object.freeze({
        id: "function.main",
        name: "main",
        range: textRange(0, SOURCE.length),
        entryNodeId: "start",
        exitNodeId: "end",
        partial: false,
        lockReasons: Object.freeze([]),
        dataFlowAvailable: true,
        dataFlowDisabledReasons: Object.freeze([]),
      }),
    ]),
    nodes: Object.freeze(nodes),
    edges: Object.freeze([
      edge("edge.entry", "start", "read", "entry"),
      edge("edge.next", "read", "branch", "next"),
      edge("edge.true", "branch", "positive", "branch-true"),
      edge("edge.false", "branch", "negative", "branch-false"),
      edge("edge.true-return", "positive", "return", "next"),
      edge("edge.false-return", "negative", "return", "next"),
      edge("edge.return", "return", "end", "return"),
    ]),
    dataEdges: Object.freeze([]),
  });
}

function node(id: string, kind: FlowNode["kind"], from: number, to: number): FlowNode {
  return Object.freeze({
    id,
    functionId: "function.main",
    sourceNodeId: id,
    kind,
    label: id,
    nodeType: null,
    range: textRange(from, to),
    ownerBlockRange: textRange(from, to),
    sourceText: SOURCE.slice(from, to),
    reachable: true,
    locked: false,
    lockReasons: Object.freeze([]),
    allowsFanOut: kind === "branch",
    defaultPosition: Object.freeze({ x: 0, y: 0 }),
    ports: Object.freeze([]),
  });
}

function edge(id: string, from: string, to: string, kind: FlowEdge["kind"]): FlowEdge {
  return Object.freeze({
    id,
    functionId: "function.main",
    from: Object.freeze({ nodeId: from, portId: `${from}:out` }),
    to: Object.freeze({ nodeId: to, portId: `${to}:in` }),
    kind,
    channel: "control" as const,
    slot: 0,
    editable: true,
  });
}

function lineRanges(source: string): Array<{ from: number; to: number }> {
  const result = [];
  let from = 0;
  for (const line of source.split("\n")) {
    result.push({ from, to: from + line.length });
    from += line.length + 1;
  }
  return result;
}

function traceBatch(
  sessionId: string,
  branch: boolean,
  afterSequence: number,
  identity: Pick<
    SuccessfulTraceBatch,
    "inputFingerprint" | "observationProfileId" | "observationAuthorizationDigest"
  >,
): SuccessfulTraceBatch {
  const events: readonly TraceEvent[] = Object.freeze([
    event(1, "line", 3),
    event(2, "branch", 4, branch),
    event(3, "line", branch ? 5 : 7),
    event(4, "line", 9),
  ]);
  return Object.freeze({
    ok: true,
    sessionId,
    sourceFingerprint: FINGERPRINT,
    inputFingerprint: identity.inputFingerprint,
    observationProfileId: identity.observationProfileId,
    observationAuthorizationDigest: identity.observationAuthorizationDigest,
    status: "running",
    afterSequence,
    nextSequence: 4,
    events,
    totalEventCount: 4,
    totalEventBytes: 64,
    truncated: false,
    unsupported: null,
    evidence: null,
    error: null,
  });
}

function traceTerminalBatch(
  sessionId: string,
  afterSequence: number,
  identity: Pick<
    SuccessfulTraceBatch,
    "inputFingerprint" | "observationProfileId" | "observationAuthorizationDigest"
  >,
): SuccessfulTraceBatch {
  return Object.freeze({
    ok: true,
    sessionId,
    sourceFingerprint: FINGERPRINT,
    inputFingerprint: identity.inputFingerprint,
    observationProfileId: identity.observationProfileId,
    observationAuthorizationDigest: identity.observationAuthorizationDigest,
    status: "completed",
    afterSequence,
    nextSequence: 4,
    events: Object.freeze([]),
    totalEventCount: 4,
    totalEventBytes: 64,
    truncated: false,
    unsupported: null,
    evidence: Object.freeze({
      ok: true,
      exitCode: 0,
      signal: null,
      termination: "process-exit",
      durationMs: 4,
      peakRssBytes: 1024,
      peakProcessCount: 1,
      outputBytes: 9,
      executedNodeCount: 4,
      operationCount: 4,
    }),
    error: null,
  });
}

function event(
  sequence: number,
  kind: TraceEvent["kind"],
  line: number,
  branchTaken: boolean | null = null,
): TraceEvent {
  return Object.freeze({ sequence, kind, line, branchTaken, elapsedMs: sequence });
}

function successfulCompile(artifactId: string): CompileResult {
  return Object.freeze({
    ok: true,
    artifactId,
    expiresAtMs: Date.now() + 1000,
    diagnostics: "",
    compileDurationMs: 1,
  });
}

function successfulRun(stdout: string): RunResult {
  return Object.freeze({
    ok: true,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    exitCode: 0,
    signal: null,
    termination: "process-exit",
    durationMs: 2,
    peakRssBytes: 1024,
    peakProcessCount: 1,
    outputBytes: stdout.length,
    executedNodeCount: null,
    operationCount: null,
  });
}

function expectedForInput(stdin: string | undefined): string {
  return Number(stdin?.trim() ?? "0") > 0 ? "positive\n" : "nonpositive\n";
}

function capabilities(runnerEnabled = true): Capabilities {
  return Object.freeze({
    mode: "trusted-only",
    runnerEnabled,
    toolchainId: "verified:Apple clang version 21.0.0 Target: arm64-apple-macos",
    isolationProbe: Object.freeze({
      kind: "macos-seatbelt",
      status: "unavailable",
      detail: "test",
    }),
    memoryDiagnostics: Object.freeze({ available: true, detail: "test" }),
    requiresNativeTrustConfirmation: false,
  });
}

async function driveTrace(scheduler: FakeScheduler): Promise<void> {
  await flushAsync();
  scheduler.runNext();
  await flushAsync();
  scheduler.runNext();
  await flushAsync();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushAsync();
  }
  throw new Error("condition not reached");
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeScheduler implements TraceScheduler {
  readonly queue: Array<() => void> = [];
  setTimeout(callback: () => void): unknown {
    this.queue.push(callback);
    return callback;
  }
  clearTimeout(token: unknown): void {
    const index = this.queue.indexOf(token as () => void);
    if (index >= 0) this.queue.splice(index, 1);
  }
  runNext(): void {
    const callback = this.queue.shift();
    if (callback === undefined) throw new Error("no scheduled trace poll");
    callback();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function workbenchElements(document: FakeDocument) {
  const hosts = {
    shell: document.createElement("div"),
    scenarioHost: document.createElement("div"),
    traceHost: document.createElement("div"),
    tracePrimaryButton: document.createElement("button"),
    traceObserveButton: document.createElement("button"),
    analysisPrimaryButton: document.createElement("button"),
    manualRunInputHost: document.createElement("div"),
    metricsHost: document.createElement("div"),
    mentorHost: document.createElement("div"),
    analysisHost: document.createElement("div"),
    runHost: document.createElement("div"),
  };
  return {
    ...hosts,
    getInspectorHost: () => hosts.runHost,
    focusPanel: vi.fn(),
  };
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly classList = { add: (..._tokens: string[]) => undefined };
  readonly style = { setProperty: (_name: string, _value: string) => undefined };
  parent: FakeElement | null = null;
  className = "";
  textContent = "";
  type = "";
  value = "";
  title = "";
  min = "";
  max = "";
  step = "";
  disabled = false;
  checked = false;
  hidden = false;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (next: unknown) => void)(event);
    }
  }

  cloneNode(deep: boolean): FakeElement {
    const clone = new FakeElement(this.ownerDocument, this.tagName);
    clone.className = this.className;
    clone.textContent = this.textContent;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  replaceWith(replacement: FakeElement): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index < 0) return;
    replacement.parent = this.parent;
    this.parent.children.splice(index, 1, replacement);
    this.parent = null;
  }
}

function findElement(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return findElement(child, predicate);
    } catch {
      // Continue searching the remaining descendants.
    }
  }
  throw new Error("element not found");
}
