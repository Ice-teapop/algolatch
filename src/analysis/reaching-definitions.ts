import type {
  DefUseDefinitionEffect,
  DefUseEffect,
  DefUseFact,
  FunctionCfg,
  ReachingDefinitionFact,
  ReachingDefinitionUse,
} from "./model.js";

interface DefinitionUniverse {
  readonly definitions: readonly DefUseDefinitionEffect[];
  readonly indexByEffectId: ReadonlyMap<string, number>;
  readonly indicesByVariableId: ReadonlyMap<string, readonly number[]>;
  readonly variableIds: readonly string[];
  readonly variableIndexById: ReadonlyMap<string, number>;
}

interface FlowState {
  readonly definitions: Uint32Array;
  readonly escapedVariables: Uint32Array;
}

export interface ReachingDefinitionInput {
  readonly cfg: FunctionCfg;
  readonly facts: readonly DefUseFact[];
}

export function collectReachingDefinitions(
  input: ReachingDefinitionInput,
): readonly ReachingDefinitionFact[] {
  assertAlignedInput(input);
  const universe = buildDefinitionUniverse(input.facts);
  const definitionWordCount = Math.ceil(universe.definitions.length / 32);
  const variableWordCount = Math.ceil(universe.variableIds.length / 32);
  const nodesById = new Map(input.cfg.nodes.map((node, index) => [node.id, index]));
  const successors = input.cfg.nodes.map((): number[] => []);
  const predecessors = input.cfg.nodes.map((): number[] => []);
  for (const edge of input.cfg.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (from === undefined || to === undefined) throw new TypeError("CFG edge 引用了未知节点");
    if (!successors[from]!.includes(to)) successors[from]!.push(to);
    if (!predecessors[to]!.includes(from)) predecessors[to]!.push(from);
  }

  const inStates = input.cfg.nodes.map(() => emptyState(definitionWordCount, variableWordCount));
  const outStates = input.cfg.nodes.map(() => emptyState(definitionWordCount, variableWordCount));
  const entryIndex = nodesById.get(input.cfg.entryId);
  if (entryIndex === undefined) throw new TypeError("CFG 缺少 entry 节点");
  const queue = [entryIndex];
  const queued = new Set(queue);
  const processed = new Set<number>();
  while (queue.length > 0) {
    const nodeIndex = queue.shift();
    if (nodeIndex === undefined) break;
    queued.delete(nodeIndex);
    const node = input.cfg.nodes[nodeIndex];
    const fact = input.facts[nodeIndex];
    if (node === undefined || fact === undefined || !node.reachable) continue;
    const nextIn = emptyState(definitionWordCount, variableWordCount);
    for (const predecessor of predecessors[nodeIndex] ?? []) {
      unionStateInto(nextIn, outStates[predecessor]!);
    }
    suppressEscapedDefinitions(nextIn, universe);
    const nextOut = transferState(nextIn, fact.effects, universe);
    const changed =
      !statesEqual(inStates[nodeIndex]!, nextIn) || !statesEqual(outStates[nodeIndex]!, nextOut);
    if (!changed && processed.has(nodeIndex)) continue;
    processed.add(nodeIndex);
    inStates[nodeIndex] = nextIn;
    outStates[nodeIndex] = nextOut;
    for (const successor of successors[nodeIndex] ?? []) {
      if (!input.cfg.nodes[successor]?.reachable || queued.has(successor)) continue;
      queue.push(successor);
      queued.add(successor);
    }
  }

  return Object.freeze(
    input.cfg.nodes.map((node, index) => {
      const fact = input.facts[index]!;
      const reachable = node.reachable;
      const inputState = reachable
        ? inStates[index]!
        : emptyState(definitionWordCount, variableWordCount);
      const outputState = reachable
        ? outStates[index]!
        : emptyState(definitionWordCount, variableWordCount);
      const uses = reachable
        ? resolveUses(inputState, fact.effects, universe)
        : fact.effects
            .filter((effect) => effect.kind === "use")
            .map((effect): ReachingDefinitionUse =>
              Object.freeze({
                useEffectId: effect.id,
                availability: "unreachable",
                definitionEffectIds: Object.freeze([]),
              }),
            );
      return Object.freeze({
        nodeId: node.id,
        nodeRange: node.range,
        inDefinitionEffectIds: freezeDefinitionIds(inputState.definitions, universe),
        outDefinitionEffectIds: freezeDefinitionIds(outputState.definitions, universe),
        inEscapedVariableIds: freezeVariableIds(inputState.escapedVariables, universe),
        outEscapedVariableIds: freezeVariableIds(outputState.escapedVariables, universe),
        uses: Object.freeze(uses),
      });
    }),
  );
}

function buildDefinitionUniverse(facts: readonly DefUseFact[]): DefinitionUniverse {
  const variableIds = [
    ...new Set(facts.flatMap((fact) => fact.effects.map((effect) => effect.variableId))),
  ];
  const definitions = facts.flatMap((fact) =>
    fact.effects.filter((effect): effect is DefUseDefinitionEffect => effect.kind === "def"),
  );
  const indexByEffectId = new Map<string, number>();
  const indicesByVariableId = new Map<string, number[]>();
  definitions.forEach((definition, index) => {
    if (indexByEffectId.has(definition.id))
      throw new TypeError(`重复 definition effect id：${definition.id}`);
    indexByEffectId.set(definition.id, index);
    const indices = indicesByVariableId.get(definition.variableId) ?? [];
    indices.push(index);
    indicesByVariableId.set(definition.variableId, indices);
  });
  return {
    definitions,
    indexByEffectId,
    indicesByVariableId,
    variableIds,
    variableIndexById: new Map(variableIds.map((variableId, index) => [variableId, index])),
  };
}

function transferState(
  input: FlowState,
  effects: readonly DefUseEffect[],
  universe: DefinitionUniverse,
): FlowState {
  const output = cloneState(input);
  for (const effect of effects) {
    if (effect.kind === "escape") {
      markEscaped(output, effect.variableId, universe);
      continue;
    }
    if (effect.kind !== "def" || isEscaped(output, effect.variableId, universe)) continue;
    if (effect.strength === "strong") {
      clearVariable(output.definitions, effect.variableId, universe);
    }
    const index = universe.indexByEffectId.get(effect.id);
    if (index === undefined) throw new TypeError(`definition effect 未进入 universe：${effect.id}`);
    addBit(output.definitions, index);
  }
  return output;
}

function resolveUses(
  input: FlowState,
  effects: readonly DefUseEffect[],
  universe: DefinitionUniverse,
): readonly ReachingDefinitionUse[] {
  const state = cloneState(input);
  const output: ReachingDefinitionUse[] = [];
  for (const effect of effects) {
    if (effect.kind === "use") {
      const escaped = isEscaped(state, effect.variableId, universe);
      const definitionEffectIds = escaped
        ? []
        : (universe.indicesByVariableId.get(effect.variableId) ?? [])
            .filter((index) => hasBit(state.definitions, index))
            .map((index) => universe.definitions[index]!.id);
      output.push(
        Object.freeze({
          useEffectId: effect.id,
          availability: escaped ? "escaped" : "tracked",
          definitionEffectIds: Object.freeze(definitionEffectIds),
        }),
      );
      continue;
    }
    if (effect.kind === "escape") {
      markEscaped(state, effect.variableId, universe);
      continue;
    }
    if (effect.kind !== "def" || isEscaped(state, effect.variableId, universe)) continue;
    if (effect.strength === "strong") {
      clearVariable(state.definitions, effect.variableId, universe);
    }
    const index = universe.indexByEffectId.get(effect.id);
    if (index === undefined) throw new TypeError(`definition effect 未进入 universe：${effect.id}`);
    addBit(state.definitions, index);
  }
  return Object.freeze(output);
}

function clearVariable(bits: Uint32Array, variableId: string, universe: DefinitionUniverse): void {
  for (const index of universe.indicesByVariableId.get(variableId) ?? []) clearBit(bits, index);
}

function markEscaped(state: FlowState, variableId: string, universe: DefinitionUniverse): void {
  const variableIndex = universe.variableIndexById.get(variableId);
  if (variableIndex === undefined) throw new TypeError(`escape 引用了未知变量：${variableId}`);
  addBit(state.escapedVariables, variableIndex);
  clearVariable(state.definitions, variableId, universe);
}

function isEscaped(state: FlowState, variableId: string, universe: DefinitionUniverse): boolean {
  const variableIndex = universe.variableIndexById.get(variableId);
  if (variableIndex === undefined) throw new TypeError(`effect 引用了未知变量：${variableId}`);
  return hasBit(state.escapedVariables, variableIndex);
}

function suppressEscapedDefinitions(state: FlowState, universe: DefinitionUniverse): void {
  universe.variableIds.forEach((variableId, index) => {
    if (hasBit(state.escapedVariables, index)) {
      clearVariable(state.definitions, variableId, universe);
    }
  });
}

function freezeDefinitionIds(bits: Uint32Array, universe: DefinitionUniverse): readonly string[] {
  return Object.freeze(
    universe.definitions
      .filter((_definition, index) => hasBit(bits, index))
      .map((definition) => definition.id),
  );
}

function freezeVariableIds(bits: Uint32Array, universe: DefinitionUniverse): readonly string[] {
  return Object.freeze(universe.variableIds.filter((_variableId, index) => hasBit(bits, index)));
}

function emptyState(definitionWordCount: number, variableWordCount: number): FlowState {
  return {
    definitions: emptyBits(definitionWordCount),
    escapedVariables: emptyBits(variableWordCount),
  };
}

function cloneState(state: FlowState): FlowState {
  return {
    definitions: state.definitions.slice(),
    escapedVariables: state.escapedVariables.slice(),
  };
}

function unionStateInto(target: FlowState, source: FlowState): void {
  unionInto(target.definitions, source.definitions);
  unionInto(target.escapedVariables, source.escapedVariables);
}

function statesEqual(left: FlowState, right: FlowState): boolean {
  return (
    bitsEqual(left.definitions, right.definitions) &&
    bitsEqual(left.escapedVariables, right.escapedVariables)
  );
}

function emptyBits(wordCount: number): Uint32Array {
  return new Uint32Array(wordCount);
}

function addBit(bits: Uint32Array, index: number): void {
  bits[index >>> 5] = (bits[index >>> 5] ?? 0) | (1 << (index & 31));
}

function clearBit(bits: Uint32Array, index: number): void {
  bits[index >>> 5] = (bits[index >>> 5] ?? 0) & ~(1 << (index & 31));
}

function hasBit(bits: Uint32Array, index: number): boolean {
  return ((bits[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

function unionInto(target: Uint32Array, source: Uint32Array): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) | (source[index] ?? 0);
  }
}

function bitsEqual(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assertAlignedInput(input: ReachingDefinitionInput): void {
  if (input.cfg.nodes.length !== input.facts.length) {
    throw new TypeError("reaching definitions 要求 CFG nodes 与 def-use facts 一一对应");
  }
  input.cfg.nodes.forEach((node, index) => {
    const fact = input.facts[index];
    if (
      fact === undefined ||
      fact.nodeId !== node.id ||
      fact.nodeRange.from !== node.range.from ||
      fact.nodeRange.to !== node.range.to
    ) {
      throw new TypeError(`reaching definitions 节点对齐失败：${node.id}`);
    }
  });
}
