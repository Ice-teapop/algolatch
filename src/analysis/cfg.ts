import type { Node } from "web-tree-sitter";
import {
  textRange,
  type Block,
  type SourceDoc,
  type SyntaxBlock,
  type TextRange,
} from "../core/model.js";
import { fingerprintSource } from "../shared/source-snapshot.js";
import { collectFunctionDefUse } from "./def-use.js";
import { collectFunctionFindings } from "./findings.js";
import { collectFunctionMemoryEvents } from "./memory-events.js";
import { collectFunctionMemoryTypestate } from "./memory-typestate.js";
import type {
  CfgEdge,
  CfgEdgeKind,
  CfgNode,
  CfgNodeRole,
  CfgPartialReason,
  CfgPartialReasonCode,
  FunctionCfg,
  ProgramAnalysisInput,
  ProgramAnalysisSnapshot,
} from "./model.js";

interface DraftNode extends Omit<CfgNode, "reachable"> {
  reachable: boolean;
}

interface FunctionBuildContext {
  readonly sourceLength: number;
  readonly functionRange: TextRange;
  readonly entryId: string;
  readonly exitId: string;
  readonly nodes: Map<string, DraftNode>;
  readonly edges: Map<string, CfgEdge>;
  readonly partialReasons: Map<string, CfgPartialReason>;
  readonly labels: Map<string, LabelTarget>;
  readonly loopAncestorsByNodeId: Map<number, ReadonlySet<string>>;
  readonly shadowedSpecialCallRanges: ReadonlySet<string>;
}

interface LabelTarget {
  readonly id: string;
  readonly loopAncestors: ReadonlySet<string>;
}

interface ControlTargets {
  readonly breakTargetId: string | null;
  readonly continueTargetId: string | null;
}

const NO_CONTROL_TARGETS: ControlTargets = Object.freeze({
  breakTargetId: null,
  continueTargetId: null,
});

const CONTROL_FLOW_NODES = new Set([
  "break_statement",
  "continue_statement",
  "do_statement",
  "for_statement",
  "goto_statement",
  "if_statement",
  "labeled_statement",
  "switch_statement",
  "while_statement",
]);

const LOOP_NODE_TYPES = new Set(["do_statement", "for_statement", "while_statement"]);
const DIRECT_TERMINATORS = new Set(["exit", "abort", "_Exit", "quick_exit"]);

const EDGE_ORDER: Readonly<Record<CfgEdgeKind, number>> = Object.freeze({
  entry: 0,
  next: 1,
  "branch-true": 2,
  "branch-false": 3,
  "switch-case": 4,
  "switch-default": 5,
  "switch-miss": 6,
  break: 7,
  continue: 8,
  goto: 9,
  return: 10,
  terminate: 11,
});

export function analyzeProgramCst(input: ProgramAnalysisInput): ProgramAnalysisSnapshot {
  assertInput(input);
  const projectedByFunction = projectedStatementsByFunction(input.document);
  const functionAnalyses = collectFunctions(input.rootNode)
    .map((node) => {
      const range = nodeRange(node, input.source.length);
      const cfg = buildFunctionCfg(
        node,
        input.source.length,
        projectedByFunction.get(rangeKey(range)) ?? [],
        input.document,
      );
      const defUse = collectFunctionDefUse({
        functionNode: node,
        cfg,
        document: input.document,
      });
      const memoryEvents = collectFunctionMemoryEvents({
        functionNode: node,
        cfg,
        defUse,
        document: input.document,
      });
      const memoryTypestate = collectFunctionMemoryTypestate({ cfg, memoryEvents });
      const findings = collectFunctionFindings({ cfg, defUse });
      return Object.freeze({ cfg, defUse, memoryEvents, memoryTypestate, findings });
    })
    .sort(
      (left, right) =>
        left.cfg.range.from - right.cfg.range.from || left.cfg.range.to - right.cfg.range.to,
    );
  const functions = Object.freeze(functionAnalyses.map(({ cfg }) => cfg));
  const defUse = Object.freeze(functionAnalyses.map((analysis) => analysis.defUse));
  const memoryEvents = Object.freeze(functionAnalyses.map((analysis) => analysis.memoryEvents));
  const memoryTypestate = Object.freeze(
    functionAnalyses.map((analysis) => analysis.memoryTypestate),
  );
  const findings = Object.freeze(functionAnalyses.flatMap((analysis) => analysis.findings));

  return Object.freeze({
    revision: input.revision,
    sourceLength: input.source.length,
    sourceFingerprint: fingerprintSource(input.source),
    functions,
    defUse,
    memoryEvents,
    memoryTypestate,
    findings,
  });
}

function buildFunctionCfg(
  functionNode: Node,
  sourceLength: number,
  projectedStatements: readonly SyntaxBlock[],
  document: SourceDoc,
): FunctionCfg {
  const range = nodeRange(functionNode, sourceLength);
  const id = `function:${range.from}:${range.to}`;
  const entryId = `${id}:entry`;
  const exitId = `${id}:exit`;
  const context: FunctionBuildContext = {
    sourceLength,
    functionRange: range,
    entryId,
    exitId,
    nodes: new Map([
      [entryId, boundaryNode(entryId, "entry", functionNode, range)],
      [exitId, boundaryNode(exitId, "exit", functionNode, range)],
    ]),
    edges: new Map(),
    partialReasons: new Map(),
    labels: new Map(),
    loopAncestorsByNodeId: new Map(),
    shadowedSpecialCallRanges: collectShadowedSpecialCallRanges(document, range, functionNode),
  };

  indexLabels(functionNode, context);

  if (functionNode.hasError) addPartial(context, "parse-error", functionNode);
  const body = functionNode.childForFieldName("body");
  if (body === null || body.type !== "compound_statement") {
    addPartial(context, "unsupported-syntax", functionNode);
    addEdge(context, entryId, exitId, "entry");
  } else {
    const first = buildSequence(body.namedChildren, exitId, context, NO_CONTROL_TARGETS);
    addEdge(context, entryId, first, "entry");
  }

  if (context.partialReasons.size > 0) {
    ensureProjectedOwnership(context, projectedStatements);
  }
  markReachable(context);
  return freezeFunctionCfg(id, declaredFunctionName(functionNode, range), range, context);
}

function buildSequence(
  children: readonly Node[],
  continuationId: string,
  context: FunctionBuildContext,
  targets: ControlTargets,
): string {
  let first = continuationId;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined || child.type === "comment") continue;
    first = buildNode(child, first, context, targets);
  }
  return first;
}

function buildNode(
  node: Node,
  continuationId: string,
  context: FunctionBuildContext,
  targets: ControlTargets,
): string {
  if (node.type === "compound_statement") {
    return buildSequence(node.namedChildren, continuationId, context, targets);
  }

  const role: CfgNodeRole =
    node.type === "declaration" || node.type === "type_definition" ? "declaration" : "statement";
  const id = addSyntaxNode(context, node, role);
  if (node.isError || node.type === "ERROR" || node.hasError) {
    addPartial(context, "parse-error", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }
  if (node.type === "return_statement") {
    addEdge(context, id, context.exitId, "return");
    return id;
  }
  if (node.type === "if_statement") {
    return buildIf(node, id, continuationId, context, targets);
  }
  if (node.type === "while_statement") {
    return buildWhile(node, id, continuationId, context);
  }
  if (node.type === "do_statement") {
    return buildDoWhile(node, id, continuationId, context);
  }
  if (node.type === "for_statement") {
    return buildFor(node, id, continuationId, context);
  }
  if (node.type === "switch_statement") {
    return buildSwitch(node, id, continuationId, context, targets);
  }
  if (node.type === "labeled_statement") {
    return buildLabeledStatement(node, id, continuationId, context, targets);
  }
  if (node.type === "goto_statement") {
    return buildGoto(node, id, context);
  }
  if (node.type === "break_statement") {
    return buildControlTransfer(node, id, continuationId, targets.breakTargetId, "break", context);
  }
  if (node.type === "continue_statement") {
    return buildControlTransfer(
      node,
      id,
      continuationId,
      targets.continueTargetId,
      "continue",
      context,
    );
  }
  if (node.type === "expression_statement") {
    const directCall = directCallName(node, context);
    if (directCall !== null && DIRECT_TERMINATORS.has(directCall)) {
      addEdge(context, id, context.exitId, "terminate");
      return id;
    }
    if (directCall === "assert") {
      addEdge(context, id, continuationId, "branch-true");
      addEdge(context, id, context.exitId, "branch-false");
      return id;
    }
    if (directCall === "longjmp" || containsNestedTerminatorCall(node, context)) {
      addPartial(context, "unsupported-syntax", node);
    }
  }
  if (
    node.type === "declaration" ||
    node.type === "type_definition" ||
    node.type === "expression_statement"
  ) {
    addEdge(context, id, continuationId, "next");
    return id;
  }

  addPartial(
    context,
    CONTROL_FLOW_NODES.has(node.type) ? "unsupported-control-flow" : "unsupported-syntax",
    node,
  );
  addEdge(context, id, continuationId, "next");
  return id;
}

function buildIf(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
  targets: ControlTargets,
): string {
  const consequence = node.childForFieldName("consequence");
  if (consequence === null) {
    addPartial(context, "unsupported-syntax", node);
    return id;
  }

  const consequenceId = buildNode(consequence, continuationId, context, targets);
  const alternativeClause = node.childForFieldName("alternative");
  let alternativeId = continuationId;
  if (alternativeClause !== null) {
    const alternatives = alternativeClause.namedChildren.filter(
      (candidate) => candidate.type !== "comment",
    );
    const alternative = alternatives.length === 1 ? alternatives[0] : undefined;
    if (alternativeClause.type !== "else_clause" || alternative === undefined) {
      addPartial(context, "unsupported-syntax", alternativeClause);
      return id;
    }
    alternativeId = buildNode(alternative, continuationId, context, targets);
  }

  addEdge(context, id, consequenceId, "branch-true");
  addEdge(context, id, alternativeId, "branch-false");
  return id;
}

function buildWhile(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
): string {
  const body = node.childForFieldName("body");
  if (body === null) {
    addPartial(context, "unsupported-syntax", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }
  const bodyId = buildNode(body, id, context, {
    breakTargetId: continuationId,
    continueTargetId: id,
  });
  addEdge(context, id, bodyId, "branch-true");
  addEdge(context, id, continuationId, "branch-false");
  return id;
}

function buildDoWhile(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
): string {
  const body = node.childForFieldName("body");
  const condition = node.childForFieldName("condition");
  if (body === null || condition === null) {
    addPartial(context, "unsupported-syntax", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }
  context.nodes.delete(id);
  const conditionId = addControlNode(context, node, condition, "do_condition");
  const bodyId = buildNode(body, conditionId, context, {
    breakTargetId: continuationId,
    continueTargetId: conditionId,
  });
  addEdge(context, conditionId, bodyId, "branch-true");
  addEdge(context, conditionId, continuationId, "branch-false");
  return bodyId;
}

function buildFor(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
): string {
  const body = node.childForFieldName("body");
  if (body === null) {
    addPartial(context, "unsupported-syntax", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }

  const update = node.childForFieldName("update");
  const updateId = update === null ? id : addControlNode(context, node, update, "for_update");
  if (update !== null) addPhaseEdges(context, update, updateId, id);

  const bodyId = buildNode(body, updateId, context, {
    breakTargetId: continuationId,
    continueTargetId: updateId,
  });
  addEdge(context, id, bodyId, "branch-true");
  if (node.childForFieldName("condition") !== null) {
    addEdge(context, id, continuationId, "branch-false");
  }

  const initializer = node.childForFieldName("initializer");
  if (initializer === null) return id;
  const initializerId = addControlNode(context, node, initializer, "for_initializer");
  addPhaseEdges(context, initializer, initializerId, id);
  return initializerId;
}

function addPhaseEdges(
  context: FunctionBuildContext,
  node: Node,
  id: string,
  continuationId: string,
): void {
  const directCall = directCallName(node, context);
  if (directCall !== null && DIRECT_TERMINATORS.has(directCall)) {
    addEdge(context, id, context.exitId, "terminate");
    return;
  }
  if (directCall === "assert") {
    addEdge(context, id, continuationId, "branch-true");
    addEdge(context, id, context.exitId, "branch-false");
    return;
  }
  if (directCall === "longjmp" || containsNestedTerminatorCall(node, context)) {
    addPartial(context, "unsupported-syntax", node);
  }
  addEdge(context, id, continuationId, "next");
}

function buildSwitch(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
  outerTargets: ControlTargets,
): string {
  const body = node.childForFieldName("body");
  if (body === null || body.type !== "compound_statement") {
    addPartial(context, "unsupported-syntax", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }

  const directChildren = body.namedChildren.filter((child) => child.type !== "comment");
  const directCases = directChildren.filter((child) => child.type === "case_statement");
  const directCaseIds = new Set(directCases.map((candidate) => candidate.id));
  const nestedCase = body
    .descendantsOfType("case_statement")
    .find(
      (candidate) =>
        !directCaseIds.has(candidate.id) && nearestSwitchAncestor(candidate)?.id === node.id,
    );
  if (nestedCase !== undefined) {
    addPartial(context, "unsupported-control-flow", nestedCase);
    addEdge(context, id, continuationId, "next");
    return id;
  }

  const switchTargets: ControlTargets = {
    breakTargetId: continuationId,
    continueTargetId: outerTargets.continueTargetId,
  };
  let nextEntryId = continuationId;
  const caseEntries: Array<{ readonly node: Node; readonly id: string }> = [];
  for (let index = directChildren.length - 1; index >= 0; index -= 1) {
    const child = directChildren[index];
    if (child === undefined) continue;
    if (child.type === "case_statement") {
      nextEntryId = buildCase(child, nextEntryId, context, switchTargets);
      caseEntries.push({ node: child, id: nextEntryId });
    } else {
      nextEntryId = buildNode(child, nextEntryId, context, switchTargets);
    }
  }

  let hasDefault = false;
  for (const entry of caseEntries.reverse()) {
    const isDefault = entry.node.childForFieldName("value") === null;
    hasDefault ||= isDefault;
    addEdge(context, id, entry.id, isDefault ? "switch-default" : "switch-case");
  }
  if (!hasDefault) addEdge(context, id, continuationId, "switch-miss");
  return id;
}

function buildCase(
  node: Node,
  continuationId: string,
  context: FunctionBuildContext,
  targets: ControlTargets,
): string {
  const id = addSyntaxNode(context, node, "statement");
  const value = node.childForFieldName("value");
  const bodyChildren = node.namedChildren.filter(
    (child) => child.type !== "comment" && (value === null || child.id !== value.id),
  );
  const bodyId = buildSequence(bodyChildren, continuationId, context, targets);
  addEdge(context, id, bodyId, "next");
  return id;
}

function buildLabeledStatement(
  node: Node,
  id: string,
  continuationId: string,
  context: FunctionBuildContext,
  targets: ControlTargets,
): string {
  const label = node.childForFieldName("label");
  const bodies = node.namedChildren.filter(
    (child) => child.type !== "comment" && (label === null || child.id !== label.id),
  );
  const body = bodies.length === 1 ? bodies[0] : undefined;
  if (label === null || body === undefined) {
    addPartial(context, "unsupported-syntax", node);
    addEdge(context, id, continuationId, "next");
    return id;
  }
  const bodyId = buildNode(body, continuationId, context, targets);
  addEdge(context, id, bodyId, "next");
  return id;
}

function buildGoto(node: Node, id: string, context: FunctionBuildContext): string {
  const label = node.childForFieldName("label");
  const target = label === null ? undefined : context.labels.get(label.text);
  const sourceLoops = context.loopAncestorsByNodeId.get(node.id) ?? new Set<string>();
  const entersLoop =
    target !== undefined && [...target.loopAncestors].some((loopKey) => !sourceLoops.has(loopKey));
  if (target === undefined) {
    addPartial(context, "unsupported-control-flow", node);
    return id;
  }
  if (entersLoop) addPartial(context, "unsupported-control-flow", node);
  addEdge(context, id, target.id, "goto");
  return id;
}

function nearestSwitchAncestor(node: Node): Node | null {
  let ancestor = node.parent;
  while (ancestor !== null) {
    if (ancestor.type === "switch_statement") return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

function indexLabels(functionNode: Node, context: FunctionBuildContext): void {
  const visit = (node: Node, loopAncestors: ReadonlySet<string>): void => {
    context.loopAncestorsByNodeId.set(node.id, loopAncestors);
    if (node.type === "labeled_statement") {
      const label = node.childForFieldName("label");
      if (label !== null) {
        if (context.labels.has(label.text)) {
          addPartial(context, "unsupported-control-flow", node);
        } else {
          context.labels.set(label.text, {
            id: addSyntaxNode(context, node, "statement"),
            loopAncestors,
          });
        }
      }
    }

    const childLoops = LOOP_NODE_TYPES.has(node.type)
      ? new Set([...loopAncestors, loopKey(node)])
      : loopAncestors;
    for (const child of node.namedChildren) visit(child, childLoops);
  };

  visit(functionNode, new Set());
}

function loopKey(node: Node): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function buildControlTransfer(
  node: Node,
  id: string,
  continuationId: string,
  targetId: string | null,
  kind: "break" | "continue",
  context: FunctionBuildContext,
): string {
  if (targetId === null) {
    addPartial(context, "unsupported-control-flow", node);
    addEdge(context, id, continuationId, "next");
  } else {
    addEdge(context, id, targetId, kind);
  }
  return id;
}

function addSyntaxNode(context: FunctionBuildContext, node: Node, role: CfgNodeRole): string {
  const range = nodeRange(node, context.sourceLength);
  const id = `syntax:${range.from}:${range.to}:${node.type}`;
  context.nodes.set(id, {
    id,
    kind: "syntax",
    role,
    ownership: "primary",
    nodeType: node.type,
    range,
    ownerBlockRange: range,
    reachable: false,
  });
  return id;
}

function addControlNode(
  context: FunctionBuildContext,
  owner: Node,
  node: Node,
  nodeType: "do_condition" | "for_initializer" | "for_update",
): string {
  const range = nodeRange(node, context.sourceLength);
  const ownerBlockRange = nodeRange(owner, context.sourceLength);
  const id = `control:${range.from}:${range.to}:${nodeType}`;
  context.nodes.set(id, {
    id,
    kind: "control",
    role: "control",
    ownership: nodeType === "do_condition" ? "primary" : "auxiliary",
    nodeType,
    range,
    ownerBlockRange,
    reachable: false,
  });
  return id;
}

function addEdge(context: FunctionBuildContext, from: string, to: string, kind: CfgEdgeKind): void {
  const edge = Object.freeze({ from, to, kind });
  context.edges.set(`${from}\u0000${kind}\u0000${to}`, edge);
}

function addPartial(context: FunctionBuildContext, code: CfgPartialReasonCode, node: Node): void {
  const range = nodeRange(node, context.sourceLength);
  const reason = Object.freeze({ code, nodeType: node.type, range });
  context.partialReasons.set(`${code}:${node.type}:${range.from}:${range.to}`, reason);
}

function ensureProjectedOwnership(
  context: FunctionBuildContext,
  projectedStatements: readonly SyntaxBlock[],
): void {
  const ownedRanges = new Set(
    [...context.nodes.values()]
      .filter((node) => node.kind !== "entry" && node.kind !== "exit")
      .map((node) => rangeKey(node.ownerBlockRange)),
  );
  for (const block of projectedStatements) {
    const key = rangeKey(block.range);
    if (ownedRanges.has(key)) continue;
    const id = `syntax:${block.range.from}:${block.range.to}:${block.nodeType}`;
    context.nodes.set(id, {
      id,
      kind: "syntax",
      role: block.role === "declaration" ? "declaration" : "statement",
      ownership: "primary",
      nodeType: block.nodeType,
      range: block.range,
      ownerBlockRange: block.range,
      reachable: false,
    });
    ownedRanges.add(key);
  }
}

function projectedStatementsByFunction(
  document: SourceDoc,
): ReadonlyMap<string, readonly SyntaxBlock[]> {
  const byFunction = new Map<string, readonly SyntaxBlock[]>();
  const visit = (block: Block): void => {
    if (block.kind === "syntax" && block.role === "function") {
      const statements: SyntaxBlock[] = [];
      collectProjectedStatements(block.children, statements);
      byFunction.set(rangeKey(block.range), statements);
      return;
    }
    block.children.forEach(visit);
  };
  document.blocks.forEach(visit);
  return byFunction;
}

function collectProjectedStatements(blocks: readonly Block[], output: SyntaxBlock[]): void {
  for (const block of blocks) {
    if (block.kind === "syntax" && (block.role === "statement" || block.role === "declaration")) {
      output.push(block);
    }
    collectProjectedStatements(block.children, output);
  }
}

function markReachable(context: FunctionBuildContext): void {
  const outgoing = new Map<string, string[]>();
  for (const edge of context.edges.values()) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const pending = [context.entryId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const node = context.nodes.get(id);
    if (node !== undefined) node.reachable = true;
    pending.push(...(outgoing.get(id) ?? []));
  }
}

function freezeFunctionCfg(
  id: string,
  name: string,
  range: TextRange,
  context: FunctionBuildContext,
): FunctionCfg {
  const nodes = [...context.nodes.values()].sort(compareNodes);
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const frozenNodes = Object.freeze(nodes.map((node) => Object.freeze({ ...node })));
  const edges = Object.freeze(
    [...context.edges.values()].sort(
      (left, right) =>
        (nodeOrder.get(left.from) ?? -1) - (nodeOrder.get(right.from) ?? -1) ||
        EDGE_ORDER[left.kind] - EDGE_ORDER[right.kind] ||
        (nodeOrder.get(left.to) ?? -1) - (nodeOrder.get(right.to) ?? -1),
    ),
  );
  const partialReasons = Object.freeze(
    [...context.partialReasons.values()].sort(
      (left, right) =>
        left.range.from - right.range.from ||
        left.range.to - right.range.to ||
        left.code.localeCompare(right.code),
    ),
  );
  return Object.freeze({
    id,
    name,
    range,
    entryId: context.entryId,
    exitId: context.exitId,
    nodes: frozenNodes,
    edges,
    partial: partialReasons.length > 0,
    partialReasons,
  });
}

function boundaryNode(
  id: string,
  kind: "entry" | "exit",
  functionNode: Node,
  range: TextRange,
): DraftNode {
  return {
    id,
    kind,
    role: "boundary",
    ownership: "boundary",
    nodeType: "function_definition",
    range,
    ownerBlockRange: range,
    reachable: false,
  };
}

function compareNodes(left: DraftNode, right: DraftNode): number {
  const kindOrder = { entry: 0, syntax: 1, control: 1, exit: 2 } as const;
  return (
    kindOrder[left.kind] - kindOrder[right.kind] ||
    left.range.from - right.range.from ||
    right.range.to - left.range.to ||
    left.id.localeCompare(right.id)
  );
}

function collectFunctions(rootNode: Node): readonly Node[] {
  return rootNode
    .descendantsOfType("function_definition")
    .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
}

function declaredFunctionName(functionNode: Node, range: TextRange): string {
  let declarator = functionNode.childForFieldName("declarator");
  while (declarator !== null) {
    if (declarator.type === "identifier") return declarator.text;
    declarator = declarator.childForFieldName("declarator");
  }
  return `<function@${range.from}>`;
}

function directCallName(node: Node, context: FunctionBuildContext): string | null {
  const expression = directCallExpression(node);
  if (expression === null) return null;
  let callee = expression.childForFieldName("function");
  while (callee?.type === "parenthesized_expression") {
    const children = callee.namedChildren.filter((candidate) => candidate.type !== "comment");
    callee = children.length === 1 ? (children[0] ?? null) : null;
  }
  if (callee?.type !== "identifier") return null;
  const range = textRange(callee.startIndex, callee.endIndex);
  return context.shadowedSpecialCallRanges.has(rangeKey(range)) ? null : callee.text;
}

function directCallExpression(node: Node): Node | null {
  if (node.type === "call_expression") return node;
  const children = node.namedChildren.filter((candidate) => candidate.type !== "comment");
  return children.length === 1 && children[0]?.type === "call_expression" ? children[0] : null;
}

function containsNestedTerminatorCall(node: Node, context: FunctionBuildContext): boolean {
  const direct = directCallExpression(node);
  return node
    .descendantsOfType("call_expression")
    .some(
      (call) =>
        call.id !== direct?.id &&
        (directCallName(call, context) === "longjmp" ||
          DIRECT_TERMINATORS.has(directCallName(call, context) ?? "")),
    );
}

function collectShadowedSpecialCallRanges(
  document: SourceDoc,
  functionRange: TextRange,
  functionNode: Node,
): ReadonlySet<string> {
  const symbols = new Map(document.symbols.symbols.map((symbol) => [symbol.id, symbol]));
  const specialNames = new Set(["assert", "exit", "abort", "_Exit", "quick_exit", "longjmp"]);
  const macroEvents = collectRelevantMacroEvents(
    functionNode,
    new Set([...specialNames, "NDEBUG"]),
  );
  const assertIncludes = collectAssertIncludeEvents(functionNode);
  return new Set(
    document.symbols.occurrences
      .filter((occurrence) => {
        if (occurrence.role !== "use" || !containsRange(functionRange, occurrence.range))
          return false;
        const symbol = symbols.get(occurrence.symbolId);
        return (
          symbol !== undefined &&
          specialNames.has(symbol.name) &&
          (macroCouldBeActiveAt(macroEvents, symbol.name, occurrence.range.from) ||
            (symbol.name === "assert" &&
              assertEvaluationCouldBeSkippedAt(
                macroEvents,
                assertIncludes,
                occurrence.range.from,
              )) ||
            (occurrence.resolution !== "unknown" &&
              occurrence.resolution !== "builtin" &&
              occurrence.resolution !== "user-macro"))
        );
      })
      .map((occurrence) => rangeKey(occurrence.range)),
  );
}

interface RelevantMacroEvent {
  readonly action: "define" | "undef";
  readonly conditional: boolean;
  readonly name: string;
  readonly offset: number;
}

interface AssertIncludeEvent {
  readonly conditional: boolean;
  readonly offset: number;
}

function collectRelevantMacroEvents(
  functionNode: Node,
  relevantNames: ReadonlySet<string>,
): readonly RelevantMacroEvent[] {
  let root = functionNode;
  while (root.parent !== null) root = root.parent;
  const definitions = [
    ...root.descendantsOfType("preproc_def"),
    ...root.descendantsOfType("preproc_function_def"),
  ]
    .map((node) => ({
      action: "define" as const,
      conditional: hasConditionalPreprocessorAncestor(node),
      name: node.childForFieldName("name")?.text ?? "",
      offset: node.startIndex,
    }))
    .filter((event) => relevantNames.has(event.name));
  const undefinitions = root
    .descendantsOfType("preproc_call")
    .filter((node) => node.childForFieldName("directive")?.text.replace(/\s/g, "") === "#undef")
    .map((node) => ({
      action: "undef" as const,
      conditional: hasConditionalPreprocessorAncestor(node),
      name: node.childForFieldName("argument")?.text.trim().split(/\s/u)[0] ?? "",
      offset: node.startIndex,
    }))
    .filter((event) => relevantNames.has(event.name));
  return [...definitions, ...undefinitions].sort(
    (left, right) => left.offset - right.offset || left.action.localeCompare(right.action),
  );
}

function collectAssertIncludeEvents(functionNode: Node): readonly AssertIncludeEvent[] {
  let root = functionNode;
  while (root.parent !== null) root = root.parent;
  return root
    .descendantsOfType("preproc_include")
    .filter((node) => node.childForFieldName("path")?.text === "<assert.h>")
    .map((node) => ({
      conditional: hasConditionalPreprocessorAncestor(node),
      offset: node.startIndex,
    }))
    .sort((left, right) => left.offset - right.offset);
}

function macroCouldBeActiveAt(
  events: readonly RelevantMacroEvent[],
  name: string,
  offset: number,
): boolean {
  let possiblyActive = false;
  for (const event of events) {
    if (event.offset >= offset) break;
    if (event.name !== name) continue;
    if (!event.conditional) {
      possiblyActive = event.action === "define";
      continue;
    }
    if (event.action === "define") possiblyActive = true;
  }
  return possiblyActive;
}

function assertEvaluationCouldBeSkippedAt(
  macroEvents: readonly RelevantMacroEvent[],
  includeEvents: readonly AssertIncludeEvent[],
  offset: number,
): boolean {
  let couldSkipEvaluation = false;
  for (const include of includeEvents) {
    if (include.offset >= offset) break;
    const ndebugCouldBeActive = macroCouldBeActiveAt(macroEvents, "NDEBUG", include.offset);
    couldSkipEvaluation = include.conditional
      ? couldSkipEvaluation || ndebugCouldBeActive
      : ndebugCouldBeActive;
  }
  return couldSkipEvaluation;
}

function hasConditionalPreprocessorAncestor(node: Node): boolean {
  let current = node.parent;
  while (current !== null) {
    if (
      current.type === "preproc_if" ||
      current.type === "preproc_ifdef" ||
      current.type === "preproc_ifndef"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function nodeRange(node: Node, sourceLength: number): TextRange {
  if (
    !Number.isSafeInteger(node.startIndex) ||
    !Number.isSafeInteger(node.endIndex) ||
    node.startIndex < 0 ||
    node.endIndex <= node.startIndex ||
    node.endIndex > sourceLength
  ) {
    throw new RangeError(`分析节点 range 非法：[${node.startIndex}, ${node.endIndex})`);
  }
  return textRange(node.startIndex, node.endIndex);
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function assertInput(input: ProgramAnalysisInput): void {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new RangeError(`分析 revision 必须是非负安全整数，实际 ${String(input.revision)}`);
  }
  if (input.rootNode.type !== "translation_unit") {
    throw new TypeError(`分析根节点必须是 translation_unit，实际 ${input.rootNode.type}`);
  }
  if (input.document.source !== input.source) {
    throw new TypeError("分析输入的 SourceDoc 与 CST 源码不一致");
  }
  let rootMatchesSource = false;
  try {
    const { startIndex, endIndex } = input.rootNode;
    rootMatchesSource =
      Number.isSafeInteger(startIndex) &&
      Number.isSafeInteger(endIndex) &&
      startIndex >= 0 &&
      endIndex >= startIndex &&
      endIndex <= input.source.length &&
      /^(?:\uFEFF)?[ \t\r\n\f\v]*$/u.test(input.source.slice(0, startIndex)) &&
      /^[ \t\r\n\f\v]*$/u.test(input.source.slice(endIndex)) &&
      input.rootNode.text === input.source.slice(startIndex, endIndex);
  } catch (error) {
    throw new TypeError("分析根节点已释放或无法读取", { cause: error });
  }
  if (!rootMatchesSource) {
    throw new TypeError("分析根节点与 source 不属于同一源码快照");
  }
}

function rangeKey(range: TextRange): string {
  return `${range.from}:${range.to}`;
}
