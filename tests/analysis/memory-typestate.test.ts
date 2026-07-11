import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeProgramCst,
  type FunctionMemoryEvents,
  type FunctionMemoryTypestate,
  type MemoryHandleTypestateFact,
  type MemoryTypestateFact,
  type MemoryTypestateValue,
  type ProgramAnalysisSnapshot,
} from "../../src/analysis/index.js";
import type { CParser } from "../../src/core/index.js";
import { createTestParser } from "../core/parser-fixture.js";

describe("M5a unique-handle memory typestate", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("refines a maybe-null allocation on exact guard edges", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); if (!p) return 1; *p = 1; free(p); return 0; }",
    );
    const typestate = onlyTypestate(analysis.snapshot);
    const memory = onlyMemory(analysis.snapshot);
    const allocation = onlyHandle(factForText(analysis, "int *p = malloc(4);"));
    const nullReturn = onlyHandle(factForText(analysis, "return 1;"));
    const dereference = onlyHandle(factForText(analysis, "*p = 1;"));
    const free = onlyHandle(factForText(analysis, "free(p);"));

    expect(typestate.status).toBe("complete");
    expect(stateNames(allocation.outStates)).toEqual(["maybeNull"]);
    expect(allocation.outStates[0]?.eventIds).toHaveLength(1);
    expect(stateNames(nullReturn.inStates)).toEqual(["unalloc"]);
    expect(stateNames(dereference.inStates)).toEqual(["alloc"]);
    const guardEventId = allEvents(memory).find((event) => event.kind === "null-guard")?.id;
    expect(dereference.inStates[0]?.eventIds).toContain(guardEventId);
    expect(stateNames(free.inStates)).toEqual(["alloc"]);
    expect(stateNames(free.outStates)).toEqual(["freed"]);

    const guardNodeId = memory.facts.find((fact) =>
      fact.events.some((event) => event.kind === "null-guard"),
    )?.nodeId;
    const guardEdges = typestate.edgeFacts.filter((edge) => edge.from === guardNodeId);
    expect(
      guardEdges.map((edge) => [edge.kind, stateNames(edge.handles[0]?.states ?? [])]),
    ).toEqual([
      ["branch-true", ["unalloc"]],
      ["branch-false", ["alloc"]],
    ]);
  });

  it("preserves assert polarity for both non-null and null continuations", () => {
    const nonNull = inspect(
      parser,
      "#include <stdlib.h>\n#include <assert.h>\nint f(void) { int *p = malloc(4); assert(p); free(p); return 0; }",
    );
    const isNull = inspect(
      parser,
      "#include <stdlib.h>\n#include <assert.h>\nint f(void) { int *p = malloc(4); assert(!p); return 0; }",
    );

    expect(stateNames(onlyHandle(factForText(nonNull, "free(p);")).inStates)).toEqual(["alloc"]);
    expect(stateNames(onlyHandle(factForText(isNull, "return 0;")).inStates)).toEqual(["unalloc"]);

    const finalAssert = inspect(
      parser,
      "#include <stdlib.h>\n#include <assert.h>\nvoid f(void) { int *p = malloc(4); assert(p); }",
    );
    const finalTypestate = onlyTypestate(finalAssert.snapshot);
    const assertNodeId = onlyMemory(finalAssert.snapshot).facts.find((fact) =>
      fact.events.some((event) => event.kind === "null-guard"),
    )?.nodeId;
    const assertEdges = finalTypestate.edgeFacts.filter((edge) => edge.from === assertNodeId);
    expect(new Set(assertEdges.map((edge) => edge.to)).size).toBe(1);
    expect(
      assertEdges.map((edge) => [edge.kind, stateNames(edge.handles[0]?.states ?? [])]),
    ).toEqual([
      ["branch-true", ["alloc"]],
      ["branch-false", ["unalloc"]],
    ]);
  });

  it("keeps parallel guard edges distinct even when they share a successor", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); if (p) { } free(p); return 0; }",
    );
    const typestate = onlyTypestate(analysis.snapshot);
    const memory = onlyMemory(analysis.snapshot);
    const guardNodeId = memory.facts.find((fact) =>
      fact.events.some((event) => event.kind === "null-guard"),
    )?.nodeId;
    const edges = typestate.edgeFacts.filter((edge) => edge.from === guardNodeId);

    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.to)).size).toBe(1);
    expect(edges.map((edge) => [edge.kind, stateNames(edge.handles[0]?.states ?? [])])).toEqual([
      ["branch-true", ["alloc"]],
      ["branch-false", ["unalloc"]],
    ]);
    expect(stateNames(onlyHandle(factForText(analysis, "free(p);")).inStates)).toEqual([
      "unalloc",
      "alloc",
    ]);
  });

  it("does not equate an unallocated obligation with a proven null pointer", () => {
    const unknownValue = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int x = 0; int *p = &x; if (p) p = malloc(4); free(p); return 0; }",
    );
    const knownNull = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = 0; if (p) p = malloc(4); return 0; }",
    );
    const correlated = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int x = 0; int *p = &x; if (c) { p = malloc(4); if (p) { free(p); return 0; } } if (p) *p = 1; return 0; }",
    );

    const unknownEdges = guardEdgesFor(unknownValue);
    expect(unknownEdges.map((edge) => [edge.kind, edge.feasible])).toEqual([
      ["branch-true", true],
      ["branch-false", true],
    ]);
    const knownNullEdges = guardEdgesFor(knownNull);
    expect(knownNullEdges.map((edge) => [edge.kind, edge.feasible])).toEqual([
      ["branch-true", false],
      ["branch-false", true],
    ]);
    const dereferenceState = onlyHandle(factForText(correlated, "*p = 1;")).inStates;
    const allocationIds = new Set(
      allEvents(onlyMemory(correlated.snapshot))
        .filter((event) => event.kind === "allocation")
        .map((event) => event.id),
    );
    expect(stateNames(dereferenceState)).toEqual(["unalloc"]);
    expect(
      dereferenceState.flatMap((state) => state.eventIds).some((id) => allocationIds.has(id)),
    ).toBe(false);
  });

  it("reaches a fixed point through CFG cycles without consulting the repeatable label", () => {
    const loop = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); while (c) free(p); return 0; }",
    );
    const backwardGoto = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); again: free(p); if (c) goto again; return 0; }",
    );
    const brokenLoop = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); while (c) { free(p); break; } return 0; }",
    );

    expect(stateNames(onlyHandle(factForText(loop, "free(p);")).inStates)).toEqual([
      "maybeNull",
      "freed",
    ]);
    expect(stateNames(onlyHandle(factForText(backwardGoto, "free(p);")).inStates)).toEqual([
      "maybeNull",
      "freed",
    ]);
    expect(
      allEvents(onlyMemory(backwardGoto.snapshot)).find((event) => event.kind === "free"),
    ).toMatchObject({ repeatable: false });
    expect(stateNames(onlyHandle(factForText(brokenLoop, "free(p);")).inStates)).toEqual([
      "maybeNull",
    ]);
    expect(
      allEvents(onlyMemory(brokenLoop.snapshot)).find((event) => event.kind === "free"),
    ).toMatchObject({ repeatable: true });
  });

  it("fails closed when a live obligation is overwritten and remains escaped", () => {
    const overwritten = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); p = 0; return 0; }",
    );
    const escapedThenAllocated = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); sink(p); p = malloc(8); return 0; }",
    );
    const liveThenAllocated = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); p = malloc(8); free(p); return 0; }",
    );
    const freedThenReset = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); free(p); p = 0; return 0; }",
    );
    const conditionalEscape = inspect(
      parser,
      "#include <stdlib.h>\nint f(int c) { int *p = malloc(4); if (c) sink(p); return 0; }",
    );

    expect(stateNames(onlyHandle(factForText(overwritten, "p = 0;")).outStates)).toEqual([
      "escaped",
    ]);
    expect(
      stateNames(onlyHandle(factForText(escapedThenAllocated, "p = malloc(8);")).outStates),
    ).toEqual(["escaped"]);
    expect(
      stateNames(onlyHandle(factForText(liveThenAllocated, "p = malloc(8);")).outStates),
    ).toEqual(["escaped"]);
    expect(stateNames(onlyHandle(factForText(freedThenReset, "p = 0;")).outStates)).toEqual([
      "unalloc",
    ]);
    expect(stateNames(onlyHandle(factForText(conditionalEscape, "return 0;")).inStates)).toEqual([
      "maybeNull",
      "escaped",
    ]);
  });

  it("gives all same-node observations the pre-escape state", () => {
    const analysis = inspect(
      parser,
      "#include <stdlib.h>\nstruct S { int a[2]; }; int f(void) { struct S *p = malloc(sizeof *p); sink(p->a); return 0; }",
    );
    const fact = onlyEventFact(onlyTypestate(analysis.snapshot), ["dereference", "escape"]);
    const before = fact.events.map((event) => stateNames(event.beforeStates));

    expect(before).toEqual([["maybeNull"], ["maybeNull"]]);
    expect(stateNames(onlyHandle(fact).outStates)).toEqual(["escaped"]);
  });

  it("keeps unreachable syntax facts empty and inherits memory disablement", () => {
    const unreachable = inspect(
      parser,
      "#include <stdlib.h>\nint f(void) { return 0; int *p = malloc(4); free(p); }",
    );
    const disabled = inspect(
      parser,
      "#define TAKE(p) (*(p))\nint f(void) { int *p = malloc(4); return TAKE(p); }",
    );
    const unreachableAllocation = factForText(unreachable, "int *p = malloc(4);");
    const disabledTypestate = onlyTypestate(disabled.snapshot);

    expect(onlyHandle(unreachableAllocation).inStates).toEqual([]);
    expect(onlyHandle(unreachableAllocation).outStates).toEqual([]);
    expect(unreachableAllocation.events[0]?.beforeStates).toEqual([]);
    expect(disabledTypestate).toMatchObject({
      status: "disabled",
      handleVariableIds: [],
      facts: [],
      edgeFacts: [],
    });
  });

  it("is CFG-aligned, deterministic and deeply frozen", () => {
    const source =
      "#include <stdlib.h>\nint f(void) { int *p = malloc(4); if (p) free(p); return 0; }";
    const first = inspect(parser, source).snapshot;
    const second = inspect(parser, source).snapshot;
    const typestate = onlyTypestate(first);
    const memory = onlyMemory(first);
    const cfg = first.functions[0]!;

    expect(typestate.facts.map((fact) => fact.nodeId)).toEqual(cfg.nodes.map((node) => node.id));
    expect(typestate.edgeFacts.map(({ from, kind, to }) => ({ from, kind, to }))).toEqual(
      cfg.edges.map(({ from, kind, to }) => ({ from, kind, to })),
    );
    const memoryEventIds = new Set(allEvents(memory).map((event) => event.id));
    const witnessIds = [
      ...typestate.facts.flatMap((fact) => [
        ...fact.handles.flatMap((handle) =>
          [...handle.inStates, ...handle.outStates].flatMap((state) => state.eventIds),
        ),
        ...fact.events.flatMap((event) => [
          event.eventId,
          ...event.beforeStates.flatMap((state) => state.eventIds),
        ]),
      ]),
      ...typestate.edgeFacts.flatMap((edge) =>
        edge.handles.flatMap((handle) => handle.states.flatMap((state) => state.eventIds)),
      ),
    ];
    expect(witnessIds.every((eventId) => memoryEventIds.has(eventId))).toBe(true);
    expect(typestate).toEqual(onlyTypestate(second));
    expect(deeplyFrozen(typestate)).toBe(true);
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

function onlyMemory(snapshot: ProgramAnalysisSnapshot): FunctionMemoryEvents {
  const memory = snapshot.memoryEvents[0];
  if (memory === undefined || snapshot.memoryEvents.length !== 1) {
    throw new Error("fixture 函数数量异常");
  }
  return memory;
}

function onlyTypestate(snapshot: ProgramAnalysisSnapshot): FunctionMemoryTypestate {
  const typestate = snapshot.memoryTypestate[0];
  if (typestate === undefined || snapshot.memoryTypestate.length !== 1) {
    throw new Error("fixture 函数数量异常");
  }
  return typestate;
}

function guardEdgesFor(analysis: InspectedProgram) {
  const guardNodeId = onlyMemory(analysis.snapshot).facts.find((fact) =>
    fact.events.some((event) => event.kind === "null-guard"),
  )?.nodeId;
  return onlyTypestate(analysis.snapshot).edgeFacts.filter((edge) => edge.from === guardNodeId);
}

function factForText(analysis: InspectedProgram, text: string): MemoryTypestateFact {
  const cfg = analysis.snapshot.functions[0];
  const typestate = onlyTypestate(analysis.snapshot);
  const matches =
    cfg?.nodes
      .map((node, index) => ({ node, fact: typestate.facts[index] }))
      .filter(({ node }) => analysis.source.slice(node.range.from, node.range.to) === text) ?? [];
  if (matches.length !== 1 || matches[0]?.fact === undefined) {
    throw new Error(`无法唯一定位 CFG 文本：${text}`);
  }
  return matches[0].fact;
}

function onlyEventFact(
  typestate: FunctionMemoryTypestate,
  kinds: readonly string[],
): MemoryTypestateFact {
  const memoryEvents = new Map(
    typestate.facts.flatMap((fact) => fact.events.map((event) => [event.eventId, fact] as const)),
  );
  const eventIds = new Set(
    onlyMemoryEventKinds(typestate, kinds).map((eventId) => memoryEvents.get(eventId)?.nodeId),
  );
  const nodeIds = [...eventIds].filter((nodeId): nodeId is string => nodeId !== undefined);
  if (nodeIds.length !== 1) throw new Error("无法唯一定位 mixed event typestate fact");
  const fact = typestate.facts.find((candidate) => candidate.nodeId === nodeIds[0]);
  if (fact === undefined) throw new Error("缺少 mixed event typestate fact");
  return fact;
}

function onlyMemoryEventKinds(
  typestate: FunctionMemoryTypestate,
  kinds: readonly string[],
): readonly string[] {
  const matchingFacts = typestate.facts.filter((fact) => fact.events.length === kinds.length);
  const match = matchingFacts.find((fact) => {
    const eventKinds = fact.events.map((event) => event.eventId.split(":")[1]);
    return kinds.every((kind) => eventKinds.includes(kind));
  });
  if (match === undefined) throw new Error(`缺少 mixed event kinds：${kinds.join(",")}`);
  return match.events.map((event) => event.eventId);
}

function onlyHandle(fact: MemoryTypestateFact): MemoryHandleTypestateFact {
  const handle = fact.handles[0];
  if (handle === undefined || fact.handles.length !== 1) throw new Error("fixture handle 数量异常");
  return handle;
}

function allEvents(memory: FunctionMemoryEvents) {
  return memory.facts.flatMap((fact) => fact.events);
}

function stateNames(states: readonly MemoryTypestateValue[]): readonly string[] {
  return states.map((state) => state.state);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
}
