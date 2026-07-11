import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProgramCst, type FunctionCfg } from "../../src/analysis/index.js";
import { type Block, type CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a CFG foundation", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("builds deterministic sequence and return edges", () => {
    const source = "int f(void) { int x = 0; x++; return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.name).toBe("f");
    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "int x = 0;", "entry"],
      ["int x = 0;", "x++;", "next"],
      ["x++;", "return x;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
    expect(cfg.nodes.every((node) => node.reachable)).toBe(true);
  });

  it("connects an empty function directly to EXIT", () => {
    const source = "int f(void) {}";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([["ENTRY", "EXIT", "entry"]]);
  });

  it("keeps the suffix after return but marks it unreachable", () => {
    const source = "int f(void) { return 1; int x = 2; x++; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "return 1;", "entry"],
      ["return 1;", "EXIT", "return"],
      ["int x = 2;", "x++;", "next"],
      ["x++;", "EXIT", "next"],
    ]);
    expect(reachability(cfg, source)).toMatchObject({
      "return 1;": true,
      "int x = 2;": false,
      "x++;": false,
    });
  });

  it("joins an if without else at the following statement", () => {
    const source = "int f(int x) { if (x) x++; return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "if (x) x++;", "entry"],
      ["if (x) x++;", "x++;", "branch-true"],
      ["if (x) x++;", "return x;", "branch-false"],
      ["x++;", "return x;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("unwraps else_clause and connects both branches to the join", () => {
    const source = "int f(int x) { if (x) x++; else x--; return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(cfg.nodes.some((node) => node.nodeType === "else_clause")).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "if (x) x++; else x--;", "entry"],
      ["if (x) x++; else x--;", "x++;", "branch-true"],
      ["if (x) x++; else x--;", "x--;", "branch-false"],
      ["x++;", "return x;", "next"],
      ["x--;", "return x;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("treats else-if as a nested if node rather than an else wrapper", () => {
    const source = "int f(int x, int y) { if (x) return 1; else if (y) return 2; else return 3; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "if (x) return 1; else if (y) return 2; else return 3;", "entry"],
      ["if (x) return 1; else if (y) return 2; else return 3;", "return 1;", "branch-true"],
      [
        "if (x) return 1; else if (y) return 2; else return 3;",
        "if (y) return 2; else return 3;",
        "branch-false",
      ],
      ["return 1;", "EXIT", "return"],
      ["if (y) return 2; else return 3;", "return 2;", "branch-true"],
      ["if (y) return 2; else return 3;", "return 3;", "branch-false"],
      ["return 2;", "EXIT", "return"],
      ["return 3;", "EXIT", "return"],
    ]);
  });

  it("preserves both typed edges when true and false empty branches share a target", () => {
    const source = "int f(int x) { if (x) {} else {} return 0; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "if (x) {} else {}", "entry"],
      ["if (x) {} else {}", "return 0;", "branch-true"],
      ["if (x) {} else {}", "return 0;", "branch-false"],
      ["return 0;", "EXIT", "return"],
    ]);
  });

  it("builds a while condition, back edge and false exit", () => {
    const source = "int f(int x) { while (x) x--; return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "while (x) x--;", "entry"],
      ["while (x) x--;", "x--;", "branch-true"],
      ["while (x) x--;", "return x;", "branch-false"],
      ["x--;", "while (x) x--;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("routes continue to the while condition and leaves its suffix unreachable", () => {
    const source = "int f(int x) { while (x) { x--; continue; x = 9; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "while (x) { x--; continue; x = 9; }", "entry"],
      ["while (x) { x--; continue; x = 9; }", "x--;", "branch-true"],
      ["while (x) { x--; continue; x = 9; }", "return x;", "branch-false"],
      ["x--;", "continue;", "next"],
      ["continue;", "while (x) { x--; continue; x = 9; }", "continue"],
      ["x = 9;", "while (x) { x--; continue; x = 9; }", "next"],
      ["return x;", "EXIT", "return"],
    ]);
    expect(reachability(cfg, source)["x = 9;"]).toBe(false);
  });

  it("enters a do-while body before evaluating its condition", () => {
    const source = "int f(int x) { do x--; while (x); return x; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "x--;", "entry"],
      ["x--;", "(x)", "next"],
      ["(x)", "x--;", "branch-true"],
      ["(x)", "return x;", "branch-false"],
      ["return x;", "EXIT", "return"],
    ]);
    const condition = cfg.nodes.find((node) => node.nodeType === "do_condition");
    expect(
      condition === undefined
        ? null
        : source.slice(condition.ownerBlockRange.from, condition.ownerBlockRange.to),
    ).toBe("do x--; while (x);");
    expect(
      condition === undefined ? null : source.slice(condition.range.from, condition.range.to),
    ).toBe("(x)");
  });

  it("routes do-while continue to the bottom condition phase", () => {
    const source = "int f(int x) { do { continue; } while (x); return x; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "continue;", "entry"],
      ["continue;", "(x)", "continue"],
      ["(x)", "continue;", "branch-true"],
      ["(x)", "return x;", "branch-false"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("routes nested break to the inner loop continuation", () => {
    const source = "int f(int x) { while (x) { while (x > 1) break; x--; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "while (x) { while (x > 1) break; x--; }", "entry"],
      ["while (x) { while (x > 1) break; x--; }", "while (x > 1) break;", "branch-true"],
      ["while (x) { while (x > 1) break; x--; }", "return x;", "branch-false"],
      ["while (x > 1) break;", "break;", "branch-true"],
      ["while (x > 1) break;", "x--;", "branch-false"],
      ["break;", "x--;", "break"],
      ["x--;", "while (x) { while (x > 1) break; x--; }", "next"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("routes for initialization, continue, update and condition in order", () => {
    const source = "int f(int n) { for (int i = 0; i < n; i++) { continue; } return n; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "int i = 0;", "entry"],
      ["for (int i = 0; i < n; i++) { continue; }", "continue;", "branch-true"],
      ["for (int i = 0; i < n; i++) { continue; }", "return n;", "branch-false"],
      ["int i = 0;", "for (int i = 0; i < n; i++) { continue; }", "next"],
      ["i++", "for (int i = 0; i < n; i++) { continue; }", "next"],
      ["continue;", "i++", "continue"],
      ["return n;", "EXIT", "return"],
    ]);
    const controls = cfg.nodes.filter((node) => node.kind === "control");
    expect(controls.map((node) => source.slice(node.range.from, node.range.to))).toEqual([
      "int i = 0;",
      "i++",
    ]);
    const forNode = cfg.nodes.find((node) => node.nodeType === "for_statement");
    expect(forNode).toBeDefined();
    expect(controls.map((node) => node.ownerBlockRange)).toEqual([forNode?.range, forNode?.range]);
  });

  it("omits the false edge for an endless for loop while preserving break", () => {
    const source = "int f(void) { for (;;) { break; } return 0; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "for (;;) { break; }", "entry"],
      ["for (;;) { break; }", "break;", "branch-true"],
      ["break;", "return 0;", "break"],
      ["return 0;", "EXIT", "return"],
    ]);
  });

  it("honors direct terminators in for initializer and update phases", () => {
    const source = "void f(int x) { for (exit(1); x; abort()) x--; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "exit(1)", "entry"],
      ["for (exit(1); x; abort()) x--;", "x--;", "branch-true"],
      ["for (exit(1); x; abort()) x--;", "EXIT", "branch-false"],
      ["exit(1)", "EXIT", "terminate"],
      ["abort()", "EXIT", "terminate"],
      ["x--;", "abort()", "next"],
    ]);
    expect(reachability(cfg, source)).toMatchObject({
      "for (exit(1); x; abort()) x--;": false,
      "x--;": false,
    });
  });

  it("branches assert in both for header phases", () => {
    const source = "void f(int x) { for (assert(x > 0); x; assert(x > 1)) x--; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "assert(x > 0)", "entry"],
      ["for (assert(x > 0); x; assert(x > 1)) x--;", "x--;", "branch-true"],
      ["for (assert(x > 0); x; assert(x > 1)) x--;", "EXIT", "branch-false"],
      ["assert(x > 0)", "for (assert(x > 0); x; assert(x > 1)) x--;", "branch-true"],
      ["assert(x > 0)", "EXIT", "branch-false"],
      ["assert(x > 1)", "for (assert(x > 0); x; assert(x > 1)) x--;", "branch-true"],
      ["assert(x > 1)", "EXIT", "branch-false"],
      ["x--;", "assert(x > 1)", "next"],
    ]);
  });

  it("models assert as a true continuation and false terminating edge", () => {
    const source = "void f(int x) { assert(x); x--; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "assert(x);", "entry"],
      ["assert(x);", "x--;", "branch-true"],
      ["assert(x);", "EXIT", "branch-false"],
      ["x--;", "EXIT", "next"],
    ]);
  });

  it("treats direct exit and abort calls as terminators", () => {
    const source = "void f(void) { exit(1); abort(); }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "exit(1);", "entry"],
      ["exit(1);", "EXIT", "terminate"],
      ["abort();", "EXIT", "terminate"],
    ]);
    expect(reachability(cfg, source)["abort();"]).toBe(false);
  });

  it.each(["_Exit(0);", "quick_exit(0);"])(
    "treats the standard direct terminator %s as no-return",
    (terminator) => {
      const source = `void f(void) { ${terminator} side(); }`;
      const cfg = analyzeOne(parser, source);

      expect(edgeShapes(cfg, source)).toContainEqual([terminator, "EXIT", "terminate"]);
      expect(reachability(cfg, source)["side();"]).toBe(false);
    },
  );

  it("marks longjmp control flow partial until its target is modeled", () => {
    const source = "void f(void) { longjmp(env, 1); side(); }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(true);
  });

  it("terminates parenthesized direct exit and fails closed for nested exit calls", () => {
    const source = "void f(void) { (exit)(1); foo(exit(1)); return; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "(exit)(1);", "entry"],
      ["(exit)(1);", "EXIT", "terminate"],
      ["foo(exit(1));", "return;", "next"],
      ["return;", "EXIT", "return"],
    ]);
    expect(cfg.partial).toBe(true);
    expect(reachability(cfg, source)["foo(exit(1));"]).toBe(false);
  });

  it("applies user-macro shadows to special calls in translation-unit source order", () => {
    const source = [
      "void before(void) { exit(1); before_side(); }",
      "#define exit(code) record(code)",
      "void active(void) { exit(1); active_side(); }",
      "#undef exit",
      "void restored(void) { exit(1); restored_side(); }",
      "#define assert(value) record(value)",
      "void custom_assert(void) { assert(0); assert_side(); }",
    ].join("\n");
    const snapshot = parser.inspect(source, 1, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 1, rootNode, document }),
    ).result;
    const functions = new Map(snapshot.functions.map((cfg) => [cfg.name, cfg]));
    const before = functions.get("before");
    const active = functions.get("active");
    const restored = functions.get("restored");
    const customAssert = functions.get("custom_assert");
    if (
      before === undefined ||
      active === undefined ||
      restored === undefined ||
      customAssert === undefined
    ) {
      throw new Error("fixture 缺少宏 source-order CFG");
    }

    expect(edgeShapes(before, source)).toContainEqual(["exit(1);", "EXIT", "terminate"]);
    expect(edgeShapes(active, source)).toContainEqual(["exit(1);", "active_side();", "next"]);
    expect(edgeShapes(restored, source)).toContainEqual(["exit(1);", "EXIT", "terminate"]);
    expect(edgeShapes(customAssert, source)).toContainEqual([
      "assert(0);",
      "assert_side();",
      "next",
    ]);
  });

  it("does not claim termination when a conditional macro may shadow a special call", () => {
    const source = [
      "#if FLAG",
      "#define quick_exit(code) record(code)",
      "#endif",
      "void f(void) { quick_exit(0); side(); }",
    ].join("\n");
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toContainEqual(["quick_exit(0);", "side();", "next"]);
    expect(reachability(cfg, source)["side();"]).toBe(true);
  });

  it("latches the NDEBUG contract when assert.h is included", () => {
    const source = [
      "#define NDEBUG",
      "#include <assert.h>",
      "#undef NDEBUG",
      "void skipped(void) { assert(touch()); skipped_side(); }",
      "#include <assert.h>",
      "#define NDEBUG",
      "void evaluated(void) { assert(touch()); evaluated_side(); }",
    ].join("\n");
    const snapshot = parser.inspect(source, 1, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 1, rootNode, document }),
    ).result;
    const functions = new Map(snapshot.functions.map((cfg) => [cfg.name, cfg]));
    const skipped = functions.get("skipped");
    const evaluated = functions.get("evaluated");
    if (skipped === undefined || evaluated === undefined) {
      throw new Error("fixture 缺少 NDEBUG assert CFG");
    }

    expect(edgeShapes(skipped, source)).toContainEqual([
      "assert(touch());",
      "skipped_side();",
      "next",
    ]);
    expect(edgeShapes(evaluated, source)).toContainEqual([
      "assert(touch());",
      "evaluated_side();",
      "branch-true",
    ]);
    expect(edgeShapes(evaluated, source)).toContainEqual([
      "assert(touch());",
      "EXIT",
      "branch-false",
    ]);
  });

  it("does not branch assert when NDEBUG may be active at the assert.h include", () => {
    const source = [
      "#if FLAG",
      "#define NDEBUG",
      "#endif",
      "#include <assert.h>",
      "void f(void) { assert(touch()); side(); }",
    ].join("\n");
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toContainEqual(["assert(touch());", "side();", "next"]);
    expect(reachability(cfg, source)["side();"]).toBe(true);
  });

  it.each(["_Exit", "quick_exit", "longjmp"])(
    "does not apply special control flow to the shadowed parameter %s",
    (name) => {
      const parameters =
        name === "longjmp" ? `void (*${name})(void *, int)` : `void (*${name})(int)`;
      const argumentsList = name === "longjmp" ? "env, 1" : "0";
      const statement = `${name}(${argumentsList});`;
      const source = `void f(${parameters}) { ${statement} side(); }`;
      const cfg = analyzeOne(parser, source);

      expect(edgeShapes(cfg, source)).toContainEqual([statement, "side();", "next"]);
      expect(reachability(cfg, source)["side();"]).toBe(true);
      expect(cfg.partial).toBe(false);
    },
  );

  it("dispatches switch cases and default while honoring break", () => {
    const source = "int f(int x) { switch (x) { case 1: x++; break; default: x--; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "switch (x) { case 1: x++; break; default: x--; }", "entry"],
      ["switch (x) { case 1: x++; break; default: x--; }", "case 1: x++; break;", "switch-case"],
      ["switch (x) { case 1: x++; break; default: x--; }", "default: x--;", "switch-default"],
      ["case 1: x++; break;", "x++;", "next"],
      ["x++;", "break;", "next"],
      ["break;", "return x;", "break"],
      ["default: x--;", "x--;", "next"],
      ["x--;", "return x;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("adds an implicit switch miss edge when default is absent", () => {
    const source = "int f(int x) { switch (x) { case 1: return 1; } return 0; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "switch (x) { case 1: return 1; }", "entry"],
      ["switch (x) { case 1: return 1; }", "case 1: return 1;", "switch-case"],
      ["switch (x) { case 1: return 1; }", "return 0;", "switch-miss"],
      ["case 1: return 1;", "return 1;", "next"],
      ["return 1;", "EXIT", "return"],
      ["return 0;", "EXIT", "return"],
    ]);
  });

  it("preserves switch fallthrough between adjacent cases", () => {
    const source = "int f(int x) { switch (x) { case 1: x++; case 2: x--; break; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "switch (x) { case 1: x++; case 2: x--; break; }", "entry"],
      ["switch (x) { case 1: x++; case 2: x--; break; }", "case 1: x++;", "switch-case"],
      ["switch (x) { case 1: x++; case 2: x--; break; }", "case 2: x--; break;", "switch-case"],
      ["switch (x) { case 1: x++; case 2: x--; break; }", "return x;", "switch-miss"],
      ["case 1: x++;", "x++;", "next"],
      ["x++;", "case 2: x--; break;", "next"],
      ["case 2: x--; break;", "x--;", "next"],
      ["x--;", "break;", "next"],
      ["break;", "return x;", "break"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("does not confuse cases owned by a nested switch with Duff-style cases", () => {
    const source =
      "int f(int x, int y) { switch (x) { case 0: switch (y) { case 1: y++; break; } break; default: x--; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(cfg.edges.filter((edge) => edge.kind === "switch-case")).toHaveLength(2);
    expect(cfg.edges.filter((edge) => edge.kind === "switch-default")).toHaveLength(1);
    expect(cfg.edges.filter((edge) => edge.kind === "switch-miss")).toHaveLength(1);
  });

  it("resolves forward goto to a labeled statement in a second pass", () => {
    const source = "int f(int x) { goto done; x++; done: return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(false);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "goto done;", "entry"],
      ["goto done;", "done: return x;", "goto"],
      ["x++;", "done: return x;", "next"],
      ["done: return x;", "return x;", "next"],
      ["return x;", "EXIT", "return"],
    ]);
    expect(reachability(cfg, source)["x++;"]).toBe(false);
  });

  it("resolves backward goto without treating it as fallthrough", () => {
    const source = "int f(int x) { start: x--; if (x) goto start; return x; }";
    const cfg = analyzeOne(parser, source);

    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "start: x--;", "entry"],
      ["start: x--;", "x--;", "next"],
      ["x--;", "if (x) goto start;", "next"],
      ["if (x) goto start;", "goto start;", "branch-true"],
      ["if (x) goto start;", "return x;", "branch-false"],
      ["goto start;", "start: x--;", "goto"],
      ["return x;", "EXIT", "return"],
    ]);
  });

  it("marks a missing goto label partial without inventing fallthrough", () => {
    const source = "int f(void) { goto missing; return 0; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partialReasons).toEqual([
      expect.objectContaining({ code: "unsupported-control-flow", nodeType: "goto_statement" }),
    ]);
    expect(edgeShapes(cfg, source)).toEqual([
      ["ENTRY", "goto missing;", "entry"],
      ["return 0;", "EXIT", "return"],
    ]);
    expect(reachability(cfg, source)["return 0;"]).toBe(false);
  });

  it("rejects goto that enters a loop body", () => {
    const source = "int f(int x) { goto inside; while (x) { inside: x--; } return x; }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(true);
    expect(cfg.partialReasons).toEqual([
      expect.objectContaining({ code: "unsupported-control-flow", nodeType: "goto_statement" }),
    ]);
    expect(edgeShapes(cfg, source)).toContainEqual(["goto inside;", "inside: x--;", "goto"]);
    expect(edgeShapes(cfg, source)).not.toContainEqual([
      "goto inside;",
      "while (x) { inside: x--; }",
      "next",
    ]);
  });

  it("fails closed with parse-error reasons for a malformed function", () => {
    const source = "int f(int x) { if (x) return 1; else }";
    const cfg = analyzeOne(parser, source);

    expect(cfg.partial).toBe(true);
    expect(cfg.partialReasons).toEqual([
      expect.objectContaining({ code: "parse-error", nodeType: "function_definition" }),
      expect.objectContaining({ code: "parse-error", nodeType: "ERROR" }),
    ]);
    expect(cfg.nodes.filter((node) => node.ownership === "primary")).toHaveLength(3);
  });

  it("fails closed with an explicit partial reason for unsupported control flow", () => {
    const source = "int f(int x) { switch (x) { case 1: while (x) { case 2: x--; } } return x; }";
    const inspected = parser.inspect(source, 1, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 1, rootNode, document }),
    );
    const cfg = inspected.result.functions[0];
    if (cfg === undefined) throw new Error("fixture 缺少函数 CFG");

    expect(cfg.partial).toBe(true);
    expect(cfg.partialReasons).toEqual([
      expect.objectContaining({ code: "unsupported-control-flow", nodeType: "case_statement" }),
    ]);
    expect(edgeShapes(cfg, source)).toContainEqual([
      "ENTRY",
      "switch (x) { case 1: while (x) { case 2: x--; } }",
      "entry",
    ]);
    expect(edgeShapes(cfg, source)).toContainEqual([
      "switch (x) { case 1: while (x) { case 2: x--; } }",
      "return x;",
      "next",
    ]);
    expect(reachability(cfg, source)["return x;"]).toBe(true);
    const projected = collectStructuredStatementRanges(inspected.analysis.document.blocks);
    const owned = cfg.nodes
      .filter((node) => node.kind === "syntax" || node.nodeType === "do_condition")
      .map((node) => `${node.ownerBlockRange.from}:${node.ownerBlockRange.to}`)
      .sort();
    expect(owned).toEqual(projected);
  });

  it("returns a deeply frozen plain snapshot that survives Tree disposal", () => {
    const source = "int f(void) { return 0; }";
    const snapshot = parser.inspect(source, 12, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 12, rootNode, document }),
    ).result;

    expect(snapshot.revision).toBe(12);
    expect(JSON.stringify(snapshot)).not.toMatch(/"tree"|"rootNode"/u);
    expect(deeplyFrozen(snapshot)).toBe(true);
    expect(snapshot.functions[0]?.nodes.map((node) => node.nodeType)).toEqual([
      "function_definition",
      "return_statement",
      "function_definition",
    ]);
  });

  it("is deeply equal across independent reparses of identical source", () => {
    const source = "int f(int x) { if (x) return 1; return 0; }";
    const first = parser.inspect(source, 5, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 5, rootNode, document }),
    ).result;
    const second = parser.inspect(source, 5, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 5, rootNode, document }),
    ).result;

    expect(second).toEqual(first);
  });

  it("binds analysis to one full-source CST and SourceDoc snapshot", () => {
    const firstSource = "int f(void) { int x; return x; }";
    const secondSource = "int f(void) { int y; return y; }";
    const firstDocument = parser.analyze(firstSource, 1).document;

    expect(firstSource).toHaveLength(secondSource.length);
    expect(() =>
      parser.inspect(secondSource, 1, ({ rootNode }) =>
        analyzeProgramCst({
          source: secondSource,
          revision: 1,
          rootNode,
          document: firstDocument,
        }),
      ),
    ).toThrowError(/SourceDoc 与 CST 源码不一致/u);

    expect(() =>
      parser.inspect(firstSource, 1, ({ rootNode: firstRoot }) =>
        parser.inspect(secondSource, 1, ({ document: secondDocument }) =>
          analyzeProgramCst({
            source: secondSource,
            revision: 1,
            rootNode: firstRoot,
            document: secondDocument,
          }),
        ),
      ),
    ).toThrowError(/根节点与 source 不属于同一源码快照/u);
  });

  it("fingerprints the full source without changing deterministic reparses", () => {
    const firstSource = "typedef int A; int f(void) { return 0; }";
    const secondSource = "typedef int B; int f(void) { return 0; }";
    const first = parser.inspect(firstSource, 8, ({ rootNode, document }) =>
      analyzeProgramCst({ source: firstSource, revision: 8, rootNode, document }),
    ).result;
    const repeat = parser.inspect(firstSource, 8, ({ rootNode, document }) =>
      analyzeProgramCst({ source: firstSource, revision: 8, rootNode, document }),
    ).result;
    const second = parser.inspect(secondSource, 8, ({ rootNode, document }) =>
      analyzeProgramCst({ source: secondSource, revision: 8, rootNode, document }),
    ).result;

    expect(firstSource).toHaveLength(secondSource.length);
    expect(repeat.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it("keeps CFG, def-use, memory events and typestate in a documented one-to-one order", () => {
    const source = "int first(void) { return 1; } int second(int x) { return x; }";
    const snapshot = parser.inspect(source, 4, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 4, rootNode, document }),
    ).result;

    expect(snapshot.defUse).toHaveLength(snapshot.functions.length);
    expect(snapshot.memoryEvents).toHaveLength(snapshot.functions.length);
    expect(snapshot.memoryTypestate).toHaveLength(snapshot.functions.length);
    expect(
      snapshot.defUse.map(({ functionId, functionRange }) => ({ functionId, functionRange })),
    ).toEqual(
      snapshot.functions.map(({ id, range }) => ({ functionId: id, functionRange: range })),
    );
    expect(
      snapshot.memoryEvents.map(({ functionId, functionRange }) => ({
        functionId,
        functionRange,
      })),
    ).toEqual(
      snapshot.functions.map(({ id, range }) => ({ functionId: id, functionRange: range })),
    );
    expect(
      snapshot.memoryTypestate.map(({ functionId, functionRange }) => ({
        functionId,
        functionRange,
      })),
    ).toEqual(
      snapshot.functions.map(({ id, range }) => ({ functionId: id, functionRange: range })),
    );
  });

  it.each([
    "int f(void) { int x = 0; x++; return x; }",
    "int f(int x) { if (x) x++; return x; }",
    "int f(int x) { if (x) x++; else x--; return x; }",
    "int f(int x, int y) { if (x) return 1; else if (y) return 2; else return 3; }",
    "int f(int x) { while (x) x--; return x; }",
    "int f(int x) { do x--; while (x); return x; }",
    "int f(int n) { for (int i = 0; i < n; i++) continue; return n; }",
    "int f(int x) { switch (x) { case 1: x++; break; default: x--; } return x; }",
    "int f(int x) { goto done; x++; done: return x; }",
  ])("owns every projected statement or declaration exactly once: %s", (source) => {
    const inspected = parser.inspect(source, 3, ({ rootNode, document }) =>
      analyzeProgramCst({ source, revision: 3, rootNode, document }),
    );
    const cfg = inspected.result.functions[0];
    if (cfg === undefined) throw new Error("fixture 缺少函数 CFG");

    const projected = collectStructuredStatementRanges(inspected.analysis.document.blocks);
    const analyzed = cfg.nodes
      .filter((node) => node.kind === "syntax" || node.nodeType === "do_condition")
      .map((node) => `${node.ownerBlockRange.from}:${node.ownerBlockRange.to}`)
      .sort();

    expect(analyzed).toEqual(projected);
    expect(new Set(analyzed).size).toBe(analyzed.length);
  });
});

function analyzeOne(parser: CParser, source: string): FunctionCfg {
  const snapshot = parser.inspect(source, 1, ({ rootNode, document }) =>
    analyzeProgramCst({ source, revision: 1, rootNode, document }),
  ).result;
  const cfg = snapshot.functions[0];
  if (cfg === undefined) throw new Error("fixture 缺少函数 CFG");
  return cfg;
}

function edgeShapes(cfg: FunctionCfg, source: string): readonly (readonly string[])[] {
  const labels = new Map(cfg.nodes.map((node) => [node.id, nodeLabel(node, source)]));
  return cfg.edges.map((edge) => [
    labels.get(edge.from) ?? "?",
    labels.get(edge.to) ?? "?",
    edge.kind,
  ]);
}

function reachability(cfg: FunctionCfg, source: string): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    cfg.nodes
      .filter((node) => node.kind === "syntax")
      .map((node) => [source.slice(node.range.from, node.range.to).trim(), node.reachable]),
  );
}

function nodeLabel(node: FunctionCfg["nodes"][number], source: string): string {
  if (node.kind === "entry") return "ENTRY";
  if (node.kind === "exit") return "EXIT";
  return source.slice(node.range.from, node.range.to).trim();
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => deeplyFrozen(child, seen));
}

function collectStructuredStatementRanges(blocks: readonly Block[]): readonly string[] {
  const ranges: string[] = [];
  const visit = (block: Block): void => {
    if (block.kind === "syntax" && (block.role === "statement" || block.role === "declaration")) {
      ranges.push(`${block.range.from}:${block.range.to}`);
    }
    block.children.forEach(visit);
  };
  blocks.forEach(visit);
  return ranges.sort();
}
