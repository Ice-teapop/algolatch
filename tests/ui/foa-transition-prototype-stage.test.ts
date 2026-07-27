import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelApi } from "../../src/shared/api.js";
import { fingerprintSource } from "../../src/shared/source-snapshot.js";
import { FOA_LESSONS } from "../../src/tutorials/foa-curriculum.js";
import {
  createFoaTransitionPrototypeStage,
  FOA_TRANSITION_PROTOTYPE_ORDERS,
} from "../../src/ui/foa-transition-prototype-stage.js";

const PROFILE_AUTHORIZATION_DIGEST = "a".repeat(64);

describe("FOA transition runtime prototype stage", () => {
  let previousHTMLElement: typeof HTMLElement | undefined;

  beforeEach(() => {
    previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: FakeElement,
    });
  });

  afterEach(() => {
    if (previousHTMLElement === undefined) Reflect.deleteProperty(globalThis, "HTMLElement");
    else {
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        value: previousHTMLElement,
      });
    }
  });

  it("creates each vertical prototype and states the simulation evidence boundary", () => {
    for (const order of FOA_TRANSITION_PROTOTYPE_ORDERS) {
      const { host, stage } = createStage(order, "zh");
      const root = stageRoot(host);

      expect(stage.order).toBe(order);
      expect(root.dataset.lessonOrder).toBe(String(order));
      expect(root.dataset.provenance).toBe("teaching-model");
      expect(root.dataset.traceStatus).toBe("unavailable");
      expect(root.textContent).toContain("教学推演");
      expect(root.textContent).toContain("真实数据待验证");
      expect(transitionAction(host, "verify-real-trace").disabled).toBe(true);
      expect(root.textContent).toContain("当前环境不支持真实 Trace");

      stage.destroy();
      expect(host.children).toHaveLength(0);
    }
  });

  it("never starts Trace automatically and keeps simulation after a failed explicit check", async () => {
    const traceApi = fakeTraceApi({
      startTrace: vi.fn(async () => ({
        ok: false as const,
        error: { code: "TRACE_UNSUPPORTED" as const, message: "unsupported" },
        unsupported: {
          code: "unsupported-statement-layout" as const,
          line: 3,
          message: "unsupported",
        },
      })),
    });
    const { host, stage } = createStage(63, "en", traceApi);
    const root = stageRoot(host);

    expect(traceApi.startTrace).not.toHaveBeenCalled();
    transitionAction(host, "verify-real-trace").emit("click");
    await flushPromises();

    expect(traceApi.startTrace).toHaveBeenCalledTimes(1);
    expect(root.dataset.provenance).toBe("teaching-model");
    expect(root.dataset.traceStatus).toBe("failed");
    expect(root.dataset.traceFailure).toBe("TRACE_UNSUPPORTED");
    expect(root.textContent).toContain("Evidence is incomplete or inconsistent");
    expect(root.textContent).not.toContain("unsupported");
    stage.destroy();
  });

  it("cancels an active real Trace when learner input changes", async () => {
    const traceApi = fakeTraceApi({
      startTrace: vi.fn(async (request) => ({
        ok: true as const,
        sessionId: "trace-session-63",
        sourceFingerprint: request.sourceFingerprint,
        inputFingerprint: fingerprintSource(request.stdin ?? ""),
        observationProfileId: request.observationProfileId ?? null,
        observationAuthorizationDigest:
          request.observationProfileId === undefined ? null : PROFILE_AUTHORIZATION_DIGEST,
        status: "preparing" as const,
      })),
    });
    const { host, stage } = createStage(63, "zh", traceApi);
    transitionAction(host, "verify-real-trace").emit("click");
    await flushPromises();
    expect(stageRoot(host).dataset.traceStatus).toBe("verifying");

    const value = inputByType(host, "number");
    value.value = "34";
    transitionAction(host, "apply-input").emit("click");
    await flushPromises();

    expect(traceApi.cancelTrace).toHaveBeenCalledWith("trace-session-63");
    expect(stageRoot(host).dataset.provenance).toBe("teaching-model");
    expect(stageRoot(host).dataset.traceStatus).toBe("idle");
    stage.destroy();
  });

  it("upgrades the stage only after complete value, relation, and stdout evidence", async () => {
    vi.useFakeTimers();
    try {
      const source = FOA_LESSONS[62]!.code.text;
      const sourceFingerprint = fingerprintSource(source);
      const events = [
        probeEvent(1, sourceLine(source, 'if (scanf("%d", &counter.value) != 1) {'), {
          probeId: "foa63.counter.value",
          probe: { kind: "scalar" as const, value: 4 },
        }),
        probeEvent(2, sourceLine(source, "struct Counter *link = &counter;"), {
          probeId: "foa63.link.target",
          probe: {
            kind: "object" as const,
            objectId: "foa63.link",
            targetObjectId: "foa63.counter",
            fieldId: null,
            value: true,
          },
        }),
        probeEvent(3, sourceLine(source, "link->value++;"), {
          probeId: "foa63.counter.value",
          probe: { kind: "scalar" as const, value: 5 },
        }),
      ];
      const startTrace = vi
        .fn()
        .mockImplementationOnce(async (request) => ({
          ok: true as const,
          sessionId: "trace-session-63",
          sourceFingerprint,
          inputFingerprint: fingerprintSource(request.stdin ?? ""),
          observationProfileId: request.observationProfileId ?? null,
          observationAuthorizationDigest:
            request.observationProfileId === undefined ? null : PROFILE_AUTHORIZATION_DIGEST,
          status: "preparing" as const,
        }))
        .mockResolvedValueOnce({
          ok: false as const,
          error: { code: "TRACE_UNSUPPORTED" as const, message: "unsupported" },
          unsupported: null,
        });
      const traceApi = fakeTraceApi({
        startTrace,
        readTrace: vi.fn(async () => ({
          ok: true as const,
          sessionId: "trace-session-63",
          sourceFingerprint,
          inputFingerprint: fingerprintSource("4\n"),
          observationProfileId: "foa-transition-63-v1" as const,
          observationAuthorizationDigest: PROFILE_AUTHORIZATION_DIGEST,
          status: "completed" as const,
          afterSequence: 0,
          nextSequence: 3,
          events,
          totalEventCount: 3,
          totalEventBytes: 256,
          truncated: false,
          unsupported: null,
          evidence: {
            ok: true,
            exitCode: 0,
            signal: null,
            termination: "process-exit" as const,
            durationMs: 8,
            peakRssBytes: 1024,
            peakProcessCount: 1,
            outputBytes: 2,
            executedNodeCount: 3,
            operationCount: 3,
            stdout: new TextEncoder().encode("5\n"),
          },
          error: null,
        })),
      });
      const { host, stage } = createStage(63, "en", traceApi);

      transitionAction(host, "verify-real-trace").emit("click");
      await flushPromises();
      expect(stageRoot(host).dataset.traceStatus).toBe("verifying");
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(stageRoot(host).dataset.traceStatus).toBe("verified");
      expect(stageRoot(host).dataset.provenance).toBe("real-trace");
      expect(stageRoot(host).dataset.modelProvenance).toBe("real-trace");
      expect(stageRoot(host).textContent).toContain("Evidence consistent");
      expect(stageRoot(host).textContent).toContain(
        "The real run, state events, and output are consistent",
      );

      transitionAction(host, "verify-real-trace").emit("click");
      await flushPromises();
      expect(stageRoot(host).dataset.traceStatus).toBe("failed");
      expect(stageRoot(host).dataset.provenance).toBe("teaching-model");
      expect(stageRoot(host).dataset.modelProvenance).toBe("teaching-model");
      expect(stageRoot(host).textContent).toContain("Teaching simulation");
      expect(stageRoot(host).textContent).not.toContain("Evidence consistent");
      stage.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets lesson 63 change the simulated value and output", () => {
    const { host } = createStage(63, "zh");
    const value = inputByType(host, "number");
    value.value = "34";
    transitionAction(host, "apply-input").emit("click");

    expect(visualOutput(host, "pointer-input").textContent).toBe("34");
    expect(visualOutput(host, "pointer-field").textContent).toBe("—");
    transitionAction(host, "next").emit("click");
    expect(visualOutput(host, "pointer-field").textContent).toBe("34");
    expect(stageRoot(host).textContent).toContain("本次输入 34");

    seekToEnd(host);
    expect(stageOutput(host).textContent).toBe("35");
    expect(visualOutput(host, "pointer-field").textContent).toBe("35");
    expect(inputByType(host, "number").value).toBe("34");
  });

  it("lets lesson 70 rebuild a lower-bound timeline from learner input", () => {
    const { host } = createStage(70, "en");
    const progress = transitionProgress(host);
    const originalFrameCount = Number(progress.max) + 1;
    const [values, target] = allInputs(host).filter((input) => input.type !== "range");
    expect(values).toBeDefined();
    expect(target).toBeDefined();

    values!.value = "1 2";
    target!.value = "1";
    transitionAction(host, "apply-input").emit("click");

    const rebuiltFrameCount = Number(transitionProgress(host).max) + 1;
    expect(rebuiltFrameCount).not.toBe(originalFrameCount);
    seekToEnd(host);
    expect(stageOutput(host).textContent).toBe("0");
  });

  it("lets lesson 75 change call-stack depth and result", () => {
    const { host } = createStage(75, "en");
    const originalFrameCount = Number(transitionProgress(host).max) + 1;
    const disks = inputByType(host, "number");
    disks.value = "2";
    transitionAction(host, "apply-input").emit("click");

    expect(Number(transitionProgress(host).max) + 1).toBeLessThan(originalFrameCount);
    seekToEnd(host);
    expect(stageOutput(host).textContent).toBe("3");
  });

  it("lets lesson 80 change obstacles and recompute the path timeline", () => {
    const { document, host } = createStage(80, "en");
    const originalFrameCount = Number(transitionProgress(host).max) + 1;
    const middle = transitionAction(host, "grid-1-1");
    expect(middle.dataset.open).toBe("true");

    middle.focus();
    expect(document.activeElement).toBe(middle);
    middle.emit("click");

    const updatedMiddle = transitionAction(host, "grid-1-1");
    expect(updatedMiddle).toBe(middle);
    expect(updatedMiddle.dataset.open).toBe("false");
    expect(document.activeElement).toBe(updatedMiddle);
    expect(Number(transitionProgress(host).max) + 1).not.toBe(originalFrameCount);
    seekToEnd(host);
    expect(stageOutput(host).textContent).toBe("0");
  });

  it.each([75, 80] as const)(
    "keeps lesson %i source identity synchronized with the active runtime frame",
    (order) => {
      const { host } = createStage(order, "en");
      const root = stageRoot(host);
      const sourceCode = walk(host)
        .find((node) => node.className.split(/\s+/u).includes("foa-transition-prototype__source"))
        ?.querySelector("code");
      expect(sourceCode).toBeDefined();

      const firstLine = root.dataset.activeSourceLine;
      const firstAnchor = root.dataset.activeSourceAnchorId;
      expect(Number(firstLine)).toBeGreaterThan(0);
      expect(firstAnchor).toBe(sourceCode!.dataset.sourceAnchorId);

      transitionAction(host, "next").emit("click");

      expect(Number(root.dataset.activeSourceLine)).toBeGreaterThan(0);
      expect(root.dataset.activeSourceAnchorId).toBe(sourceCode!.dataset.sourceAnchorId);
      seekToEnd(host);
      expect(Number(root.dataset.activeSourceLine)).toBeGreaterThan(0);
      expect(root.dataset.activeSourceAnchorId).toBe(sourceCode!.dataset.sourceAnchorId);
      expect(
        root.dataset.activeSourceLine !== firstLine ||
          root.dataset.activeSourceAnchorId !== firstAnchor,
      ).toBe(true);
    },
  );

  it("supports previous, next, seek, locale, reduced motion, reset, and destroy", () => {
    const { host, stage } = createStage(63, "zh");
    const root = stageRoot(host);
    const progress = transitionProgress(host);
    expect(progress.value).toBe("0");

    transitionAction(host, "next").emit("click");
    expect(progress.value).toBe("1");
    transitionAction(host, "previous").emit("click");
    expect(progress.value).toBe("0");

    progress.value = progress.max;
    progress.emit("input");
    expect(progress.value).toBe(progress.max);

    stage.setLocale("en");
    expect(root.dataset.locale).toBe("en");
    expect(root.textContent).toContain("Teaching simulation");
    expect(root.textContent).toContain("Real data not verified");
    expect(transitionAction(host, "previous").textContent).toBe("Previous");

    stage.setReducedMotion(true);
    expect(root.dataset.reducedMotion).toBe("true");

    stage.reset();
    expect(transitionProgress(host).value).toBe("0");
    expect(inputByType(host, "number").value).toBe("4");

    stage.destroy();
    expect(host.children).toHaveLength(0);
    expect(() => stage.setLocale("zh")).toThrow(/destroyed/u);
  });
});

function createStage(
  order: 63 | 70 | 75 | 80,
  locale: "zh" | "en",
  traceApi?: Pick<PanelApi, "startTrace" | "readTrace" | "cancelTrace">,
) {
  const document = new FakeDocument();
  const host = document.createElement("div");
  document.body.append(host);
  const lesson = FOA_LESSONS[order - 1]!;
  const stage = createFoaTransitionPrototypeStage(host as unknown as HTMLElement, lesson, {
    locale,
    reducedMotion: false,
    traceApi,
  });
  return { document, host, stage };
}

function fakeTraceApi(
  overrides: Partial<Pick<PanelApi, "startTrace" | "readTrace" | "cancelTrace">> = {},
): Pick<PanelApi, "startTrace" | "readTrace" | "cancelTrace"> {
  return {
    startTrace: vi.fn(async () => ({
      ok: false as const,
      error: { code: "TRACE_UNSUPPORTED" as const, message: "unsupported" },
      unsupported: null,
    })),
    readTrace: vi.fn(async (sessionId: string) => ({
      ok: false as const,
      sessionId,
      error: { code: "TRACE_SESSION_NOT_FOUND" as const, message: "missing" },
    })),
    cancelTrace: vi.fn(async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      status: "cancelled" as const,
    })),
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sourceLine(source: string, exact: string): number {
  const matches = source
    .split(/\r?\n/u)
    .flatMap((line, index) => (line.includes(exact) ? [index + 1] : []));
  if (matches.length !== 1) throw new Error(`Expected one source line for ${exact}`);
  return matches[0]!;
}

function probeEvent(
  sequence: number,
  line: number,
  payload: {
    readonly probeId: string;
    readonly probe:
      | { readonly kind: "scalar"; readonly value: number | boolean }
      | {
          readonly kind: "object";
          readonly objectId: string;
          readonly targetObjectId: string | null;
          readonly fieldId: string | null;
          readonly value: number | boolean | null;
        };
  },
) {
  return Object.freeze({
    sequence,
    kind: "probe" as const,
    line,
    branchTaken: null,
    probeId: payload.probeId,
    probe: Object.freeze(payload.probe),
    elapsedMs: sequence,
  });
}

function stageRoot(host: FakeElement): FakeElement {
  return host.children[0]!;
}

function transitionAction(host: FakeElement, action: string): FakeElement {
  const target = walk(host).find((node) => node.dataset.transitionAction === action);
  if (target === undefined) throw new Error(`Missing transition action ${action}`);
  return target;
}

function transitionProgress(host: FakeElement): FakeElement {
  const target = walk(host).find((node) => node.dataset.transitionProgress !== undefined);
  if (target === undefined) throw new Error("Missing transition progress");
  return target;
}

function stageOutput(host: FakeElement): FakeElement {
  const container = walk(host).find((node) =>
    node.className.split(/\s+/u).includes("foa-transition-prototype__output"),
  );
  const output = container?.children.find((node) => node.tagName.toLowerCase() === "output");
  if (output === undefined) throw new Error("Missing stage output");
  return output;
}

function visualOutput(host: FakeElement, teachingTokenId: string): FakeElement {
  const node = walk(host).find(
    (candidate) => candidate.dataset.teachingTokenId === teachingTokenId,
  );
  const output = node?.children.find((candidate) => candidate.tagName.toLowerCase() === "output");
  if (output === undefined) throw new Error(`Missing visual output for ${teachingTokenId}`);
  return output;
}

function inputByType(host: FakeElement, type: string): FakeElement {
  const input = allInputs(host).find((candidate) => candidate.type === type);
  if (input === undefined) throw new Error(`Missing ${type} input`);
  return input;
}

function allInputs(host: FakeElement): FakeElement[] {
  return walk(host).filter((node) => node.tagName.toLowerCase() === "input");
}

function seekToEnd(host: FakeElement): void {
  const progress = transitionProgress(host);
  progress.value = progress.max;
  progress.emit("input");
}

function walk(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(walk)];
}

class FakeDocument {
  readonly body = new FakeElement(this, "body");
  activeElement: FakeElement | null = null;
  readonly defaultView = {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    ResizeObserver: undefined,
  };

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
  }
}

class FakeElement {
  readonly dataset: Record<string, string | undefined> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  readonly style: Record<string, string> = {};
  readonly classList = {
    add: (...names: string[]) => {
      this.className = [
        ...new Set([...this.className.split(/\s+/u).filter(Boolean), ...names]),
      ].join(" ");
    },
  };
  parentElement: FakeElement | null = null;
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  value = "";
  min = "";
  max = "";
  step = "";
  title = "";
  inputMode = "";
  autocomplete = "";
  noValidate = false;
  clientWidth = 0;
  scrollWidth = 0;
  private ownText = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.clearChildren();
  }

  get isConnected(): boolean {
    return this === this.ownerDocument.body || this.ownerDocument.body.contains(this);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get previousElementSibling(): FakeElement | null {
    if (this.parentElement === null) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1]! : null;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.ownText += node;
        continue;
      }
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.ownText = "";
    this.clearChildren();
    this.append(...nodes);
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  removeChild(node: FakeElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
  }

  contains(candidate: FakeElement): boolean {
    return this === candidate || this.children.some((child) => child.contains(candidate));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string): void {
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      preventDefault: () => undefined,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return walk(this).filter((node) => selectors.some((part) => node.matches(part)));
  }

  matches(selector: string): boolean {
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/u).includes(selector.slice(1));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    };
  }

  private clearChildren(): void {
    for (const child of this.children) child.parentElement = null;
    this.children.splice(0);
  }
}

interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement;
  readonly currentTarget: FakeElement;
  preventDefault(): void;
}
