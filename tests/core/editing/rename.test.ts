import { Buffer } from "node:buffer";
import { Language, Parser, type Node } from "web-tree-sitter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceDoc, SymbolRecord } from "../../../src/core/model.js";
import { projectCst } from "../../../src/core/projector.js";
import { applyTextPatches } from "../../../src/core/editing/patch.js";
import {
  LocalRenameError,
  planConservativeLocalRename,
  type ConservativeLocalRenamePlan,
  type LocalRenameAnalysis,
  type LocalRenameErrorCode,
} from "../../../src/core/editing/rename.js";
import { TEST_PARSER_ASSETS } from "../parser-fixture.js";

let parser: Parser;

beforeAll(async () => {
  await Parser.init({ locateFile: () => TEST_PARSER_ASSETS.runtimeWasmUrl });
  const language = await Language.load(TEST_PARSER_ASSETS.languageWasm);
  parser = new Parser();
  parser.setLanguage(language);
});

afterAll(() => {
  parser.delete();
});

describe("M3b conservative function-local rename planner", () => {
  it("returns sorted minimal identifier patches for one certain local binding", () => {
    const source = [
      "int main(void) {",
      "  int count = 1;",
      "  count += count;",
      "  return count;",
      "}",
      "",
    ].join("\n");

    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "count", "local-variable");
      const plan = planRename(source, rootNode, document, target, "total");

      expect(plan).toMatchObject({
        kind: "local-variable-rename",
        symbolId: target.id,
        oldName: "count",
        newName: "total",
        requiresConfirmation: true,
        semanticValidationRequired: true,
      });
      expect(plan.patches).toHaveLength(4);
      expect(plan.patches.map((patch) => source.slice(patch.range.from, patch.range.to))).toEqual([
        "count",
        "count",
        "count",
        "count",
      ]);
      expect(plan.patches.map((patch) => patch.range.from)).toEqual(
        [...plan.patches].map((patch) => patch.range.from).sort((left, right) => left - right),
      );
      expect(applyTextPatches(source, plan.patches).source).toBe(
        [
          "int main(void) {",
          "  int total = 1;",
          "  total += total;",
          "  return total;",
          "}",
          "",
        ].join("\n"),
      );
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.functionRange)).toBe(true);
      expect(Object.isFrozen(plan.patches)).toBe(true);
      expect(plan.patches.every(Object.isFrozen)).toBe(true);
    });
  });

  it("changes declarations and true identifier uses but not fields, labels, comments or strings", () => {
    const source = [
      "struct Item { int value; };",
      "int main(void) {",
      "  // value stays in this comment",
      "  int value = 1;",
      '  const char *text = "value";',
      "  struct Item item = {.value = 2};",
      "  item.value += value;",
      "  if (value < 2) goto value;",
      "value:",
      "  return value + (text[0] == 'v');",
      "}",
      "",
    ].join("\n");
    const expected = [
      "struct Item { int value; };",
      "int main(void) {",
      "  // value stays in this comment",
      "  int amount = 1;",
      '  const char *text = "value";',
      "  struct Item item = {.value = 2};",
      "  item.value += amount;",
      "  if (amount < 2) goto value;",
      "value:",
      "  return amount + (text[0] == 'v');",
      "}",
      "",
    ].join("\n");

    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "value", "local-variable");
      const plan = planRename(source, rootNode, document, target, "amount");
      const candidate = applyTextPatches(source, plan.patches).source;

      expect(plan.patches).toHaveLength(4);
      expect(candidate).toBe(expected);
      expect(candidate).toContain("// value stays in this comment");
      expect(candidate).toContain('"value"');
      expect(candidate).toContain(".value");
      expect(candidate).toContain("goto value;");
      expect(candidate).toContain("value:");
    });
  });

  it("keeps same-spelled locals in different functions independent", () => {
    const source = [
      "int first(void) { int item = 1; return item; }",
      "int second(void) { int item = 2; return item; }",
      "",
    ].join("\n");

    withAnalysis(source, (rootNode, document) => {
      const secondFunctionStart = source.indexOf("int second");
      const target = document.symbols.symbols.find(
        (symbol) =>
          symbol.name === "item" &&
          symbol.kind === "local-variable" &&
          (symbol.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) < secondFunctionStart,
      );
      if (target === undefined) throw new Error("缺少 first.item");

      const plan = planRename(source, rootNode, document, target, "firstItem");
      const candidate = applyTextPatches(source, plan.patches).source;
      expect(plan.patches).toHaveLength(2);
      expect(candidate).toContain("int firstItem = 1; return firstItem;");
      expect(candidate).toContain("int item = 2; return item;");
    });
  });

  it("rejects parameters, file variables, enum constants and macros", () => {
    const source = [
      "#define LIMIT 3",
      "enum Tone { RED = 1 };",
      "int global = 0;",
      "int main(int parameter) {",
      "  int local = LIMIT + RED + global + parameter;",
      "  return local;",
      "}",
      "",
    ].join("\n");

    withAnalysis(source, (rootNode, document) => {
      const targets: readonly SymbolRecord[] = [
        requireSymbol(document, "parameter", "parameter"),
        requireSymbol(document, "global", "file-variable"),
        requireSymbol(document, "RED", "enum-constant"),
        requireSymbol(document, "LIMIT", "object-macro"),
      ];
      for (const target of targets) {
        expectRenameError(
          () => planRename(source, rootNode, document, target, "renamed"),
          "UNSUPPORTED_RENAME_TARGET",
        );
      }
    });
  });

  it("rejects nested and file-scope shadowing of the old name", () => {
    const nested = "int main(void){ int value=1; { int value=2; value++; } return value; }\n";
    withAnalysis(nested, (rootNode, document) => {
      const target = document.symbols.symbols.find(
        (symbol) =>
          symbol.name === "value" &&
          symbol.kind === "local-variable" &&
          symbol.declarationRanges[0]?.from === nested.indexOf("value"),
      );
      if (target === undefined) throw new Error("缺少外层 value");
      expectRenameError(
        () => planRename(nested, rootNode, document, target, "result"),
        "SHADOWING_DETECTED",
      );
    });

    const fileShadow = "int value=0; int main(void){ int value=1; return value; }\n";
    withAnalysis(fileShadow, (rootNode, document) => {
      const target = requireSymbol(document, "value", "local-variable");
      expectRenameError(
        () => planRename(fileShadow, rootNode, document, target, "result"),
        "SHADOWING_DETECTED",
      );
    });
  });

  it("rejects new-name collisions in lexical, file and builtin namespaces", () => {
    const source = [
      "#define LIMIT 3",
      "#define APPLY(x) (x)",
      "int global=0;",
      "int main(void){ int first=1; int second=2; return first+second; }",
      "",
    ].join("\n");
    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "first", "local-variable");
      for (const newName of ["second", "global", "printf", "size_t", "NULL", "LIMIT", "APPLY"]) {
        expectRenameError(
          () => planRename(source, rootNode, document, target, newName),
          "NAME_COLLISION",
        );
      }
    });
  });

  it("rejects C17 keywords, non-identifiers and Unicode names", () => {
    const source = "int main(void){ int value=1; return value; }\n";
    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "value", "local-variable");
      for (const newName of [
        "",
        "2value",
        "value-name",
        "for",
        "_Static_assert",
        "__next",
        "_Next",
        "变量",
        "😀",
      ]) {
        expectRenameError(
          () => planRename(source, rootNode, document, target, newName),
          "INVALID_NEW_NAME",
        );
      }
      expect(() => planRename(source, rootNode, document, target, "_next2")).not.toThrow();
    });
  });

  it("rejects parse recovery, ambiguity concerns and preprocessor branches", () => {
    const parseError = "int main(void){ int target=1; return target + ; }\n";
    withAnalysis(parseError, (rootNode, document) => {
      const target = requireSymbol(document, "target", "local-variable");
      expectRenameError(
        () => planRename(parseError, rootNode, document, target, "result"),
        "SUSPICIOUS_PARSE",
      );
    });

    const concern = "int main(void){ int a=1,b=2; a * b; int target=1; return target; }\n";
    withAnalysis(concern, (rootNode, document) => {
      expect(document.concerns.length).toBeGreaterThan(0);
      const target = requireSymbol(document, "target", "local-variable");
      expectRenameError(
        () => planRename(concern, rootNode, document, target, "result"),
        "SUSPICIOUS_PARSE",
      );
    });

    const preprocessor = [
      "int main(void){",
      "  int target=1;",
      "#ifdef ENABLED",
      "  target++;",
      "#endif",
      "  return target;",
      "}",
      "",
    ].join("\n");
    withAnalysis(preprocessor, (rootNode, document) => {
      const target = requireSymbol(document, "target", "local-variable");
      expectRenameError(
        () => planRename(preprocessor, rootNode, document, target, "result"),
        "SUSPICIOUS_PARSE",
      );
    });
  });

  it("rejects stale, duplicated and non-identifier occurrence facts", () => {
    const source =
      "struct Item { int value; }; int main(void){ struct Item item; int value=1; return value + item.value; }\n";
    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "value", "local-variable");
      expectRenameError(
        () =>
          planConservativeLocalRename({
            source,
            rootNode,
            analysis: document,
            symbolId: target.id,
            expectedOldName: "stale",
            newName: "result",
          }),
        "STALE_RENAME_ANALYSIS",
      );

      const use = document.symbols.occurrences.find(
        (occurrence) => occurrence.symbolId === target.id && occurrence.role === "use",
      );
      if (use === undefined) throw new Error("缺少 value use");
      const duplicated: LocalRenameAnalysis = {
        ...document,
        symbols: Object.freeze({
          symbols: document.symbols.symbols,
          occurrences: Object.freeze([...document.symbols.occurrences, use]),
        }),
      };
      expectRenameError(
        () =>
          planConservativeLocalRename({
            source,
            rootNode,
            analysis: duplicated,
            symbolId: target.id,
            expectedOldName: target.name,
            newName: "result",
          }),
        "OVERLAPPING_OCCURRENCES",
      );

      const fieldStart = source.lastIndexOf("value");
      const maliciousUse = Object.freeze({
        ...use,
        range: Object.freeze({ from: fieldStart, to: fieldStart + "field".length }),
      }) as typeof use;
      const forged: LocalRenameAnalysis = {
        ...document,
        symbols: Object.freeze({
          symbols: document.symbols.symbols,
          occurrences: Object.freeze(
            document.symbols.occurrences.map((occurrence) =>
              occurrence === use ? maliciousUse : occurrence,
            ),
          ),
        }),
      };
      expectRenameError(
        () =>
          planConservativeLocalRename({
            source,
            rootNode,
            analysis: forged,
            symbolId: target.id,
            expectedOldName: target.name,
            newName: "result",
          }),
        "INCOMPLETE_BINDING",
      );
    });
  });

  it("rejects a same-length CST from a different source snapshot", () => {
    const source = "int main(void){ int value=1; return value; }\n";
    const staleSource = "int main(void){ int other=1; return other; }\n";
    const sourceTree = parser.parse(source);
    const staleTree = parser.parse(staleSource);
    if (sourceTree === null || staleTree === null) throw new Error("tree-sitter 未返回语法树");
    try {
      const document = projectCst(source, sourceTree.rootNode);
      const target = requireSymbol(document, "value", "local-variable");
      expectRenameError(
        () => planRename(source, staleTree.rootNode, document, target, "result"),
        "STALE_RENAME_ANALYSIS",
      );
    } finally {
      sourceTree.delete();
      staleTree.delete();
    }
  });

  it("preserves BOM, CRLF, Unicode trivia and every untouched byte exactly", () => {
    const source = [
      "\uFEFFint main(void) {",
      "  // 中文 x 😀",
      "  int x = 1;",
      "  return x;",
      "}",
      "",
    ].join("\r\n");
    const expected = [
      "\uFEFFint main(void) {",
      "  // 中文 x 😀",
      "  int total = 1;",
      "  return total;",
      "}",
      "",
    ].join("\r\n");

    withAnalysis(source, (rootNode, document) => {
      const target = requireSymbol(document, "x", "local-variable");
      const plan = planRename(source, rootNode, document, target, "total");
      const application = applyTextPatches(source, plan.patches);

      expect(Buffer.from(application.source)).toEqual(Buffer.from(expected));
      expect(application.source).toContain("\uFEFF");
      expect(application.source).toContain("\r\n  // 中文 x 😀\r\n");
      const restored = applyTextPatches(application.source, application.inversePatches).source;
      expect(Buffer.from(restored)).toEqual(Buffer.from(source));
    });
  });
});

function withAnalysis<T>(source: string, run: (rootNode: Node, document: SourceDoc) => T): T {
  const tree = parser.parse(source);
  if (tree === null) throw new Error("tree-sitter 未返回语法树");
  try {
    return run(tree.rootNode, projectCst(source, tree.rootNode));
  } finally {
    tree.delete();
  }
}

function planRename(
  source: string,
  rootNode: Node,
  analysis: LocalRenameAnalysis,
  target: SymbolRecord,
  newName: string,
): ConservativeLocalRenamePlan {
  return planConservativeLocalRename({
    source,
    rootNode,
    analysis,
    symbolId: target.id,
    expectedOldName: target.name,
    newName,
  });
}

function requireSymbol(
  document: SourceDoc,
  name: string,
  kind: SymbolRecord["kind"],
): SymbolRecord {
  const matches = document.symbols.symbols.filter(
    (symbol) => symbol.name === name && symbol.kind === kind,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`需要唯一 symbol ${kind}:${name}，实际 ${matches.length}`);
  }
  return matches[0];
}

function expectRenameError(run: () => unknown, code: LocalRenameErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalRenameError);
    expect((error as LocalRenameError).code).toBe(code);
    return;
  }
  throw new Error(`预期 LocalRenameError ${code}`);
}
