import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFlowProjection } from "../../src/flow/index.js";
import type { CParser } from "../../src/core/index.js";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";
import { createTestParser } from "../core/parser-fixture.js";
import { analyzeFlowFixture, deeplyFrozen } from "./fixture.js";

describe("source-authoritative flow projection", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("projects Start/End and preserves every CFG edge kind without merging typed edges", () => {
    const fixture = analyzeFlowFixture(parser, "int f(int x) { if (x) {} else {} return 0; }", 7);
    const { projection, analysis } = fixture;
    const cfg = analysis.functions[0];
    if (cfg === undefined) throw new Error("fixture 缺少 CFG");

    expect(projection.sourceRevision).toBe(7);
    expect(projection.nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(projection.nodes.filter((node) => node.kind === "end")).toHaveLength(1);
    expect(projection.edges.map((edge) => edge.kind)).toEqual(cfg.edges.map((edge) => edge.kind));

    const trueEdge = projection.edges.find((edge) => edge.kind === "branch-true");
    const falseEdge = projection.edges.find((edge) => edge.kind === "branch-false");
    expect(trueEdge?.to.nodeId).toBe(falseEdge?.to.nodeId);
    expect(trueEdge?.id).not.toBe(falseEdge?.id);
    expect(trueEdge?.from.portId).not.toBe(falseEdge?.from.portId);
  });

  it("keeps multiple same-kind switch endpoints in distinct edge lanes", () => {
    const { projection } = analyzeFlowFixture(
      parser,
      "int f(int x) { switch (x) { case 1: x++; break; case 2: x += 2; break; default: x--; } return x; }",
    );
    const cases = projection.edges.filter((edge) => edge.kind === "switch-case");

    expect(cases).toHaveLength(2);
    expect(new Set(cases.map((edge) => edge.id)).size).toBe(2);
    expect(new Set(cases.map((edge) => edge.to.nodeId)).size).toBe(2);
    expect(cases.map((edge) => edge.slot)).toEqual([0, 1]);
    expect(new Set(cases.map((edge) => edge.from.portId)).size).toBe(1);
  });

  it("publishes valid endpoint ports and stable free-layout coordinates", () => {
    const source = "int first(void) { return 1; } int second(int x) { while (x) x--; return x; }";
    const first = analyzeFlowFixture(parser, source, 3).projection;
    const second = analyzeFlowFixture(parser, source, 3).projection;

    expect(second).toEqual(first);
    expect(deeplyFrozen(first)).toBe(true);
    expect(
      new Set(first.nodes.map((node) => `${node.defaultPosition.x}:${node.defaultPosition.y}`))
        .size,
    ).toBe(first.nodes.length);
    for (const edge of first.edges) {
      const from = first.nodes.find((node) => node.id === edge.from.nodeId);
      const to = first.nodes.find((node) => node.id === edge.to.nodeId);
      expect(from?.ports.some((port) => port.id === edge.from.portId)).toBe(true);
      expect(to?.ports.some((port) => port.id === edge.to.portId)).toBe(true);
    }
  });

  it("keeps repeated guard returns distinct and places nested branches in readable lanes", () => {
    const { projection } = analyzeFlowFixture(parser, FIRST_ALGORITHM_SOURCE);
    const repeatedReturns = projection.nodes.filter(
      (node) => node.sourceText.trim() === "return 1;",
    );
    const outerBranch = projection.nodes.find((node) => node.range.from === 52);
    const outerReturn = projection.nodes.find((node) => node.range.from === 102);
    const loop = projection.nodes.find((node) => node.kind === "loop");
    const loopBodyDeclaration = projection.nodes.find((node) => node.range.from === 227);
    const nestedBranch = projection.nodes.find((node) => node.range.from === 242);
    const nestedReturn = projection.nodes.find((node) => node.range.from === 280);

    expect(repeatedReturns).toHaveLength(3);
    expect(new Set(repeatedReturns.map((node) => node.id)).size).toBe(3);
    expect(new Set(repeatedReturns.map((node) => `${node.range.from}:${node.range.to}`)).size).toBe(
      3,
    );
    expect(repeatedReturns.every((node) => /^L\d+ · return 1;$/u.test(node.label))).toBe(true);
    expect(outerReturn?.defaultPosition.x).toBeGreaterThan(outerBranch?.defaultPosition.x ?? 0);
    expect(loopBodyDeclaration?.defaultPosition.x).toBeGreaterThan(loop?.defaultPosition.x ?? 0);
    expect(nestedReturn?.defaultPosition.x).toBeGreaterThan(nestedBranch?.defaultPosition.x ?? 0);
  });

  it("projects valid translation-unit declarations as locked module nodes without raw/partial labels", () => {
    const source = [
      "#include <stdio.h>",
      "#define LIMIT 8",
      "typedef unsigned count_t;",
      "static count_t global_count = LIMIT;",
      "int main(void) { return global_count == LIMIT ? 0 : 1; }",
      "",
    ].join("\n");
    const { projection, document } = analyzeFlowFixture(parser, source);
    const moduleNodes = projection.nodes.filter((node) => node.kind === "module");

    expect(moduleNodes.map((node) => node.nodeType)).toEqual([
      "preproc_include",
      "preproc_def",
      "type_definition",
      "declaration",
    ]);
    expect(moduleNodes.map((node) => node.sourceText)).toEqual([
      "#include <stdio.h>\n",
      "#define LIMIT 8\n",
      "typedef unsigned count_t;",
      "static count_t global_count = LIMIT;",
    ]);
    expect(
      moduleNodes.every(
        (node) =>
          node.functionId === null &&
          node.sourceNodeId === null &&
          node.locked &&
          node.ports.length === 0 &&
          node.lockReasons.length === 1 &&
          node.lockReasons[0]?.code === "translation-unit" &&
          node.lockReasons[0].partialCode === null &&
          node.lockReasons[0].rawReason === null &&
          node.sourceText === document.source.slice(node.range.from, node.range.to),
      ),
    ).toBe(true);
    expect(projection.nodes.filter((node) => node.kind === "raw")).toEqual([]);
    expect(projection.functions.every((fn) => !fn.partial)).toBe(true);
    expect(document.source).toBe(source);
  });

  it("exposes edit handles only for the source-writer subset", () => {
    const { projection } = analyzeFlowFixture(
      parser,
      "int f(int x) { int y = 0; if (x) y++; else y--; return y; }",
    );
    const editableOutputs = projection.nodes.flatMap((node) =>
      node.ports.filter((port) => port.direction === "output" && port.editable),
    );
    expect(editableOutputs.map((port) => port.edgeKind)).toEqual(
      expect.arrayContaining(["next", "branch-true", "branch-false"]),
    );
    for (const node of projection.nodes.filter(
      (candidate) =>
        candidate.kind === "start" ||
        candidate.kind === "end" ||
        candidate.kind === "declaration" ||
        candidate.nodeType === "return_statement",
    )) {
      expect(
        node.ports.every((port) => port.direction !== "output" || port.editable === false),
      ).toBe(true);
    }
  });

  it("projects proven def-use relations as read-only data wires", () => {
    const { projection } = analyzeFlowFixture(
      parser,
      "int f(void) { int x = 1; int y = x + 1; return y; }",
    );

    expect(projection.dataEdges.length).toBeGreaterThanOrEqual(2);
    expect(projection.dataEdges.every((edge) => edge.channel === "data" && !edge.editable)).toBe(
      true,
    );
    expect(projection.dataEdges.map((edge) => edge.variableName)).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    expect(
      projection.dataEdges.every(
        (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
      ),
    ).toBe(true);
  });

  it("locks every node and edge in a partial CFG with explicit reasons", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(void) { goto missing; return 0; }");
    const functionProjection = projection.functions[0];
    if (functionProjection === undefined) throw new Error("fixture 缺少函数投影");
    const functionNodes = projection.nodes.filter(
      (node) => node.functionId === functionProjection.id && node.kind !== "raw",
    );

    expect(functionProjection.partial).toBe(true);
    expect(projection.nodes.filter((node) => node.kind === "module")).toEqual([]);
    expect(functionProjection.lockReasons).toEqual([
      expect.objectContaining({ code: "partial-cfg", partialCode: "unsupported-control-flow" }),
    ]);
    expect(functionNodes.length).toBeGreaterThan(0);
    expect(functionNodes.every((node) => node.locked && node.lockReasons.length > 0)).toBe(true);
    expect(projection.edges.every((edge) => !edge.editable)).toBe(true);
  });

  it("projects unsupported raw source as a locked, disconnected node", () => {
    const { projection } = analyzeFlowFixture(
      parser,
      "__attribute__((unused)) int extended(void) { return 1; }\nint main(void) { return 0; }\n",
    );
    const rawNodes = projection.nodes.filter((node) => node.kind === "raw");

    expect(rawNodes.length).toBeGreaterThan(0);
    expect(projection.nodes.filter((node) => node.kind === "module")).toEqual([]);
    expect(rawNodes.every((node) => node.locked && node.ports.length === 0)).toBe(true);
    expect(rawNodes[0]?.lockReasons[0]).toEqual(
      expect.objectContaining({ code: "raw-block", rawReason: "unsupported-syntax" }),
    );
  });

  it("rejects an analysis snapshot paired with a different SourceDoc", () => {
    const first = analyzeFlowFixture(parser, "int f(void) { return 0; }", 1);
    const otherDocument = parser.project("int g(void) { return 1; }");

    expect(() => createFlowProjection(first.analysis, otherDocument)).toThrowError(
      /不属于同一源码快照/u,
    );
  });
});
