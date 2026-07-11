import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type DefUseEffect,
  type FunctionCfg,
  type FunctionDefUse,
  type ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";
import { type CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a ordered def-use effects", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("orders parameter, declaration, assignment, compound and update effects", () => {
    const source = "int f(int p) { int x; int y = p; x = y; x += p; ++x; return x; }";
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "ENTRY")).toEqual(["def:p:strong:written:parameter"]);
    expect(labelsForNode(analysis, "int x;")).toEqual(["def:x:strong:uninitialized:declaration"]);
    expect(labelsForNode(analysis, "int y = p;")).toEqual([
      "use:p:value:always",
      "def:y:strong:written:declaration",
    ]);
    expect(labelsForNode(analysis, "x = y;")).toEqual([
      "use:y:value:always",
      "def:x:strong:written:assignment",
    ]);
    expect(labelsForNode(analysis, "x += p;")).toEqual([
      "use:x:value:always",
      "use:p:value:always",
      "def:x:strong:written:compound-assignment",
    ]);
    expect(labelsForNode(analysis, "++x;")).toEqual([
      "use:x:value:always",
      "def:x:strong:written:update",
    ]);
    expect(labelsForNode(analysis, "return x;")).toEqual(["use:x:value:always"]);
    expect(labelsForNode(analysis, "EXIT")).toEqual([]);
  });

  it("preserves declarator order and binds a self-initializer to the new object", () => {
    const source = "int f(int p) { int x = p, y = x; int z = z; return y; }";
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "int x = p, y = x;")).toEqual([
      "use:p:value:always",
      "def:x:strong:written:declaration",
      "use:x:value:always",
      "def:y:strong:written:declaration",
    ]);
    expect(labelsForNode(analysis, "int z = z;")).toEqual([
      "use:z:value:always",
      "def:z:strong:written:declaration",
    ]);
  });

  it("uses whole-array facts with strong declarations and weak element writes", () => {
    const source = [
      "int f(int i, int value, int a[]) {",
      "  int local[4];",
      "  local[i] = value;",
      "  local[i] += a[i];",
      "  return local[i];",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "ENTRY")).toEqual([
      "def:i:strong:written:parameter",
      "def:value:strong:written:parameter",
      "def:a:strong:written:parameter",
    ]);
    expect(labelsForNode(analysis, "int local[4];")).toEqual([
      "def:local:strong:uninitialized:declaration",
    ]);
    expect(labelsForNode(analysis, "local[i] = value;")).toEqual([
      "use:i:index:always",
      "use:value:value:always",
      "def:local:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "local[i] += a[i];")).toEqual([
      "use:i:index:always",
      "use:local:array-element:always",
      "use:i:index:always",
      "use:a:array-element:always",
      "def:local:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "return local[i];")).toEqual([
      "use:i:index:always",
      "use:local:array-element:always",
    ]);
  });

  it("evaluates VLA bounds and keeps nested index uses classified as indices", () => {
    const source = [
      "int f(int n, int i, int a[]) {",
      "  int local[n];",
      "  local[i * 2] = a[i + 1];",
      "  return local[i];",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "int local[n];")).toEqual([
      "use:n:value:always",
      "def:local:strong:uninitialized:declaration",
    ]);
    expect(labelsForNode(analysis, "local[i * 2] = a[i + 1];")).toEqual([
      "use:i:index:always",
      "use:i:index:always",
      "use:a:array-element:always",
      "def:local:weak:written:array-element",
    ]);
  });

  it("evaluates block-scope VLA typedef bounds instead of silently dropping them", () => {
    const source = "int f(int n) { typedef int Row[n]; return n; }";
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "typedef int Row[n];")).toEqual(["use:n:value:always"]);
  });

  it("sequences separate typedef declarators but not bounds within one declarator", () => {
    const sequential = inspectOne(parser, "int f(int n) { typedef int A[n++], B[n]; return n; }");
    const conflicting = inspectOne(parser, "int f(int n) { typedef int A[n++][n]; return n; }");

    expect(sequential.defUse.status).toBe("complete");
    expect(labelsForNode(sequential, "typedef int A[n++], B[n];")).toEqual([
      "use:n:value:always",
      "def:n:strong:written:update",
      "use:n:value:always",
    ]);
    expect(conflicting.defUse.status).toBe("disabled");
    expect(conflicting.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("evaluates parameter VLA bounds after earlier parameter definitions", () => {
    const ordinary = inspectOne(parser, "int f(int n, int a[n]) { return a[0]; }");
    const mutating = inspectOne(parser, "int f(int n, int a[n++]) { return n; }");

    expect(labelsForNode(ordinary, "ENTRY")).toEqual([
      "def:n:strong:written:parameter",
      "use:n:value:always",
      "def:a:strong:written:parameter",
    ]);
    expect(labelsForNode(mutating, "ENTRY")).toEqual([
      "def:n:strong:written:parameter",
      "use:n:value:always",
      "def:n:strong:written:update",
      "def:a:strong:written:parameter",
    ]);
  });

  it("fails closed for conflicting VLA bounds within one declarator", () => {
    const local = inspectOne(parser, "int f(int i) { int a[i++][i]; return i; }");
    const parameters = inspectOne(parser, "int f(int n, int a[n++], int b[n]) { return n; }");

    expect(local.defUse.status).toBe("disabled");
    expect(local.defUse.disabledReasons).toContain("unsequenced-conflict");
    expect(parameters.defUse.status).toBe("disabled");
    expect(parameters.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it("flattens multidimensional array accesses to one whole-array fact", () => {
    const source = [
      "int f(int i, int j, int value) {",
      "  int matrix[2][3];",
      "  matrix[i][j] = value;",
      "  matrix[i][j] += value;",
      "  return matrix[i][j];",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "matrix[i][j] = value;")).toEqual([
      "use:i:index:always",
      "use:j:index:always",
      "use:value:value:always",
      "def:matrix:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "matrix[i][j] += value;")).toEqual([
      "use:i:index:always",
      "use:j:index:always",
      "use:matrix:array-element:always",
      "use:value:value:always",
      "def:matrix:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "return matrix[i][j];")).toEqual([
      "use:i:index:always",
      "use:j:index:always",
      "use:matrix:array-element:always",
    ]);
  });

  it("normalizes commutative subscripts and direct array dereferences", () => {
    const source = [
      "int f(int i, int a[]) {",
      "  i[a] = 1;",
      "  *a = i[a];",
      "  *(a + i) = *a;",
      "  return *(a + i);",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "i[a] = 1;")).toEqual([
      "use:i:index:always",
      "def:a:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "*a = i[a];")).toEqual([
      "use:i:index:always",
      "use:a:array-element:always",
      "def:a:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "*(a + i) = *a;")).toEqual([
      "use:i:index:always",
      "use:a:array-element:always",
      "def:a:weak:written:array-element",
    ]);
    expect(labelsForNode(analysis, "return *(a + i);")).toEqual([
      "use:i:index:always",
      "use:a:array-element:always",
    ]);
  });

  it("recursively normalizes multidimensional pointer-style dereferences", () => {
    const source = [
      "int f(int i, int j, int matrix[2][3]) {",
      "  int x = **matrix;",
      "  x += *(*(matrix + i) + j);",
      "  *(matrix[0] + j) = x;",
      "  return *(matrix[i] + j);",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("complete");
    expect(labelsForNode(analysis, "int x = **matrix;")).toEqual([
      "use:matrix:array-element:always",
      "def:x:strong:written:declaration",
    ]);
    expect(labelsForNode(analysis, "return *(matrix[i] + j);")).toEqual([
      "use:i:index:always",
      "use:j:index:always",
      "use:matrix:array-element:always",
    ]);
  });

  it("treats partially indexed multidimensional arrays as decays", () => {
    const source = [
      "int f(int i, int matrix[2][3]) {",
      "  sink(matrix[i]);",
      "  sink(*matrix);",
      "  return matrix[0][0];",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "sink(matrix[i]);")).toEqual([
      "use:i:index:always",
      "escape:matrix:array-decay",
    ]);
    expect(labelsForNode(analysis, "sink(*matrix);")).toEqual(["escape:matrix:array-decay"]);
  });

  it.each([
    "long f(long i) { int matrix[2][3]; i = (long)matrix[i++]; return i; }",
    "long f(long i) { int matrix[2][3]; i = (long)*(matrix + i++); return i; }",
  ])("preserves pending index writes across a partial-rank decay: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("models direct address arguments as may-defs and delays escapes until the call", () => {
    const source = [
      "int f(int i) {",
      "  int x = 0;",
      "  int a[4];",
      "  sink(&x, &a[i]);",
      "  int *p = &x;",
      "  consume(a, a[i]);",
      "  return x;",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "sink(&x, &a[i]);")).toEqual([
      "use:i:index:always",
      "def:x:weak:maybe-written:call-argument",
      "def:a:weak:maybe-written:call-argument",
    ]);
    expect(labelsForNode(analysis, "int *p = &x;")).toEqual(["escape:x:stored-address"]);
    expect(labelsForNode(analysis, "consume(a, a[i]);")).toEqual([
      "use:i:index:always",
      "use:a:array-element:always",
      "escape:a:array-decay",
    ]);
    expect(labelsForNode(analysis, "return x;")).toEqual(["use:x:value:always"]);
  });

  it("routes only each control node payload and never rescans its body", () => {
    const source = [
      "int f(int n) {",
      "  int x = 0;",
      "  if (n) x++;",
      "  while (x < n) x++;",
      "  do x--; while (x);",
      "  for (int i = 0; i < n; i++) x += i;",
      "  switch (x) { case 0: return n; default: return x; }",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForType(analysis, "if_statement")).toEqual([["use:n:value:always"]]);
    expect(labelsForType(analysis, "while_statement")).toEqual([
      ["use:x:value:always", "use:n:value:always"],
    ]);
    expect(labelsForType(analysis, "do_condition")).toEqual([["use:x:value:always"]]);
    expect(labelsForType(analysis, "for_initializer")).toEqual([
      ["def:i:strong:written:declaration"],
    ]);
    expect(labelsForType(analysis, "for_statement")).toEqual([
      ["use:i:value:always", "use:n:value:always"],
    ]);
    expect(labelsForType(analysis, "for_update")).toEqual([
      ["use:i:value:always", "def:i:strong:written:update"],
    ]);
    expect(labelsForType(analysis, "switch_statement")).toEqual([["use:x:value:always"]]);
    expect(labelsForType(analysis, "case_statement")).toEqual([[], []]);
  });

  it("marks short-circuit and conditional-arm reads as conditional", () => {
    const source = "int f(int x, int y, int z) { if (x && y) return x ? y : z; return 0; }";
    const analysis = inspectOne(parser, source);

    expect(labelsForType(analysis, "if_statement")).toEqual([
      ["use:x:value:always", "use:y:value:conditional"],
    ]);
    expect(labelsForNode(analysis, "return x ? y : z;")).toEqual([
      "use:x:value:always",
      "use:y:value:conditional",
      "use:z:value:conditional",
    ]);
  });

  it("sequences direct call effects after every argument evaluation", () => {
    const source = "int f(int x) { sink(&x, x); return x; }";
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "sink(&x, x);")).toEqual([
      "use:x:value:always",
      "def:x:weak:maybe-written:call-argument",
    ]);
  });

  it("treats assert as a condition rather than an opaque mutating call", () => {
    const array = inspectOne(parser, "int f(int a[]) { assert(a); return a[0]; }");
    const scalar = inspectOne(parser, "int f(int x) { assert(&x); return x; }");
    const shadowed = inspectOne(
      parser,
      "int f(void (*assert)(int *), int x) { assert(&x); return x; }",
    );
    const fileShadowed = inspectOne(
      parser,
      "void assert(int *); int f(int x) { assert(&x); return x; }",
    );

    expect(labelsForNode(array, "assert(a);")).toEqual([]);
    expect(labelsForNode(scalar, "assert(&x);")).toEqual([]);
    expect(labelsForNode(shadowed, "assert(&x);")).toEqual([
      "def:x:weak:maybe-written:call-argument",
    ]);
    expect(labelsForNode(fileShadowed, "assert(&x);")).toEqual([
      "def:x:weak:maybe-written:call-argument",
    ]);
    expect(array.defUse.status).toBe("complete");
    expect(scalar.defUse.status).toBe("complete");
    expect(shadowed.defUse.status).toBe("complete");
    expect(fileShadowed.defUse.status).toBe("complete");
    for (const analysis of [shadowed, fileShadowed]) {
      const call = analysis.cfg.nodes.find(
        (node) => analysis.source.slice(node.range.from, node.range.to) === "assert(&x);",
      );
      expect(call).toBeDefined();
      expect(
        analysis.cfg.edges.filter((edge) => edge.from === call?.id).map((edge) => edge.kind),
      ).toEqual(["next"]);
    }
  });

  it("does not terminate CFG flow for shadowed exit and abort callees", () => {
    const analysis = inspectOne(
      parser,
      "int f(void (*exit)(int), void (*abort)(void)) { exit(1); abort(); return 0; }",
    );

    for (const statement of ["exit(1);", "abort();"]) {
      const call = analysis.cfg.nodes.find(
        (node) => analysis.source.slice(node.range.from, node.range.to) === statement,
      );
      expect(call).toBeDefined();
      expect(
        analysis.cfg.edges.filter((edge) => edge.from === call?.id).map((edge) => edge.kind),
      ).toEqual(["next"]);
    }
  });

  it("handles parenthesized direct addresses, queued cast escapes and dereference cancellation", () => {
    const source = [
      "int f(int x) {",
      "  sink((&x));",
      "  sink((void *)&x, x);",
      "  return *(&x);",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(labelsForNode(analysis, "sink((&x));")).toEqual([
      "def:x:weak:maybe-written:call-argument",
    ]);
    expect(labelsForNode(analysis, "sink((void *)&x, x);")).toEqual([
      "use:x:value:always",
      "escape:x:stored-address",
    ]);
    expect(labelsForNode(analysis, "return *(&x);")).toEqual(["use:x:value:always"]);
  });

  it("normalizes exact zero-offset address dereferences back to the scalar", () => {
    const ordinary = inspectOne(
      parser,
      "int f(int x) { (&x)[0] = 1; x = *(&x + 0); return 0[&x]; }",
    );
    const conflicting = inspectOne(parser, "int f(int x) { sink((&x)[0]++, x); return x; }");

    expect(labelsForNode(ordinary, "(&x)[0] = 1;")).toEqual(["def:x:strong:written:assignment"]);
    expect(labelsForNode(ordinary, "x = *(&x + 0);")).toEqual([
      "use:x:value:always",
      "def:x:strong:written:assignment",
    ]);
    expect(labelsForNode(ordinary, "return 0[&x];")).toEqual(["use:x:value:always"]);
    expect(conflicting.defUse.status).toBe("disabled");
    expect(conflicting.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("does not escape transient scalar addresses or scalar array-decay results", () => {
    const scalar = inspectOne(
      parser,
      "int f(int x, int *p) { (void)&x; if (&x == p) return x; return x; }",
    );
    const logicalArray = inspectOne(parser, "int f(void) { int a[2]; return !a; }");
    const arrayDifference = inspectOne(parser, "long f(void) { int a[2]; return a - a; }");
    const derivedDifference = inspectOne(parser, "long f(int i) { int a[2]; return (a + i) - a; }");
    const conditionalDifference = inspectOne(
      parser,
      "long f(int c) { int a[2], b[2]; return (c ? a : b) - a; }",
    );
    const commaDifference = inspectOne(parser, "long f(int c) { int a[2]; return (c, a) - a; }");

    for (const analysis of [
      scalar,
      logicalArray,
      arrayDifference,
      derivedDifference,
      conditionalDifference,
      commaDifference,
    ]) {
      expect(analysis.defUse.status).toBe("complete");
      expect(analysis.defUse.facts.flatMap((fact) => fact.effects)).not.toContainEqual(
        expect.objectContaining({ kind: "escape" }),
      );
    }
  });

  it("accepts comma sequencing but refuses conditional writes without a choice IR", () => {
    const ordered = inspectOne(parser, "int f(int i) { (i++, i++); return i; }");
    const conditional = inspectOne(parser, "int f(int x, int y) { x && (y = 1); return y; }");

    expect(labelsForNode(ordered, "(i++, i++);")).toEqual([
      "use:i:value:always",
      "def:i:strong:written:update",
      "use:i:value:always",
      "def:i:strong:written:update",
    ]);
    expect(conditional.defUse.status).toBe("disabled");
    expect(conditional.defUse.disabledReasons).toContain("unsupported-effect-order");
    expect(conditional.defUse.facts).toEqual([]);
  });

  it("limits opaque pointer-write blocking to tracked array alias candidates", () => {
    const scalarOnly = inspectOne(parser, "int f(int x, int *p) { *p = 1; return x; }");
    const arrayCandidate = inspectOne(parser, "int f(int a[], int *p) { *p = 1; return a[0]; }");
    const castAddress = inspectOne(
      parser,
      "int f(void) { int x = 0; ((unsigned char *)&x)[0] = 0; return x; }",
    );

    expect(scalarOnly.defUse.status).toBe("complete");
    expect(labelsForNode(scalarOnly, "*p = 1;")).toEqual([]);
    expect(arrayCandidate.defUse.status).toBe("disabled");
    expect(arrayCandidate.defUse.disabledReasons).toContain("opaque-alias-effect");
    expect(castAddress.defUse.status).toBe("disabled");
    expect(castAddress.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it("keeps address escapes when the address is stored in a struct or array", () => {
    const source = [
      "struct Holder { int *ptr; };",
      "int f(int i) {",
      "  int x = 0;",
      "  struct Holder holder;",
      "  int *slots[2];",
      "  holder.ptr = &x;",
      "  slots[i] = &x;",
      "  return x;",
      "}",
    ].join("\n");
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("complete");
    expect(labelsForNode(analysis, "holder.ptr = &x;")).toEqual(["escape:x:stored-address"]);
    expect(labelsForNode(analysis, "slots[i] = &x;")).toEqual([
      "use:i:index:always",
      "escape:x:stored-address",
    ]);
  });

  it("normalizes pointer arithmetic over a tracked array", () => {
    const analysis = inspectOne(parser, "int f(int i) { int a[4]; *(a + i) = 1; return a[i]; }");

    expect(analysis.defUse.status).toBe("complete");
    expect(labelsForNode(analysis, "*(a + i) = 1;")).toEqual([
      "use:i:index:always",
      "def:a:weak:written:array-element",
    ]);
  });

  it("keeps unsequenced hazard checks for baseline-untracked objects", () => {
    const volatileObject = inspectOne(
      parser,
      "int f(void) { volatile int i = 0; sink(i++, i); return 0; }",
    );
    const pointerObject = inspectOne(parser, "int f(int *p) { sink(p++, p); return 0; }");
    const aggregateObject = inspectOne(
      parser,
      [
        "struct S { int x; };",
        "int f(void) { struct S s = {0}; sink((s = s), s); return 0; }",
      ].join("\n"),
    );
    const aggregateField = inspectOne(
      parser,
      [
        "struct S { int x; };",
        "int f(void) { struct S s = {0}; sink(s.x++, s.x); return 0; }",
      ].join("\n"),
    );
    const memberArray = inspectOne(
      parser,
      [
        "struct S { int values[2]; };",
        "int f(void) { struct S s = {{0}}; sink(s.values[0]++, s.values[0]); return 0; }",
      ].join("\n"),
    );
    const memberPointer = inspectOne(
      parser,
      [
        "struct S { int *value; };",
        "int f(void) { int x = 0; struct S s = {&x}; sink((*s.value)++, *s.value); return x; }",
      ].join("\n"),
    );
    const typedefArray = inspectOne(
      parser,
      "typedef int Values[2]; int f(void) { Values values = {0}; sink(values[0]++, values[0]); return 0; }",
    );
    const arrayObject = inspectOne(
      parser,
      "int f(void) { volatile int a[2]; sink(a[0]++, a[0]); return 0; }",
    );

    for (const analysis of [
      volatileObject,
      pointerObject,
      aggregateObject,
      aggregateField,
      memberArray,
      memberPointer,
      typedefArray,
      arrayObject,
    ]) {
      expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
    }
  });

  it("separates opaque pointer values from their possibly aliased pointees", () => {
    const pointerValue = inspectOne(parser, "int f(int *p) { return (*p)++ + (p != 0); }");
    const arrowValue = inspectOne(
      parser,
      "struct S { int x; }; int f(struct S *p) { return p->x++ + (p != 0); }",
    );
    const dereferenceValue = inspectOne(
      parser,
      "struct S { int x; }; int f(struct S *p) { return (*p).x++ + (p != 0); }",
    );
    const subscriptValue = inspectOne(
      parser,
      "struct S { int x; }; int f(struct S *p) { return p[0].x++ + (p != 0); }",
    );
    const aliasedSubscripts = inspectOne(
      parser,
      "int f(int *p, int *q) { sink(p[0]++, q[0]); return 0; }",
    );
    const aliasedDereferences = inspectOne(
      parser,
      "int f(int *p, int *q) { sink((*p)++, *q); return 0; }",
    );
    const aliasedFieldSubscripts = inspectOne(
      parser,
      [
        "struct S { int *p; };",
        "int f(struct S s, struct S t) { sink(s.p[0]++, t.p[0]); return 0; }",
      ].join("\n"),
    );
    const aliasedFieldDereferences = inspectOne(
      parser,
      [
        "struct S { int x; };",
        "int f(struct S *p, struct S *q) { sink((*p).x++, q->x); return 0; }",
      ].join("\n"),
    );
    const aggregateSubobject = inspectOne(
      parser,
      [
        "struct T { int x; }; struct S { struct T a[2]; };",
        "int f(struct S s) { sink(s.a[0].x++, s); return 0; }",
      ].join("\n"),
    );
    const storedAggregateAlias = inspectOne(
      parser,
      [
        "struct S { int x; };",
        "int f(struct S s) { struct S *p = &s; sink(p->x++, s); return 0; }",
      ].join("\n"),
    );
    const conditionalStoredAggregateAlias = inspectOne(
      parser,
      [
        "struct S { int x; };",
        "int f(struct S s, struct S t, int c) { sink((c ? &s : &t)->x++, s); return 0; }",
      ].join("\n"),
    );
    const directAddressArrowAliases = [
      "(&s)->x++",
      "((0, &s))->x++",
      "(c ? &s : &s)->x++",
      "(&s + 0)->x++",
      "((struct S *)&s)->x++",
    ].map((left) =>
      inspectOne(
        parser,
        `struct S { int x; }; int f(struct S s, int c) { sink(${left}, s); return 0; }`,
      ),
    );

    expect(pointerValue.defUse.status).toBe("complete");
    expect(arrowValue.defUse.status).toBe("complete");
    expect(dereferenceValue.defUse.status).toBe("complete");
    expect(subscriptValue.defUse.status).toBe("complete");
    for (const analysis of [
      aliasedSubscripts,
      aliasedDereferences,
      aliasedFieldSubscripts,
      aliasedFieldDereferences,
      aggregateSubobject,
      storedAggregateAlias,
      conditionalStoredAggregateAlias,
      ...directAddressArrowAliases,
    ]) {
      expect(analysis.defUse.status).toBe("disabled");
      expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
    }
  });

  it("does not reread a local aggregate when selecting a field from an expression result", () => {
    const analysis = inspectOne(
      parser,
      "struct S { int x; }; int f(struct S a, struct S b) { return (a = b).x; }",
    );

    expect(analysis.defUse.status).toBe("complete");
  });

  it("recognizes sequence barriers before an outer assignment store", () => {
    const comma = inspectOne(parser, "int f(int x) { x = (x++, x); return x; }");
    const call = inspectOne(parser, "int f(int x) { x = identity(x++); return x; }");

    expect(comma.defUse.status).toBe("complete");
    expect(call.defUse.status).toBe("complete");
  });

  it("reports nested-call conflicts as unsupported order rather than C UB", () => {
    const scalar = inspectOne(parser, "int f(int x) { sink(inner(&x), x); return x; }");
    const array = inspectOne(parser, "int f(int a[]) { sink(inner(a), a[0]); return a[0]; }");

    for (const analysis of [scalar, array]) {
      expect(analysis.defUse.status).toBe("disabled");
      expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
      expect(analysis.defUse.disabledReasons).not.toContain("unsequenced-conflict");
    }
  });

  it.each([
    "int f(void) { volatile int a[2]; sink(inner(a), a[0]); return 0; }",
    "typedef int V[2]; int f(void) { V a = {0}; sink(inner(a), a[0]); return 0; }",
    "struct S { int a[2]; }; int f(void) { struct S s = {{0}}; sink(inner(s.a), s.a[0]); return 0; }",
    "struct S { int *p; }; int f(struct S s) { sink(inner(s.p), *s.p); return 0; }",
  ])("keeps hidden writes from calls through baseline-untracked values: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it.each([
    "int f(int x, int *p) { return inner(p = &x) + x; }",
    "int f(int x, int *p) { return inner((p = &x, p)) + x; }",
    "int f(void) { int a[2] = {0}; int *p; return inner(p = a) + a[0]; }",
  ])(
    "fails closed when an assignment result carries an escaped object into a call: %s",
    (source) => {
      const analysis = inspectOne(parser, source);

      expect(analysis.defUse.status).toBe("disabled");
      expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
    },
  );

  it.each([
    "int f(int i) { return (i++ + ext()) + i; }",
    "int f(int i) { return i++ + (ext(), i); }",
  ])("does not let an unrelated completed call mask unsequenced UB: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int a[2]) { return a[(a[0]++, 0)]; }",
    "int h(int *); int f(int a[2]) { return a[h(&a[0])]; }",
    "int h(int *); int f(int a[2]) { *(a + h(&a[0])) += 1; return a[0]; }",
  ])("accepts an index write completed before the final element access: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("complete");
  });

  it.each([
    "int f(int *p) { int y = p[(*p)++]; return y; }",
    "int f(int *p) { p[(*p)++]++; return 0; }",
    "int f(int *p) { return *(p + (*p)++); }",
    "int f(int *p) { (*(p + (*p)++))++; return 0; }",
    "struct S { int i; }; int f(struct S *p) { return (p + p->i++)->i; }",
  ])("fails closed when an opaque final read conflicts with a pending write: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("fails closed when an opaque pointer may alias an array parameter", () => {
    for (const source of [
      "int f(int a[], int *p) { sink(p); return a[0]; }",
      "int f(int a[], int *p) { int *q = p; sink(q); return a[0]; }",
      "int *g; int f(int a[]) { sink(g); return a[0]; }",
      "int f(int a[], int *p) { return *p + a[0]; }",
      "int *g; int f(int a[]) { return *g + a[0]; }",
      "int f(int a[], int *p) { return p[0] + a[0]; }",
      "int f(int a[], int *p, int i) { return i[p] + a[0]; }",
      "struct S { int *p; }; int f(int a[], struct S s) { sink(s); return a[0]; }",
      "int f(int a[], int *p) { sink(&p); return a[0]; }",
      "struct S { int *p; }; int f(int a[], struct S s) { sink(&s); return a[0]; }",
    ]) {
      const analysis = inspectOne(parser, source);
      expect(analysis.defUse.status).toBe("disabled");
      expect(analysis.defUse.disabledReasons).toContain("opaque-alias-effect");
    }
  });

  it("fails closed when a call takes the binding address of an adjusted array parameter", () => {
    const analysis = inspectOne(parser, "int f(int a[]) { sink(&a); return a[0]; }");

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it.each([
    "int f(int x, int *p) { return (p = &x, (*p)++) + x; }",
    "int f(int x, int *p) { sink((p = &x, (*p)++), x); return x; }",
  ])(
    "fails closed when a comma chain writes through an address captured earlier in the chain: %s",
    (source) => {
      const analysis = inspectOne(parser, source);

      expect(analysis.defUse.status).toBe("disabled");
      expect(
        analysis.defUse.disabledReasons.some(
          (reason) => reason === "unsupported-effect-order" || reason === "unsequenced-conflict",
        ),
      ).toBe(true);
    },
  );

  it("preserves index roles through update and compound assignment expressions", () => {
    const analysis = inspectOne(
      parser,
      "int f(int i, int j, int a[]) { int x = a[i++]; return a[i += j] + x; }",
    );

    expect(labelsForNode(analysis, "int x = a[i++];")).toEqual([
      "use:i:index:always",
      "def:i:strong:written:update",
      "use:a:array-element:always",
      "def:x:strong:written:declaration",
    ]);
    expect(labelsForNode(analysis, "return a[i += j] + x;")).toEqual([
      "use:i:index:always",
      "use:j:index:always",
      "def:i:strong:written:compound-assignment",
      "use:a:array-element:always",
      "use:x:value:always",
    ]);
  });

  it("propagates index roles through call arguments", () => {
    const analysis = inspectOne(parser, "int f(int i, int a[]) { return a[identity(i)]; }");

    expect(labelsForNode(analysis, "return a[identity(i)];")).toEqual([
      "use:i:index:always",
      "use:a:array-element:always",
    ]);
  });

  it("keeps scalar sizeof unevaluated without disabling the function", () => {
    const analysis = inspectOne(parser, "int f(int x) { return sizeof x + x; }");

    expect(analysis.defUse.status).toBe("complete");
    expect(labelsForNode(analysis, "return sizeof x + x;")).toEqual(["use:x:value:always"]);
  });

  it("keeps ordinary fixed and VLA object sizeof operands unevaluated", () => {
    const fixed = inspectOne(parser, "int f(void) { int a[4]; return sizeof a / sizeof a[0]; }");
    const vla = inspectOne(parser, "int f(int n) { int a[n]; return sizeof a; }");

    expect(fixed.defUse.status).toBe("complete");
    expect(labelsForNode(fixed, "return sizeof a / sizeof a[0];")).toEqual([]);
    expect(vla.defUse.status).toBe("complete");
    expect(labelsForNode(vla, "return sizeof a;")).toEqual([]);
  });

  it("fails closed for variably modified typeof type expressions", () => {
    const analysis = inspectOne(parser, "int f(int n) { typeof(int[n++]) value; return n; }");

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it.each([
    "int f(int x, int *p) { p = &x; sink((*p)++, x); return x; }",
    "int f(void) { int a[2] = {0}; int *p = a; sink(p[0]++, a[0]); return 0; }",
    "int f(void) { volatile int a[2] = {0}; int *p = (int *)a; sink(p[0]++, a[0]); return 0; }",
  ])("finds unsequenced conflicts through a simple stored pointer alias: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x, int *p) { p = &x; return ((*p)++, x); }",
    "int f(int x, int *p) { p = &x; return (*p)++ && x; }",
    "int f(int x, int *p) { p = &x; return (*p)++ ? x : x; }",
    "int f(int x, int *p) { p = &x; *p = x; return x; }",
    "int f(int x, int *p) { p = &x; mutate(p); return x; }",
  ])("preserves sequence barriers around a simple stored pointer alias: %s", (source) => {
    expect(inspectOne(parser, source).defUse.status).toBe("complete");
  });

  it("strongly replaces a simple pointer alias on direct reassignment", () => {
    const safe = inspectOne(
      parser,
      "int f(int x, int y) { int *p = &x; p = &y; sink((*p)++, x); return x + y; }",
    );
    const conflict = inspectOne(
      parser,
      "int f(int x, int y) { int *p = &x; p = &y; sink((*p)++, y); return x + y; }",
    );

    expect(safe.defUse.status).toBe("complete");
    expect(conflict.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each(["*(&p)", "(&p)[0]", "0[&p]", "*(&p + 0)"])(
    "recognizes an exact pointer-binding lvalue written through %s",
    (left) => {
      const analysis = inspectOne(
        parser,
        `int f(int x, int y) { int *p = &y; ${left} = &x; sink((*p)++, x); return x + y; }`,
      );

      expect(analysis.defUse.status).toBe("disabled");
      expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
    },
  );

  it.each([
    "int f(int x, int y) { int *p = &y; int *q = (p = &x, p); sink((*q)++, x); return x + y; }",
    "int f(int x, int y) { int *p = &y, *q = (p = &x, p); sink((*q)++, x); return x + y; }",
  ])("transfers pointer side effects inside a declaration initializer: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x) { int *p = &x, *q = (sink((*p)++, x), p); return x; }",
    "struct S { int x; }; int f(struct S s) { struct S *p = &s, *q = (sink(p->x++, s), p); return q != 0; }",
  ])("threads aliases across declarators in one declaration: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x, int y) { int *p = &y; int z = (p = &x, 0); sink((*p)++, x); return z; }",
    "int f(int x, int y) { int *p = &y; int a[(p = &x, 1)]; sink((*p)++, x); return a[0]; }",
    "struct S { int z; }; int f(int x, int y) { int *p = &y; struct S s = {(p = &x, 0)}; sink((*p)++, x); return s.z; }",
    "int f(int x, int y) { int *p = &y; typedef int A[(p = &x, 1)]; sink((*p)++, x); return sizeof(A); }",
  ])("transfers pointer side effects from every declaration payload: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x, int y) { int *p = &x; sizeof(p = &y); sink((*p)++, x); return x; }",
    "int f(int x, int y) { int *p = &x; sizeof((p = &y)); sink((*p)++, x); return x; }",
  ])("does not transfer pointer writes from unevaluated sizeof operands: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x, int y) { int *p = &y; (p = &x, sink((*p)++, x)); return x + y; }",
    "int f(int x, int y) { int *p = &y; return (p = &x, (*p)++ + x); }",
    "int f(int x, int y) { int *p = &y; (p = &x, inner((*p)++, x)); return x + y; }",
  ])("threads pointer aliases across sequenced comma operands: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x, int y) { int *p = &y; return (p = &x) && sink((*p)++, x); }",
    "int f(int x, int y) { int *p = &y; return (p = &x) ? ((*p)++ + x) : 0; }",
  ])("threads pointer aliases across conditional sequence barriers: %s", (source) => {
    expect(inspectOne(parser, source).defUse.status).toBe("disabled");
  });

  it.each([
    "struct S { int x; }; int f(struct S a, struct S b) { struct S *p = &b; return (p = &a)->x++ + a.x; }",
    "struct S { int x; }; int f(struct S a, struct S b) { struct S *p = &b; return (p = &a, p)->x++ + a.x; }",
  ])("resolves the pointer value produced by an in-expression assignment: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("transfers pointer side effects in a call callee expression", () => {
    const analysis = inspectOne(
      parser,
      "void g(void); int f(int x, int y) { int *p = &y; void (*fp)(void) = g; (p = &x, fp)(); sink((*p)++, x); return x + y; }",
    );

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int x) { int *p = &x; int *q = p; sink((*q)++, x); return x; }",
    "int f(void) { int a[2] = {0}; int *p = a; int *q = p; sink(q[0]++, a[0]); return 0; }",
  ])("propagates a simple pointer alias through a copy: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it.each([
    "int f(int c, int x, int y) { int *p = &y; if (c) p = &x; sink((*p)++, x); return x + y; }",
    "int f(int c, int x, int y) { int *p = &y; while (c) { p = &x; c--; } sink((*p)++, x); return x + y; }",
  ])("joins pointer aliases across CFG branches and loop back-edges: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
  });

  it("invalidates a pointer passed by address and lets a later strong assignment recover", () => {
    const uncertain = inspectOne(
      parser,
      "int f(int x, int y) { int *p = &x; mutate(&p); sink((*p)++, x); return x + y; }",
    );
    const recovered = inspectOne(
      parser,
      "int f(int x, int y) { int *p = &x; mutate(&p); p = &y; sink((*p)++, x); return x + y; }",
    );

    expect(uncertain.defUse.disabledReasons).toContain("unsequenced-conflict");
    expect(recovered.defUse.status).toBe("complete");
  });

  it("does not propagate pointer aliases into unreachable CFG nodes", () => {
    const analysis = inspectOne(parser, "int f(int x) { int *p = &x; return x; sink((*p)++, x); }");

    expect(analysis.defUse.status).toBe("complete");
  });

  it.each([
    "int f(int n, int *p) { (void)(int (*)[n++])p; return n; }",
    "int f(int n, int *p) { return sizeof *(int (*)[n++])p + n; }",
    "int f(int n) { typedef typeof(int[n++]) T; return n; }",
    "int f(int n, typeof(int[n++]) value) { return n; }",
  ])("fails closed for a bound hidden in a variably modified type: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it("fails closed when a generic selection may evaluate a bound variable", () => {
    const analysis = inspectOne(
      parser,
      "int f(void) { volatile int value = 0; sink(_Generic(1, int: value++), value); return 0; }",
    );

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it("fails closed for GNU statement expressions until their statement order is modeled", () => {
    const analysis = inspectOne(parser, "int f(int x) { return ({ int y = x; y + 1; }); }");

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsupported-effect-order");
  });

  it.each([
    "int f(int i) { sink(i++, i); return i; }",
    "int f(int i, int a[]) { a[i++] = i; return i; }",
    "int f(int i) { (i = 1) + i; return i; }",
    "int f(int i) { i = ++i + 1; return i; }",
    "int f(int a[]) { a[a[0]++] = 1; return a[0]; }",
  ])("fails closed for an unsequenced same-variable conflict: %s", (source) => {
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.disabledReasons).toContain("unsequenced-conflict");
    expect(analysis.defUse.facts).toEqual([]);
    expect(analysis.defUse.variables.every((variable) => variable.tracking === "untracked")).toBe(
      true,
    );
  });

  it("accepts transfer-equivalent unsequenced effects on different variables", () => {
    const source = "int f(int i, int j) { sink(i++, j++); return i + j; }";
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.status).toBe("complete");
    expect(labelsForNode(analysis, "sink(i++, j++);")).toEqual([
      "use:i:value:always",
      "def:i:strong:written:update",
      "use:j:value:always",
      "def:j:strong:written:update",
    ]);
  });

  it("publishes deeply frozen facts aligned one-to-one with CFG nodes", () => {
    const source = "int f(int x) { x++; return x; }";
    const analysis = inspectOne(parser, source);

    expect(analysis.defUse.facts).toHaveLength(analysis.cfg.nodes.length);
    expect(analysis.defUse.facts.map(({ nodeId, nodeRange }) => ({ nodeId, nodeRange }))).toEqual(
      analysis.cfg.nodes.map(({ id, range }) => ({ nodeId: id, nodeRange: range })),
    );
    expect(deeplyFrozen(analysis.defUse.facts)).toBe(true);
    expect(
      new Set(analysis.defUse.facts.flatMap((fact) => fact.effects.map((effect) => effect.id)))
        .size,
    ).toBe(analysis.defUse.facts.flatMap((fact) => fact.effects).length);
    expect(JSON.stringify(analysis.defUse.facts)).not.toContain("symbol-");
  });
});

interface InspectedFunction {
  readonly source: string;
  readonly snapshot: ProgramAnalysisSnapshot;
  readonly cfg: FunctionCfg;
  readonly defUse: FunctionDefUse;
}

function inspectOne(parser: CParser, source: string): InspectedFunction {
  return parser.inspect(source, 1, ({ rootNode, document }) => {
    const snapshot = analyzeProgramCst({ source, revision: 1, rootNode, document });
    const cfg = snapshot.functions[0];
    const defUse = snapshot.defUse[0];
    if (cfg === undefined || defUse === undefined) throw new Error("fixture 缺少函数分析");
    return Object.freeze({ source, snapshot, cfg, defUse });
  }).result;
}

function labelsForNode(analysis: InspectedFunction, text: "ENTRY" | "EXIT" | string): string[] {
  const node = analysis.cfg.nodes.find((candidate) => {
    if (text === "ENTRY") return candidate.kind === "entry";
    if (text === "EXIT") return candidate.kind === "exit";
    return analysis.source.slice(candidate.range.from, candidate.range.to).trim() === text;
  });
  if (node === undefined) throw new Error(`找不到 CFG 节点：${text}`);
  const fact = analysis.defUse.facts.find((candidate) => candidate.nodeId === node.id);
  if (fact === undefined) throw new Error(`找不到 def-use fact：${node.id}`);
  return fact.effects.map((effect) => effectLabel(effect, analysis.defUse));
}

function labelsForType(analysis: InspectedFunction, nodeType: string): string[][] {
  return analysis.cfg.nodes
    .filter((node) => node.nodeType === nodeType)
    .map((node) => {
      const fact = analysis.defUse.facts.find((candidate) => candidate.nodeId === node.id);
      if (fact === undefined) throw new Error(`找不到 def-use fact：${node.id}`);
      return fact.effects.map((effect) => effectLabel(effect, analysis.defUse));
    });
}

function effectLabel(effect: DefUseEffect, defUse: FunctionDefUse): string {
  const variable = defUse.variables.find((candidate) => candidate.id === effect.variableId);
  if (variable === undefined) throw new Error(`effect 引用了未知变量：${effect.variableId}`);
  if (effect.kind === "use") {
    return `use:${variable.name}:${effect.role}:${effect.execution}`;
  }
  if (effect.kind === "def") {
    return `def:${variable.name}:${effect.strength}:${effect.valueState}:${effect.origin}`;
  }
  return `escape:${variable.name}:${effect.origin}`;
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
