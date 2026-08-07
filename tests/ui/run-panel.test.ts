import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, CompileResult, RunResult } from "../../src/shared/api.js";
import { fingerprintSource } from "../../src/shared/source-snapshot.js";
import {
  createRunPanel,
  formatCompileDurationEvidence,
  formatRunEvidence,
  normalizeManualRunScenario,
  toRunnerSourceName,
  type ManualRunScenario,
} from "../../src/ui/run-panel.js";

const RUNNER_SOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.c$/u;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run panel source names", () => {
  it.each([
    ["hello.c", "hello.c"],
    ["/tmp/My source.C", "My-source.c"],
    ["C:\\Users\\student\\sort demo.c", "sort-demo.c"],
    [".hidden.c", "hidden.c"],
    ["保真.c", "main.c"],
    ["", "main.c"],
  ])("converts %j to a safe runner file name", (displayName, expected) => {
    expect(toRunnerSourceName(displayName)).toBe(expected);
  });

  it("removes paths and bounds the generated ASCII name", () => {
    const sourceName = toRunnerSourceName(`/private/tmp/../${"a".repeat(300)}\0.c`);

    expect(sourceName).toMatch(RUNNER_SOURCE_NAME_PATTERN);
    expect(sourceName).toHaveLength(128);
    expect(sourceName).not.toContain("/");
    expect(sourceName).not.toContain("\\");
    expect(sourceName).not.toContain("\0");
  });
});

describe("run panel evidence summary", () => {
  it("presents sampled resources and instrumentation as separate evidence", () => {
    const presentation = formatRunEvidence(
      runResult({
        durationMs: 12.25,
        peakRssBytes: 1_572_864,
        peakProcessCount: 3,
        outputBytes: 3_072,
        executedNodeCount: 18,
        operationCount: 41,
      }),
    );

    expect(presentation).toEqual({
      runDuration: "12.3 ms",
      peakRss: "1.5 MiB（采样峰值）",
      peakProcessCount: "3（采样峰值）",
      outputBytes: "3 KiB（stdout + stderr 已捕获）",
      executedNodeCount: "18",
      operationCount: "41",
    });
    expect(Object.keys(presentation)).not.toContain("score");
    expect(formatCompileDurationEvidence(6.5)).toBe("6.5 ms");
  });

  it("labels absent sampling and disabled instrumentation without inventing data", () => {
    const presentation = formatRunEvidence(
      runResult({
        peakRssBytes: 0,
        peakProcessCount: 0,
        outputBytes: undefined,
        executedNodeCount: null,
        operationCount: undefined,
      }),
    );

    expect(presentation.peakRss).toBe("未取得有效样本");
    expect(presentation.peakProcessCount).toBe("未取得有效样本");
    expect(presentation.outputBytes).toBe("5 B（stdout + stderr 已捕获）");
    expect(presentation.executedNodeCount).toBe("未启用轨迹插桩");
    expect(presentation.operationCount).toBe("不可用");
    expect(formatCompileDurationEvidence(undefined)).toBe("不可用");
  });
});

describe("run panel scenario completion", () => {
  it("updates static and completed run evidence when the workbench locale changes", async () => {
    const ownerDocument = new FakeDocument();
    const shell = ownerDocument.createElement("div");
    shell.id = "workbench-shell";
    shell.dataset.locale = "zh-CN";
    const host = ownerDocument.createElement("div");
    shell.append(host);
    const rawDiagnostics = "warning: compiler 原始信息";
    installPanelGlobals(ownerDocument, {
      compile: async () => ({
        ok: true,
        artifactId: "artifact-locale",
        expiresAtMs: 100,
        diagnostics: rawDiagnostics,
        compileDurationMs: 4,
      }),
      run: async () => runResult({ peakProcessCount: 0, peakRssBytes: 0 }),
    });
    const panel = createRunPanel(host as unknown as HTMLElement, {
      getSource: () => "int main(void) { return 0; }\n",
      getDisplayName: () => "main.c",
    });

    await flushMicrotasks();
    await panel.runCurrent();
    shell.dataset.locale = "en";
    shell.dispatchEvent(new Event("workbench-locale-change"));

    const runButton = find(host, (element) => element.className === "run-panel__run-button");
    expect(runButton.textContent).toBe("Run current code");
    expect(runButton.attributes.get("aria-label")).toBe("Run current code");
    expect(
      find(host, (element) => element.className === "run-panel__operation-status").textContent,
    ).toBe("Run completed successfully.");
    expect(find(host, (element) => element.dataset.runField === "diagnostics").textContent).toBe(
      rawDiagnostics,
    );
    expect(find(host, (element) => element.dataset.runField === "peak-rss").textContent).toBe(
      "No valid sample",
    );
    expect(find(host, (element) => element.dataset.runField === "termination").textContent).toBe(
      "Process exited (process-exit)",
    );
    panel.destroy();
  });

  it("normalizes and freezes a bounded manual scenario", () => {
    const input = scenario();
    const normalized = normalizeManualRunScenario(input);

    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized?.arguments)).toBe(true);
    expect(() => normalizeManualRunScenario({ ...input, stdin: "bad\0input" })).toThrow(/stdin/u);
    expect(() => normalizeManualRunScenario({ ...input, inputSize: 0 })).toThrow(/inputSize/u);
  });

  it("passes scenario input to the runner and emits one source-bound completion", async () => {
    const ownerDocument = new FakeDocument();
    const host = ownerDocument.createElement("div");
    const compileResult: CompileResult = {
      ok: true,
      artifactId: "artifact-a",
      expiresAtMs: 100,
      diagnostics: "",
      compileDurationMs: 3,
    };
    const result = runResult({ operationCount: 12 });
    const compile = vi.fn(async () => compileResult);
    const run = vi.fn(async () => result);
    const onRunComplete = vi.fn();
    installPanelGlobals(ownerDocument, { compile, run });
    const source = "int main(void) { return 0; }\n";
    const manualScenario = scenario();
    const panel = createRunPanel(host as unknown as HTMLElement, {
      getSource: () => source,
      getDisplayName: () => "main.c",
      getManualScenario: () => manualScenario,
      onRunComplete,
    });

    await flushMicrotasks();
    const returnedCompletion = await panel.runCurrent();

    expect(run).toHaveBeenCalledWith({
      artifactId: "artifact-a",
      args: ["--ascending"],
      stdin: "3\n3 2 1\n",
    });
    expect(onRunComplete).toHaveBeenCalledOnce();
    expect(returnedCompletion).toEqual(onRunComplete.mock.calls[0]?.[0]);
    expect(onRunComplete).toHaveBeenCalledWith({
      source,
      sourceFingerprint: fingerprintSource(source),
      compileResult,
      runResult: result,
      capabilities: capabilities(),
      scenario: manualScenario,
    });
    const completion = onRunComplete.mock.calls[0]?.[0];
    expect(Object.isFrozen(completion)).toBe(true);
    expect(Object.isFrozen(completion?.capabilities)).toBe(true);
    expect(Object.isFrozen(completion?.scenario)).toBe(true);
    panel.destroy();
  });

  it("fails visibly without compiling when the runner is unavailable", async () => {
    const ownerDocument = new FakeDocument();
    const host = ownerDocument.createElement("div");
    const compile = vi.fn(async () => {
      throw new Error("compile must not start");
    });
    const onRunComplete = vi.fn();
    installPanelGlobals(ownerDocument, {
      compile,
      run: vi.fn(async () => runResult({})),
      capabilities: { ...capabilities(), runnerEnabled: false },
    });
    const panel = createRunPanel(host as unknown as HTMLElement, {
      getSource: () => "int main(void) { return 0; }\n",
      getDisplayName: () => "main.c",
      onRunComplete,
    });

    await flushMicrotasks();
    const completion = await panel.runCurrent();

    expect(completion).toBeNull();
    expect(compile).not.toHaveBeenCalled();
    expect(onRunComplete).not.toHaveBeenCalled();
    expect(find(host, (element) => element.className === "run-panel__result").hidden).toBe(false);
    expect(
      find(host, (element) => element.className === "run-panel__result-status").textContent,
    ).toMatch(/运行器当前不可用/u);
    panel.destroy();
  });

  it("emits compile failures with a null run result and never starts the runner", async () => {
    const ownerDocument = new FakeDocument();
    const host = ownerDocument.createElement("div");
    const compileResult: CompileResult = {
      ok: false,
      diagnostics: "error",
      compileDurationMs: 2,
      error: { code: "COMPILE_FAILED", message: "syntax" },
    };
    const compile = vi.fn(async () => compileResult);
    const run = vi.fn(async () => runResult({}));
    const onRunComplete = vi.fn();
    installPanelGlobals(ownerDocument, { compile, run });
    const panel = createRunPanel(host as unknown as HTMLElement, {
      getSource: () => "broken",
      getDisplayName: () => "main.c",
      onRunComplete,
    });

    await flushMicrotasks();
    find(host, (element) => element.className === "run-panel__run-button").click();
    await flushMicrotasks();

    expect(run).not.toHaveBeenCalled();
    expect(onRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({ compileResult, runResult: null, scenario: null }),
    );
    panel.destroy();
  });
});

function runResult(overrides: Partial<RunResult>): RunResult {
  return {
    ok: true,
    stdout: Uint8Array.from([1, 2, 3]),
    stderr: Uint8Array.from([4, 5]),
    exitCode: 0,
    signal: null,
    termination: "process-exit",
    durationMs: 10,
    ...overrides,
  };
}

function scenario(): ManualRunScenario {
  return Object.freeze({
    id: "scenario.sorting",
    version: "1.0.0",
    mode: "real",
    stdin: "3\n3 2 1\n",
    arguments: Object.freeze(["--ascending"]),
    inputSize: 3,
  });
}

function capabilities(): Capabilities {
  return {
    mode: "trusted-only",
    runnerEnabled: true,
    toolchainId: "verified:Apple clang version 21.0.0",
    isolationProbe: { kind: "macos-seatbelt", status: "unavailable", detail: "trusted" },
    memoryDiagnostics: { available: true, detail: "test" },
    requiresNativeTrustConfirmation: false,
  };
}

function installPanelGlobals(
  ownerDocument: FakeDocument,
  handlers: {
    readonly compile: (request: unknown) => Promise<CompileResult>;
    readonly run: (request: unknown) => Promise<RunResult>;
    readonly capabilities?: Capabilities | undefined;
  },
): void {
  vi.stubGlobal("document", ownerDocument);
  vi.stubGlobal("window", {
    panelApi: {
      capabilities: vi.fn(async () => handlers.capabilities ?? capabilities()),
      compile: handlers.compile,
      run: handlers.run,
      diagnose: vi.fn(),
    },
  });
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

class FakeElement {
  readonly ownerDocument: FakeDocument;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event?: Event) => void)[]>();
  parent: FakeElement | null = null;
  className = "";
  textContent = "";
  type = "";
  id = "";
  disabled = false;
  hidden = false;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: (event?: Event) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event?: Event) => void): void {
    const listeners = this.listeners.get(name);
    if (listeners === undefined) return;
    this.listeners.set(
      name,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  click(): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  closest<T extends Element>(selector: string): T | null {
    let candidate: FakeElement | null = this;
    while (candidate !== null) {
      if (selector === "#workbench-shell" && candidate.id === "workbench-shell") {
        return candidate as unknown as T;
      }
      candidate = candidate.parent;
    }
    return null;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }
}

function find(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return find(child, predicate);
    } catch {
      // Continue through siblings.
    }
  }
  throw new Error("element not found");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
