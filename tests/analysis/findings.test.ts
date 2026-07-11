import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type AnalysisFinding,
  type ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";
import type { CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a deterministic findings foundation", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("reports each maximal unreachable primary range once", () => {
    const analysis = inspect(
      parser,
      "int f(int x) { return x; int y = 1; while (x) { y++; } y = 2; }",
    );
    const unreachable = findingsFor(analysis, "unreachable-code");

    expect(unreachable.map((finding) => selectedText(analysis, finding))).toEqual([
      "int y = 1;",
      "while (x) { y++; }",
      "y = 2;",
    ]);
    expect(unreachable.every((finding) => finding.confidence === "certain")).toBe(true);
    expect(
      unreachable.every(
        (finding) => finding.evidence.length === 1 && finding.evidence[0]?.role === "unreachable",
      ),
    ).toBe(true);
  });

  it("collapses a wholly unreachable do-while without hiding a reachable body", () => {
    const wholeLoop = inspect(parser, "int f(int x) { return x; do { x++; x += 2; } while (x); }");
    const conditionOnly = inspect(parser, "int f(int x) { do { return x; } while (x); }");

    expect(
      findingsFor(wholeLoop, "unreachable-code").map((finding) => selectedText(wholeLoop, finding)),
    ).toEqual(["do { x++; x += 2; } while (x);"]);
    expect(
      findingsFor(conditionOnly, "unreachable-code").map((finding) =>
        selectedText(conditionOnly, finding),
      ),
    ).toEqual(["(x)"]);
  });

  it("does not mark an executed for initializer as part of an unreachable owner", () => {
    const analysis = inspect(parser, "int f(int x) { for (exit(1); x; abort()) x--; return x; }");

    expect(
      findingsFor(analysis, "unreachable-code").map((finding) => selectedText(analysis, finding)),
    ).toEqual(["x--;", "return x;"]);
  });

  it("reports a read only when every reaching definition is uninitialized", () => {
    const allPaths = inspect(
      parser,
      "int f(int c) { int x; if (c) { c++; } else { c--; } return x; }",
    );
    const partialPath = inspect(parser, "int f(int c) { int x; if (c) x = 1; return x; }");

    expect(findingsFor(allPaths, "uninitialized-read")).toHaveLength(1);
    expect(findingsFor(allPaths, "uninitialized-read")[0]).toMatchObject({
      subject: "x",
      confidence: "certain",
      reason: "all-reaching-definitions-uninitialized",
    });
    expect(findingsFor(partialPath, "uninitialized-read")).toEqual([]);
  });

  it("recognizes self-initialization without treating an arbitrary empty reaching set as proof", () => {
    const self = inspect(parser, "int f(void) { int x = x; return x; }");
    const finding = findingsFor(self, "uninitialized-read")[0];

    expect(finding).toBeDefined();
    expect(selectedText(self, finding!)).toBe("x");
    expect(finding?.reason).toBe("no-reaching-definition");
    expect(finding?.evidence.map((evidence) => evidence.role)).toEqual(["definition", "use"]);
  });

  it("stays silent after a possible write, escape, or for unreachable reads", () => {
    const weakWrite = inspect(parser, 'int f(void) { int x; scanf("%d", &x); return x; }');
    const escaped = inspect(parser, "int f(void) { int x; int *p = &x; sink(p); return x; }");
    const unreachable = inspect(parser, "int f(void) { int x; return 0; sink(x); }");
    const staticLocal = inspect(parser, "int f(void) { static int x; return x; }");
    const conditional = inspect(parser, "int f(void) { int x; return 0 && x; }");

    expect(findingsFor(weakWrite, "uninitialized-read")).toEqual([]);
    expect(findingsFor(escaped, "uninitialized-read")).toEqual([]);
    expect(findingsFor(unreachable, "uninitialized-read")).toEqual([]);
    expect(findingsFor(staticLocal, "uninitialized-read")).toEqual([]);
    expect(findingsFor(conditional, "uninitialized-read")).toEqual([]);
    expect(findingsFor(unreachable, "unreachable-code")).toHaveLength(1);
  });

  it("maps an auxiliary for-header use back to its primary loop owner", () => {
    const analysis = inspect(
      parser,
      "int f(void) { int x; for (int i = x; i < 2; i++) { } return 0; }",
    );
    const finding = findingsFor(analysis, "uninitialized-read")[0];
    const functionCfg = analysis.snapshot.functions[0];
    const owner = functionCfg?.nodes.find((node) => node.id === finding?.ownerNodeId);

    expect(finding).toBeDefined();
    expect(owner).toMatchObject({ ownership: "primary", nodeType: "for_statement" });
    expect(
      owner !== undefined &&
        finding !== undefined &&
        finding.primaryRange.from >= owner.range.from &&
        finding.primaryRange.to <= owner.range.to,
    ).toBe(true);
  });

  it("publishes no findings for partial or otherwise disabled functions", () => {
    const partial = inspect(parser, "int f(int x) { goto missing; return x; }");
    const disabled = inspect(parser, "#define READ(v) (v)\nint f(void) { int x; return READ(x); }");

    expect(partial.snapshot.findings).toEqual([]);
    expect(disabled.snapshot.findings).toEqual([]);
  });

  it("is source ordered, deterministic and deeply frozen", () => {
    const source = "int f(void) { int x; sink(x); return 0; x++; }";
    const first = inspect(parser, source).snapshot.findings;
    const second = inspect(parser, source).snapshot.findings;

    expect(first).toEqual(second);
    expect(first.map((finding) => finding.primaryRange.from)).toEqual(
      [...first].map((finding) => finding.primaryRange.from).sort((left, right) => left - right),
    );
    expect(new Set(first.map((finding) => finding.id)).size).toBe(first.length);
    expect(deeplyFrozen(first)).toBe(true);
  });
});

interface InspectedProgram {
  readonly source: string;
  readonly snapshot: ProgramAnalysisSnapshot;
}

function inspect(parser: CParser, source: string): InspectedProgram {
  return parser.inspect(source, 1, ({ rootNode, document }) =>
    Object.freeze({
      source,
      snapshot: analyzeProgramCst({ source, revision: 1, rootNode, document }),
    }),
  ).result;
}

function findingsFor(
  analysis: InspectedProgram,
  ruleId: AnalysisFinding["ruleId"],
): readonly AnalysisFinding[] {
  return analysis.snapshot.findings.filter((finding) => finding.ruleId === ruleId);
}

function selectedText(analysis: InspectedProgram, finding: AnalysisFinding): string {
  return analysis.source.slice(finding.primaryRange.from, finding.primaryRange.to);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
