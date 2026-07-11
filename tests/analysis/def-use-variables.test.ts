import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProgramCst } from "../../src/analysis/index.js";
import { type CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a def-use variable inventory", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("classifies parameters, locals, arrays, pointers, aggregates and typedef-backed unknowns", () => {
    const source = [
      "typedef int Number;",
      "struct Item { int value; };",
      "int f(int p, int a[], int *q) {",
      "  int x = 0;",
      "  int values[4];",
      "  struct Item item;",
      "  Number alias = 1;",
      "  { int x = 2; return x; }",
      "}",
      "",
    ].join("\n");
    const variables = inspectVariables(parser, source);

    expect(
      variables.map(({ name, kind, storage, tracking }) => ({ name, kind, storage, tracking })),
    ).toEqual([
      { name: "p", kind: "parameter", storage: "scalar", tracking: "precise" },
      { name: "a", kind: "parameter", storage: "array", tracking: "weak" },
      { name: "q", kind: "parameter", storage: "pointer", tracking: "untracked" },
      { name: "x", kind: "local", storage: "scalar", tracking: "precise" },
      { name: "values", kind: "local", storage: "array", tracking: "weak" },
      { name: "item", kind: "local", storage: "aggregate", tracking: "untracked" },
      { name: "alias", kind: "local", storage: "unknown", tracking: "untracked" },
      { name: "x", kind: "local", storage: "scalar", tracking: "precise" },
    ]);
    expect(new Set(variables.map((variable) => variable.id)).size).toBe(variables.length);
    expect(variables.every(Object.isFrozen)).toBe(true);
    expect(variables.every((variable) => Object.isFrozen(variable.declarationRanges))).toBe(true);
  });

  it("is deterministic across independent reparses and excludes file variables", () => {
    const source = "int global; int f(int x) { int y; return x; }";
    const first = inspectVariables(parser, source);
    const second = inspectVariables(parser, source);

    expect(second).toEqual(first);
    expect(first.map((variable) => variable.name)).toEqual(["x", "y"]);
    expect(JSON.stringify(first)).not.toContain("symbol-");
  });

  it("refuses volatile, atomic and persistent local storage", () => {
    const source =
      "int f(void) { volatile int v = 0; static int s = 0; _Atomic int a = 0; auto int x = 0; return x; }";
    const variables = inspectVariables(parser, source);

    expect(
      Object.fromEntries(variables.map((variable) => [variable.name, variable.tracking])),
    ).toEqual({ v: "untracked", s: "untracked", a: "untracked", x: "precise" });
  });

  it("keeps intrinsic scalar tracking until ordered escape effects are applied", () => {
    const escaped = inspectVariables(
      parser,
      "int f(void) { int x = 0; int *p = &x; mutate(p); return x; }",
    );
    const directCall = inspectVariables(parser, "int f(void) { int x = 0; sink(&x); return x; }");

    expect(escaped.find((variable) => variable.name === "x")?.tracking).toBe("precise");
    expect(directCall.find((variable) => variable.name === "x")?.tracking).toBe("precise");
  });

  it("fails closed for partial, concerned and preprocessed functions", () => {
    const partial = inspectDefUse(parser, "int f(int x) { if (x) return 1; else }");
    const concerned = inspectDefUse(parser, "int f(void) { int a = 1, b = 2; a * b; return a; }");
    const preprocessed = inspectDefUse(
      parser,
      "int f(int x) {\n#ifdef FLAG\n  x++;\n#endif\n  return x;\n}",
    );

    expect(partial.status).toBe("disabled");
    expect(partial.disabledReasons).toContain("cfg-partial");
    expect(partial.variables.every((variable) => variable.tracking === "untracked")).toBe(true);
    expect(concerned.status).toBe("disabled");
    expect(concerned.disabledReasons).toContain("parse-concern");
    expect(concerned.variables.every((variable) => variable.tracking === "untracked")).toBe(true);
    expect(preprocessed.status).toBe("disabled");
    expect(preprocessed.disabledReasons).toContain("preprocessor");
    expect(preprocessed.variables.every((variable) => variable.tracking === "untracked")).toBe(
      true,
    );
  });

  it("distinguishes a complete empty inventory from a disabled empty inventory", () => {
    const complete = inspectDefUse(parser, "int f(void) { return 0; }");
    const disabled = inspectDefUse(parser, "int f(void) {\n#if FLAG\n#endif\nreturn 0;\n}");

    expect(complete).toMatchObject({ status: "complete", disabledReasons: [], variables: [] });
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledReasons).toContain("preprocessor");
    expect(disabled.variables).toEqual([]);
  });

  it.each([
    "#define F(x) ((x) + (x))\nint f(int i) { return F(i++); }",
    "#define SET(x) ((x) = 1)\nint f(int i) { SET(i); return i; }",
    "#define TY int\nint f(void) { TY x = 0; return x; }",
    "#define M x++\nstruct S { int x; }; int f(void) { struct S s = {0}; sink(s.M, s.x); return 0; }",
    "#define return return i++,\nint f(int i) { return i; }",
  ])("fails closed when a translation-unit macro is used inside a function", (source) => {
    const defUse = inspectDefUse(parser, source);

    expect(defUse.status).toBe("disabled");
    expect(defUse.disabledReasons).toContain("preprocessor");
    expect(defUse.facts).toEqual([]);
  });

  it("does not apply macro definitions that are not active at the function", () => {
    const beforeDefinition = inspectDefUse(
      parser,
      "int f(int x) { return LATER(x); }\n#define LATER(x) (x)",
    );
    const afterUndef = inspectDefUse(
      parser,
      "#define OLD(x) (x)\n#undef OLD\nint f(int x) { return OLD(x); }",
    );

    expect(beforeDefinition.disabledReasons).not.toContain("preprocessor");
    expect(afterUndef.disabledReasons).not.toContain("preprocessor");
  });

  it("fails closed when conditional preprocessing makes macro state uncertain", () => {
    const defUse = inspectDefUse(
      parser,
      "#define M i++\n#if 0\n#undef M\n#endif\nint f(int i) { M; return i; }",
    );

    expect(defUse.status).toBe("disabled");
    expect(defUse.disabledReasons).toContain("preprocessor");
  });

  it("allows known system-header syntax but fails closed for an unknown local header", () => {
    const system = inspectDefUse(
      parser,
      '#include <stdio.h>\nint f(void) { int n; scanf("%d", &n); return n; }',
    );
    const local = inspectDefUse(parser, '#include "custom.h"\nint f(int i) { return F(i++); }');
    const unknownSystem = inspectDefUse(
      parser,
      "#include <course_macros.h>\nint f(int i) { return F(i++); }",
    );

    expect(system.disabledReasons).not.toContain("preprocessor");
    expect(local.status).toBe("disabled");
    expect(local.disabledReasons).toContain("preprocessor");
    expect(unknownSystem.disabledReasons).toContain("preprocessor");
  });

  it("fails closed when NDEBUG changes the assert evaluation contract", () => {
    const activeAtInclude = inspectDefUse(
      parser,
      "#define NDEBUG\n#include <assert.h>\nint f(int i) { assert(i++); return i; }",
    );
    const undefinedLater = inspectDefUse(
      parser,
      "#define NDEBUG\n#include <assert.h>\n#undef NDEBUG\nint f(int i) { assert(i++); return i; }",
    );

    for (const defUse of [activeAtInclude, undefinedLater]) {
      expect(defUse.status).toBe("disabled");
      expect(defUse.disabledReasons).toContain("preprocessor");
    }
  });

  it("refuses function declarators and mixed pointer-array declarators", () => {
    const variables = inspectVariables(parser, "int f(int cb(int)) { int (*p)[4]; return 0; }");

    expect(variables.map(({ name, storage, tracking }) => ({ name, storage, tracking }))).toEqual([
      { name: "cb", storage: "unknown", tracking: "untracked" },
      { name: "p", storage: "unknown", tracking: "untracked" },
    ]);
  });

  it("refuses void and non-scalar array objects even when Tree-sitter accepts them", () => {
    const variables = inspectVariables(
      parser,
      [
        "typedef int Number;",
        "struct Item { int value; };",
        "int f(void) {",
        "  void x;",
        "  void invalid[3];",
        "  Number aliases[2];",
        "  struct Item items[2];",
        "  return 0;",
        "}",
      ].join("\n"),
    );

    for (const name of ["x", "invalid", "aliases", "items"]) {
      expect(variables.find((variable) => variable.name === name)).toMatchObject({
        storage: "unknown",
        tracking: "untracked",
      });
    }
  });

  it("keeps array baseline weak before ordered decay and escape effects are applied", () => {
    const decayed = inspectVariables(parser, "int f(void) { int a[4]; consume(a); return 0; }");
    const indexed = inspectVariables(
      parser,
      "int f(int i) { int a[4]; a[i] = 1; swap(&a[i]); return a[i]; }",
    );

    expect(decayed.find((variable) => variable.name === "a")?.tracking).toBe("weak");
    expect(indexed.find((variable) => variable.name === "a")?.tracking).toBe("weak");
  });
});

function inspectVariables(parser: CParser, source: string) {
  return inspectDefUse(parser, source).variables;
}

function inspectDefUse(parser: CParser, source: string) {
  return parser.inspect(source, 1, ({ rootNode, document }) => {
    const analysis = analyzeProgramCst({ source, revision: 1, rootNode, document });
    const defUse = analysis.defUse[0];
    if (defUse === undefined) throw new Error("fixture 缺少 def-use");
    return defUse;
  }).result;
}
