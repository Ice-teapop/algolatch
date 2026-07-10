import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSourceSyncController,
  type SourceAnalysisLike,
} from "../../src/app/source-sync-controller.js";
import { textRange, type ParseSummary } from "../../src/core/model.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("source sync controller", () => {
  it("debounces direct edits and analyzes only the latest exact source", () => {
    vi.useFakeTimers();
    const harness = createHarness(50);

    harness.setCurrent("one");
    harness.controller.handleSourceChange("one", "edit");
    harness.setCurrent("two");
    harness.controller.handleSourceChange("two", "edit");
    expect(harness.pending).toEqual(["one:edit", "two:edit"]);
    expect(harness.analyzed).toEqual([]);

    vi.advanceTimersByTime(49);
    expect(harness.analyzed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(harness.analyzed).toEqual(["two"]);
    expect(harness.adopted).toEqual(["two:synced:edit"]);
  });

  it("processes undo immediately and skips an already synchronized source", () => {
    const harness = createHarness(100);
    harness.setDisplayed("base");
    harness.setCurrent("base");
    harness.controller.handleSourceChange("base", "edit");
    expect(harness.analyzed).toEqual([]);

    harness.setCurrent("undo");
    harness.controller.handleSourceChange("undo", "undo");
    expect(harness.analyzed).toEqual(["undo"]);
    expect(harness.controller.getMode()).toBe("synced");
  });

  it("adopts small recovery but holds the previous tree for impact above thirty percent", () => {
    const harness = createHarness(0);
    harness.setAnalysis("small", parse(true, [textRange(0, 1)], []));
    harness.setCurrent("small");
    harness.controller.handleSourceChange("small", "edit");
    expect(harness.adopted).toEqual(["small:recovery:edit"]);
    expect(harness.controller.getMode()).toBe("recovery");

    harness.setAnalysis("large-error", parse(true, [textRange(0, 8)], []));
    harness.setCurrent("large-error");
    harness.controller.handleSourceChange("large-error", "edit");
    expect(harness.held).toEqual(["large-error:recovery-impact:edit"]);
    expect(harness.controller.getMode()).toBe("held");
  });

  it("re-analyzes the displayed source when recovering from a held projection", () => {
    const harness = createHarness(0);
    harness.setDisplayed("stable");
    harness.setCurrent("broken-source");
    harness.setAnalysis("broken-source", parse(true, [textRange(0, 8)], []));
    harness.controller.handleSourceChange("broken-source", "edit");
    expect(harness.controller.getMode()).toBe("held");

    harness.setCurrent("stable");
    harness.controller.handleSourceChange("stable", "undo");
    expect(harness.analyzed).toEqual(["broken-source", "stable"]);
    expect(harness.controller.getMode()).toBe("synced");
  });

  it("drops stale timers and pending work after destroy", () => {
    vi.useFakeTimers();
    const harness = createHarness(20);
    harness.setCurrent("pending");
    harness.controller.handleSourceChange("pending", "edit");
    harness.controller.destroy();
    vi.runAllTimers();

    expect(harness.analyzed).toEqual([]);
    harness.controller.handleSourceChange("ignored", "edit");
    expect(harness.pending).toEqual(["pending:edit"]);
  });

  it("resets pending work after an external source replacement", () => {
    vi.useFakeTimers();
    const harness = createHarness(20);
    harness.setCurrent("typed");
    harness.controller.handleSourceChange("typed", "edit");

    harness.controller.reset("recovery");
    vi.runAllTimers();

    expect(harness.analyzed).toEqual([]);
    expect(harness.controller.getMode()).toBe("recovery");
    expect(() => harness.controller.reset("held" as never)).toThrow(/reset mode/u);
  });

  it("holds on host validation or analyzer failure", () => {
    const harness = createHarness(0);
    harness.rejectSource("bad");
    harness.setCurrent("bad");
    harness.controller.handleSourceChange("bad", "redo");
    expect(harness.held).toEqual(["bad:analysis-failed:redo"]);
  });

  it("turns a current-source lookup failure into a held analysis failure", () => {
    const harness = createHarness(0);
    harness.failCurrentLookup();
    harness.controller.handleSourceChange("lookup", "undo");

    expect(harness.held).toEqual(["lookup:analysis-failed:undo"]);
    expect(harness.controller.getMode()).toBe("held");
  });
});

function createHarness(delayMs: number) {
  let current = "";
  let currentLookupError: Error | null = null;
  let displayed: string | null = null;
  const analyses = new Map<string, ParseSummary>();
  const rejected = new Set<string>();
  const pending: string[] = [];
  const analyzed: string[] = [];
  const adopted: string[] = [];
  const held: string[] = [];
  const controller = createSourceSyncController({
    delayMs,
    getCurrentSource: () => {
      if (currentLookupError !== null) throw currentLookupError;
      return current;
    },
    getDisplayedSource: () => displayed,
    validateSource(source) {
      if (rejected.has(source)) throw new Error("rejected");
    },
    analyze(source): SourceAnalysisLike {
      analyzed.push(source);
      return { document: { source, parse: analyses.get(source) ?? parse(false, [], []) } };
    },
    onPending: (source, reason) => pending.push(`${source}:${reason}`),
    onAdopt: (source, _analysis, mode, reason) => {
      displayed = source;
      adopted.push(`${source}:${mode}:${reason}`);
    },
    onHold: (source, detail, reason) => held.push(`${source}:${detail.kind}:${reason}`),
  });
  return {
    controller,
    pending,
    analyzed,
    adopted,
    held,
    setCurrent: (source: string) => {
      current = source;
    },
    setDisplayed: (source: string) => {
      displayed = source;
    },
    setAnalysis: (source: string, value: ParseSummary) => analyses.set(source, value),
    rejectSource: (source: string) => rejected.add(source),
    failCurrentLookup: () => {
      currentLookupError = new Error("lookup failed");
    },
  };
}

function parse(
  hasError: boolean,
  errorRanges: ParseSummary["errorRanges"],
  missingOffsets: ParseSummary["missingOffsets"],
): ParseSummary {
  return Object.freeze({ mode: "tree-sitter", hasError, errorRanges, missingOffsets });
}
