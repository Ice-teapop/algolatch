import { describe, expect, it } from "vitest";
import { textRange } from "../../src/core/model.js";
import {
  FLOW_PROJECTION_SCHEMA_VERSION,
  FLOW_VIEW_STATE_SCHEMA_VERSION,
  type FlowEdge,
  type FlowNode,
  type FlowPort,
  type FlowProjection,
  type FlowViewState,
} from "../../src/flow/index.js";
import {
  alignFlowCanvasPositions,
  canonicalizeFlowCanvasWireEndpoints,
  createFlowCanvasDraftConnectionIntent,
  createFlowWirePath,
  createFlowWireRoute,
  distanceToFlowWire,
  exceedsFlowCanvasDragThreshold,
  FLOW_CANVAS_MINIMAP_INITIAL_STATE,
  fitFlowCanvasReadableViewport,
  fitFlowCanvasViewport,
  flowCanvasClientToWorld,
  flowCanvasPortScreenScale,
  flowCanvasDraftNodeRole,
  flowCanvasProjectedNodeRole,
  flowCanvasProjectedNodeReachability,
  flowCanvasWireDragPhase,
  flowWireLabelPoint,
  focusFlowCanvasNodeElement,
  nearestFlowCanvasWireTargetKey,
  normalizeFlowCanvasDraftState,
  normalizeFlowCanvasViewState,
  recoverDisconnectedFlowCanvasViewport,
  resolveFlowCanvasWireStart,
  type FlowCanvasDraftNode,
  type FlowCanvasWireEndpoint,
} from "../../src/ui/flow-canvas.js";

describe("M6 flow canvas contracts", () => {
  it("restores only known coordinates and selection for the same source fingerprint", () => {
    const projection = fixtureProjection("sha256:a");
    const restored = normalizeFlowCanvasViewState(projection, {
      schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
      sourceFingerprint: "sha256:a",
      viewport: { x: 24, y: -18, zoom: 99 },
      positions: {
        start: { x: 44, y: 72 },
        branch: { x: Number.NaN, y: 30 },
        removed: { x: 1, y: 1 },
      },
      selectedNodeIds: ["branch", "branch", "removed"],
      detailNodeId: "removed",
    });

    expect(restored.viewport).toEqual({ x: 24, y: -18, zoom: 2.5 });
    expect(restored.positions).toEqual({
      start: { x: 44, y: 72 },
      branch: { x: 240, y: 40 },
    });
    expect(restored.selectedNodeIds).toEqual(["branch"]);
    expect(restored.detailNodeId).toBeNull();
    expect(Object.isFrozen(restored.positions)).toBe(true);
  });

  it("fails closed to projection defaults when a sidecar belongs to stale C source", () => {
    const projection = fixtureProjection("sha256:new");
    const stale: FlowViewState = {
      schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
      sourceFingerprint: "sha256:old",
      viewport: { x: 900, y: 800, zoom: 0.5 },
      positions: { start: { x: 999, y: 999 } },
      selectedNodeIds: ["start"],
      detailNodeId: "start",
    };

    expect(normalizeFlowCanvasViewState(projection, stale)).toEqual({
      schemaVersion: FLOW_VIEW_STATE_SCHEMA_VERSION,
      sourceFingerprint: "sha256:new",
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: {
        start: { x: 20, y: 40 },
        branch: { x: 240, y: 40 },
      },
      selectedNodeIds: [],
      detailNodeId: null,
    });
  });

  it("includes a scrolled canvas root when converting client coordinates to world space", () => {
    const projection = fixtureProjection("sha256:scroll");
    const state = Object.freeze({
      ...normalizeFlowCanvasViewState(projection, null),
      viewport: Object.freeze({ x: 20, y: 30, zoom: 2 }),
    });
    const root = {
      scrollLeft: 40,
      scrollTop: 60,
      getBoundingClientRect: () =>
        ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300 }) as DOMRect,
    };

    expect(flowCanvasClientToWorld(root, state, 160, 130)).toEqual({ x: 40, y: 55 });
  });

  it("keeps the overview collapsed until the learner explicitly opens it", () => {
    expect(FLOW_CANVAS_MINIMAP_INITIAL_STATE).toEqual({
      collapsed: true,
      display: "none",
      ariaExpanded: "false",
    });
    expect(Object.isFrozen(FLOW_CANVAS_MINIMAP_INITIAL_STATE)).toBe(true);
  });

  it("focuses a projected node without scrolling the canvas root", () => {
    const focusCalls: (FocusOptions | undefined)[] = [];
    const element = {
      focus(options?: FocusOptions) {
        focusCalls.push(options);
      },
    };

    focusFlowCanvasNodeElement(element);

    expect(focusCalls).toEqual([{ preventScroll: true }]);
  });

  it("recenters a restored viewport only when every projected node is off screen", () => {
    const projection = fixtureProjection("sha256:viewport");
    const base = normalizeFlowCanvasViewState(projection, null);
    const disconnected = Object.freeze({
      ...base,
      viewport: Object.freeze({ x: 2493, y: 1112, zoom: 1 }),
    });

    const recovered = recoverDisconnectedFlowCanvasViewport(projection, disconnected, {
      width: 1000,
      height: 600,
    });

    expect(recovered).not.toEqual(disconnected.viewport);
    expect(recovered.x).toBeLessThan(1000);
    expect(recovered.y).toBeLessThan(600);
    expect(
      recoverDisconnectedFlowCanvasViewport(projection, base, { width: 1000, height: 600 }),
    ).toEqual(base.viewport);
  });

  it("builds deterministic orthogonal SVG wires without accepting invalid coordinates", () => {
    expect(createFlowWirePath({ x: 10, y: 20 }, { x: 210, y: 120 })).toBe(
      "M 10 20 L 10 39 Q 10 46 17 46 L 203 46 Q 210 46 210 53 L 210 120",
    );
    expect(() => createFlowWirePath({ x: Number.NaN, y: 0 }, { x: 1, y: 1 })).toThrow(/有限坐标/u);
  });

  it("routes a top-to-bottom cable on the vertical axis instead of folding through its nodes", () => {
    expect(createFlowWirePath({ x: 80, y: 32 }, { x: 80, y: 112 })).toBe("M 80 32 L 80 112");
    expect(flowWireLabelPoint({ x: 80, y: 32 }, { x: 80, y: 112 })).toEqual({ x: 80, y: 72 });
    expect(distanceToFlowWire({ x: 80, y: 72 }, { x: 80, y: 32 }, { x: 80, y: 112 })).toBe(0);
  });

  it("routes around unrelated node rectangles instead of drawing through them", () => {
    const obstacle = { left: 40, top: 80, right: 120, bottom: 140 };
    const route = createFlowWireRoute({ x: 80, y: 32 }, { x: 80, y: 220 }, 0, [obstacle]);

    expect(route.length).toBeGreaterThan(2);
    for (let index = 1; index < route.length; index += 1) {
      const from = route[index - 1]!;
      const to = route[index]!;
      const crossesInterior =
        from.x === to.x
          ? from.x > obstacle.left &&
            from.x < obstacle.right &&
            Math.max(from.y, to.y) > obstacle.top &&
            Math.min(from.y, to.y) < obstacle.bottom
          : from.y > obstacle.top &&
            from.y < obstacle.bottom &&
            Math.max(from.x, to.x) > obstacle.left &&
            Math.min(from.x, to.x) < obstacle.right;
      expect(crossesInterior).toBe(false);
    }
  });

  it("places wire labels on the longest orthogonal channel and rejects invalid endpoints", () => {
    expect(flowWireLabelPoint({ x: 10, y: 20 }, { x: 210, y: 120 })).toEqual({
      x: 110,
      y: 46,
    });
    expect(flowWireLabelPoint({ x: 210, y: 120 }, { x: 10, y: 20 })).toEqual({
      x: 86,
      y: 142,
    });
    expect(() => flowWireLabelPoint({ x: Number.POSITIVE_INFINITY, y: 0 }, { x: 1, y: 1 })).toThrow(
      /有限端点/u,
    );
    expect(() => flowWireLabelPoint({ x: 0, y: 0 }, { x: 1, y: Number.NaN })).toThrow(/有限端点/u);
  });

  it("uses the visible orthogonal geometry for edge insertion hit testing", () => {
    const from = { x: 10, y: 20 };
    const to = { x: 210, y: 120 };
    expect(distanceToFlowWire({ x: 110, y: 46 }, from, to)).toBeLessThan(1);
    expect(distanceToFlowWire({ x: 110, y: 220 }, from, to)).toBeGreaterThan(100);
  });

  it("keeps a click stable until pointer movement exceeds four pixels", () => {
    expect(exceedsFlowCanvasDragThreshold({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(false);
    expect(exceedsFlowCanvasDragThreshold({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true);
    expect(() => exceedsFlowCanvasDragThreshold({ x: 0, y: 0 }, { x: 1, y: 1 }, -1)).toThrow(
      /非负距离/u,
    );
  });

  it("arms a cable immediately but does not unplug it until a seven-pixel drag", () => {
    expect(flowCanvasWireDragPhase({ x: 10, y: 10 }, { x: 10, y: 10 }, false)).toBe("armed");
    expect(flowCanvasWireDragPhase({ x: 10, y: 10 }, { x: 17, y: 10 }, false)).toBe("armed");
    expect(flowCanvasWireDragPhase({ x: 10, y: 10 }, { x: 18, y: 10 }, false)).toBe("dragging");
    expect(flowCanvasWireDragPhase({ x: 10, y: 10 }, { x: 10, y: 10 }, true)).toBe("dragging");
  });

  it("keeps port hit targets screen-sized and selects only the nearest compatible socket", () => {
    expect(flowCanvasPortScreenScale(0.25)).toBe(4);
    expect(flowCanvasPortScreenScale(1)).toBe(1);
    expect(flowCanvasPortScreenScale(2.5)).toBe(0.4);
    expect(() => flowCanvasPortScreenScale(0)).toThrow(/缩放/u);

    expect(
      nearestFlowCanvasWireTargetKey(
        { x: 100, y: 100 },
        [
          { key: "far", point: { x: 132, y: 100 } },
          { key: "nearest", point: { x: 111, y: 104 } },
          { key: "other", point: { x: 92, y: 119 } },
        ],
        28,
      ),
    ).toBe("nearest");
    expect(
      nearestFlowCanvasWireTargetKey(
        { x: 100, y: 100 },
        [{ key: "outside", point: { x: 129, y: 100 } }],
        28,
      ),
    ).toBeNull();
  });

  it("exposes stable semantic roles without turning visual state into source semantics", () => {
    expect(flowCanvasProjectedNodeRole(node("start", "start", "开始", 0, 0))).toBe("cfg-boundary");
    expect(flowCanvasProjectedNodeRole(node("branch", "branch", "分支", 0, 0))).toBe(
      "projected-structure",
    );
    expect(flowCanvasProjectedNodeRole(node("statement", "statement", "语句", 0, 0))).toBe(
      "projected-code",
    );
    expect(flowCanvasProjectedNodeRole(node("raw", "raw", "原始源码", 0, 0))).toBe("raw");

    expect(flowCanvasDraftNodeRole(draftNode())).toBe("detached-code");
    expect(
      flowCanvasDraftNodeRole(
        Object.freeze({
          ...draftNode(),
          id: "virtual:checkpoint",
          blockKind: "virtual",
          sourceText: undefined,
        }),
      ),
    ).toBe("runtime-marker");
  });

  it("keeps projection emphasis independent from algorithm recognition without inventing reachability", () => {
    const reachable = node("statement", "statement", "普通语句", 0, 0);
    const unreachable = Object.freeze({ ...reachable, id: "unreachable", reachable: false });
    const moduleNode = Object.freeze({
      ...reachable,
      id: "module",
      functionId: null,
      sourceNodeId: null,
      kind: "module" as const,
      reachable: false,
      locked: true,
    });
    const rawNode = Object.freeze({
      ...moduleNode,
      id: "raw",
      kind: "raw" as const,
    });

    expect(flowCanvasProjectedNodeReachability(reachable)).toBe("reachable");
    expect(flowCanvasProjectedNodeReachability(unreachable)).toBe("unreachable");
    expect(flowCanvasProjectedNodeReachability(moduleNode)).toBe("not-applicable");
    expect(flowCanvasProjectedNodeReachability(rawNode)).toBe("not-applicable");
  });

  it("fits all flow items into the viewport around their shared center", () => {
    expect(
      fitFlowCanvasViewport(
        { left: 0, top: 0, right: 400, bottom: 200 },
        { width: 1000, height: 600 },
        50,
      ),
    ).toEqual({ x: 200, y: 150, zoom: 1.5 });
    expect(() =>
      fitFlowCanvasViewport({ left: 0, top: 0, right: 1, bottom: 1 }, { width: 0, height: 100 }),
    ).toThrow(/正尺寸/u);
  });

  it("can frame a newly opened projection in a narrow first-view canvas", () => {
    const bounds = { left: 20, top: 40, right: 400, bottom: 300 };
    const size = { width: 340, height: 240 };
    const viewport = fitFlowCanvasViewport(bounds, size, 44, 1.5);

    expect(bounds.left * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(44);
    expect(bounds.right * viewport.zoom + viewport.x).toBeLessThanOrEqual(size.width - 44);
    expect(bounds.top * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(44);
    expect(bounds.bottom * viewport.zoom + viewport.y).toBeLessThanOrEqual(size.height - 44);
  });

  it("keeps semantic projection labels readable when a tall graph cannot fit at once", () => {
    const bounds = { left: 48, top: 48, right: 656, bottom: 872 };
    const size = { width: 340, height: 251 };
    const viewport = fitFlowCanvasReadableViewport(bounds, size, 20, 0.8, 1.5);

    expect(viewport.zoom).toBe(0.8);
    expect(bounds.left * viewport.zoom + viewport.x).toBeCloseTo(20);
    expect(bounds.top * viewport.zoom + viewport.y).toBeCloseTo(20);
    expect(160 * viewport.zoom).toBeGreaterThanOrEqual(128);
    expect(bounds.bottom * viewport.zoom + viewport.y).toBeGreaterThan(size.height);
  });

  it("centres a semantic projection when it fits without crossing the readable zoom floor", () => {
    expect(
      fitFlowCanvasReadableViewport(
        { left: 20, top: 40, right: 220, bottom: 140 },
        { width: 700, height: 500 },
        20,
        0.8,
        1.5,
      ),
    ).toEqual({ x: 170, y: 115, zoom: 1.5 });
  });

  it("rejects an inverted readable projection zoom range", () => {
    expect(() =>
      fitFlowCanvasReadableViewport(
        { left: 0, top: 0, right: 100, bottom: 100 },
        { width: 300, height: 200 },
        20,
        1.2,
        0.8,
      ),
    ).toThrow(/最小值不得超过最大值/u);
  });

  it("canonicalizes control-wire gestures from either endpoint to the same directed edge", () => {
    const output = wireEndpoint("projection", "branch", "branch:true", "output", "branch-true");
    const input = wireEndpoint("projection", "target", "target:in", "input", null);

    const forward = canonicalizeFlowCanvasWireEndpoints(output, input);
    const reverse = canonicalizeFlowCanvasWireEndpoints(input, output);

    expect(reverse).toEqual(forward);
    expect(reverse).toEqual({ from: output, to: input, edgeKind: "branch-true" });
    expect(Object.isFrozen(reverse)).toBe(true);
  });

  it("takes semantics from the output port and rejects incompatible endpoint pairs", () => {
    const output = wireEndpoint("draft", "draft", "draft:false", "output", "branch-false");
    const misleadingInput = wireEndpoint(
      "projection",
      "target",
      "target:in",
      "input",
      "branch-true",
    );

    expect(canonicalizeFlowCanvasWireEndpoints(misleadingInput, output)?.edgeKind).toBe(
      "branch-false",
    );
    expect(
      canonicalizeFlowCanvasWireEndpoints(output, { ...output, portId: "other:out" }),
    ).toBeNull();
    expect(
      canonicalizeFlowCanvasWireEndpoints(misleadingInput, {
        ...misleadingInput,
        nodeId: "other",
        portId: "other:in",
      }),
    ).toBeNull();
    expect(
      canonicalizeFlowCanvasWireEndpoints({ ...output, channel: "data" }, misleadingInput),
    ).toBeNull();
    expect(
      canonicalizeFlowCanvasWireEndpoints({ ...output, edgeKind: null }, misleadingInput),
    ).toBeNull();
  });

  it("unplugs the grabbed cable end while keeping the opposite end anchored", () => {
    const { projection, edge, aOutput, bInput, cInput, dOutput } = reconnectProjection();

    const moveTarget = resolveFlowCanvasWireStart(projection, bInput, null);
    expect(moveTarget).toEqual({
      status: "reconnect",
      anchor: aOutput,
      detached: bInput,
      replaceEdgeId: edge.id,
    });
    if (moveTarget.status !== "reconnect") throw new Error("fixture 未进入目标端改接");
    expect(canonicalizeFlowCanvasWireEndpoints(moveTarget.anchor, cInput)).toEqual({
      from: aOutput,
      to: cInput,
      edgeKind: "next",
    });

    expect(resolveFlowCanvasWireStart(projection, aOutput, null)).toEqual({
      status: "reconnect",
      anchor: bInput,
      detached: aOutput,
      replaceEdgeId: edge.id,
    });
  });

  it("never guesses which cable to unplug when one socket has multiple incident edges", () => {
    const fixture = reconnectProjection();
    const second = Object.freeze({
      ...fixture.edge,
      id: "edge:d-b",
      from: Object.freeze({ nodeId: "d", portId: "d:out" }),
    });
    const projection = Object.freeze({
      ...fixture.projection,
      edges: Object.freeze([...fixture.projection.edges, second]),
    });

    expect(resolveFlowCanvasWireStart(projection, fixture.bInput, null)).toEqual({
      status: "ambiguous",
      edgeIds: [fixture.edge.id, second.id],
    });
    expect(resolveFlowCanvasWireStart(projection, fixture.bInput, second.id)).toMatchObject({
      status: "reconnect",
      replaceEdgeId: second.id,
      anchor: fixture.dOutput,
    });
  });

  it("rewires the only cable on a fan-out socket and never implies an unsupported graph-only add", () => {
    const fixture = reconnectProjection();
    const projection = Object.freeze({
      ...fixture.projection,
      nodes: Object.freeze(
        fixture.projection.nodes.map((candidate) =>
          candidate.id === "a"
            ? Object.freeze({
                ...candidate,
                allowsFanOut: true,
                ports: Object.freeze(
                  candidate.ports.map((port) =>
                    port.id === "a:out"
                      ? Object.freeze({ ...port, capacity: "many" as const, allowsFanOut: true })
                      : port,
                  ),
                ),
              })
            : candidate,
        ),
      ),
    });

    expect(resolveFlowCanvasWireStart(projection, fixture.aOutput, null)).toEqual({
      status: "reconnect",
      anchor: fixture.bInput,
      detached: fixture.aOutput,
      replaceEdgeId: fixture.edge.id,
    });
    expect(resolveFlowCanvasWireStart(projection, fixture.aOutput, fixture.edge.id)).toEqual({
      status: "reconnect",
      anchor: fixture.bInput,
      detached: fixture.aOutput,
      replaceEdgeId: fixture.edge.id,
    });
  });

  it("aligns mixed free nodes without changing their unconstrained axis", () => {
    const aligned = alignFlowCanvasPositions(
      [
        { id: "a", position: { x: 80, y: 10 } },
        { id: "b", position: { x: 20, y: 90 } },
      ],
      "left",
    );

    expect(Object.fromEntries(aligned)).toEqual({
      a: { x: 20, y: 10 },
      b: { x: 20, y: 90 },
    });
  });

  it("distributes selected nodes vertically and rejects ambiguous inputs", () => {
    const distributed = alignFlowCanvasPositions(
      [
        { id: "bottom", position: { x: 300, y: 210 } },
        { id: "top", position: { x: 100, y: 10 } },
        { id: "middle", position: { x: 200, y: 42 } },
      ],
      "distribute-y",
    );

    expect(Object.fromEntries(distributed)).toEqual({
      top: { x: 100, y: 10 },
      middle: { x: 200, y: 110 },
      bottom: { x: 300, y: 210 },
    });
    expect(() =>
      alignFlowCanvasPositions(
        [
          { id: "same", position: { x: 0, y: 0 } },
          { id: "same", position: { x: 1, y: 1 } },
        ],
        "left",
      ),
    ).toThrow(/id 必须唯一/u);
  });

  it("normalizes freely positioned draft metadata, ports and selection without losing source", () => {
    const draft = draftNode();
    const normalized = normalizeFlowCanvasDraftState({
      nodes: [draft],
      connection: null,
      selectedNodeIds: [draft.id, draft.id, "missing"],
    });

    expect(normalized.selectedNodeIds).toEqual([draft.id]);
    expect(normalized.nodes[0]).toMatchObject({
      presetId: "builtin.c.print-integer",
      sourceText: 'printf("%d\\n", value);',
      position: { x: 120, y: 88 },
      ports: [
        expect.objectContaining({ id: "draft:in", direction: "input" }),
        expect.objectContaining({ id: "draft:out", direction: "output", edgeKind: "next" }),
      ],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.nodes[0]?.ports)).toBe(true);
  });

  it("creates an explicit draft intent only for a real editable projected input", () => {
    const targetPort = controlPort("target:in", "input", null);
    const target = node("target", "statement", "目标语句", 240, 40, [targetPort]);
    const projection = Object.freeze({
      ...fixtureProjection("sha256:draft"),
      nodes: Object.freeze([target]),
    });
    const draft = draftNode();
    const output = draft.ports?.find((port) => port.direction === "output");
    if (output === undefined) throw new Error("fixture 缺少草稿输出端口");

    expect(
      createFlowCanvasDraftConnectionIntent(projection, draft, output, target, targetPort),
    ).toEqual({
      sourceFingerprint: "sha256:draft",
      draftNodeId: "draft:print",
      draftPortId: "draft:out",
      presetId: "builtin.c.print-integer",
      sourceText: 'printf("%d\\n", value);',
      toNodeId: "target",
      toPortId: "target:in",
      edgeKind: "next",
    });

    const lockedTarget = Object.freeze({ ...target, locked: true });
    expect(
      createFlowCanvasDraftConnectionIntent(
        Object.freeze({ ...projection, nodes: Object.freeze([lockedTarget]) }),
        draft,
        output,
        lockedTarget,
        targetPort,
      ),
    ).toBeNull();
  });

  it("rejects duplicate draft ids and output ports without an edge kind", () => {
    const draft = draftNode();
    expect(() =>
      normalizeFlowCanvasDraftState({ nodes: [draft, draft], connection: null }),
    ).toThrow(/唯一非空 id/u);
    expect(() =>
      normalizeFlowCanvasDraftState({
        nodes: [
          {
            ...draft,
            ports: [{ ...draft.ports?.[1], id: "bad", direction: "output", edgeKind: null }],
          } as FlowCanvasDraftNode,
        ],
        connection: null,
      }),
    ).toThrow(/输出端口必须声明 edgeKind/u);
  });
});

function fixtureProjection(sourceFingerprint: string): FlowProjection {
  const start = node("start", "start", "开始", 20, 40);
  const branch = node("branch", "branch", "条件分支", 240, 40);
  return Object.freeze({
    schemaVersion: FLOW_PROJECTION_SCHEMA_VERSION,
    sourceRevision: 1,
    sourceFingerprint,
    sourceLength: 32,
    documentHasError: false,
    functions: Object.freeze([]),
    nodes: Object.freeze([start, branch]),
    edges: Object.freeze([]),
    dataEdges: Object.freeze([]),
  });
}

function node(
  id: string,
  kind: FlowNode["kind"],
  label: string,
  x: number,
  y: number,
  ports: readonly FlowPort[] = [],
): FlowNode {
  return Object.freeze({
    id,
    functionId: "fn:main",
    sourceNodeId: id,
    kind,
    label,
    nodeType: kind,
    range: textRange(0, 1),
    ownerBlockRange: textRange(0, 1),
    sourceText: "x;",
    reachable: true,
    locked: false,
    lockReasons: Object.freeze([]),
    allowsFanOut: kind === "branch",
    defaultPosition: Object.freeze({ x, y }),
    ports: Object.freeze([...ports]),
  });
}

function controlPort(
  id: string,
  direction: FlowPort["direction"],
  edgeKind: FlowPort["edgeKind"],
): FlowPort {
  return Object.freeze({
    id,
    nodeId: "target",
    direction,
    channel: "control",
    edgeKind,
    label: direction === "input" ? "输入" : "下一步",
    editable: true,
    capacity: direction === "input" ? "many" : "one",
    allowsFanOut: false,
  });
}

function wireEndpoint(
  source: FlowCanvasWireEndpoint["source"],
  nodeId: string,
  portId: string,
  direction: FlowCanvasWireEndpoint["direction"],
  edgeKind: FlowCanvasWireEndpoint["edgeKind"],
): FlowCanvasWireEndpoint {
  return Object.freeze({
    source,
    nodeId,
    portId,
    direction,
    channel: "control",
    edgeKind,
  });
}

function reconnectProjection(): {
  readonly projection: FlowProjection;
  readonly edge: FlowEdge;
  readonly aOutput: FlowCanvasWireEndpoint;
  readonly bInput: FlowCanvasWireEndpoint;
  readonly cInput: FlowCanvasWireEndpoint;
  readonly dOutput: FlowCanvasWireEndpoint;
} {
  const aOutput = wireEndpoint("projection", "a", "a:out", "output", "next");
  const bInput = wireEndpoint("projection", "b", "b:in", "input", null);
  const cInput = wireEndpoint("projection", "c", "c:in", "input", null);
  const dOutput = wireEndpoint("projection", "d", "d:out", "output", "next");
  const a = node("a", "statement", "A", 0, 0, [controlPort("a:out", "output", "next")]);
  const b = node("b", "statement", "B", 200, 0, [controlPort("b:in", "input", null)]);
  const c = node("c", "statement", "C", 400, 0, [controlPort("c:in", "input", null)]);
  const d = node("d", "statement", "D", 600, 0, [controlPort("d:out", "output", "next")]);
  const edge = Object.freeze({
    id: "edge:a-b",
    functionId: "fn:main",
    from: Object.freeze({ nodeId: "a", portId: "a:out" }),
    to: Object.freeze({ nodeId: "b", portId: "b:in" }),
    kind: "next" as const,
    channel: "control" as const,
    slot: 0,
    editable: true,
  });
  return Object.freeze({
    projection: Object.freeze({
      ...fixtureProjection("sha256:wire"),
      nodes: Object.freeze([a, b, c, d]),
      edges: Object.freeze([edge]),
    }),
    edge,
    aOutput,
    bInput,
    cInput,
    dOutput,
  });
}

function draftNode(): FlowCanvasDraftNode {
  return Object.freeze({
    id: "draft:print",
    label: "打印整数",
    presetId: "builtin.c.print-integer",
    sourceText: 'printf("%d\\n", value);',
    position: Object.freeze({ x: 120, y: 88 }),
    status: "detached",
    ports: Object.freeze([
      Object.freeze({
        id: "draft:in",
        direction: "input",
        channel: "control",
        edgeKind: null,
        label: "输入",
        editable: true,
      }),
      Object.freeze({
        id: "draft:out",
        direction: "output",
        channel: "control",
        edgeKind: "next",
        label: "下一步",
        editable: true,
      }),
    ]),
  });
}
