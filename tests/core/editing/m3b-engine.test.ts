import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTextPatches,
  M3bEditError,
  planM3bEdit,
  textRange,
  type CAnalysisSnapshot,
  type CParser,
  type M3bEditAnalyzer,
  type M3bEditErrorCode,
  type StatementEditTarget,
  type SymbolRecord,
} from "../../../src/core/index.js";
import { createTestParser } from "../parser-fixture.js";

let parser: CParser;

beforeAll(async () => {
  parser = await createTestParser();
});

afterAll(() => {
  parser.dispose();
});

describe("M3b parser integration", () => {
  it("captures pure-value statement facts before tree disposal and accepts leading trivia roots", () => {
    const source = "\nint main(void) {\n  return 0;\n}\n";
    const analysis = parser.analyze(source, 4);
    const target = requireStatement(source, analysis, "return 0;");

    expect(analysis.statementEdits).toMatchObject({ revision: 4, sourceLength: source.length });
    expect(target.nodeType).toBe("return_statement");
    expect(Object.isFrozen(analysis.statementEdits)).toBe(true);
    expect(Object.isFrozen(analysis.statementEdits.statements)).toBe(true);
    expect(JSON.stringify(analysis.statementEdits)).not.toContain("rootNode");
  });

  it("plans local rename through a parser-owned short-lived tree", () => {
    const source = "int main(void){ int count=1; return count; }\n";
    const analysis = parser.analyze(source, 5);
    const symbol = requireSymbol(analysis, "count", "local-variable");

    const first = parser.planLocalRename(source, analysis, {
      symbolId: symbol.id,
      expectedOldName: symbol.name,
      newName: "total",
    });
    const second = parser.planLocalRename(source, analysis, {
      symbolId: symbol.id,
      expectedOldName: symbol.name,
      newName: "result",
    });

    expect(first.patches).toHaveLength(2);
    expect(second.patches).toHaveLength(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect("rootNode" in first).toBe(false);
  });
});

describe("M3b validated statement engine", () => {
  it("inserts exactly one declaration while preserving BOM and CRLF byte-for-byte", () => {
    const source = "\uFEFFint main(void) {\r\n  return 0;\r\n}\r\n";
    const revision = 11;
    const analysis = parser.analyze(source, revision);
    const target = requireStatement(source, analysis, "return 0;");
    const validations: string[] = [];

    const plan = planM3bEdit(
      {
        source,
        analysis,
        analyzer: parser,
        validateSource(candidate) {
          validations.push(candidate);
        },
      },
      {
        kind: "insert-statement",
        baseRevision: revision,
        targetId: target.id,
        expectedTargetText: "return 0;",
        position: "before",
        statementText: "int value = 1;",
      },
    );

    const expected = "\uFEFFint main(void) {\r\n  int value = 1;\r\n  return 0;\r\n}\r\n";
    expect(Buffer.from(plan.candidateSource)).toEqual(Buffer.from(expected));
    expect(plan).toMatchObject({
      kind: "insert-statement",
      baseRevision: revision,
      candidateRevision: revision + 1,
      requiresConfirmation: true,
      semanticValidationRequired: false,
    });
    expect(validations).toEqual([source, expected]);
    expect(applyTextPatches(plan.candidateSource, plan.inversePatches).source).toBe(source);
    assertDeepPlanFrozen(plan);
  });

  it("rejects a BOM-disguised directive only after candidate reparse", () => {
    const source = "int main(void) {\n  return 0;\n}\n";
    const revision = 12;
    const analysis = parser.analyze(source, revision);
    const target = requireStatement(source, analysis, "return 0;");

    expectM3bError(
      () =>
        planM3bEdit(
          { source, analysis, analyzer: parser, validateSource: () => undefined },
          {
            kind: "insert-statement",
            baseRevision: revision,
            targetId: target.id,
            expectedTargetText: "return 0;",
            position: "before",
            // The raw lexical guard does not treat an interior BOM as trivia.
            // Full reparse must still reject the line as recovery/preprocessor shape.
            statementText: "\uFEFF#define DISGUISED 1",
          },
        ),
      ["CANDIDATE_PARSE_ERROR", "CANDIDATE_POSTCONDITION_FAILED"],
    );
  });

  it("replaces a required control body with one semantic empty statement", () => {
    const source = [
      "int main(int ready) {",
      "  if (ready)",
      "    update();",
      "  return ready;",
      "}",
      "",
    ].join("\n");
    const revision = 13;
    const analysis = parser.analyze(source, revision);
    const target = requireStatement(source, analysis, "update();");
    const plan = planM3bEdit(
      { source, analysis, analyzer: parser, validateSource: () => undefined },
      {
        kind: "delete-statement",
        baseRevision: revision,
        targetId: target.id,
        expectedTargetText: "update();",
      },
    );

    expect(plan.candidateSource).toContain("  if (ready)\n    ;\n");
    const emptyBodies = plan.candidateAnalysis.statementEdits.statements.filter(
      (entry) =>
        entry.parentMode === "required-body" &&
        plan.candidateSource.slice(entry.range.from, entry.range.to) === ";",
    );
    expect(emptyBodies).toHaveLength(1);
    expect(emptyBodies[0]?.nodeType).toBe("expression_statement");
  });

  it("deletes one list target and swaps only same-parent adjacent text with comments", () => {
    const source = [
      "int main(void) {",
      "  // A",
      "  first();",
      "  // B",
      "  second();",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const revision = 14;
    const analysis = parser.analyze(source, revision);
    const first = requireStatement(source, analysis, "first();");
    const second = requireStatement(source, analysis, "second();");
    const swapped = planM3bEdit(
      { source, analysis, analyzer: parser, validateSource: () => undefined },
      {
        kind: "swap-adjacent-statements",
        baseRevision: revision,
        targetId: first.id,
        expectedTargetText: "first();",
        adjacentTargetId: second.id,
        expectedAdjacentTargetText: "second();",
      },
    );

    expect(swapped.candidateSource).toContain("  // B\n  second();\n  // A\n  first();\n");
    if (swapped.kind !== "swap-adjacent-statements") throw new Error("错误的 swap plan 类型");
    expect(swapped.targetIds).toEqual([first.id, second.id]);

    const swappedAnalysis = swapped.candidateAnalysis;
    const returnTarget = requireStatement(swapped.candidateSource, swappedAnalysis, "return 0;");
    const deleted = planM3bEdit(
      {
        source: swapped.candidateSource,
        analysis: swappedAnalysis,
        analyzer: parser,
        validateSource: () => undefined,
      },
      {
        kind: "delete-statement",
        baseRevision: swapped.candidateRevision,
        targetId: returnTarget.id,
        expectedTargetText: "return 0;",
      },
    );
    expect(deleted.candidateSource).not.toContain("return 0;");
    expect(deleted.candidateAnalysis.document.parse.hasError).toBe(false);
  });

  it("rejects stale source and revision before applying raw statement patches", () => {
    const source = "int main(void) {\n  first();\n  return 0;\n}\n";
    const analysis = parser.analyze(source, 20);
    const target = requireStatement(source, analysis, "first();");
    const request = {
      kind: "delete-statement" as const,
      baseRevision: 20,
      targetId: target.id,
      expectedTargetText: "first();",
    };

    expectM3bError(
      () =>
        planM3bEdit(
          {
            source: source.replace("first", "other"),
            analysis,
            analyzer: parser,
            validateSource: () => undefined,
          },
          request,
        ),
      ["STALE_M3B_EDIT"],
    );
    expectM3bError(
      () =>
        planM3bEdit(
          { source, analysis, analyzer: parser, validateSource: () => undefined },
          { ...request, baseRevision: 19 },
        ),
      ["STALE_M3B_EDIT"],
    );
  });

  it("rejects cleanly parsed swap candidates whose same-parent shape facts do not exchange", () => {
    const source = "int main(void) {\n  first();\n  second();\n  return 0;\n}\n";
    const revision = 21;
    const analysis = parser.analyze(source, revision);
    const first = requireStatement(source, analysis, "first();");
    const second = requireStatement(source, analysis, "second();");
    const analyzer: M3bEditAnalyzer = {
      planLocalRename: parser.planLocalRename.bind(parser),
      analyze(candidateSource, candidateRevision) {
        const real = parser.analyze(candidateSource, candidateRevision);
        if (candidateSource === source) return real;
        const statements = real.statementEdits.statements.map((entry) =>
          candidateSource.slice(entry.range.from, entry.range.to) === "second();"
            ? Object.freeze({ ...entry, nodeType: "return_statement" })
            : entry,
        );
        return Object.freeze({
          ...real,
          statementEdits: Object.freeze({
            ...real.statementEdits,
            statements: Object.freeze(statements),
          }),
        });
      },
    };

    expectM3bError(
      () =>
        planM3bEdit(
          { source, analysis, analyzer, validateSource: () => undefined },
          {
            kind: "swap-adjacent-statements",
            baseRevision: revision,
            targetId: first.id,
            expectedTargetText: "first();",
            adjacentTargetId: second.id,
            expectedAdjacentTargetText: "second();",
          },
        ),
      ["CANDIDATE_POSTCONDITION_FAILED"],
    );
  });

  it("rejects candidate snapshots whose projected blocks do not render the candidate source", () => {
    const source = "int main(void) {\n  return 0;\n}\n";
    const revision = 22;
    const analysis = parser.analyze(source, revision);
    const target = requireStatement(source, analysis, "return 0;");
    const analyzer: M3bEditAnalyzer = {
      planLocalRename: parser.planLocalRename.bind(parser),
      analyze(candidateSource, candidateRevision) {
        const real = parser.analyze(candidateSource, candidateRevision);
        if (candidateSource === source) return real;
        const firstBlock = real.document.blocks[0];
        if (firstBlock === undefined) throw new Error("候选分析缺少 block");
        return Object.freeze({
          ...real,
          document: Object.freeze({
            ...real.document,
            blocks: Object.freeze([firstBlock, ...real.document.blocks]),
          }),
        });
      },
    };

    expectM3bError(
      () =>
        planM3bEdit(
          { source, analysis, analyzer, validateSource: () => undefined },
          {
            kind: "insert-statement",
            baseRevision: revision,
            targetId: target.id,
            expectedTargetText: "return 0;",
            position: "before",
            statementText: "prepare();",
          },
        ),
      ["CANDIDATE_ANALYSIS_FAILED"],
    );
  });
});

describe("M3b validated local rename engine", () => {
  it("keeps declaration/use counts, exact trivia and an explicit semantic acceptance flag", () => {
    const source = [
      "\uFEFFint main(void) {",
      "  // 中文 count 😀",
      "  int count = 1;",
      "  count += count;",
      "  return count;",
      "}",
      "",
    ].join("\r\n");
    const revision = 30;
    const analysis = parser.analyze(source, revision);
    const symbol = requireSymbol(analysis, "count", "local-variable");
    const plan = planM3bEdit(
      { source, analysis, analyzer: parser, validateSource: () => undefined },
      {
        kind: "local-variable-rename",
        baseRevision: revision,
        symbolId: symbol.id,
        expectedOldName: "count",
        newName: "total",
      },
    );

    expect(plan).toMatchObject({
      kind: "local-variable-rename",
      symbolId: symbol.id,
      requiresConfirmation: true,
      semanticValidationRequired: true,
    });
    expect(plan.diffs).toHaveLength(4);
    expect(plan.candidateSource).toContain("// 中文 count 😀\r\n");
    expect(plan.candidateSource).toContain("int total = 1;\r\n  total += total;");
    expect(applyTextPatches(plan.candidateSource, plan.inversePatches).source).toBe(source);
    assertDeepPlanFrozen(plan);
  });

  it("rejects a candidate analysis that shifts one renamed use while keeping role counts", () => {
    const source = "int main(void){ int item=1; item++; return item; }\n";
    const revision = 31;
    const analysis = parser.analyze(source, revision);
    const symbol = requireSymbol(analysis, "item", "local-variable");
    const analyzer: M3bEditAnalyzer = {
      planLocalRename: parser.planLocalRename.bind(parser),
      analyze(candidateSource, candidateRevision) {
        const real = parser.analyze(candidateSource, candidateRevision);
        if (candidateSource === source) return real;
        const renamed = requireSymbol(real, "entry", "local-variable");
        let shifted = false;
        const occurrences = real.document.symbols.occurrences.map((occurrence) => {
          if (!shifted && occurrence.symbolId === renamed.id && occurrence.role === "use") {
            shifted = true;
            return Object.freeze({
              ...occurrence,
              range: textRange(occurrence.range.from + 1, occurrence.range.to + 1),
            });
          }
          return occurrence;
        });
        return Object.freeze({
          ...real,
          document: Object.freeze({
            ...real.document,
            symbols: Object.freeze({
              symbols: real.document.symbols.symbols,
              occurrences: Object.freeze(occurrences),
            }),
          }),
        });
      },
    };

    expectM3bError(
      () =>
        planM3bEdit(
          { source, analysis, analyzer, validateSource: () => undefined },
          {
            kind: "local-variable-rename",
            baseRevision: revision,
            symbolId: symbol.id,
            expectedOldName: "item",
            newName: "entry",
          },
        ),
      ["CANDIDATE_POSTCONDITION_FAILED"],
    );
  });
});

function requireStatement(
  source: string,
  analysis: CAnalysisSnapshot,
  text: string,
): StatementEditTarget {
  const matches = analysis.statementEdits.statements.filter(
    (target) => source.slice(target.range.from, target.range.to) === text,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`需要唯一 statement ${JSON.stringify(text)}，实际 ${String(matches.length)}`);
  }
  return matches[0];
}

function requireSymbol(
  analysis: CAnalysisSnapshot,
  name: string,
  kind: SymbolRecord["kind"],
): SymbolRecord {
  const matches = analysis.document.symbols.symbols.filter(
    (symbol) => symbol.name === name && symbol.kind === kind,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`需要唯一 symbol ${kind}:${name}，实际 ${String(matches.length)}`);
  }
  return matches[0];
}

function expectM3bError(run: () => unknown, codes: readonly M3bEditErrorCode[]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(M3bEditError);
    expect(codes).toContain((error as M3bEditError).code);
    return;
  }
  throw new Error(`预期 M3bEditError ${codes.join("/")}`);
}

function assertDeepPlanFrozen(plan: ReturnType<typeof planM3bEdit>): void {
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.textPlan)).toBe(true);
  expect(Object.isFrozen(plan.patches)).toBe(true);
  expect(plan.patches.every(Object.isFrozen)).toBe(true);
  expect(Object.isFrozen(plan.diffs)).toBe(true);
  expect(plan.diffs.every(Object.isFrozen)).toBe(true);
  expect(Object.isFrozen(plan.inversePatches)).toBe(true);
  expect(plan.inversePatches.every(Object.isFrozen)).toBe(true);
  expect(Object.isFrozen(plan.candidateAnalysis)).toBe(true);
  expect(Object.isFrozen(plan.candidateAnalysis.document.symbols.occurrences)).toBe(true);
  expect(Object.isFrozen(plan.candidateAnalysis.statementEdits.statements)).toBe(true);
}
