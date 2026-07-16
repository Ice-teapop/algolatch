import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CParser } from "../../src/core/index.js";
import {
  createDefaultFlowViewState,
  deserializeFlowViewState,
  serializeFlowViewState,
  validateFlowViewState,
  type FlowNode,
  type FlowProjection,
  type FlowViewState,
} from "../../src/flow/index.js";
import { createTestParser } from "../core/parser-fixture.js";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";
import { analyzeFlowFixture, deeplyFrozen } from "./fixture.js";

describe("flow view-state sidecar", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => {
    parser.dispose();
  });

  it("creates a deeply frozen default position for every projected node", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(int x) { if (x) x++; return x; }");
    const state = createDefaultFlowViewState(projection);

    expect(Object.keys(state.positions).sort()).toEqual(
      projection.nodes.map((node) => node.id).sort(),
    );
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(deeplyFrozen(state)).toBe(true);
  });

  it("round-trips canonical v2 JSON without persisting projection node IDs", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(void) { int x = 0; return x; }");
    const defaultState = createDefaultFlowViewState(projection);
    const serialized = serializeFlowViewState(defaultState, projection);
    const payload = JSON.parse(serialized) as {
      schemaVersion: number;
      positions: unknown[];
      selectedNodes: unknown[];
    };
    payload.positions.reverse();
    const validation = validateFlowViewState(payload, projection);

    expect(payload.schemaVersion).toBe(2);
    expect(Array.isArray(payload.positions)).toBe(true);
    expect(payload.selectedNodes).toEqual([]);
    for (const node of projection.nodes) expect(serialized).not.toContain(node.id);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("fixture 布局应通过校验");
    expect(validation.issues).toEqual([]);
    expect(serializeFlowViewState(validation.value, projection)).toBe(serialized);
    expect(deserializeFlowViewState(serialized, projection)).toEqual(validation);
  });

  it("fills omitted anchored positions from deterministic projection defaults", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(void) { return 0; }");
    const target = requiredNodeBySource(projection, "return 0;");
    const moved = changedState(createDefaultFlowViewState(projection), target, { x: 901, y: 411 });
    const payload = JSON.parse(serializeFlowViewState(moved, projection)) as {
      positions: Array<{ point: { x: number; y: number } }>;
    };
    payload.positions = payload.positions.filter((entry) => entry.point.x !== 901);

    const validation = validateFlowViewState(payload, projection);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("缺失坐标应使用默认布局");
    expect(validation.value.positions[target.id]).toEqual(target.defaultPosition);
  });

  it("reads legacy v1 IDs for the exact source and migrates on serialization", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(void) { return 0; }");
    const target = requiredNodeBySource(projection, "return 0;");
    const legacy = {
      schemaVersion: 1,
      sourceFingerprint: projection.sourceFingerprint,
      viewport: { x: 10, y: 20, zoom: 1.2 },
      positions: { [target.id]: { x: 700, y: 320 } },
      selectedNodeIds: [target.id],
      detailNodeId: target.id,
    };

    const validation = validateFlowViewState(legacy, projection);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("同源码 v1 应可迁移");
    expect(validation.value).toMatchObject({
      schemaVersion: 2,
      viewport: { x: 10, y: 20, zoom: 1.2 },
      selectedNodeIds: [target.id],
      detailNodeId: target.id,
    });
    expect(validation.value.positions[target.id]).toEqual({ x: 700, y: 320 });
    const migrated = serializeFlowViewState(validation.value, projection);
    expect(JSON.parse(migrated)).toMatchObject({ schemaVersion: 2 });
    expect(migrated).not.toContain(target.id);
  });

  it("upgrades the old generated single-column layout without merging repeated nodes", () => {
    const { projection } = analyzeFlowFixture(parser, FIRST_ALGORITHM_SOURCE);
    const defaults = createDefaultFlowViewState(projection);
    const legacyPositions = legacyGeneratedPositions(projection);
    const serialized = serializeFlowViewState(
      Object.freeze({ ...defaults, positions: Object.freeze(legacyPositions) }),
      projection,
    );

    const validation = deserializeFlowViewState(serialized, projection);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("旧版自动布局应迁移");
    expect(validation.issues.map((entry) => entry.code)).toContain("legacy-generated-layout");
    expect(validation.value.positions).toEqual(defaults.positions);
    const repeatedReturns = projection.nodes.filter(
      (node) => node.sourceText.trim() === "return 1;",
    );
    expect(new Set(repeatedReturns.map((node) => validation.value.positions[node.id])).size).toBe(
      3,
    );
  });

  it("recovers unique anchors after a small source shift", () => {
    const oldFixture = analyzeFlowFixture(parser, "int f(void) { int value = 1; return value; }\n");
    const oldTarget = requiredNodeBySource(oldFixture.projection, "return value;");
    const moved = changedState(createDefaultFlowViewState(oldFixture.projection), oldTarget, {
      x: 840,
      y: 460,
    });
    const serialized = serializeFlowViewState(moved, oldFixture.projection);
    const nextFixture = analyzeFlowFixture(
      parser,
      "#include <stddef.h>\nint f(void) { int value = 1; return value; }\n",
      2,
    );
    const nextTarget = requiredNodeBySource(nextFixture.projection, "return value;");

    const validation = deserializeFlowViewState(serialized, nextFixture.projection);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("唯一锚点应恢复");
    expect(validation.value.positions[nextTarget.id]).toEqual({ x: 840, y: 460 });
    expect(validation.value.selectedNodeIds).toEqual([nextTarget.id]);
    expect(validation.value.detailNodeId).toBe(nextTarget.id);
    expect(validation.issues.map((entry) => entry.code)).toEqual(["stale-source"]);
  });

  it("drops only ambiguous anchors while preserving other uniquely matched locations", () => {
    const oldFixture = analyzeFlowFixture(parser, "int f(void) { int x = 0; x++; return x; }\n");
    const oldIncrement = requiredNodeBySource(oldFixture.projection, "x++;");
    const oldReturn = requiredNodeBySource(oldFixture.projection, "return x;");
    const state = changedState(
      changedState(createDefaultFlowViewState(oldFixture.projection), oldIncrement, {
        x: 900,
        y: 400,
      }),
      oldReturn,
      { x: 760, y: 520 },
      [oldIncrement.id, oldReturn.id],
      oldIncrement.id,
    );
    const serialized = serializeFlowViewState(state, oldFixture.projection);
    const nextFixture = analyzeFlowFixture(
      parser,
      "int f(void) { int x = 0; x++; x++; return x; }\n",
      2,
    );
    const nextReturn = requiredNodeBySource(nextFixture.projection, "return x;");
    const increments = nextFixture.projection.nodes.filter(
      (node) => node.sourceText.trim() === "x++;",
    );

    const validation = deserializeFlowViewState(serialized, nextFixture.projection);

    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error("歧义应局部降级而不是整份失败");
    expect(validation.value.positions[nextReturn.id]).toEqual({ x: 760, y: 520 });
    for (const increment of increments) {
      expect(validation.value.positions[increment.id]).toEqual(increment.defaultPosition);
    }
    expect(validation.value.selectedNodeIds).toEqual([nextReturn.id]);
    expect(validation.value.detailNodeId).toBeNull();
    expect(validation.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["stale-source", "ambiguous-anchor"]),
    );
  });

  it("fails closed for malformed JSON or viewport and refuses invalid runtime state", () => {
    const { projection } = analyzeFlowFixture(parser, "int f(void) { return 0; }");
    const serialized = JSON.parse(
      serializeFlowViewState(createDefaultFlowViewState(projection), projection),
    ) as Record<string, unknown>;

    expect(deserializeFlowViewState("{", projection)).toEqual(
      expect.objectContaining({
        ok: false,
        issues: [expect.objectContaining({ code: "invalid-json" })],
      }),
    );
    expect(
      validateFlowViewState({ ...serialized, viewport: { x: 0, y: 0, zoom: 99 } }, projection),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: "invalid-viewport" })]),
      }),
    );
    const invalid = {
      ...createDefaultFlowViewState(projection),
      viewport: { x: Number.NaN, y: 0, zoom: 1 },
    } as FlowViewState;
    expect(() => serializeFlowViewState(invalid, projection)).toThrowError(/非法 viewport/u);
  });
});

function requiredNodeBySource(projection: FlowProjection, sourceText: string): FlowNode {
  const node = projection.nodes.find((candidate) => candidate.sourceText.trim() === sourceText);
  if (node === undefined) throw new Error(`fixture 缺少节点：${sourceText}`);
  return node;
}

function changedState(
  state: FlowViewState,
  node: FlowNode,
  position: { readonly x: number; readonly y: number },
  selectedNodeIds: readonly string[] = [node.id],
  detailNodeId: string | null = node.id,
): FlowViewState {
  return Object.freeze({
    ...state,
    positions: Object.freeze({ ...state.positions, [node.id]: Object.freeze(position) }),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    detailNodeId,
  });
}

function legacyGeneratedPositions(
  projection: FlowProjection,
): Record<string, { x: number; y: number }> {
  const functionOrder = new Map(projection.functions.map((fn, index) => [fn.id, index]));
  const fallbackLane = projection.functions.length;
  const lanes = new Map<number, FlowNode[]>();
  for (const node of projection.nodes) {
    const lane =
      node.functionId === null
        ? fallbackLane
        : (functionOrder.get(node.functionId) ?? fallbackLane);
    const entries = lanes.get(lane) ?? [];
    entries.push(node);
    lanes.set(lane, entries);
  }
  const kindOrder: Readonly<Record<FlowNode["kind"], number>> = {
    module: 0,
    start: 0,
    declaration: 1,
    statement: 1,
    branch: 1,
    loop: 1,
    switch: 1,
    assert: 1,
    control: 1,
    raw: 1,
    end: 2,
  };
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [lane, nodes] of lanes) {
    nodes.sort(
      (left, right) =>
        kindOrder[left.kind] - kindOrder[right.kind] ||
        left.range.from - right.range.from ||
        right.range.to - left.range.to ||
        left.id.localeCompare(right.id),
    );
    nodes.forEach((node, row) => {
      positions[node.id] = { x: 48 + lane * 224, y: 48 + row * 64 };
    });
  }
  return positions;
}
