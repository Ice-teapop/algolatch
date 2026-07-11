import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DefUseDefinitionEffect,
  DefUseUseEffect,
  FunctionDefUse,
  ProgramAnalysisSnapshot,
  ReachingDefinitionFact,
  ReachingDefinitionUse,
} from "../../src/analysis/index.js";
import { analyzeProgramCst } from "../../src/analysis/index.js";
import type { CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a reaching definitions", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("replays uninitialized and strong definitions in node effect order", () => {
    const analysis = inspectOne(parser, "int f(int p) { int x; int y = x; x = p; return x + y; }");

    expect(definitionOriginsForUse(analysis, "int y = x;", "x")).toEqual([
      "declaration:strong:uninitialized",
    ]);
    expect(definitionOriginsForUse(analysis, "x = p;", "p")).toEqual(["parameter:strong:written"]);
    expect(definitionOriginsForUse(analysis, "return x + y;", "x")).toEqual([
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(analysis, "return x + y;", "y")).toEqual([
      "declaration:strong:written",
    ]);
  });

  it("preserves tracked empty state for a self-initializer", () => {
    const analysis = inspectOne(parser, "int f(void) { int x = x; return x; }");
    const resolution = resolutionForUse(analysis, "int x = x;", "x");

    expect(resolution.availability).toBe("tracked");
    expect(resolution.definitionEffectIds).toEqual([]);
    expect(definitionOriginsForUse(analysis, "return x;", "x")).toEqual([
      "declaration:strong:written",
    ]);
  });

  it("unions weak call definitions without killing the prior scalar definition", () => {
    const analysis = inspectOne(parser, "int f(int x) { int y = x; sink(&y, y); return y; }");

    expect(definitionOriginsForUse(analysis, "sink(&y, y);", "y")).toEqual([
      "declaration:strong:written",
    ]);
    expect(definitionOriginsForUse(analysis, "return y;", "y")).toEqual([
      "declaration:strong:written",
      "call-argument:weak:maybe-written",
    ]);
  });

  it("keeps whole-array declarations beside weak element definitions", () => {
    const analysis = inspectOne(parser, "int f(int i) { int a[2]; a[i] = 1; return a[i]; }");

    expect(definitionOriginsForUse(analysis, "return a[i];", "a")).toEqual([
      "declaration:strong:uninitialized",
      "array-element:weak:written",
    ]);
  });

  it("joins both sides of a diamond and preserves the zero-iteration path", () => {
    const diamond = inspectOne(
      parser,
      "int f(int c, int x) { if (c) x = 1; else x = 2; return x; }",
    );
    const loop = inspectOne(
      parser,
      "int f(int c) { int x = 0; while (c) { x = x + 1; c--; } return x; }",
    );

    expect(definitionOriginsForUse(diamond, "return x;", "x")).toEqual([
      "assignment:strong:written",
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(loop, "x = x + 1;", "x")).toEqual([
      "declaration:strong:written",
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(loop, "return x;", "x")).toEqual([
      "declaration:strong:written",
      "assignment:strong:written",
    ]);
  });

  it("respects do-first execution, for back-edges and goto joins", () => {
    const doLoop = inspectOne(
      parser,
      "int f(int c) { int x = 0; do { x = 1; } while (c); return x; }",
    );
    const forLoop = inspectOne(
      parser,
      "int f(int n) { int x = 0; for (int i = 0; i < n; i++) { x = i; if (i) continue; } return x; }",
    );
    const jumped = inspectOne(
      parser,
      "int f(int c) { int x = 0; if (c) goto done; x = 1; done: return x; }",
    );

    expect(definitionOriginsForUse(doLoop, "return x;", "x")).toEqual([
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(forLoop, "return x;", "x")).toEqual([
      "declaration:strong:written",
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(forLoop, "i++", "i")).toEqual([
      "declaration:strong:written",
      "update:strong:written",
    ]);
    expect(definitionOriginsForUse(jumped, "return x;", "x")).toEqual([
      "declaration:strong:written",
      "assignment:strong:written",
    ]);
  });

  it("keeps the switch miss path and crosses 32-bit bitset word boundaries", () => {
    const switched = inspectOne(
      parser,
      "int f(int c) { int x = 0; switch (c) { case 1: x = 1; break; } return x; }",
    );
    const declarations = Array.from({ length: 40 }, (_value, index) => `int v${index} = ${index};`);
    const wide = inspectOne(parser, `int f(void) { ${declarations.join(" ")} return v39; }`);

    expect(definitionOriginsForUse(switched, "return x;", "x")).toEqual([
      "declaration:strong:written",
      "assignment:strong:written",
    ]);
    expect(definitionOriginsForUse(wide, "return v39;", "v39")).toEqual([
      "declaration:strong:written",
    ]);
  });

  it("makes stored-address escape an absorbing state across later definitions and joins", () => {
    const straight = inspectOne(parser, "int f(int x) { int *p = &x; x = 1; return x; }");
    const joined = inspectOne(
      parser,
      "int f(int c, int x) { if (c) { int *p = &x; sink(p); } return x; }",
    );

    for (const analysis of [straight, joined]) {
      const resolution = resolutionForUse(analysis, "return x;", "x");
      expect(resolution.availability).toBe("escaped");
      expect(resolution.definitionEffectIds).toEqual([]);
      expect(flowForNode(analysis, "return x;").inEscapedVariableIds).toContain(
        variableId(analysis.defUse, "x"),
      );
    }
  });

  it("keeps direct address calls precise and applies escape only after its effect", () => {
    const directCall = inspectOne(parser, "int f(int x) { sink(&x, x); return x; }");
    const arrayEscape = inspectOne(
      parser,
      "int f(void) { int a[2] = {0}; return (consume(a), a[0]); }",
    );

    expect(resolutionForUse(directCall, "sink(&x, x);", "x").availability).toBe("tracked");
    expect(definitionOriginsForUse(directCall, "return x;", "x")).toEqual([
      "parameter:strong:written",
      "call-argument:weak:maybe-written",
    ]);
    const escapedUse = resolutionForUse(arrayEscape, "return (consume(a), a[0]);", "a");
    expect(escapedUse.availability).toBe("escaped");
    expect(escapedUse.definitionEffectIds).toEqual([]);
  });

  it("changes use availability exactly at an in-node escape effect", () => {
    const analysis = inspectOne(
      parser,
      "int f(void) { int a[2] = {0}; return (a[0], consume(a), a[0]); }",
    );
    const resolutions = resolutionsForUses(analysis, "return (a[0], consume(a), a[0]);", "a");

    expect(resolutions.map((resolution) => resolution.availability)).toEqual([
      "tracked",
      "escaped",
    ]);
    expect(resolutions[0]?.definitionEffectIds).toHaveLength(1);
    expect(resolutions[1]?.definitionEffectIds).toEqual([]);
  });

  it("marks unreachable uses explicitly and never propagates definitions into them", () => {
    const analysis = inspectOne(parser, "int f(int x) { return x; x++; }");
    const flow = flowForNode(analysis, "x++;");
    const resolution = resolutionForUse(analysis, "x++;", "x");

    expect(flow.inDefinitionEffectIds).toEqual([]);
    expect(flow.outDefinitionEffectIds).toEqual([]);
    expect(flow.inEscapedVariableIds).toEqual([]);
    expect(flow.outEscapedVariableIds).toEqual([]);
    expect(resolution.availability).toBe("unreachable");
    expect(resolution.definitionEffectIds).toEqual([]);
  });

  it("does not publish partial reaching facts for disabled functions", () => {
    const analysis = inspectOne(
      parser,
      "#define STEP(v) ((v)++)\nint f(int x) { STEP(x); return x; }",
    );

    expect(analysis.defUse.status).toBe("disabled");
    expect(analysis.defUse.reachingDefinitions).toEqual([]);
  });

  it("is deterministic, deeply frozen and references only local definition effects", () => {
    const source = "int f(int c, int x) { if (c) x = 1; return x; }";
    const first = inspectOne(parser, source);
    const second = inspectOne(parser, source);
    const definitionIds = new Set(
      first.defUse.facts.flatMap((fact) =>
        fact.effects.filter((effect) => effect.kind === "def").map((effect) => effect.id),
      ),
    );

    expect(first.defUse.reachingDefinitions).toEqual(second.defUse.reachingDefinitions);
    expect(deeplyFrozen(first.defUse.reachingDefinitions)).toBe(true);
    for (const flow of first.defUse.reachingDefinitions) {
      for (const definitionId of [
        ...flow.inDefinitionEffectIds,
        ...flow.outDefinitionEffectIds,
        ...flow.uses.flatMap((use) => use.definitionEffectIds),
      ]) {
        expect(definitionIds.has(definitionId)).toBe(true);
      }
    }
  });
});

interface InspectedFunction {
  readonly source: string;
  readonly snapshot: ProgramAnalysisSnapshot;
  readonly defUse: FunctionDefUse;
}

function inspectOne(parser: CParser, source: string): InspectedFunction {
  return parser.inspect(source, 1, ({ rootNode, document }) => {
    const snapshot = analyzeProgramCst({ source, revision: 1, rootNode, document });
    const defUse = snapshot.defUse[0];
    if (defUse === undefined) throw new Error("fixture 缺少函数 def-use");
    return Object.freeze({ source, snapshot, defUse });
  }).result;
}

function flowForNode(analysis: InspectedFunction, text: string): ReachingDefinitionFact {
  const cfg = analysis.snapshot.functions[0];
  if (cfg === undefined) throw new Error("fixture 缺少 CFG");
  const node = cfg.nodes.find(
    (candidate) => analysis.source.slice(candidate.range.from, candidate.range.to).trim() === text,
  );
  if (node === undefined) throw new Error(`找不到 CFG 节点：${text}`);
  const flow = analysis.defUse.reachingDefinitions.find(
    (candidate) => candidate.nodeId === node.id,
  );
  if (flow === undefined) throw new Error(`找不到 reaching fact：${node.id}`);
  return flow;
}

function resolutionForUse(
  analysis: InspectedFunction,
  nodeText: string,
  variableName: string,
): ReachingDefinitionUse {
  const resolution = resolutionsForUses(analysis, nodeText, variableName)[0];
  if (resolution === undefined) throw new Error(`节点 ${nodeText} 缺少 ${variableName} use`);
  return resolution;
}

function resolutionsForUses(
  analysis: InspectedFunction,
  nodeText: string,
  variableName: string,
): readonly ReachingDefinitionUse[] {
  const variable = analysis.defUse.variables.find((candidate) => candidate.name === variableName);
  if (variable === undefined) throw new Error(`找不到变量：${variableName}`);
  const cfg = analysis.snapshot.functions[0];
  if (cfg === undefined) throw new Error("fixture 缺少 CFG");
  const node = cfg.nodes.find(
    (candidate) =>
      analysis.source.slice(candidate.range.from, candidate.range.to).trim() === nodeText,
  );
  if (node === undefined) throw new Error(`找不到 CFG 节点：${nodeText}`);
  const fact = analysis.defUse.facts.find((candidate) => candidate.nodeId === node.id);
  const flow = analysis.defUse.reachingDefinitions.find(
    (candidate) => candidate.nodeId === node.id,
  );
  if (fact === undefined || flow === undefined)
    throw new Error(`节点缺少 def-use 数据：${node.id}`);
  const uses = fact.effects.filter(
    (effect): effect is DefUseUseEffect =>
      effect.kind === "use" && effect.variableId === variable.id,
  );
  return uses.map((use) => {
    const resolution = flow.uses.find((candidate) => candidate.useEffectId === use.id);
    if (resolution === undefined) throw new Error(`use 缺少 reaching resolution：${use.id}`);
    return resolution;
  });
}

function definitionOriginsForUse(
  analysis: InspectedFunction,
  nodeText: string,
  variableName: string,
): string[] {
  const resolution = resolutionForUse(analysis, nodeText, variableName);
  expect(resolution.availability).toBe("tracked");
  const definitions = new Map(
    analysis.defUse.facts.flatMap((fact) =>
      fact.effects
        .filter((effect): effect is DefUseDefinitionEffect => effect.kind === "def")
        .map((effect) => [effect.id, effect] as const),
    ),
  );
  return resolution.definitionEffectIds.map((definitionId) => {
    const definition = definitions.get(definitionId);
    if (definition === undefined) throw new Error(`找不到 definition：${definitionId}`);
    return `${definition.origin}:${definition.strength}:${definition.valueState}`;
  });
}

function variableId(defUse: FunctionDefUse, name: string): string {
  const variable = defUse.variables.find((candidate) => candidate.name === name);
  if (variable === undefined) throw new Error(`找不到变量：${name}`);
  return variable.id;
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
