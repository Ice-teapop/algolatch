import type { TextRange } from "../core/model.js";
import type {
  CfgEdge,
  CfgEdgeKind,
  FunctionCfg,
  FunctionMemoryEvents,
  FunctionMemoryTypestate,
  MemoryEvent,
  MemoryEventFact,
  MemoryHandleEdgeState,
  MemoryHandleTypestateFact,
  MemoryTypestate,
  MemoryTypestateEdgeFact,
  MemoryTypestateFact,
  MemoryTypestateValue,
} from "./model.js";

export interface FunctionMemoryTypestateInput {
  readonly cfg: FunctionCfg;
  readonly memoryEvents: FunctionMemoryEvents;
}

interface MutableHandleState {
  mask: number;
  readonly eventIdsByState: readonly Set<string>[];
}

interface FlowState {
  feasible: boolean;
  readonly handles: MutableHandleState[];
}

interface IndexedEdge {
  readonly edge: CfgEdge;
  readonly fromIndex: number;
  readonly toIndex: number;
}

const UNALLOC_NULL_BIT = 1 << 0;
const UNALLOC_UNKNOWN_BIT = 1 << 1;
const ALLOC_BIT = 1 << 2;
const MAYBE_NULL_BIT = 1 << 3;
const FREED_BIT = 1 << 4;
const ESCAPED_BIT = 1 << 5;
const UNALLOC_BITS = UNALLOC_NULL_BIT | UNALLOC_UNKNOWN_BIT;
const INTERNAL_STATE_BITS = Object.freeze([
  UNALLOC_NULL_BIT,
  UNALLOC_UNKNOWN_BIT,
  ALLOC_BIT,
  MAYBE_NULL_BIT,
  FREED_BIT,
  ESCAPED_BIT,
] as const);
const PUBLIC_STATE_ORDER = Object.freeze([
  ["unalloc", UNALLOC_BITS],
  ["alloc", ALLOC_BIT],
  ["maybeNull", MAYBE_NULL_BIT],
  ["freed", FREED_BIT],
  ["escaped", ESCAPED_BIT],
] as const satisfies readonly (readonly [MemoryTypestate, number])[]);
const STATE_INDEX_BY_BIT = new Map(INTERNAL_STATE_BITS.map((bit, index) => [bit, index]));
const LIVE_BITS = ALLOC_BIT | MAYBE_NULL_BIT;

/**
 * Solves flow-sensitive unique-handle typestate over the complete memory-event layer.
 * Node facts and edge facts are pure values and never retain Tree-sitter nodes.
 */
export function collectFunctionMemoryTypestate(
  input: FunctionMemoryTypestateInput,
): FunctionMemoryTypestate {
  assertAlignedInput(input);
  if (input.memoryEvents.status === "disabled") {
    return freezeFunctionMemoryTypestate(input, input.memoryEvents.disabledReasons, [], [], []);
  }

  const handleVariableIds = [...input.memoryEvents.handleVariableIds];
  const handleIndexById = new Map(
    handleVariableIds.map((variableId, index) => [variableId, index]),
  );
  const memoryFactsByNodeId = new Map(input.memoryEvents.facts.map((fact) => [fact.nodeId, fact]));
  const eventRank = buildEventRank(input.memoryEvents.facts);
  const nodeIndexById = new Map(input.cfg.nodes.map((node, index) => [node.id, index]));
  const indexedEdges = input.cfg.edges.map((edge): IndexedEdge => {
    const fromIndex = nodeIndexById.get(edge.from);
    const toIndex = nodeIndexById.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined) {
      throw new TypeError("memory typestate CFG edge 引用了未知节点");
    }
    return { edge, fromIndex, toIndex };
  });
  const predecessors = input.cfg.nodes.map((): IndexedEdge[] => []);
  const successors = input.cfg.nodes.map((): IndexedEdge[] => []);
  for (const edge of indexedEdges) {
    predecessors[edge.toIndex]!.push(edge);
    successors[edge.fromIndex]!.push(edge);
  }

  const inStates = input.cfg.nodes.map(() => bottomFlow(handleVariableIds.length));
  const outStates = input.cfg.nodes.map(() => bottomFlow(handleVariableIds.length));
  const entryIndex = nodeIndexById.get(input.cfg.entryId);
  if (entryIndex === undefined) throw new TypeError("memory typestate CFG 缺少 entry 节点");
  const queue = [entryIndex];
  const queued = new Set(queue);
  const processed = new Set<number>();
  let cursor = 0;
  while (cursor < queue.length) {
    const nodeIndex = queue[cursor++];
    if (nodeIndex === undefined) break;
    queued.delete(nodeIndex);
    const node = input.cfg.nodes[nodeIndex];
    const memoryFact = node === undefined ? undefined : memoryFactsByNodeId.get(node.id);
    if (node === undefined || memoryFact === undefined || !node.reachable) continue;

    const nextIn =
      nodeIndex === entryIndex
        ? initialFlow(handleVariableIds.length)
        : bottomFlow(handleVariableIds.length);
    if (nodeIndex !== entryIndex) {
      for (const incoming of predecessors[nodeIndex] ?? []) {
        const predecessorNode = input.cfg.nodes[incoming.fromIndex];
        const predecessorFact =
          predecessorNode === undefined ? undefined : memoryFactsByNodeId.get(predecessorNode.id);
        if (predecessorFact === undefined) {
          throw new TypeError("memory typestate 缺少 predecessor event fact");
        }
        const edgeState = refineForEdge(
          outStates[incoming.fromIndex]!,
          predecessorFact.events,
          incoming.edge.kind,
          handleIndexById,
        );
        joinFlowInto(nextIn, edgeState);
      }
    }
    const nextOut = transferFlow(nextIn, memoryFact.events, handleIndexById);
    const changed =
      !flowsEqual(inStates[nodeIndex]!, nextIn) || !flowsEqual(outStates[nodeIndex]!, nextOut);
    if (!changed && processed.has(nodeIndex)) continue;
    processed.add(nodeIndex);
    inStates[nodeIndex] = nextIn;
    outStates[nodeIndex] = nextOut;
    for (const outgoing of successors[nodeIndex] ?? []) {
      if (!input.cfg.nodes[outgoing.toIndex]?.reachable || queued.has(outgoing.toIndex)) continue;
      queue.push(outgoing.toIndex);
      queued.add(outgoing.toIndex);
    }
  }

  const facts = input.cfg.nodes.map((node, index) => {
    const memoryFact = memoryFactsByNodeId.get(node.id);
    if (memoryFact === undefined) throw new TypeError(`memory typestate 缺少节点事实：${node.id}`);
    return freezeNodeFact(
      node.id,
      node.range,
      handleVariableIds,
      inStates[index]!,
      outStates[index]!,
      memoryFact.events,
      handleIndexById,
      eventRank,
    );
  });
  const edgeFacts = indexedEdges.map((indexed): MemoryTypestateEdgeFact => {
    const predecessorNode = input.cfg.nodes[indexed.fromIndex]!;
    const predecessorFact = memoryFactsByNodeId.get(predecessorNode.id);
    if (predecessorFact === undefined) {
      throw new TypeError(`memory typestate 缺少 edge predecessor：${predecessorNode.id}`);
    }
    const state = refineForEdge(
      outStates[indexed.fromIndex]!,
      predecessorFact.events,
      indexed.edge.kind,
      handleIndexById,
    );
    return freezeEdgeFact(indexed.edge, handleVariableIds, state, eventRank);
  });
  return freezeFunctionMemoryTypestate(input, [], handleVariableIds, facts, edgeFacts);
}

function transferFlow(
  input: FlowState,
  events: readonly MemoryEvent[],
  handleIndexById: ReadonlyMap<string, number>,
): FlowState {
  if (!input.feasible) return cloneFlow(input);
  const output = cloneFlow(input);
  const eventsByHandle = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    const grouped = eventsByHandle.get(event.variableId) ?? [];
    grouped.push(event);
    eventsByHandle.set(event.variableId, grouped);
  }
  for (const [variableId, grouped] of eventsByHandle) {
    const handleIndex = handleIndexById.get(variableId);
    if (handleIndex === undefined) {
      throw new TypeError(`memory typestate event 引用了未知 handle：${variableId}`);
    }
    output.handles[handleIndex] = transferHandle(output.handles[handleIndex]!, grouped);
  }
  return output;
}

function transferHandle(
  input: MutableHandleState,
  events: readonly MemoryEvent[],
): MutableHandleState {
  const escapes = events.filter((event) => event.kind === "escape");
  const transitions = events.filter(
    (event) =>
      event.kind === "allocation" || event.kind === "free" || event.kind === "null-assignment",
  );
  if (escapes.length > 0 && transitions.length > 0) {
    throw new TypeError("memory typestate 收到未禁用的 escape/transition 混合事件");
  }
  if (transitions.length > 1) {
    throw new TypeError("memory typestate 收到多个同句柄状态转移");
  }
  if (escapes.length > 0) {
    return escapeHandle(
      input,
      escapes.map((event) => event.id),
    );
  }
  const transition = transitions[0];
  if (transition === undefined) return cloneHandle(input);
  if (transition.kind === "allocation") return allocateHandle(input, transition.id);
  if (transition.kind === "null-assignment") return nullAssignHandle(input, transition.id);
  return freeHandle(input, transition.id);
}

function allocateHandle(input: MutableHandleState, eventId: string): MutableHandleState {
  if ((input.mask & (LIVE_BITS | ESCAPED_BIT)) !== 0) {
    return escapeHandle(input, [eventId]);
  }
  const output = emptyHandle();
  forEachState(input, () => {
    addState(output, MAYBE_NULL_BIT, new Set([eventId]));
  });
  return output;
}

function nullAssignHandle(input: MutableHandleState, eventId: string): MutableHandleState {
  if ((input.mask & (LIVE_BITS | ESCAPED_BIT)) !== 0) {
    return escapeHandle(input, [eventId]);
  }
  const output = emptyHandle();
  forEachState(input, () => {
    addState(output, UNALLOC_NULL_BIT, new Set([eventId]));
  });
  return output;
}

function freeHandle(input: MutableHandleState, eventId: string): MutableHandleState {
  const output = emptyHandle();
  forEachState(input, (bit, eventIds) => {
    const lineage = withEvent(eventIds, eventId);
    if (bit === UNALLOC_NULL_BIT || bit === UNALLOC_UNKNOWN_BIT) {
      addState(output, bit, lineage);
      return;
    }
    if (bit === MAYBE_NULL_BIT) {
      addState(output, FREED_BIT, lineage);
      return;
    }
    if (bit === ALLOC_BIT || bit === FREED_BIT) {
      addState(output, FREED_BIT, lineage);
      return;
    }
    addState(output, ESCAPED_BIT, lineage);
  });
  return output;
}

function escapeHandle(input: MutableHandleState, eventIds: readonly string[]): MutableHandleState {
  const output = emptyHandle();
  const lineage = allEventIds(input);
  for (const eventId of eventIds) lineage.add(eventId);
  addState(output, ESCAPED_BIT, lineage);
  return output;
}

function refineForEdge(
  input: FlowState,
  events: readonly MemoryEvent[],
  edgeKind: CfgEdgeKind,
  handleIndexById: ReadonlyMap<string, number>,
): FlowState {
  if (!input.feasible) return cloneFlow(input);
  const output = cloneFlow(input);
  for (const event of events) {
    if (event.kind !== "null-guard") continue;
    if (edgeKind !== "branch-true" && edgeKind !== "branch-false") continue;
    const handleIndex = handleIndexById.get(event.variableId);
    if (handleIndex === undefined) {
      throw new TypeError(`memory null guard 引用了未知 handle：${event.variableId}`);
    }
    const nonNull = edgeKind === event.nonNullEdgeKind;
    output.handles[handleIndex] = refineHandle(output.handles[handleIndex]!, nonNull, event.id);
    if (output.handles[handleIndex]!.mask === 0) {
      return bottomFlow(output.handles.length);
    }
  }
  return output;
}

function refineHandle(
  input: MutableHandleState,
  nonNull: boolean,
  guardEventId: string,
): MutableHandleState {
  const output = emptyHandle();
  forEachState(input, (bit, eventIds) => {
    const lineage = withEvent(eventIds, guardEventId);
    if (bit === ESCAPED_BIT) {
      addState(output, ESCAPED_BIT, lineage);
      return;
    }
    if (bit === MAYBE_NULL_BIT) {
      addState(output, nonNull ? ALLOC_BIT : UNALLOC_NULL_BIT, lineage);
      return;
    }
    if (bit === UNALLOC_NULL_BIT) {
      if (!nonNull) addState(output, UNALLOC_NULL_BIT, lineage);
      return;
    }
    if (bit === UNALLOC_UNKNOWN_BIT) {
      addState(output, nonNull ? UNALLOC_UNKNOWN_BIT : UNALLOC_NULL_BIT, lineage);
      return;
    }
    if (bit === FREED_BIT || (nonNull && bit === ALLOC_BIT)) {
      addState(output, bit, lineage);
    }
  });
  return output;
}

function freezeNodeFact(
  nodeId: string,
  nodeRange: TextRange,
  handleVariableIds: readonly string[],
  input: FlowState,
  output: FlowState,
  events: readonly MemoryEvent[],
  handleIndexById: ReadonlyMap<string, number>,
  eventRank: ReadonlyMap<string, number>,
): MemoryTypestateFact {
  const handles = handleVariableIds.map((variableId, index): MemoryHandleTypestateFact =>
    Object.freeze({
      variableId,
      inStates: freezeHandleValues(input, index, eventRank),
      outStates: freezeHandleValues(output, index, eventRank),
    }),
  );
  const eventStates = events.map((event) => {
    const handleIndex = handleIndexById.get(event.variableId);
    if (handleIndex === undefined) {
      throw new TypeError(`memory typestate fact 引用了未知 handle：${event.variableId}`);
    }
    return Object.freeze({
      eventId: event.id,
      variableId: event.variableId,
      beforeStates: freezeHandleValues(input, handleIndex, eventRank),
    });
  });
  return Object.freeze({
    nodeId,
    nodeRange: Object.freeze({ ...nodeRange }),
    handles: Object.freeze(handles),
    events: Object.freeze(eventStates),
  });
}

function freezeEdgeFact(
  edge: CfgEdge,
  handleVariableIds: readonly string[],
  state: FlowState,
  eventRank: ReadonlyMap<string, number>,
): MemoryTypestateEdgeFact {
  const handles = handleVariableIds.map((variableId, index): MemoryHandleEdgeState =>
    Object.freeze({
      variableId,
      states: freezeHandleValues(state, index, eventRank),
    }),
  );
  return Object.freeze({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    feasible: state.feasible,
    handles: Object.freeze(handles),
  });
}

function freezeHandleValues(
  flow: FlowState,
  handleIndex: number,
  eventRank: ReadonlyMap<string, number>,
): readonly MemoryTypestateValue[] {
  if (!flow.feasible) return Object.freeze([]);
  const handle = flow.handles[handleIndex];
  if (handle === undefined) throw new TypeError("memory typestate handle index 越界");
  return Object.freeze(
    PUBLIC_STATE_ORDER.filter(([, bits]) => (handle.mask & bits) !== 0).map(([state, bits]) => {
      const eventIds = [...eventIdsForMask(handle, bits)].sort(
        (left, right) =>
          (eventRank.get(left) ?? Number.POSITIVE_INFINITY) -
            (eventRank.get(right) ?? Number.POSITIVE_INFINITY) || left.localeCompare(right),
      );
      return Object.freeze({ state, eventIds: Object.freeze(eventIds) });
    }),
  );
}

function buildEventRank(facts: readonly MemoryEventFact[]): ReadonlyMap<string, number> {
  const events = facts
    .flatMap((fact) => fact.events)
    .sort(
      (left, right) =>
        left.range.from - right.range.from ||
        left.range.to - right.range.to ||
        left.subjectRange.from - right.subjectRange.from ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );
  const rank = new Map<string, number>();
  events.forEach((event, index) => {
    if (rank.has(event.id)) throw new TypeError(`重复 memory event id：${event.id}`);
    rank.set(event.id, index);
  });
  return rank;
}

function initialFlow(handleCount: number): FlowState {
  return {
    feasible: true,
    handles: Array.from({ length: handleCount }, () => {
      const handle = emptyHandle();
      addState(handle, UNALLOC_UNKNOWN_BIT, new Set());
      return handle;
    }),
  };
}

function bottomFlow(handleCount: number): FlowState {
  return {
    feasible: false,
    handles: Array.from({ length: handleCount }, () => emptyHandle()),
  };
}

function cloneFlow(flow: FlowState): FlowState {
  return {
    feasible: flow.feasible,
    handles: flow.handles.map(cloneHandle),
  };
}

function joinFlowInto(target: FlowState, source: FlowState): void {
  if (!source.feasible) return;
  target.feasible = true;
  source.handles.forEach((handle, index) => {
    const output = target.handles[index];
    if (output === undefined) throw new TypeError("memory typestate join handle 数量不一致");
    forEachState(handle, (bit, eventIds) => addState(output, bit, eventIds));
  });
}

function flowsEqual(left: FlowState, right: FlowState): boolean {
  if (left.feasible !== right.feasible || left.handles.length !== right.handles.length)
    return false;
  return left.handles.every((handle, index) => handlesEqual(handle, right.handles[index]!));
}

function emptyHandle(): MutableHandleState {
  return {
    mask: 0,
    eventIdsByState: INTERNAL_STATE_BITS.map(() => new Set<string>()),
  };
}

function cloneHandle(input: MutableHandleState): MutableHandleState {
  return {
    mask: input.mask,
    eventIdsByState: input.eventIdsByState.map((eventIds) => new Set(eventIds)),
  };
}

function handlesEqual(left: MutableHandleState, right: MutableHandleState): boolean {
  if (left.mask !== right.mask) return false;
  return left.eventIdsByState.every((eventIds, index) =>
    setsEqual(eventIds, right.eventIdsByState[index]!),
  );
}

function forEachState(
  handle: MutableHandleState,
  visit: (bit: number, eventIds: ReadonlySet<string>) => void,
): void {
  for (const bit of INTERNAL_STATE_BITS) {
    if ((handle.mask & bit) === 0) continue;
    visit(bit, handle.eventIdsByState[stateIndexForBit(bit)]!);
  }
}

function addState(handle: MutableHandleState, bit: number, eventIds: ReadonlySet<string>): void {
  handle.mask |= bit;
  const target = handle.eventIdsByState[stateIndexForBit(bit)];
  if (target === undefined) throw new TypeError("memory typestate state bit 非法");
  for (const eventId of eventIds) target.add(eventId);
}

function allEventIds(handle: MutableHandleState): Set<string> {
  const output = new Set<string>();
  forEachState(handle, (_bit, eventIds) => {
    for (const eventId of eventIds) output.add(eventId);
  });
  return output;
}

function eventIdsForMask(handle: MutableHandleState, mask: number): Set<string> {
  const output = new Set<string>();
  for (const bit of INTERNAL_STATE_BITS) {
    if ((mask & bit) === 0 || (handle.mask & bit) === 0) continue;
    for (const eventId of handle.eventIdsByState[stateIndexForBit(bit)]!) output.add(eventId);
  }
  return output;
}

function withEvent(eventIds: ReadonlySet<string>, eventId: string): Set<string> {
  return new Set([...eventIds, eventId]);
}

function stateIndexForBit(bit: number): number {
  const index = STATE_INDEX_BY_BIT.get(bit);
  if (index === undefined) throw new TypeError(`memory typestate bit 非法：${String(bit)}`);
  return index;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function freezeFunctionMemoryTypestate(
  input: FunctionMemoryTypestateInput,
  disabledReasons: FunctionMemoryTypestate["disabledReasons"],
  handleVariableIds: readonly string[],
  facts: FunctionMemoryTypestate["facts"],
  edgeFacts: FunctionMemoryTypestate["edgeFacts"],
): FunctionMemoryTypestate {
  return Object.freeze({
    functionId: input.cfg.id,
    functionRange: Object.freeze({ ...input.cfg.range }),
    status: disabledReasons.length === 0 ? "complete" : "disabled",
    disabledReasons: Object.freeze([...disabledReasons]),
    handleVariableIds: Object.freeze([...handleVariableIds]),
    facts: Object.freeze([...facts]),
    edgeFacts: Object.freeze([...edgeFacts]),
  });
}

function assertAlignedInput(input: FunctionMemoryTypestateInput): void {
  if (
    input.memoryEvents.functionId !== input.cfg.id ||
    input.memoryEvents.functionRange.from !== input.cfg.range.from ||
    input.memoryEvents.functionRange.to !== input.cfg.range.to
  ) {
    throw new TypeError("memory typestate function 与 memory events 未对齐");
  }
  if (input.memoryEvents.status === "disabled") {
    if (
      input.memoryEvents.facts.length !== 0 ||
      input.memoryEvents.handleVariableIds.length !== 0
    ) {
      throw new TypeError("disabled memory events 必须为空");
    }
    return;
  }
  if (input.memoryEvents.facts.length !== input.cfg.nodes.length) {
    throw new TypeError("memory typestate 要求 CFG nodes 与 memory event facts 一一对应");
  }
  input.cfg.nodes.forEach((node, index) => {
    const fact = input.memoryEvents.facts[index];
    if (
      fact === undefined ||
      fact.nodeId !== node.id ||
      fact.nodeRange.from !== node.range.from ||
      fact.nodeRange.to !== node.range.to
    ) {
      throw new TypeError(`memory typestate 节点对齐失败：${node.id}`);
    }
  });
}
