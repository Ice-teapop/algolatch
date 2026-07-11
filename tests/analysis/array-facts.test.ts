import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type AnalysisFinding,
  type FunctionDefUse,
  type ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";
import type { CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a fixed-array facts and literal bounds", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("publishes exact rank-one shape/access facts and both certain OOB reasons", () => {
    const analysis = inspect(parser, "int f(void) { int a[3]; a[-1] = 0; return a[3]; }");
    const defUse = onlyDefUse(analysis.snapshot);
    const findings = literalFindings(analysis.snapshot);

    expect(defUse.arrayShapes).toHaveLength(1);
    expect(defUse.arrayShapes[0]).toMatchObject({
      dimensions: [{ dimension: 0, extent: 3 }],
    });
    expect(defUse.arrayAccesses.map((access) => access.indices[0]?.literalIndex)).toEqual([-1, 3]);
    expect(findings.map((finding) => finding.reason)).toEqual([
      "negative-literal-index",
      "literal-index-not-less-than-extent",
    ]);
    expect(findings.map((finding) => selectedText(analysis, finding))).toEqual(["-1", "3"]);
    expect(findings.every((finding) => finding.confidence === "certain")).toBe(true);
    expect(findings.map((finding) => finding.evidence.map((entry) => entry.role))).toEqual([
      ["bound", "index"],
      ["bound", "index"],
    ]);
  });

  it("allows an exact one-past address but rejects addresses beyond either end", () => {
    const analysis = inspect(
      parser,
      "int f(void) { int a[3]; int *p = &((a[3])); int *q = &a[4]; int *r = &a[-1]; int *s = &*&a[3]; int *t = &(*(&a[3])); return (p == q) + (r == p) + (s == t); }",
    );

    expect(
      literalFindings(analysis.snapshot).map((finding) => [
        finding.reason,
        selectedText(analysis, finding),
      ]),
    ).toEqual([
      ["literal-index-not-less-than-extent", "4"],
      ["negative-literal-index", "-1"],
    ]);
  });

  it("does not preserve the one-past address allowance through direct dereference", () => {
    const analyses = [
      "int f(void) { int a[3]; return *&a[3]; }",
      "int f(void) { int a[3]; return *(&a[3]); }",
    ].map((source) => inspect(parser, source));

    expect(
      analyses.map((analysis) =>
        onlyDefUse(analysis.snapshot).arrayAccesses.map((access) => access.mode),
      ),
    ).toEqual([["value"], ["value"]]);
    expect(
      analyses.map((analysis) =>
        literalFindings(analysis.snapshot).map((finding) => selectedText(analysis, finding)),
      ),
    ).toEqual([["3"], ["3"]]);
  });

  it("keeps parameter arrays, VLAs, pointers, multidimensional and reversed syntax out of scope", () => {
    const analysis = inspect(
      parser,
      [
        "int parameter(int a[3]) { return a[3]; }",
        "int vla(int n) { int a[n]; return a[3]; }",
        "int pointer(void) { int a[3]; int *p = a; return p[3]; }",
        "int multidimensional(void) { int a[2][3]; return a[2][0]; }",
        "int inferred_outer(void) { int a[][3] = {{0}, {0}, {0}, {0}}; return a[3][0]; }",
        "int reversed(void) { int a[3]; return 3[a]; }",
      ].join("\n"),
    );

    expect(literalFindings(analysis.snapshot)).toEqual([]);
    expect(analysis.snapshot.defUse[0]?.arrayShapes).toEqual([]);
    expect(analysis.snapshot.defUse[1]?.arrayShapes).toEqual([]);
    expect(analysis.snapshot.defUse[2]?.arrayAccesses).toEqual([]);
    expect(analysis.snapshot.defUse[3]?.arrayShapes).toEqual([]);
    expect(analysis.snapshot.defUse[4]?.arrayShapes).toEqual([]);
    expect(analysis.snapshot.defUse[5]?.arrayAccesses).toEqual([]);
  });

  it("rejects suffixes, non-decimal forms, constant expressions and unsafe integers", () => {
    const analysis = inspect(
      parser,
      [
        "int octal(void) { int a[03]; return a[3]; }",
        "int suffix_bound(void) { int a[3U]; return a[3]; }",
        "int expression(void) { int a[1 + 2]; return a[3]; }",
        "int suffix_index(void) { int a[3]; return a[3U]; }",
        "int hex_index(void) { int a[3]; return a[0x3]; }",
        "int huge(void) { int a[3]; return a[9007199254740992]; }",
        "int unsigned_negative(void) { int a[3]; return a[-1U]; }",
      ].join("\n"),
    );

    expect(literalFindings(analysis.snapshot)).toEqual([]);
  });

  it("omits unevaluated, expression-conditional and definitely dead accesses", () => {
    const analysis = inspect(
      parser,
      [
        "int expressions(int c) { int a[3]; return sizeof(a[9]) + (c && a[3]) + (c ? a[3] : 0); }",
        "int dead(void) { int a[3]; if (0) return a[3]; while (0) a[3] = 1; for (; 0;) a[3] = 2; return 0; }",
        "int switched(void) { int a[3]; switch (0) { case 1: return a[3]; default: return 0; } }",
        "#include <stdbool.h>",
        "int builtin_false(void) { int a[3]; if (false) return a[3]; return 0; }",
        "#include <stddef.h>",
        "int builtin_null(void) { int a[3]; if (NULL) return a[3]; return 0; }",
        "int choose_expr(void) { int a[3]; return __builtin_choose_expr(0, a[3], 0); }",
        "int constant_p(void) { int a[3]; return __builtin_constant_p(a[3]); }",
        "int constant_control(void) { int a[3]; if (1 - 1) return a[3]; return 0; }",
        "enum { NEVER = 0 };",
        "int enum_control(void) { int a[3]; if (NEVER) return a[3]; return 0; }",
        "int short_and(int c) { int a[3]; if (c && 0) return a[3]; return 0; }",
        "int short_while(int c) { int a[3]; while (c && 0) return a[3]; return 0; }",
        "int short_for(int c) { int a[3]; for (; c && 0;) return a[3]; return 0; }",
        "int short_else(int c) { int a[3]; if (c || 1) return 0; else return a[3]; }",
        "int unsupported_composite(int c) { int a[3]; if (c * 0) return a[3]; return 0; }",
        "int comma_control(int c) { int a[3]; if ((c, 0)) return a[3]; return 0; }",
        "int ternary_control(int c) { int a[3]; if (c ? 0 : 0) return a[3]; return 0; }",
        "int sizeof_control(int c) { int a[3]; if (sizeof(c)) return 0; else return a[3]; }",
        "int local_zero(void) { int a[3]; int c = 0; if (c) return a[3]; return 0; }",
        "int local_one(void) { int a[3]; int c = 1; if (c) return 0; else return a[3]; }",
        "int array_truth(void) { int a[3], b[3]; if (a) return 0; else return b[3]; }",
        "int array_not(void) { int a[3], b[3]; if (!a) return b[3]; return 0; }",
      ].join("\n"),
    );

    expect(literalFindings(analysis.snapshot)).toEqual([]);
    expect(analysis.snapshot.defUse.flatMap((defUse) => defUse.arrayAccesses)).toHaveLength(2);
    expect(
      analysis.snapshot.defUse
        .flatMap((defUse) => defUse.arrayAccesses)
        .every((access) => access.execution === "conditional"),
    ).toBe(true);
  });

  it("fails closed for parameter-controlled branches with or without later definitions", () => {
    const analyses = [
      "int f(int c) { int a[3]; if (c) return a[3]; return 0; }",
      "int f(int c) { int a[3]; c = 0; if (c) return a[3]; return 0; }",
      "int f(int c) { int a[3]; c = 1; if (c) return 0; else return a[3]; }",
      "int f(int p[3]) { int a[3]; if (p) return a[3]; return 0; }",
    ].map((source) => inspect(parser, source));

    expect(analyses.map((analysis) => literalFindings(analysis.snapshot))).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(
      analyses.map((analysis) => ({
        status: onlyDefUse(analysis.snapshot).status,
        shapes: onlyDefUse(analysis.snapshot).arrayShapes.length,
      })),
    ).toEqual([
      { status: "complete", shapes: 1 },
      { status: "complete", shapes: 1 },
      { status: "complete", shapes: 1 },
      { status: "complete", shapes: 1 },
    ]);
  });

  it("uses binding identity for shadowed arrays and points to the matching bound", () => {
    const analysis = inspect(parser, "int f(void) { int a[3]; { int a[5]; return a[5]; } }");
    const finding = literalFindings(analysis.snapshot)[0];
    if (finding === undefined) throw new Error("fixture 缺少 OOB finding");

    expect(finding.subject).toBe("a");
    expect(
      analysis.source.slice(finding.evidence[0]!.range.from, finding.evidence[0]!.range.to),
    ).toBe("5");
    expect(finding.subjectVariableId).toBe(
      onlyDefUse(analysis.snapshot).arrayShapes[1]?.variableId,
    );
  });

  it("keeps multi-declarator bounds separate and analyzes ordinary call arguments", () => {
    const analysis = inspect(
      parser,
      "int sink(int); int f(void) { int a[2], b[4]; return sink(a[2]) + sink(b[4]); }",
    );
    const defUse = onlyDefUse(analysis.snapshot);
    const findings = literalFindings(analysis.snapshot);

    expect(defUse.arrayShapes.map((shape) => shape.dimensions[0]?.extent)).toEqual([2, 4]);
    expect(findings.map((finding) => selectedText(analysis, finding))).toEqual(["2", "4"]);
    expect(
      findings.map((finding) =>
        analysis.source.slice(finding.evidence[0]!.range.from, finding.evidence[0]!.range.to),
      ),
    ).toEqual(["2", "4"]);
  });

  it("maps a for-header access to the primary loop owner", () => {
    const analysis = inspect(
      parser,
      "int f(void) { int a[3]; for (int i = a[3]; i < 1; i++) { } return 0; }",
    );
    const finding = literalFindings(analysis.snapshot)[0];
    const cfg = analysis.snapshot.functions[0];
    const owner = cfg?.nodes.find((node) => node.id === finding?.ownerNodeId);

    expect(finding).toBeDefined();
    expect(owner).toMatchObject({ ownership: "primary", nodeType: "for_statement" });
  });

  it("does not duplicate a read-modify-write access and excludes persistent or pointer arrays", () => {
    const ordinary = inspect(parser, "int f(void) { int a[3]; return a[3]++; }");
    const excluded = inspect(
      parser,
      "int f(void) { static int a[3]; int *b[3]; return a[3] + (b[3] != 0); }",
    );

    expect(onlyDefUse(ordinary.snapshot).arrayAccesses).toHaveLength(1);
    expect(literalFindings(ordinary.snapshot)).toHaveLength(1);
    expect(onlyDefUse(excluded.snapshot).arrayShapes).toEqual([]);
    expect(literalFindings(excluded.snapshot)).toEqual([]);
  });

  it("publishes empty facts for disabled functions and freezes deterministic facts deeply", () => {
    const disabled = inspect(
      parser,
      "#define AT(a, i) ((a)[i])\nint f(void) { int a[3]; return AT(a, 3); }",
    );
    const source = "int f(void) { int a[3]; return a[3]; }";
    const first = inspect(parser, source).snapshot.defUse[0];
    const second = inspect(parser, source).snapshot.defUse[0];

    expect(disabled.snapshot.defUse[0]?.status).toBe("disabled");
    expect(disabled.snapshot.defUse[0]?.arrayShapes).toEqual([]);
    expect(disabled.snapshot.defUse[0]?.arrayAccesses).toEqual([]);
    expect(first?.arrayShapes).toEqual(second?.arrayShapes);
    expect(first?.arrayAccesses).toEqual(second?.arrayAccesses);
    expect(deeplyFrozen(first?.arrayShapes)).toBe(true);
    expect(deeplyFrozen(first?.arrayAccesses)).toBe(true);
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

function onlyDefUse(snapshot: ProgramAnalysisSnapshot): FunctionDefUse {
  const defUse = snapshot.defUse[0];
  if (defUse === undefined || snapshot.defUse.length !== 1) throw new Error("fixture 函数数量异常");
  return defUse;
}

function literalFindings(snapshot: ProgramAnalysisSnapshot): readonly AnalysisFinding[] {
  return snapshot.findings.filter((finding) => finding.ruleId === "literal-out-of-bounds");
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
