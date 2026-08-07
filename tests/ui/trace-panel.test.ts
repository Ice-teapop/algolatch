import { describe, expect, it, vi } from "vitest";
import type { TraceEvent, TraceRunEvidence } from "../../src/shared/trace.js";
import {
  createTracePanel,
  formatTraceEvent,
  selectTraceChartEvents,
  selectTracePanelEvents,
  TRACE_CHART_POINT_LIMIT,
  TRACE_PANEL_EVENT_LIMIT,
  traceBranchOutcomeBars,
  traceChartXAxisMode,
  traceChartLineDomain,
  traceChartTimeDomain,
  traceLineHitBars,
  tracePanelStateMessage,
  tracePlaybackControlEnabled,
  traceStatusPresentation,
  type TracePanelState,
  type TracePanelStatus,
} from "../../src/ui/trace-panel.js";

describe("trace panel status contract", () => {
  it("gives every real-flow state a compact status icon and label", () => {
    const statuses: readonly TracePanelStatus[] = [
      "idle",
      "preparing",
      "running",
      "branch",
      "completed",
      "cancelled",
      "error",
      "resource",
      "truncated",
      "unsupported",
    ];

    const presentations = statuses.map((status) => [status, traceStatusPresentation(status)]);

    expect(presentations).toEqual([
      ["idle", { icon: "○", label: "待命", tone: "neutral" }],
      ["preparing", { icon: "◌", label: "准备", tone: "working" }],
      ["running", { icon: "▶", label: "运行", tone: "working" }],
      ["branch", { icon: "⑂", label: "分支", tone: "working" }],
      ["completed", { icon: "✓", label: "完成", tone: "success" }],
      ["cancelled", { icon: "■", label: "已取消", tone: "neutral" }],
      ["error", { icon: "!", label: "错误", tone: "danger" }],
      ["resource", { icon: "▣", label: "资源限制", tone: "danger" }],
      ["truncated", { icon: "…", label: "已截断", tone: "warning" }],
      ["unsupported", { icon: "—", label: "不支持", tone: "warning" }],
    ]);
  });

  it("allows terminal paused playback to resume after the C process has finished", () => {
    expect(tracePlaybackControlEnabled("running", false)).toBe(true);
    expect(tracePlaybackControlEnabled("completed", true)).toBe(true);
    expect(tracePlaybackControlEnabled("truncated", true)).toBe(true);
    expect(tracePlaybackControlEnabled("completed", false)).toBe(false);
  });

  it("projects controller-owned Chinese states into safe English UI copy", () => {
    expect(
      tracePanelStateMessage(
        panelState({ status: "preparing", message: "正在准备临时影子 Trace…" }),
        "en",
      ),
    ).toBe("Preparing the temporary shadow Trace…");
    expect(
      tracePanelStateMessage(
        panelState({ status: "branch", message: "真实分支：第 12 行为 false。" }),
        "en",
      ),
    ).toBe("Real branch: line 12 evaluated to false.");
    expect(
      tracePanelStateMessage(
        panelState({
          status: "unsupported",
          message: "当前源码布局不支持可靠 Trace。",
          unsupported: {
            code: "unsupported-control-layout",
            line: 8,
            message: "当前控制结构不支持",
          },
        }),
        "en",
      ),
    ).toBe("This source layout cannot be traced reliably near line 8.");
  });
});

describe("trace panel event list", () => {
  it("renders at most the newest 500 events without mutating backend evidence", () => {
    const sourceEvents = Array.from({ length: 620 }, (_, index) => {
      const kind = index % 5 === 0 ? "branch" : "line";
      return event(index + 1, kind, index + 2, kind === "branch" ? index % 2 === 0 : null);
    });
    const selected = selectTracePanelEvents(sourceEvents);

    expect(TRACE_PANEL_EVENT_LIMIT).toBe(500);
    expect(selected).toHaveLength(500);
    expect(selected[0]?.sequence).toBe(121);
    expect(selected.at(-1)?.sequence).toBe(620);
    expect(sourceEvents).toHaveLength(620);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected[0])).toBe(true);
  });

  it("labels actual line and branch results without presenting simulation", () => {
    expect(formatTraceEvent(event(7, "line", 12))).toBe("#7 · 行 12 · 语句 · 17.5 ms");
    expect(formatTraceEvent(event(8, "branch", 18, true))).toBe("#8 · 行 18 · 分支 true · 20 ms");
    expect(formatTraceEvent(event(9, "branch", 18, false))).toBe(
      "#9 · 行 18 · 分支 false · 22.5 ms",
    );
    expect(formatTraceEvent(event(9, "branch", 18, false))).not.toMatch(/模拟|simulation/iu);
  });

  it("samples a finite 80-point chart while preserving branch evidence", () => {
    const sourceEvents = Array.from({ length: 620 }, (_, index) =>
      event(index + 1, index === 310 ? "branch" : "line", index + 2, index === 310),
    );
    sourceEvents.splice(200, 0, {
      sequence: 900,
      kind: "line",
      line: 1,
      branchTaken: null,
      elapsedMs: Number.POSITIVE_INFINITY,
    });

    const selected = selectTraceChartEvents(sourceEvents);

    expect(TRACE_CHART_POINT_LIMIT).toBe(80);
    expect(selected).toHaveLength(80);
    expect(selected.some((candidate) => candidate.kind === "branch")).toBe(true);
    expect(selected.every((candidate) => Number.isFinite(candidate.elapsedMs))).toBe(true);
    expect(selected[0]?.sequence).toBe(1);
    expect(selected.at(-1)?.sequence).toBe(620);
  });

  it("aggregates only finite real events for line-hit and branch bars", () => {
    const events = [
      event(1, "line", 4),
      event(2, "line", 4),
      event(3, "branch", 7, true),
      event(4, "branch", 7, false),
      { ...event(5, "line", 9), elapsedMs: Number.POSITIVE_INFINITY },
    ];

    expect(traceLineHitBars(events)).toEqual([
      { key: "line:4", label: "4", count: 2, kind: "line" },
      { key: "line:7", label: "7", count: 2, kind: "line" },
    ]);
    expect(traceBranchOutcomeBars(events)).toEqual([
      { key: "branch:true", label: "true", count: 1, kind: "true" },
      { key: "branch:false", label: "false", count: 1, kind: "false" },
    ]);
  });
});

describe("trace panel interaction", () => {
  it("uses the canvas toolbar as the single start control and mirrors active state", () => {
    const fixture = fakeHost();
    const primary = fixture.host.ownerDocument.createElement("button");
    primary.textContent = "观察路径";
    const onStart = vi.fn();
    const panel = createTracePanel(fixture.host, {
      primaryStartButton: primary,
      onStart,
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });

    expect(fixture.findByAction("start")).toBeUndefined();
    expect(primary.dataset.traceAction).toBe("start");
    expect(primary.disabled).toBe(false);
    primary.click();
    expect(onStart).toHaveBeenCalledOnce();

    panel.setState(panelState({ status: "preparing" }));
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toBe("观察中…");
    expect(primary.getAttribute("aria-busy")).toBe("true");
    expect(fixture.findByAction("cancel")?.hidden).toBe(false);

    panel.setState(panelState({ status: "completed" }));
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toBe("观察路径");
    expect(primary.getAttribute("aria-busy")).toBe("false");
    expect(fixture.findByClass("trace-panel__controls")?.hidden).toBe(true);

    panel.destroy();
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toBe("观察路径");
  });

  it("spreads same-millisecond events by real execution order instead of drawing a vertical line", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    const events = [
      event(1, "line", 2, null, 0),
      event(2, "branch", 3, true, 0),
      event(3, "line", 4, null, 0),
    ];

    panel.setEvents(events);

    const chart = fixture.findByClass("trace-panel__chart");
    const points = fixture.findByData("series", "trace")?.getAttribute("points") ?? "";
    const uniqueX = new Set(
      points
        .split(" ")
        .filter(Boolean)
        .map((point) => point.split(",")[0]),
    );
    expect(traceChartXAxisMode(events)).toBe("sequence");
    expect(chart?.dataset.xMode).toBe("sequence");
    expect(uniqueX.size).toBe(3);
    expect(fixture.findByClass("trace-panel__chart-caption")?.textContent).toContain("步序 × 行号");
    expect(traceChartLineDomain(events)).toEqual({ minimum: 2, maximum: 4 });
    const markerY = walk(chart!)
      .filter((element) => element.tagName === "circle")
      .map((element) => element.getAttribute("cy"));
    expect(new Set(markerY).size).toBe(3);
    const guide = fixture.findByClass("trace-panel__chart-guide");
    expect(guide?.hidden).toBe(false);
    expect(guide?.children[0]?.textContent).toBe("怎么看");
    expect(walk(guide!).map((element) => element.textContent)).toContain(
      "实测/参考不是速度评分，也不能单独证明 Big-O。",
    );
  });

  it("draws a point for a single event and keeps sequence as the stable default", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });

    panel.setEvents([event(1, "line", 2, null, 0)]);
    expect(fixture.findByData("kind", "line")?.tagName).toBe("circle");
    expect(fixture.findByClass("trace-panel__chart")?.dataset.pointCount).toBe("1");

    const timed = [
      event(1, "line", 2, null, 0),
      event(2, "line", 3, null, 1),
      event(3, "line", 4, null, 2),
    ];
    panel.setEvents(timed);
    expect(traceChartXAxisMode(timed)).toBe("sequence");
    expect(fixture.findByClass("trace-panel__chart")?.dataset.xMode).toBe("sequence");
  });

  it("switches between the timeline and two real-evidence bar views", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    panel.setEvents([
      event(1, "line", 4),
      event(2, "line", 4),
      event(3, "branch", 7, true),
      event(4, "branch", 7, false),
    ]);

    const chart = fixture.findByClass("trace-panel__chart");
    const timeline = fixture.findByAction("chart-timeline");
    const lineHits = fixture.findByAction("chart-line-hits");
    const branches = fixture.findByAction("chart-branches");
    expect(chart?.dataset.chartView).toBe("timeline");
    expect(chart?.dataset.barCount).toBe("0");
    expect(timeline?.textContent).toBe("执行时间线");
    expect(timeline?.getAttribute("aria-pressed")).toBe("true");

    lineHits?.click();
    expect(chart?.dataset.chartView).toBe("line-hits");
    expect(chart?.dataset.barCount).toBe("2");
    expect(fixture.findByClass("trace-panel__chart-caption")?.textContent).toBe("行命中直方图");
    expect(fixture.findByData("bar-key", "line:4")?.dataset.count).toBe("2");
    expect(fixture.findByData("bar-key", "line:7")?.dataset.count).toBe("2");
    expect(lineHits?.getAttribute("aria-pressed")).toBe("true");

    branches?.click();
    expect(chart?.dataset.chartView).toBe("branches");
    expect(chart?.dataset.barCount).toBe("2");
    expect(fixture.findByClass("trace-panel__chart-caption")?.textContent).toBe(
      "分支结果 · true / false",
    );
    expect(fixture.findByData("bar-key", "branch:true")?.dataset.count).toBe("1");
    expect(fixture.findByData("bar-key", "branch:false")?.dataset.count).toBe("1");
    expect(branches?.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses only the event span in an explicit time view and keeps wall time separate", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      chartXAxisMode: "time",
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    const events = [
      event(1, "line", 2, null, 100),
      event(2, "branch", 3, true, 101),
      event(3, "line", 4, null, 102),
    ];

    panel.setEvents(events);
    panel.setState(
      panelState({ status: "completed", eventCount: 3, evidence: traceEvidence(3, 30_000) }),
    );

    const chart = fixture.findByClass("trace-panel__chart");
    const points = fixture.findByData("series", "trace")?.getAttribute("points") ?? "";
    const xCoordinates = points
      .split(" ")
      .filter(Boolean)
      .map((point) => Number(point.split(",")[0]));
    expect(traceChartXAxisMode(events, "time")).toBe("time");
    expect(traceChartTimeDomain(events)).toEqual({ startMs: 100, endMs: 102, spanMs: 2 });
    expect(chart?.dataset.xMode).toBe("time");
    expect(chart?.dataset.eventSpanMs).toBe("2");
    expect(Math.max(...xCoordinates) - Math.min(...xCoordinates)).toBeGreaterThan(250);
    expect(
      walk(panel.element as unknown as FakeElement).find(
        (element) => element.dataset.traceField === "duration",
      )?.textContent,
    ).toBe("30000 ms");
  });

  it("keeps real events local, caps DOM rows and distinguishes playback from process control", () => {
    const fixture = fakeHost();
    const pause = vi.fn();
    const resume = vi.fn();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: pause,
      onResumePlayback: resume,
    });
    panel.setEvents(
      Array.from({ length: 620 }, (_, index) =>
        event(index + 1, index === 310 ? "branch" : "line", index + 2, index === 310),
      ),
    );
    panel.setState(panelState({ status: "running", eventCount: 620 }));

    expect(panel.element.dataset.traceMode).toBe("real");
    expect(fixture.findByClass("trace-panel__visual-stage")).toBeUndefined();
    expect(fixture.findByClass("trace-panel__chart")?.tagName).toBe("svg");
    expect(fixture.findByClass("trace-panel__chart")?.dataset.pointCount).toBe("80");
    expect(fixture.findByData("kind", "branch")?.tagName).toBe("circle");
    expect(fixture.findByClass("trace-panel__events")?.children).toHaveLength(500);
    expect(fixture.findByClass("trace-panel__event-count")?.textContent).toBe(
      "620 条 · 仅显示最近 500 条",
    );
    const playback = fixture.findByAction("playback");
    expect(playback?.disabled).toBe(false);
    playback?.click();
    expect(pause).toHaveBeenCalledOnce();

    panel.setState(panelState({ status: "completed", playbackPaused: true, eventCount: 620 }));
    expect(playback?.disabled).toBe(false);
    expect(playback?.textContent).toBe("继续回放");
    playback?.click();
    expect(resume).toHaveBeenCalledOnce();
    expect(fixture.findByClass("trace-panel__safety")?.textContent).toContain(
      "C 进程仍在后台继续运行",
    );
  });

  it("reports live reference-budget use and the terminal measured/reference ratio", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    panel.setReference({ inputSize: 32, referenceOperationCount: 100, label: "O(n log n) 参考" });
    panel.setEvents(Array.from({ length: 40 }, (_, index) => event(index + 1, "line", index + 2)));
    panel.setState(panelState({ status: "running", eventCount: 40 }));

    expect(fixture.findByClass("trace-panel__reference")?.textContent).toBe(
      "已消耗参考预算：0.40×（40 / 100）· n=32 · O(n log n) 参考",
    );
    expect(fixture.findByData("series", "reference")).toBeUndefined();

    panel.setState(
      panelState({ status: "completed", eventCount: 40, evidence: traceEvidence(125) }),
    );
    expect(fixture.findByClass("trace-panel__reference")?.textContent).toBe(
      "实测/参考工作量比：1.25×（125 / 100）· n=32 · O(n log n) 参考",
    );

    panel.setReference(null);
    expect(fixture.findByClass("trace-panel__reference")?.textContent).toBe(
      "实测/参考工作量比：不可用（尚未建立同规模参考）",
    );
    expect(fixture.findByClass("trace-panel__reference")?.dataset.available).toBe("false");
  });

  it("rejects non-finite reference values instead of rendering misleading ratios", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    panel.setReference({
      inputSize: 32,
      referenceOperationCount: Number.POSITIVE_INFINITY,
      label: "invalid",
    });
    panel.setState(panelState({ status: "running", eventCount: 40 }));

    expect(fixture.findByClass("trace-panel__reference")?.dataset.available).toBe("false");
    expect(fixture.findByData("series", "reference")).toBeUndefined();
  });

  it("relabels the live panel in place without losing trace state or translating external text", () => {
    const fixture = fakeHost();
    const panel = createTracePanel(fixture.host, {
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onPausePlayback: vi.fn(),
      onResumePlayback: vi.fn(),
    });
    panel.setReference({ inputSize: 8, referenceOperationCount: 10, label: "course baseline" });
    panel.setEvents([event(1, "line", 4, null, 2), event(2, "branch", 5, true, 3)]);
    panel.setState(
      panelState({
        status: "completed",
        message: "compiler supplied message",
        eventCount: 2,
        evidence: traceEvidence(12),
      }),
    );

    fixture.shell.dataset.locale = "en";
    fixture.shell.dispatch("workbench-locale-change");

    expect(panel.element.getAttribute("aria-label")).toBe("Real execution flow");
    expect(fixture.findByClass("trace-panel__title")?.textContent).toBe("Execution Flow");
    expect(fixture.findByClass("trace-panel__badge")?.textContent).toBe("✓ Completed");
    expect(fixture.findByClass("trace-panel__status")?.textContent).toBe(
      "compiler supplied message",
    );
    expect(fixture.findByClass("trace-panel__events")?.children).toHaveLength(2);
    expect(fixture.findByClass("trace-panel__event")?.textContent).toBe(
      "#1 · line 4 · statement · 2 ms",
    );
    expect(fixture.findByClass("trace-panel__reference")?.textContent).toBe(
      "Measured/reference work ratio: 1.20× (12 / 10) · n=8 · course baseline",
    );
    expect(
      walk(panel.element as unknown as FakeElement).map((element) => element.textContent),
    ).toContain("Wall time");
    expect(fixture.findByClass("trace-panel__chart-guide")?.children[0]?.textContent).toBe(
      "How to read",
    );
    expect(fixture.findByAction("chart-timeline")?.textContent).toBe("Execution Timeline");
    expect(fixture.findByAction("chart-line-hits")?.textContent).toBe("Line Hits");
    expect(fixture.findByAction("chart-branches")?.textContent).toBe("Branch Outcomes");

    fixture.shell.dataset.locale = "zh-CN";
    fixture.shell.dispatch("workbench-locale-change");
    expect(fixture.findByClass("trace-panel__title")?.textContent).toBe("运行流程");
    expect(fixture.findByClass("trace-panel__events")?.children).toHaveLength(2);
    expect(fixture.findByClass("trace-panel__status")?.textContent).toBe(
      "compiler supplied message",
    );
  });
});

function event(
  sequence: number,
  kind: TraceEvent["kind"],
  line: number,
  branchTaken: boolean | null = null,
  elapsedMs = sequence * 2.5,
): TraceEvent {
  return Object.freeze({ sequence, kind, line, branchTaken, elapsedMs });
}

function panelState(overrides: Partial<TracePanelState>): TracePanelState {
  return {
    status: "idle",
    message: "状态",
    sessionId: null,
    sourceFingerprint: null,
    playbackPaused: false,
    eventCount: 0,
    evidence: null,
    unsupported: null,
    error: null,
    ...overrides,
  };
}

function traceEvidence(operationCount: number, durationMs = 250): TraceRunEvidence {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    termination: "process-exit",
    durationMs,
    peakRssBytes: 1_024,
    peakProcessCount: 1,
    outputBytes: 8,
    executedNodeCount: 4,
    operationCount,
  };
}

function fakeHost(): {
  readonly shell: FakeElement;
  readonly host: HTMLElement;
  findByClass(className: string): FakeElement | undefined;
  findByAction(action: string): FakeElement | undefined;
  findByData(name: string, value: string): FakeElement | undefined;
} {
  const ownerDocument = new FakeDocument();
  const shell = ownerDocument.createElement("main");
  shell.setAttribute("id", "workbench-shell");
  shell.dataset.locale = "zh-CN";
  const host = ownerDocument.createElement("div");
  shell.append(host);
  return {
    shell,
    host: host as unknown as HTMLElement,
    findByClass: (className) => walk(host).find((element) => element.className === className),
    findByAction: (action) => walk(host).find((element) => element.dataset.traceAction === action),
    findByData: (name, value) =>
      walk(host).find((element) => element.getAttribute(`data-${name}`) === value),
  };
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #attributes = new Map<string, string>();
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  hidden = false;
  parent: FakeElement | null = null;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    for (const child of children) child.parent = this;
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) {
      const dataName = name
        .slice(5)
        .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
      this.dataset[dataName] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  click(): void {
    for (const listener of this.#listeners.get("click") ?? []) listener();
  }

  dispatch(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }

  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    let current: FakeElement | null = this;
    while (current !== null) {
      if (
        (selector.includes("[data-locale]") && current.dataset.locale !== undefined) ||
        (selector.includes("#workbench-shell") && current.getAttribute("id") === "workbench-shell")
      ) {
        return current as T;
      }
      current = current.parent;
    }
    return null;
  }

  cloneNode(deep = false): FakeElement {
    const clone = new FakeElement(this.tagName, this.ownerDocument);
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.type = this.type;
    clone.disabled = this.disabled;
    clone.hidden = this.hidden;
    Object.assign(clone.dataset, this.dataset);
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }
}

function walk(root: FakeElement): readonly FakeElement[] {
  return [root, ...root.children.flatMap((child) => walk(child))];
}
