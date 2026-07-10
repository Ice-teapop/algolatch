import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyTextPatches,
  createBlockIndex,
  type BlockIndexEntry,
  type CParser,
  type M3bEditPlan,
} from "../../src/core/index.js";
import {
  createStructureEditController,
  type StructureEditSession,
} from "../../src/app/structure-edit-controller.js";
import { createTestParser } from "../core/parser-fixture.js";

let parser: CParser;

beforeAll(async () => {
  parser = await createTestParser();
});

afterAll(() => {
  parser.dispose();
});

describe("structure edit controller", () => {
  const source = `int main(void) {
  int first = 1;
  int second = 2;
  return first + second;
}
`;

  it("maps an adjacent move through plan, confirmation and one exact commit", async () => {
    const events: string[] = [];
    let confirmedPlan: M3bEditPlan | undefined;
    const harness = createHarness(
      source,
      4,
      async (plan) => {
        events.push("confirm");
        confirmedPlan = plan;
        return true;
      },
      events,
    );
    const sourceEntry = statementEntry(harness.session(), "int first = 1;");
    const targetEntry = statementEntry(harness.session(), "int second = 2;");

    await harness.controller.move(sourceEntry, targetEntry);

    expect(confirmedPlan?.kind).toBe("swap-adjacent-statements");
    expect(harness.source()).toContain("int second = 2;\n  int first = 1;");
    expect(events).toEqual([
      "validate",
      "validate",
      "confirm",
      "apply",
      "reset",
      "adopt",
      "success",
    ]);
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("never applies a cancelled, stale-source, or stale-revision plan", async () => {
    const cancelled = createHarness(source, 8, () => false);
    await cancelled.controller.run(deleteRequest(cancelled.session(), "return first + second;"));
    expect(cancelled.apply).not.toHaveBeenCalled();

    const stale = createHarness(source, 10, () => true);
    const plan = stale.controller.plan(deleteRequest(stale.session(), "return first + second;"));
    stale.setSource(`${source} `);
    expect(() => stale.controller.commit(plan)).toThrow(/尚未同步/u);
    stale.setSource(source);
    stale.setSession({
      ...stale.session(),
      analysis: parser.analyze(source, 11),
    });
    expect(() => stale.controller.commit(plan)).toThrow(/已经过期/u);
    expect(stale.apply).not.toHaveBeenCalled();
  });

  it("does not commit after destruction while confirmation is pending", async () => {
    const confirmation = deferred<boolean>();
    const harness = createHarness(source, 14, () => confirmation.promise);
    const running = harness.controller.run(
      deleteRequest(harness.session(), "return first + second;"),
    );
    harness.controller.destroy();
    confirmation.resolve(true);
    await running;

    expect(harness.apply).not.toHaveBeenCalled();
  });
});

function createHarness(
  source: string,
  revision: number,
  confirm: (plan: M3bEditPlan) => boolean | Promise<boolean>,
  events: string[] = [],
) {
  let currentSource = source;
  let currentSession: StructureEditSession = {
    imported: { source, displayName: "main.c", origin: "paste" },
    analysis: parser.analyze(source, revision),
  };
  const apply = vi.fn((patches: M3bEditPlan["patches"]) => {
    events.push("apply");
    const next = applyTextPatches(currentSource, patches).source;
    const changed = next !== currentSource;
    currentSource = next;
    return changed;
  });
  const error = vi.fn();
  const controller = createStructureEditController({
    getSession: () => currentSession,
    getAnalyzer: () => parser,
    getCurrentSource: () => currentSource,
    getProjectionMode: () => "synced",
    resetProjection: () => events.push("reset"),
    validateSource: () => events.push("validate"),
    applyPatches: apply,
    confirm,
    adopt: (imported, analysis) => {
      events.push("adopt");
      currentSession = { imported, analysis };
    },
    onSuccess: () => events.push("success"),
    onError: error,
  });
  return {
    controller,
    apply,
    error,
    source: () => currentSource,
    session: () => currentSession,
    setSource: (next: string) => {
      currentSource = next;
    },
    setSession: (next: StructureEditSession) => {
      currentSession = next;
    },
  };
}

function statementEntry(session: StructureEditSession, text: string): BlockIndexEntry {
  const from = session.imported.source.indexOf(text);
  const to = from + text.length;
  const entry = createBlockIndex(session.analysis.document).entries.find(
    (candidate) => candidate.block?.range.from === from && candidate.block.range.to === to,
  );
  if (entry === undefined) throw new Error(`缺少 statement entry：${text}`);
  return entry;
}

function deleteRequest(session: StructureEditSession, text: string) {
  const target = session.analysis.statementEdits.statements.find(
    (candidate) => session.imported.source.slice(candidate.range.from, candidate.range.to) === text,
  );
  if (target === undefined) throw new Error(`缺少 statement target：${text}`);
  return {
    kind: "delete-statement" as const,
    baseRevision: session.analysis.statementEdits.revision,
    targetId: target.id,
    expectedTargetText: text,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("deferred 未初始化");
  return { promise, resolve: resolvePromise };
}
