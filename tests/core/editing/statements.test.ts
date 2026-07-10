import { resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { applyTextPatches } from "../../../src/core/editing/patch.js";
import {
  extractStatementEditTargets,
  planStatementOperation,
  StatementOperationError,
  type StatementEditTarget,
  type StatementEditTargetSnapshot,
} from "../../../src/core/editing/statements.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const propertyRuns = 80;
const propertySeed = 0x3b_2026;
let parser: Parser;

beforeAll(async () => {
  const runtimeWasmUrl = resolve(projectRoot, "resources/wasm/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => runtimeWasmUrl });
  const language = await Language.load(resolve(projectRoot, "resources/wasm/tree-sitter-c.wasm"));
  parser = new Parser();
  parser.setLanguage(language);
});

afterAll(() => {
  parser.delete();
});

describe("M3b statement target extraction", () => {
  it("marks same-line declarations as non-editable but keeps independent lines editable", () => {
    const source = [
      "int value(void) {",
      "  int first = 1; int second = 2;",
      "  first += second;",
      "  return first;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 7);
    const first = requireTarget(source, snapshot, "int first = 1;");
    const second = requireTarget(source, snapshot, "int second = 2;");
    const addition = requireTarget(source, snapshot, "first += second;");

    expect(first.blocker).toBe("not-line-exclusive");
    expect(second.blocker).toBe("not-line-exclusive");
    expect(first.extendedRange).toEqual(first.range);
    expect(second.extendedRange).toEqual(second.range);
    expect(addition.blocker).toBeNull();
    expect(source.slice(addition.extendedRange.from, addition.extendedRange.to)).toBe(
      "  first += second;\n",
    );
    expect(addition.nextSiblingId).toBe(requireTarget(source, snapshot, "return first;").id);
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "delete-statement",
          baseRevision: 7,
          targetId: first.id,
          expectedTargetText: slice(source, first),
        }),
      "NOT_LINE_EXCLUSIVE",
    );
  });

  it("exposes only direct statement-list entries and actual required control bodies", () => {
    const source = [
      "int value(int condition) {",
      "  if (condition)",
      "    run();",
      "  for (int index = 0; index < 2; index++)",
      "    tick();",
      "  return condition;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 9);
    const run = requireTarget(source, snapshot, "run();");
    const tick = requireTarget(source, snapshot, "tick();");

    expect(run).toMatchObject({ parentNodeType: "if_statement", parentMode: "required-body" });
    expect(tick).toMatchObject({ parentNodeType: "for_statement", parentMode: "required-body" });
    expect(snapshot.statements.some((target) => slice(source, target) === "int index = 0;")).toBe(
      false,
    );
  });

  it("blocks clean-looking descendants when any ancestor reports parse recovery", () => {
    const source = [
      "int value(int condition) {",
      "  if (condition {",
      "    update();",
      "  }",
      "  return condition;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 10);
    const update = requireTarget(source, snapshot, "update();");

    expect(update.blocker).toBe("parse-recovery");
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "delete-statement",
          baseRevision: 10,
          targetId: update.id,
          expectedTargetText: slice(source, update),
        }),
      "STALE_STATEMENT_TARGET",
    );
  });
});

describe("M3b whole-line insertion and deletion", () => {
  it("inserts one line with the target indentation and exact CRLF convention", () => {
    const source = `\uFEFF// 中😀\r\nint value(void) {\r\n  return 1;\r\n}\r\n`;
    const snapshot = extract(source, 11);
    const target = requireTarget(source, snapshot, "return 1;");
    const plan = planStatementOperation(source, snapshot, {
      kind: "insert-statement",
      baseRevision: 11,
      targetId: target.id,
      expectedTargetText: slice(source, target),
      position: "before",
      statementText: "trace();",
    });
    const application = applyTextPatches(source, plan.patches);

    expect(plan.patches).toEqual([
      {
        range: { from: target.extendedRange.from, to: target.extendedRange.from },
        newText: "  trace();\r\n",
      },
    ]);
    expect(application.source).toBe(
      `\uFEFF// 中😀\r\nint value(void) {\r\n  trace();\r\n  return 1;\r\n}\r\n`,
    );
    expect(application.source.startsWith("\uFEFF")).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("adapts a single multiline control block to the target indentation and newline", () => {
    const source = "int value(void) {\r\n  return 1;\r\n}\r\n";
    const snapshot = extract(source, 111);
    const target = requireTarget(source, snapshot, "return 1;");
    const plan = planStatementOperation(source, snapshot, {
      kind: "insert-statement",
      baseRevision: 111,
      targetId: target.id,
      expectedTargetText: slice(source, target),
      position: "before",
      statementText: "for (int i = 0; i < 3; i++) {\n  tick();\n}",
    });
    const application = applyTextPatches(source, plan.patches);

    expect(plan.insertedStatementText).toBe("for (int i = 0; i < 3; i++) {\r\n    tick();\r\n  }");
    expect(application.source).toBe(
      "int value(void) {\r\n  for (int i = 0; i < 3; i++) {\r\n    tick();\r\n  }\r\n  return 1;\r\n}\r\n",
    );
    expect(parseHasError(application.source)).toBe(false);
  });

  it("deletes attached movable leading and trailing comments in one minimal range", () => {
    const source = [
      "int value(void) {",
      "  // attached lead",
      "  /* attached one-line block */",
      "  update(); // attached tail",
      "",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 12);
    const target = requireTarget(source, snapshot, "update();");
    const plan = planStatementOperation(source, snapshot, {
      kind: "delete-statement",
      baseRevision: 12,
      targetId: target.id,
      expectedTargetText: slice(source, target),
    });
    const application = applyTextPatches(source, plan.patches);

    expect(source.slice(target.extendedRange.from, target.extendedRange.to)).toBe(
      "  // attached lead\n  /* attached one-line block */\n  update(); // attached tail\n",
    );
    expect(plan.patches).toEqual([{ range: target.extendedRange, newText: "" }]);
    expect(application.source).toBe(["int value(void) {", "", "  return 1;", "}", ""].join("\n"));
    expect(applyTextPatches(application.source, application.inversePatches).source).toBe(source);
  });

  it("replaces a deleted unbraced control body with an empty statement", () => {
    const source = [
      "int value(int condition) {",
      "  if (condition)",
      "    // body note",
      "    update();",
      "  return condition;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 13);
    const target = requireTarget(source, snapshot, "update();");
    const plan = planStatementOperation(source, snapshot, {
      kind: "delete-statement",
      baseRevision: 13,
      targetId: target.id,
      expectedTargetText: slice(source, target),
    });
    const application = applyTextPatches(source, plan.patches);

    expect(plan.patches).toEqual([{ range: target.extendedRange, newText: "    ;\n" }]);
    expect(application.source).toContain("  if (condition)\n    ;\n");
    expect(parseHasError(application.source)).toBe(false);
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "insert-statement",
          baseRevision: 13,
          targetId: target.id,
          expectedTargetText: slice(source, target),
          position: "before",
          statementText: "prepare();",
        }),
      "UNSUPPORTED_STATEMENT_PARENT",
    );
  });

  it("replaces an inline required body exactly and rejects invalid inserted source lines", () => {
    const source =
      "int value(int condition) {\n  if (condition) update();\n  return condition;\n}\n";
    const snapshot = extract(source, 14);
    const target = requireTarget(source, snapshot, "update();");

    expect(target.blocker).toBe("not-line-exclusive");
    const deletion = planStatementOperation(source, snapshot, {
      kind: "delete-statement",
      baseRevision: 14,
      targetId: target.id,
      expectedTargetText: slice(source, target),
    });
    expect(deletion.patches).toEqual([{ range: target.range, newText: ";" }]);
    const deletedSource = applyTextPatches(source, deletion.patches).source;
    expect(deletedSource).toContain("if (condition) ;");
    expect(parseHasError(deletedSource)).toBe(false);
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "insert-statement",
          baseRevision: 14,
          targetId: target.id,
          expectedTargetText: slice(source, target),
          position: "before",
          statementText: "prepare();",
        }),
      "NOT_LINE_EXCLUSIVE",
    );

    const returnTarget = requireTarget(source, snapshot, "return condition;");
    for (const statementText of [
      "  update();",
      "\nupdate();",
      "update();\n",
      "#define X 1",
      "/* disguised */ #define X 1",
      "/**/ %:define X 1",
      "/**/ ??=define X 1",
      "next();\\",
      "next();??/",
    ]) {
      expect(() =>
        planStatementOperation(source, snapshot, {
          kind: "insert-statement",
          baseRevision: 14,
          targetId: returnTarget.id,
          expectedTargetText: slice(source, returnTarget),
          position: "before",
          statementText,
        }),
      ).toThrow(StatementOperationError);
    }
  });

  it("deletes movable trailing comments with an inline required body but preserves else code", () => {
    const source = [
      "int value(int condition) {",
      "  if (condition) update(); // attached tail",
      "  if (condition) first(); else second();",
      "  return condition;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 15);
    const update = requireTarget(source, snapshot, "update();");
    const first = requireTarget(source, snapshot, "first();");

    const withoutUpdate = applyTextPatches(
      source,
      planStatementOperation(source, snapshot, {
        kind: "delete-statement",
        baseRevision: 15,
        targetId: update.id,
        expectedTargetText: slice(source, update),
      }).patches,
    ).source;
    expect(withoutUpdate).toContain("  if (condition) ;\n");
    expect(withoutUpdate).not.toContain("attached tail");

    const withoutFirst = applyTextPatches(
      source,
      planStatementOperation(source, snapshot, {
        kind: "delete-statement",
        baseRevision: 15,
        targetId: first.id,
        expectedTargetText: slice(source, first),
      }).patches,
    ).source;
    expect(withoutFirst).toContain("  if (condition) ; else second();");
  });
});

describe("M3b adjacent sibling exchange", () => {
  it("moves each statement with its attached comments and preserves the untouched gap", () => {
    const source = [
      "int value(void) {",
      "  // A lead",
      "  a(); // A tail",
      "",
      "  /* B lead */",
      "  b(); // B tail",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 20);
    const first = requireTarget(source, snapshot, "a();");
    const second = requireTarget(source, snapshot, "b();");
    const plan = planSwap(source, snapshot, first, second, 20);
    const application = applyTextPatches(source, plan.patches);

    expect(plan.patches).toEqual([
      {
        range: first.extendedRange,
        newText: source.slice(second.extendedRange.from, second.extendedRange.to),
      },
      {
        range: second.extendedRange,
        newText: source.slice(first.extendedRange.from, first.extendedRange.to),
      },
    ]);
    expect(application.source).toBe(
      [
        "int value(void) {",
        "  /* B lead */",
        "  b(); // B tail",
        "",
        "  // A lead",
        "  a(); // A tail",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    assertOutsidePatchesUnchanged(source, application.source, plan.patches);
    expect(applyTextPatches(application.source, application.inversePatches).source).toBe(source);
    expect(parseHasError(application.source)).toBe(false);
  });

  it("leaves a detached multi-line block comment in place", () => {
    const source = [
      "int value(void) {",
      "  a();",
      "  /* detached teaching",
      "     note stays here */",
      "  b();",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 21);
    const first = requireTarget(source, snapshot, "a();");
    const second = requireTarget(source, snapshot, "b();");
    const application = applyTextPatches(
      source,
      planSwap(source, snapshot, first, second, 21).patches,
    );

    expect(application.source).toContain(
      "  b();\n  /* detached teaching\n     note stays here */\n  a();\n",
    );
  });

  it("rejects non-adjacent, different-parent, and internal multi-line-comment swaps", () => {
    const source = [
      "int value(void) {",
      "  a();",
      "  if (ready) {",
      "    nested();",
      "  }",
      "  b(/* internal",
      "       note */);",
      "  c();",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 22);
    const first = requireTarget(source, snapshot, "a();");
    const third = requireTarget(source, snapshot, "c();");
    const nested = requireTarget(source, snapshot, "nested();");
    const multiline = requireTarget(source, snapshot, "b(/* internal\n       note */);");

    expect(multiline.blocker).toBe("multiline-block-comment");
    expectOperationCode(
      () => planSwap(source, snapshot, first, third, 22),
      "NOT_ADJACENT_SIBLINGS",
    );
    expectOperationCode(
      () => planSwap(source, snapshot, first, nested, 22),
      "NOT_ADJACENT_SIBLINGS",
    );
    expectOperationCode(
      () => planSwap(source, snapshot, multiline, third, 22),
      "MULTILINE_BLOCK_COMMENT",
    );
  });
});

describe("M3b preprocessor and stale-snapshot guards", () => {
  it("rejects insertion beside a multi-line macro and does not expose guarded statements", () => {
    const source = [
      "int value(void) {",
      "#define CALL_HELPER() do { \\",
      "  helper(); \\",
      "} while (0)",
      "  plain();",
      "#ifdef FEATURE",
      "  guarded();",
      "#endif",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const snapshot = extract(source, 30);
    const plain = requireTarget(source, snapshot, "plain();");

    expect(plain.beforeBoundaryUnsafe).toBe(true);
    expect(snapshot.statements.some((target) => slice(source, target) === "guarded();")).toBe(
      false,
    );
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "insert-statement",
          baseRevision: 30,
          targetId: plain.id,
          expectedTargetText: slice(source, plain),
          position: "before",
          statementText: "prepare();",
        }),
      "PREPROCESSOR_BOUNDARY",
    );
  });

  it("rejects a same-length source mutation and stale expected text", () => {
    const source = "int value(void) {\n  first();\n  return 0;\n}\n";
    const snapshot = extract(source, 31);
    const target = requireTarget(source, snapshot, "first();");
    const changed = source.replace("first", "other");

    expectOperationCode(
      () =>
        planStatementOperation(changed, snapshot, {
          kind: "delete-statement",
          baseRevision: 31,
          targetId: target.id,
          expectedTargetText: "other();",
        }),
      "STALE_STATEMENT_TARGET",
    );
    expectOperationCode(
      () =>
        planStatementOperation(source, snapshot, {
          kind: "delete-statement",
          baseRevision: 31,
          targetId: target.id,
          expectedTargetText: "stale();",
        }),
      "STALE_STATEMENT_TARGET",
    );
  });

  it("rejects target extraction from a same-length stale CST", () => {
    const source = "int value(void) {\n  first();\n  return 0;\n}\n";
    const staleSource = source.replace("first", "other");
    const tree = parser.parse(staleSource);
    if (tree === null) throw new Error("tree-sitter 未返回语法树");
    try {
      expect(() => extractStatementEditTargets(tree.rootNode, source, 32)).toThrow(/同一源码快照/u);
    } finally {
      tree.delete();
    }
  });
});

describe("M3b statement patch properties", () => {
  it("preserves every UTF-16 source unit outside generated swap patches", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("\n", "\r\n"),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (newline, leftValue, rightValue) => {
          fc.pre(leftValue !== rightValue);
          const source = [
            "\uFEFF// 中😀",
            "int value(void) {",
            `  // left ${String(leftValue)}`,
            `  consume(${String(leftValue)});`,
            "",
            `  // right ${String(rightValue)}`,
            `  consume(${String(rightValue)});`,
            "  return 0;",
            "}",
            "",
          ].join(newline);
          const snapshot = extract(source, leftValue + rightValue);
          const first = requireTarget(source, snapshot, `consume(${String(leftValue)});`);
          const second = requireTarget(source, snapshot, `consume(${String(rightValue)});`);
          const plan = planSwap(source, snapshot, first, second, snapshot.revision);
          const application = applyTextPatches(source, plan.patches);

          assertOutsidePatchesUnchanged(source, application.source, plan.patches);
          expect(application.source.startsWith("\uFEFF// 中😀")).toBe(true);
          expect(applyTextPatches(application.source, application.inversePatches).source).toBe(
            source,
          );
          expect(parseHasError(application.source)).toBe(false);
        },
      ),
      { numRuns: propertyRuns, seed: propertySeed },
    );
  });
});

function extract(source: string, revision: number): StatementEditTargetSnapshot {
  const tree = parser.parse(source);
  if (tree === null) throw new Error("tree-sitter 未返回语法树");
  try {
    return extractStatementEditTargets(tree.rootNode, source, revision);
  } finally {
    tree.delete();
  }
}

function parseHasError(source: string): boolean {
  const tree = parser.parse(source);
  if (tree === null) throw new Error("tree-sitter 未返回语法树");
  try {
    return tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

function requireTarget(
  source: string,
  snapshot: StatementEditTargetSnapshot,
  text: string,
): StatementEditTarget {
  const matches = snapshot.statements.filter((target) => slice(source, target) === text);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(
      `缺少唯一 statement target ${JSON.stringify(text)}，实际 ${String(matches.length)}`,
    );
  }
  return matches[0];
}

function slice(source: string, target: StatementEditTarget): string {
  return source.slice(target.range.from, target.range.to);
}

function planSwap(
  source: string,
  snapshot: StatementEditTargetSnapshot,
  target: StatementEditTarget,
  adjacent: StatementEditTarget,
  revision: number,
) {
  return planStatementOperation(source, snapshot, {
    kind: "swap-adjacent-statements",
    baseRevision: revision,
    targetId: target.id,
    expectedTargetText: slice(source, target),
    adjacentTargetId: adjacent.id,
    expectedAdjacentTargetText: slice(source, adjacent),
  });
}

function expectOperationCode(action: () => unknown, code: StatementOperationError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StatementOperationError);
    expect((error as StatementOperationError).code).toBe(code);
    return;
  }
  throw new Error(`预期 ${code}，但操作成功`);
}

function assertOutsidePatchesUnchanged(
  source: string,
  candidate: string,
  patches: readonly {
    readonly range: { readonly from: number; readonly to: number };
    readonly newText: string;
  }[],
): void {
  let sourceCursor = 0;
  let candidateCursor = 0;
  for (const patch of patches) {
    const unchanged = source.slice(sourceCursor, patch.range.from);
    expect(candidate.slice(candidateCursor, candidateCursor + unchanged.length)).toBe(unchanged);
    sourceCursor = patch.range.to;
    candidateCursor += unchanged.length + patch.newText.length;
  }
  expect(candidate.slice(candidateCursor)).toBe(source.slice(sourceCursor));
}
