import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowSourceEditor } from "../../src/app/flow-source-editor.js";
import {
  analyzeProgramSnapshot,
  type ReadySession,
} from "../../src/app/program-analysis-session.js";
import {
  applyTextPatches,
  createBlockIndex,
  type CAnalysisSnapshot,
  type CParser,
} from "../../src/core/index.js";
import {
  createFlowProjection,
  type ConnectionIntent,
  type FlowProjection,
} from "../../src/flow/index.js";
import type { ImportedSource } from "../../src/shared/api.js";
import { FIRST_ALGORITHM_SOURCE } from "../../src/tutorials/first-algorithm.js";
import {
  FIRST_ALGORITHM_SKELETON_SOURCE,
  MAXIMUM_UPDATE_PRESET_ID,
} from "../../src/tutorials/first-lesson.js";
import { createTestParser } from "../core/parser-fixture.js";

const SOURCE = [
  "int main(void) {",
  "  int a = 1, b = 2;",
  "  a++;",
  "  b++;",
  "  return a + b;",
  "}",
  "",
].join("\n");

describe("flow source editor connection postconditions", () => {
  let parser: CParser;

  beforeEach(async () => {
    parser = await createTestParser();
  });

  afterEach(() => parser.dispose());

  it("rewires adjacent reversed statements only after exact source and CFG verification", () => {
    let source = SOURCE;
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const committed = vi.fn();
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: committed,
    });
    const a = requiredNode(projection, "a++;");
    const b = requiredNode(projection, "b++;");
    const oldOutgoing = projection.edges.find(
      (edge) => edge.from.nodeId === b.id && edge.kind === "next",
    );
    const fromPort = b.ports.find(
      (port) => port.direction === "output" && port.edgeKind === "next",
    );
    const toPort = a.ports.find((port) => port.direction === "input");
    if (oldOutgoing === undefined || fromPort === undefined || toPort === undefined) {
      throw new Error("fixture 缺少可编辑 next 端口");
    }
    const intent: ConnectionIntent = Object.freeze({
      sourceFingerprint: projection.sourceFingerprint,
      fromNodeId: b.id,
      fromPortId: fromPort.id,
      toNodeId: a.id,
      toPortId: toPort.id,
      kind: "next",
      replaceEdgeId: oldOutgoing.id,
    });

    expect(editor.connectNodes(intent)).toBe(true);
    expect(source.indexOf("b++;")).toBeLessThan(source.indexOf("a++;"));
    const nextA = requiredNode(projection, "a++;");
    const nextB = requiredNode(projection, "b++;");
    expect(
      projection.edges.some(
        (edge) =>
          edge.from.nodeId === nextB.id && edge.to.nodeId === nextA.id && edge.kind === "next",
      ),
    ).toBe(true);
    expect(committed).toHaveBeenCalledOnce();
  });

  it("rejects non-adjacent rewiring without changing main.c", () => {
    const source = [
      "int main(void) {",
      "  int a = 1, b = 2, c = 3;",
      "  a++;",
      "  b++;",
      "  c++;",
      "  return a + b + c;",
      "}",
      "",
    ].join("\n");
    let liveSource = source;
    let revision = 1;
    const session = analyzeSession(parser, liveSource, revision);
    const projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => liveSource,
      applyPatches: () => {
        throw new Error("不应提交");
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt: vi.fn(),
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const a = requiredNode(projection, "a++;");
    const c = requiredNode(projection, "c++;");
    const oldOutgoing = projection.edges.find(
      (edge) => edge.from.nodeId === c.id && edge.kind === "next",
    );
    const fromPort = c.ports.find(
      (port) => port.direction === "output" && port.edgeKind === "next",
    );
    const toPort = a.ports.find((port) => port.direction === "input");
    if (oldOutgoing === undefined || fromPort === undefined || toPort === undefined) {
      throw new Error("fixture 缺少可编辑 next 端口");
    }

    expect(() =>
      editor.connectNodes({
        sourceFingerprint: projection.sourceFingerprint,
        fromNodeId: c.id,
        fromPortId: fromPort.id,
        toNodeId: a.id,
        toPortId: toPort.id,
        kind: "next",
        replaceEdgeId: oldOutgoing.id,
      }),
    ).toThrow(/相邻/u);
    expect(liveSource).toBe(source);
  });

  it("rewires the source plug by swapping the adjacent statement before the fixed target", () => {
    let source = [
      "int main(void) {",
      "  int a = 1, b = 2, c = 3;",
      "  a++;",
      "  b++;",
      "  c++;",
      "  return a + b + c;",
      "}",
      "",
    ].join("\n");
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const a = requiredNode(projection, "a++;");
    const b = requiredNode(projection, "b++;");
    const c = requiredNode(projection, "c++;");
    const oldEdge = projection.edges.find(
      (edge) => edge.from.nodeId === a.id && edge.to.nodeId === b.id && edge.kind === "next",
    );
    const output = c.ports.find((port) => port.direction === "output" && port.edgeKind === "next");
    const input = b.ports.find((port) => port.direction === "input");
    if (oldEdge === undefined || output === undefined || input === undefined) {
      throw new Error("fixture 缺少可移动的线端");
    }

    const intent: ConnectionIntent = Object.freeze({
      sourceFingerprint: projection.sourceFingerprint,
      fromNodeId: c.id,
      fromPortId: output.id,
      toNodeId: b.id,
      toPortId: input.id,
      kind: "next",
      replaceEdgeId: oldEdge.id,
    });
    expect(editor.assessConnection(intent)).toEqual({ accepted: true });
    expect(editor.connectNodes(intent)).toBe(true);
    expect(source.indexOf("c++;")).toBeLessThan(source.indexOf("b++;"));
    const nextB = requiredNode(projection, "b++;");
    const nextC = requiredNode(projection, "c++;");
    expect(
      projection.edges.some(
        (edge) =>
          edge.from.nodeId === nextC.id && edge.to.nodeId === nextB.id && edge.kind === "next",
      ),
    ).toBe(true);
  });

  it("rewires the target plug by swapping the original target with its next statement", () => {
    let source = [
      "int main(void) {",
      "  int a = 1, b = 2, c = 3;",
      "  a++;",
      "  b++;",
      "  c++;",
      "  return a + b + c;",
      "}",
      "",
    ].join("\n");
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const a = requiredNode(projection, "a++;");
    const b = requiredNode(projection, "b++;");
    const c = requiredNode(projection, "c++;");
    const oldEdge = projection.edges.find(
      (edge) => edge.from.nodeId === a.id && edge.to.nodeId === b.id && edge.kind === "next",
    );
    const output = a.ports.find((port) => port.direction === "output" && port.edgeKind === "next");
    const input = c.ports.find((port) => port.direction === "input");
    if (oldEdge === undefined || output === undefined || input === undefined) {
      throw new Error("fixture 缺少可移动的目标线端");
    }

    const intent: ConnectionIntent = Object.freeze({
      sourceFingerprint: projection.sourceFingerprint,
      fromNodeId: a.id,
      fromPortId: output.id,
      toNodeId: c.id,
      toPortId: input.id,
      kind: "next",
      replaceEdgeId: oldEdge.id,
    });
    expect(editor.assessConnection(intent)).toEqual({ accepted: true });
    expect(editor.connectNodes(intent)).toBe(true);
    expect(source.indexOf("c++;")).toBeLessThan(source.indexOf("b++;"));
    const nextA = requiredNode(projection, "a++;");
    const nextC = requiredNode(projection, "c++;");
    expect(
      projection.edges.some(
        (edge) =>
          edge.from.nodeId === nextA.id && edge.to.nodeId === nextC.id && edge.kind === "next",
      ),
    ).toBe(true);
  });

  it("commits the named lesson preset through a compiling slot and full CFG gate", () => {
    let source = FIRST_ALGORITHM_SKELETON_SOURCE;
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const slot = requiredNode(projection, ";");
    const port = slot.ports.find(
      (candidate) => candidate.direction === "input" && candidate.channel === "control",
    );
    if (port === undefined) throw new Error("课程插槽缺少控制输入");

    expect(
      editor.connectDraft({
        sourceFingerprint: projection.sourceFingerprint,
        draftNodeId: "draft:update-maximum",
        draftPortId: "draft:update-maximum:next",
        presetId: MAXIMUM_UPDATE_PRESET_ID,
        sourceText: "if (value > maximum) {\n  maximum = value;\n}",
        toNodeId: slot.id,
        toPortId: port.id,
        edgeKind: "next",
      }),
    ).toBe(true);
    expect(source).toBe(FIRST_ALGORITHM_SOURCE);
    expect(projection.documentHasError).toBe(false);
    expect(projection.functions.every((item) => !item.partial)).toBe(true);
  });

  it("moves a proven expression target to the front of an if branch and verifies the new CFG edge", () => {
    let source = [
      "int f(int flag) {",
      "  int value = 0;",
      "  if (flag) {",
      "    value += 1;",
      "    value += 2;",
      "  }",
      "  return value;",
      "}",
      "",
    ].join("\n");
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const branch = projection.nodes.find((node) => node.kind === "branch");
    const target = requiredNode(projection, "value += 2;");
    const oldEdge = projection.edges.find(
      (edge) => edge.from.nodeId === branch?.id && edge.kind === "branch-true",
    );
    const output = branch?.ports.find(
      (port) => port.direction === "output" && port.edgeKind === "branch-true",
    );
    const input = target.ports.find((port) => port.direction === "input");
    if (
      branch === undefined ||
      oldEdge === undefined ||
      output === undefined ||
      input === undefined
    ) {
      throw new Error("fixture 缺少 if 真分支端口");
    }

    expect(
      editor.connectNodes({
        sourceFingerprint: projection.sourceFingerprint,
        fromNodeId: branch.id,
        fromPortId: output.id,
        toNodeId: target.id,
        toPortId: input.id,
        kind: "branch-true",
        replaceEdgeId: oldEdge.id,
      }),
    ).toBe(true);
    expect(source.indexOf("value += 2;")).toBeLessThan(source.indexOf("value += 1;"));
    const nextBranch = projection.nodes.find((node) => node.kind === "branch");
    const nextTarget = requiredNode(projection, "value += 2;");
    expect(
      projection.edges.some(
        (edge) =>
          edge.from.nodeId === nextBranch?.id &&
          edge.to.nodeId === nextTarget.id &&
          edge.kind === "branch-true",
      ),
    ).toBe(true);
  });

  it("allows a safe edit in a complete function while an unrelated function is already partial", () => {
    let source = [
      "int legacy(void) { goto missing; return 0; }",
      "int main(void) {",
      "  int a = 0;",
      "  a++;",
      "  a += 2;",
      "  return a;",
      "}",
      "",
    ].join("\n");
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    expect(session.programAnalysis.functions.some((cfg) => cfg.partial)).toBe(true);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const first = requiredNode(projection, "a++;");
    const second = requiredNode(projection, "a += 2;");
    const displaced = projection.edges.find(
      (edge) => edge.from.nodeId === second.id && edge.kind === "next",
    );
    const output = second.ports.find(
      (port) => port.direction === "output" && port.edgeKind === "next",
    );
    const input = first.ports.find((port) => port.direction === "input" && port.editable);
    if (displaced === undefined || output === undefined || input === undefined) {
      throw new Error("fixture 缺少完整函数的可编辑端口");
    }

    expect(
      editor.connectNodes({
        sourceFingerprint: projection.sourceFingerprint,
        fromNodeId: second.id,
        fromPortId: output.id,
        toNodeId: first.id,
        toPortId: input.id,
        kind: "next",
        replaceEdgeId: displaced.id,
      }),
    ).toBe(true);
    expect(source.indexOf("a += 2;")).toBeLessThan(source.indexOf("a++;"));
    expect(session.programAnalysis.functions.find((cfg) => cfg.name === "legacy")?.partial).toBe(
      true,
    );
    expect(session.programAnalysis.functions.find((cfg) => cfg.name === "main")?.partial).toBe(
      false,
    );
  });

  it("rejects an edit that degrades a previously complete function to partial CFG", () => {
    let source = SOURCE;
    let revision = 1;
    const session = analyzeSession(parser, source, revision);
    const projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const applyPatches = vi.fn(() => true);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches,
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt: vi.fn(),
      confirm: () => true,
      onCommitted: vi.fn(),
    });

    expect(() =>
      editor.replaceNodeSource(requiredNode(projection, "a++;"), "goto missing;"),
    ).toThrow(/降级为 partial CFG/u);
    expect(applyPatches).not.toHaveBeenCalled();
    expect(source).toBe(SOURCE);
  });

  it("atomically replaces one next edge with predecessor -> inserted block -> successor", () => {
    let source = SOURCE;
    let revision = 1;
    let session = analyzeSession(parser, source, revision);
    let projection = createFlowProjection(session.programAnalysis, session.analysis.document);
    const editor = createFlowSourceEditor({
      getSession: () => session,
      getProjection: () => projection,
      getParser: () => parser,
      getProjectionMode: () => "synced",
      getEditorSource: () => source,
      applyPatches(patches) {
        source = applyTextPatches(source, patches).source;
        return true;
      },
      resetProjection: vi.fn(),
      nextRevision: () => ++revision,
      adopt(imported, analysis) {
        session = analyzeSession(parser, imported.source, analysis.editTargets.revision, analysis);
        projection = createFlowProjection(session.programAnalysis, session.analysis.document);
      },
      confirm: () => true,
      onCommitted: vi.fn(),
    });
    const predecessor = requiredNode(projection, "a++;");
    const successor = requiredNode(projection, "b++;");
    const edge = projection.edges.find(
      (candidate) =>
        candidate.from.nodeId === predecessor.id &&
        candidate.to.nodeId === successor.id &&
        candidate.kind === "next",
    );
    const input = successor.ports.find((port) => port.direction === "input");
    if (edge === undefined || input === undefined) throw new Error("fixture 缺少 next 插入锚点");

    expect(
      editor.connectDraft({
        sourceFingerprint: projection.sourceFingerprint,
        draftNodeId: "draft:insert",
        draftPortId: "draft:insert:next",
        presetId: "builtin.test.insert",
        sourceText: "a += 10;",
        toNodeId: successor.id,
        toPortId: input.id,
        edgeKind: "next",
        insertOnEdge: {
          edgeId: edge.id,
          fromNodeId: edge.from.nodeId,
          fromPortId: edge.from.portId,
          toNodeId: edge.to.nodeId,
          toPortId: edge.to.portId,
          edgeKind: edge.kind,
        },
      }),
    ).toBe(true);
    expect(source.indexOf("a++;")).toBeLessThan(source.indexOf("a += 10;"));
    expect(source.indexOf("a += 10;")).toBeLessThan(source.indexOf("b++;"));
  });
});

function analyzeSession(
  parser: CParser,
  source: string,
  revision: number,
  providedAnalysis?: CAnalysisSnapshot,
): ReadySession {
  const analysis = providedAnalysis ?? parser.analyze(source, revision);
  const blockIndex = createBlockIndex(analysis.document);
  const programAnalysis = analyzeProgramSnapshot(
    parser,
    source,
    analysis.editTargets.revision,
    blockIndex.entries.length,
  );
  const imported: ImportedSource = Object.freeze({
    source,
    displayName: "main.c",
    origin: "paste",
  });
  return Object.freeze({ imported, analysis, blockIndex, programAnalysis });
}

function requiredNode(projection: FlowProjection, sourceText: string) {
  const matches = projection.nodes.filter((node) => node.sourceText.trim() === sourceText);
  if (matches.length !== 1) throw new Error(`fixture 节点不唯一：${sourceText}`);
  return matches[0]!;
}
