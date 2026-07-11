import type { Node } from "web-tree-sitter";
import { textRange, type SourceDoc, type TextRange } from "../core/model.js";
import {
  buildFunctionVariableBindings,
  type FunctionVariableBindings,
} from "./function-bindings.js";
import type {
  CfgNode,
  DefUseVariable,
  FunctionCfg,
  FunctionDefUse,
  FunctionMemoryEvents,
  MemoryAllocationEvent,
  MemoryAllocationSizeForm,
  MemoryDereferenceEvent,
  MemoryEscapeEvent,
  MemoryEvent,
  MemoryEventDisabledReasonCode,
  MemoryEventExecution,
  MemoryFreeEvent,
  MemoryNullAssignmentEvent,
  MemoryNullGuardEvent,
} from "./model.js";

export interface FunctionMemoryEventsInput {
  readonly functionNode: Node;
  readonly cfg: FunctionCfg;
  readonly defUse: FunctionDefUse;
  readonly document: SourceDoc;
}

interface AllocationSeed {
  readonly allocator: "malloc" | "calloc";
  readonly call: Node;
  readonly arguments: readonly Node[];
  readonly subject: Node;
  readonly variable: DefUseVariable;
}

interface OwnedEvent {
  readonly nodeId: string;
  readonly event: MemoryEvent;
}

interface EventCollection {
  readonly events: OwnedEvent[];
  readonly claimedSubjectRanges: Set<string>;
  readonly blockers: Set<MemoryEventDisabledReasonCode>;
  readonly ownerIndex: CfgOwnerIndex;
  readonly branchNodeIds: ReadonlySet<string>;
  readonly falseExitNodeIds: ReadonlySet<string>;
}

interface IndexedCfgOwner {
  readonly node: CfgNode;
  readonly originalOrder: number;
}

interface CfgOwnerIndex {
  readonly candidates: readonly IndexedCfgOwner[];
  readonly leafCount: number;
  readonly maxEnds: readonly number[];
}

interface EvaluationSuppression {
  readonly kind: "never" | "ambiguous";
  readonly operation: Node;
}

interface GuardShape {
  readonly subject: Node;
  readonly variable: DefUseVariable;
  readonly nonNullEdgeKind: "branch-true" | "branch-false";
  readonly form: MemoryNullGuardEvent["form"];
}

const MEMORY_REASON_ORDER = Object.freeze([
  "cfg-partial",
  "invalid-function-cst",
  "parse-error",
  "preprocessor",
  "projection-issue",
  "parse-concern",
  "raw-block",
  "missing-function-projection",
  "effect-cst-mismatch",
  "unsequenced-conflict",
  "unsupported-effect-order",
  "opaque-alias-effect",
  "memory-cst-mismatch",
  "unsupported-memory-effect-order",
] as const satisfies readonly MemoryEventDisabledReasonCode[]);
const NEVER_EVALUATED_BUILTIN_CALLS = new Set([
  "__builtin_classify_type",
  "__builtin_constant_p",
  "__builtin_object_size",
]);
const EXPLICIT_HANDLE_BASE_TYPES = new Set([
  "primitive_type",
  "sized_type_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
]);

/**
 * Extracts conservative syntax facts for direct unique allocation handles.
 * This layer deliberately does not solve typestate or publish findings.
 */
export function collectFunctionMemoryEvents(
  input: FunctionMemoryEventsInput,
): FunctionMemoryEvents {
  if (input.defUse.status === "disabled") {
    return freezeFunctionMemoryEvents(input, input.defUse.disabledReasons, [], []);
  }
  const bindings = buildFunctionVariableBindings({
    document: input.document,
    functionRange: input.cfg.range,
    variables: input.defUse.variables,
    functionNode: input.functionNode,
  });
  const collection: EventCollection = {
    events: [],
    claimedSubjectRanges: new Set(),
    blockers: new Set(),
    ownerIndex: buildCfgOwnerIndex(input.cfg),
    branchNodeIds: collectBranchNodeIds(input.cfg),
    falseExitNodeIds: collectFalseExitNodeIds(input.cfg),
  };
  const seeds = collectAllocationSeeds(input, bindings, collection.blockers);
  const handleVariables = uniqueVariables(seeds.map((seed) => seed.variable));
  const handlesById = new Map(handleVariables.map((variable) => [variable.id, variable]));
  const repeatableNodeIds = new Set(input.defUse.loopRegions.flatMap((loop) => loop.nodeIds));

  for (const seed of seeds) {
    addAllocationEvent(input, bindings, collection, seed, repeatableNodeIds);
  }
  collectNullAssignments(input, bindings, handlesById, collection, repeatableNodeIds);
  collectReallocationEscapes(input, bindings, handlesById, collection, repeatableNodeIds);
  collectFreeEvents(input, bindings, handlesById, collection, repeatableNodeIds);
  collectGuardEvents(input, bindings, handlesById, collection, repeatableNodeIds);
  collectDereferenceEvents(input, bindings, handlesById, collection, repeatableNodeIds);
  collectFallbackEscapes(input, bindings, handlesById, collection, repeatableNodeIds);

  const events = deduplicateEvents(collection.events).sort(compareOwnedEvents);
  enforceSupportedEventOrder(events, collection.blockers);
  const disabledReasons = MEMORY_REASON_ORDER.filter((reason) => collection.blockers.has(reason));
  if (disabledReasons.length > 0) {
    return freezeFunctionMemoryEvents(input, disabledReasons, [], []);
  }
  const eventsByNode = new Map<string, MemoryEvent[]>();
  for (const owned of events) {
    const existing = eventsByNode.get(owned.nodeId) ?? [];
    existing.push(owned.event);
    eventsByNode.set(owned.nodeId, existing);
  }
  const facts = input.cfg.nodes.map((node) =>
    Object.freeze({
      nodeId: node.id,
      nodeRange: Object.freeze({ ...node.range }),
      events: Object.freeze(eventsByNode.get(node.id) ?? []),
    }),
  );
  return freezeFunctionMemoryEvents(
    input,
    [],
    handleVariables.map((variable) => variable.id),
    facts,
  );
}

function collectAllocationSeeds(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  blockers: Set<MemoryEventDisabledReasonCode>,
): AllocationSeed[] {
  const seeds: AllocationSeed[] = [];
  for (const call of input.functionNode.descendantsOfType("call_expression")) {
    if (!belongsToFunction(call, input.functionNode) || hasUnevaluatedAncestor(call)) continue;
    const allocator = directBuiltinCallName(call, bindings, ["malloc", "calloc"]);
    if (allocator !== "malloc" && allocator !== "calloc") continue;
    const argumentsNode = call.childForFieldName("arguments");
    const argumentsList = argumentsNode === null ? [] : namedChildren(argumentsNode);
    const unsupportedTarget = resultTarget(call, bindings, false, true);
    if (argumentsList.length !== (allocator === "malloc" ? 1 : 2)) {
      if (
        unsupportedTarget !== null &&
        isUniqueHandleCandidate(unsupportedTarget.variable, unsupportedTarget.node, bindings)
      ) {
        blockers.add("unsupported-memory-effect-order");
      }
      continue;
    }
    const target = resultTarget(call, bindings);
    if (target === null) {
      if (
        unsupportedTarget !== null &&
        isUniqueHandleCandidate(unsupportedTarget.variable, unsupportedTarget.node, bindings)
      ) {
        blockers.add("unsupported-memory-effect-order");
      }
      continue;
    }
    if (!isUniqueHandleCandidate(target.variable, target.node, bindings)) {
      continue;
    }
    seeds.push(
      Object.freeze({
        allocator,
        call,
        arguments: Object.freeze(argumentsList),
        subject: target.node,
        variable: target.variable,
      }),
    );
  }
  return seeds.sort(
    (left, right) =>
      left.call.startIndex - right.call.startIndex ||
      left.call.endIndex - right.call.endIndex ||
      left.variable.id.localeCompare(right.variable.id),
  );
}

function addAllocationEvent(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  collection: EventCollection,
  seed: AllocationSeed,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const range = checkedNodeRange(seed.call, input.document.source.length);
  const subjectRange = checkedNodeRange(seed.subject, input.document.source.length);
  const owner = smallestOwningCfgNode(collection.ownerIndex, range);
  if (owner === null) {
    collection.blockers.add("memory-cst-mismatch");
    return;
  }
  collection.claimedSubjectRanges.add(rangeKey(subjectRange));
  const event: MemoryAllocationEvent = Object.freeze({
    ...eventBase(
      "allocation",
      seed.variable,
      range,
      subjectRange,
      seed.call,
      owner.id,
      repeatableNodeIds,
    ),
    kind: "allocation",
    allocator: seed.allocator,
    argumentRanges: Object.freeze(
      seed.arguments.map((argument) =>
        Object.freeze({ ...checkedNodeRange(argument, input.document.source.length) }),
      ),
    ),
    sizeForm: allocationSizeForm(seed, bindings, seed.variable),
  });
  collection.events.push(Object.freeze({ nodeId: owner.id, event }));
}

function collectNullAssignments(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  for (const assignment of input.functionNode.descendantsOfType("assignment_expression")) {
    if (!belongsToFunction(assignment, input.functionNode) || hasUnevaluatedAncestor(assignment)) {
      continue;
    }
    const operator = assignment.childForFieldName("operator")?.text;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    const target = left === null ? null : directHandle(left, bindings, handlesById);
    if (operator !== "=" || target === null || right === null || !isNullConstant(right, bindings)) {
      continue;
    }
    addNullAssignmentEvent(
      input,
      collection,
      target.variable,
      target.node,
      assignment,
      right,
      repeatableNodeIds,
    );
  }
  for (const variable of handlesById.values()) {
    const declarationRange = variable.declarationRanges[0];
    const nameNode =
      declarationRange === undefined
        ? undefined
        : bindings.declarationNodeByRange.get(rangeKey(declarationRange));
    if (nameNode === undefined) continue;
    const declaration = nearestDeclaration(nameNode);
    const initializer = declaration === null ? null : nearestInitializer(nameNode, declaration);
    if (initializer === null || !isNullConstant(initializer, bindings)) continue;
    const operation = nearestAncestorOfType(nameNode, "init_declarator") ?? declaration;
    if (operation === null) continue;
    addNullAssignmentEvent(
      input,
      collection,
      variable,
      nameNode,
      operation,
      initializer,
      repeatableNodeIds,
    );
  }
}

function addNullAssignmentEvent(
  input: FunctionMemoryEventsInput,
  collection: EventCollection,
  variable: DefUseVariable,
  subject: Node,
  operation: Node,
  value: Node,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const range = checkedNodeRange(operation, input.document.source.length);
  const subjectRange = checkedNodeRange(subject, input.document.source.length);
  const owner = smallestOwningCfgNode(collection.ownerIndex, range);
  if (owner === null) {
    collection.blockers.add("memory-cst-mismatch");
    return;
  }
  collection.claimedSubjectRanges.add(rangeKey(subjectRange));
  const event: MemoryNullAssignmentEvent = Object.freeze({
    ...eventBase(
      "null-assignment",
      variable,
      range,
      subjectRange,
      operation,
      owner.id,
      repeatableNodeIds,
    ),
    kind: "null-assignment",
    valueRange: Object.freeze({ ...checkedNodeRange(value, input.document.source.length) }),
  });
  collection.events.push(Object.freeze({ nodeId: owner.id, event }));
}

function collectReallocationEscapes(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  for (const call of input.functionNode.descendantsOfType("call_expression")) {
    if (
      !belongsToFunction(call, input.functionNode) ||
      hasUnevaluatedAncestor(call) ||
      directBuiltinCallName(call, bindings, ["realloc"]) !== "realloc"
    ) {
      continue;
    }
    const argumentsNode = call.childForFieldName("arguments");
    const argumentsList = argumentsNode === null ? [] : namedChildren(argumentsNode);
    if (argumentsList.length !== 2) continue;
    const subjects: Array<{ readonly variable: DefUseVariable; readonly node: Node }> = [];
    const argument = directHandle(argumentsList[0]!, bindings, handlesById);
    if (argument !== null) subjects.push(argument);
    const target = resultTarget(call, bindings);
    if (target !== null && handlesById.has(target.variable.id)) subjects.push(target);
    const unique = uniqueSubjects(subjects);
    for (const subject of subjects) {
      collection.claimedSubjectRanges.add(
        rangeKey(checkedNodeRange(subject.node, input.document.source.length)),
      );
    }
    for (const subject of unique) {
      addEscapeEvent(
        input,
        collection,
        subject.variable,
        subject.node,
        call,
        "unsupported-reallocation",
        repeatableNodeIds,
      );
    }
  }
}

function collectFreeEvents(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  for (const call of input.functionNode.descendantsOfType("call_expression")) {
    if (
      !belongsToFunction(call, input.functionNode) ||
      hasUnevaluatedAncestor(call) ||
      directBuiltinCallName(call, bindings, ["free"]) !== "free"
    ) {
      continue;
    }
    const argumentsNode = call.childForFieldName("arguments");
    const argumentsList = argumentsNode === null ? [] : namedChildren(argumentsNode);
    if (argumentsList.length !== 1) continue;
    const argumentNode = argumentsList[0]!;
    if (isNullConstant(argumentNode, bindings)) continue;
    const subject = directHandle(argumentNode, bindings, handlesById);
    if (subject === null) continue;
    const range = checkedNodeRange(call, input.document.source.length);
    const subjectRange = checkedNodeRange(subject.node, input.document.source.length);
    const owner = smallestOwningCfgNode(collection.ownerIndex, range);
    if (owner === null) {
      collection.blockers.add("memory-cst-mismatch");
      continue;
    }
    collection.claimedSubjectRanges.add(rangeKey(subjectRange));
    const event: MemoryFreeEvent = Object.freeze({
      ...eventBase(
        "free",
        subject.variable,
        range,
        subjectRange,
        call,
        owner.id,
        repeatableNodeIds,
      ),
      kind: "free",
    });
    collection.events.push(Object.freeze({ nodeId: owner.id, event }));
  }
}

function collectGuardEvents(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const controls = ["if_statement", "while_statement", "for_statement", "do_statement"].flatMap(
    (type) => input.functionNode.descendantsOfType(type),
  );
  for (const control of controls) {
    if (!belongsToFunction(control, input.functionNode)) continue;
    const condition = control.childForFieldName("condition");
    if (condition === null) continue;
    const shape = directGuardShape(condition, bindings, handlesById);
    if (shape === null) continue;
    addGuardEvent(input, collection, shape, condition, condition, repeatableNodeIds);
  }
  for (const call of input.functionNode.descendantsOfType("call_expression")) {
    if (!belongsToFunction(call, input.functionNode)) continue;
    const callee = unwrapParentheses(call.childForFieldName("function") ?? call);
    if (callee.type !== "identifier" || callee.text !== "assert") continue;
    const range = checkedNodeRange(call, input.document.source.length);
    const owner = smallestOwningCfgNode(collection.ownerIndex, range);
    if (
      owner === null ||
      !collection.branchNodeIds.has(owner.id) ||
      !collection.falseExitNodeIds.has(owner.id) ||
      !isDirectAssertOwner(call, owner, input.document.source.length)
    ) {
      continue;
    }
    const argumentsNode = call.childForFieldName("arguments");
    const argumentsList = argumentsNode === null ? [] : namedChildren(argumentsNode);
    if (argumentsList.length !== 1) continue;
    const shape = directGuardShape(argumentsList[0]!, bindings, handlesById);
    if (shape === null) continue;
    addGuardEvent(
      input,
      collection,
      {
        subject: shape.subject,
        variable: shape.variable,
        nonNullEdgeKind: shape.nonNullEdgeKind,
        form: "assert",
      },
      call,
      call,
      repeatableNodeIds,
    );
  }
}

function addGuardEvent(
  input: FunctionMemoryEventsInput,
  collection: EventCollection,
  shape: GuardShape,
  operation: Node,
  executionNode: Node,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const range = checkedNodeRange(operation, input.document.source.length);
  const subjectRange = checkedNodeRange(shape.subject, input.document.source.length);
  const owner = smallestOwningCfgNode(collection.ownerIndex, range);
  if (owner === null) {
    collection.blockers.add("memory-cst-mismatch");
    return;
  }
  collection.claimedSubjectRanges.add(rangeKey(subjectRange));
  const event: MemoryNullGuardEvent = Object.freeze({
    ...eventBase(
      "null-guard",
      shape.variable,
      range,
      subjectRange,
      executionNode,
      owner.id,
      repeatableNodeIds,
    ),
    kind: "null-guard",
    nonNullEdgeKind: shape.nonNullEdgeKind,
    form: shape.form,
  });
  collection.events.push(Object.freeze({ nodeId: owner.id, event }));
}

function collectDereferenceEvents(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  for (const pointer of input.functionNode.descendantsOfType("pointer_expression")) {
    if (
      !belongsToFunction(pointer, input.functionNode) ||
      pointer.childForFieldName("operator")?.text !== "*" ||
      hasUnevaluatedAncestor(pointer) ||
      isDirectlyAddressed(pointer)
    ) {
      continue;
    }
    const argument = pointer.childForFieldName("argument");
    const subject = argument === null ? null : pointerRootHandle(argument, bindings, handlesById);
    if (subject === null) continue;
    addDereferenceEvent(
      input,
      collection,
      subject.variable,
      subject.node,
      pointer,
      "indirection",
      repeatableNodeIds,
    );
    addDerivedValueEscape(
      input,
      collection,
      subject.variable,
      subject.node,
      pointer,
      false,
      repeatableNodeIds,
    );
  }
  for (const subscript of input.functionNode.descendantsOfType("subscript_expression")) {
    if (
      !belongsToFunction(subscript, input.functionNode) ||
      hasUnevaluatedAncestor(subscript) ||
      isDirectlyAddressed(subscript)
    ) {
      continue;
    }
    const argument = subscript.childForFieldName("argument");
    const index = subscript.childForFieldName("index");
    if (argument === null || index === null) continue;
    const subjects = [
      directHandle(argument, bindings, handlesById),
      directHandle(index, bindings, handlesById),
    ].filter((subject): subject is NonNullable<typeof subject> => subject !== null);
    if (subjects.length !== 1) continue;
    addDereferenceEvent(
      input,
      collection,
      subjects[0]!.variable,
      subjects[0]!.node,
      subscript,
      "subscript",
      repeatableNodeIds,
    );
    addDerivedValueEscape(
      input,
      collection,
      subjects[0]!.variable,
      subjects[0]!.node,
      subscript,
      false,
      repeatableNodeIds,
    );
  }
  for (const field of input.functionNode.descendantsOfType("field_expression")) {
    if (
      !belongsToFunction(field, input.functionNode) ||
      field.childForFieldName("operator")?.text !== "->" ||
      hasUnevaluatedAncestor(field)
    ) {
      continue;
    }
    const argument = field.childForFieldName("argument");
    const subject = argument === null ? null : directHandle(argument, bindings, handlesById);
    if (subject === null) continue;
    addDereferenceEvent(
      input,
      collection,
      subject.variable,
      subject.node,
      field,
      "arrow",
      repeatableNodeIds,
    );
    addDerivedValueEscape(
      input,
      collection,
      subject.variable,
      subject.node,
      field,
      true,
      repeatableNodeIds,
    );
  }
}

function addDerivedValueEscape(
  input: FunctionMemoryEventsInput,
  collection: EventCollection,
  variable: DefUseVariable,
  subject: Node,
  dereference: Node,
  includeDereference: boolean,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const projection = outermostMemberProjection(dereference, includeDereference);
  if (projection === null) return;
  const context = derivedValueEscapeContext(projection);
  if (context === null) return;
  addEscapeEvent(
    input,
    collection,
    variable,
    subject,
    context.operation,
    context.origin,
    repeatableNodeIds,
  );
}

function outermostMemberProjection(node: Node, includeNode: boolean): Node | null {
  let current = node;
  let found = includeNode;
  while (true) {
    while (current.parent?.type === "parenthesized_expression") current = current.parent;
    const parent = current.parent;
    if (
      parent?.type !== "field_expression" ||
      parent.childForFieldName("operator")?.text !== "." ||
      parent.childForFieldName("argument")?.id !== current.id
    ) {
      return found ? current : null;
    }
    current = parent;
    found = true;
  }
}

function addDereferenceEvent(
  input: FunctionMemoryEventsInput,
  collection: EventCollection,
  variable: DefUseVariable,
  subject: Node,
  operation: Node,
  form: MemoryDereferenceEvent["form"],
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const range = checkedNodeRange(operation, input.document.source.length);
  const subjectRange = checkedNodeRange(subject, input.document.source.length);
  const owner = smallestOwningCfgNode(collection.ownerIndex, range);
  if (owner === null) {
    collection.blockers.add("memory-cst-mismatch");
    return;
  }
  collection.claimedSubjectRanges.add(rangeKey(subjectRange));
  const event: MemoryDereferenceEvent = Object.freeze({
    ...eventBase(
      "dereference",
      variable,
      range,
      subjectRange,
      operation,
      owner.id,
      repeatableNodeIds,
    ),
    kind: "dereference",
    form,
  });
  collection.events.push(Object.freeze({ nodeId: owner.id, event }));
}

function collectFallbackEscapes(
  input: FunctionMemoryEventsInput,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
  collection: EventCollection,
  repeatableNodeIds: ReadonlySet<string>,
): void {
  for (const identifier of input.functionNode.descendantsOfType("identifier")) {
    if (!belongsToFunction(identifier, input.functionNode)) continue;
    const subjectRange = checkedNodeRange(identifier, input.document.source.length);
    const variable = bindings.variableByOccurrenceRange.get(rangeKey(subjectRange));
    if (variable === undefined || !handlesById.has(variable.id)) continue;
    if (variable.declarationRanges.some((range) => sameRange(range, subjectRange))) continue;
    if (collection.claimedSubjectRanges.has(rangeKey(subjectRange))) continue;
    const suppression = evaluationSuppression(identifier);
    if (suppression?.kind === "never") continue;
    if (suppression?.kind === "ambiguous") {
      addEscapeEvent(
        input,
        collection,
        variable,
        identifier,
        suppression.operation,
        "unsupported-use",
        repeatableNodeIds,
      );
      continue;
    }
    if (isBenignPointerObservation(identifier) || isDiscardedPointerObservation(identifier)) {
      continue;
    }
    const context = escapeContext(identifier);
    addEscapeEvent(
      input,
      collection,
      variable,
      identifier,
      context.operation,
      context.origin,
      repeatableNodeIds,
    );
  }
}

function addEscapeEvent(
  input: FunctionMemoryEventsInput,
  collection: EventCollection,
  variable: DefUseVariable,
  subject: Node,
  operation: Node,
  origin: MemoryEscapeEvent["origin"],
  repeatableNodeIds: ReadonlySet<string>,
): void {
  const range = checkedNodeRange(operation, input.document.source.length);
  const subjectRange = checkedNodeRange(subject, input.document.source.length);
  const owner = smallestOwningCfgNode(collection.ownerIndex, range);
  if (owner === null) {
    collection.blockers.add("memory-cst-mismatch");
    return;
  }
  collection.claimedSubjectRanges.add(rangeKey(subjectRange));
  const event: MemoryEscapeEvent = Object.freeze({
    ...eventBase("escape", variable, range, subjectRange, operation, owner.id, repeatableNodeIds),
    kind: "escape",
    origin,
  });
  collection.events.push(Object.freeze({ nodeId: owner.id, event }));
}

function directGuardShape(
  condition: Node,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
): GuardShape | null {
  const candidate = unwrapParentheses(condition);
  const truthy = directHandle(candidate, bindings, handlesById);
  if (truthy !== null) {
    return {
      subject: truthy.node,
      variable: truthy.variable,
      nonNullEdgeKind: "branch-true",
      form: "truthy",
    };
  }
  if (
    candidate.type === "unary_expression" &&
    candidate.childForFieldName("operator")?.text === "!"
  ) {
    const argument = candidate.childForFieldName("argument");
    const subject = argument === null ? null : directHandle(argument, bindings, handlesById);
    return subject === null
      ? null
      : {
          subject: subject.node,
          variable: subject.variable,
          nonNullEdgeKind: "branch-false",
          form: "logical-not",
        };
  }
  if (candidate.type !== "binary_expression") return null;
  const operator = candidate.childForFieldName("operator")?.text;
  if (operator !== "==" && operator !== "!=") return null;
  const left = candidate.childForFieldName("left");
  const right = candidate.childForFieldName("right");
  if (left === null || right === null) return null;
  const leftHandle = directHandle(left, bindings, handlesById);
  const rightHandle = directHandle(right, bindings, handlesById);
  const subject =
    leftHandle !== null && isNullConstant(right, bindings)
      ? leftHandle
      : rightHandle !== null && isNullConstant(left, bindings)
        ? rightHandle
        : null;
  if (subject === null) return null;
  return {
    subject: subject.node,
    variable: subject.variable,
    nonNullEdgeKind: operator === "!=" ? "branch-true" : "branch-false",
    form: operator === "!=" ? "not-equals-null" : "equals-null",
  };
}

function resultTarget(
  call: Node,
  bindings: FunctionVariableBindings,
  requireStandalone = true,
  allowUnsupportedCast = false,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  let current = call;
  while (true) {
    const parent = current.parent;
    if (parent?.type === "parenthesized_expression") {
      current = parent;
      continue;
    }
    if (
      parent?.type === "cast_expression" &&
      (allowUnsupportedCast || isObjectPointerCast(parent))
    ) {
      current = parent;
      continue;
    }
    break;
  }
  const parent = current.parent;
  if (parent?.type === "assignment_expression") {
    if (
      parent.childForFieldName("operator")?.text !== "=" ||
      parent.childForFieldName("right")?.id !== current.id ||
      (requireStandalone && !isStandaloneAssignment(parent))
    ) {
      return null;
    }
    const left = parent.childForFieldName("left");
    return left === null ? null : directBoundVariable(unwrapPointerValue(left), bindings);
  }
  if (parent?.type !== "init_declarator" || parent.childForFieldName("value")?.id !== current.id) {
    return null;
  }
  const declarator = parent.childForFieldName("declarator");
  if (declarator === null) return null;
  const candidates = [
    ...(declarator.type === "identifier" ? [declarator] : []),
    ...declarator.descendantsOfType("identifier"),
  ]
    .map((node) => directBoundVariable(node, bindings))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return candidates.length === 1 ? candidates[0]! : null;
}

function isStandaloneAssignment(assignment: Node): boolean {
  let current = assignment;
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  const parent = current.parent;
  if (parent?.type === "expression_statement") return true;
  if (parent?.type !== "for_statement") return false;
  return (
    parent.childForFieldName("initializer")?.id === current.id ||
    parent.childForFieldName("update")?.id === current.id
  );
}

function directHandle(
  node: Node,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  const direct = directBoundVariable(unwrapPointerValue(node), bindings);
  return direct !== null && handlesById.has(direct.variable.id) ? direct : null;
}

function directBoundVariable(
  node: Node,
  bindings: FunctionVariableBindings,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "identifier") return null;
  const variable = bindings.variableByOccurrenceRange.get(
    rangeKey(textRange(candidate.startIndex, candidate.endIndex)),
  );
  return variable === undefined ? null : { variable, node: candidate };
}

function pointerRootHandle(
  node: Node,
  bindings: FunctionVariableBindings,
  handlesById: ReadonlyMap<string, DefUseVariable>,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  const direct = directHandle(node, bindings, handlesById);
  if (direct !== null) return direct;
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "binary_expression") return null;
  const operator = candidate.childForFieldName("operator")?.text;
  if (operator !== "+" && operator !== "-") return null;
  const left = candidate.childForFieldName("left");
  const right = candidate.childForFieldName("right");
  if (left === null || right === null) return null;
  const subjects = [
    directHandle(left, bindings, handlesById),
    operator === "+" ? directHandle(right, bindings, handlesById) : null,
  ].filter((subject): subject is NonNullable<typeof subject> => subject !== null);
  return subjects.length === 1 ? subjects[0]! : null;
}

function isUniqueHandleCandidate(
  variable: DefUseVariable,
  _subjectNode: Node,
  bindings: FunctionVariableBindings,
): boolean {
  if (
    variable.kind !== "local" ||
    variable.storage !== "pointer" ||
    variable.confidence !== "certain" ||
    variable.declarationRanges.length !== 1
  ) {
    return false;
  }
  const declarationRange = variable.declarationRanges[0];
  const nameNode =
    declarationRange === undefined
      ? undefined
      : bindings.declarationNodeByRange.get(rangeKey(declarationRange));
  if (declarationRange === undefined || nameNode === undefined) return false;
  const declaration = nearestDeclaration(nameNode);
  if (declaration === null) return false;
  const declaredType = declaration.childForFieldName("type");
  if (declaredType === null || !EXPLICIT_HANDLE_BASE_TYPES.has(declaredType.type)) {
    return false;
  }
  const forbiddenStorage = new Set(["static", "extern", "thread_local", "__thread"]);
  if (
    declaration
      .descendantsOfType("storage_class_specifier")
      .some((specifier) => forbiddenStorage.has(specifier.text)) ||
    hasForbiddenHandleQualifier(nameNode, declaration)
  ) {
    return false;
  }
  let pointerCount = 0;
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "pointer_declarator") pointerCount += 1;
    if (current.type === "function_declarator" || current.type === "array_declarator") return false;
    current = current.parent;
  }
  return (
    pointerCount === 1 &&
    bindings.declarationNodeByRange.get(rangeKey(declarationRange))?.id === nameNode.id
  );
}

function hasForbiddenHandleQualifier(nameNode: Node, declaration: Node): boolean {
  const forbidden = (node: Node): boolean =>
    node.type === "type_qualifier" && (node.text === "volatile" || node.text === "_Atomic");
  if (declaration.namedChildren.some(forbidden)) return true;
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.namedChildren.some(forbidden)) return true;
    current = current.parent;
  }
  return false;
}

function allocationSizeForm(
  seed: AllocationSeed,
  bindings: FunctionVariableBindings,
  variable: DefUseVariable,
): MemoryAllocationSizeForm {
  const sizeArgument = seed.allocator === "malloc" ? seed.arguments[0] : seed.arguments[1];
  if (sizeArgument === undefined) return "other";
  const candidate = unwrapParentheses(sizeArgument);
  if (candidate.type !== "sizeof_expression") return "other";
  const value = candidate.childForFieldName("value");
  if (value === null) return "other";
  const direct = directBoundVariable(value, bindings);
  if (direct?.variable.id === variable.id) return "sizeof-handle";
  const pointee = unwrapParentheses(value);
  if (
    pointee.type !== "pointer_expression" ||
    pointee.childForFieldName("operator")?.text !== "*"
  ) {
    return "other";
  }
  const argument = pointee.childForFieldName("argument");
  if (argument === null) return "other";
  const subject = directBoundVariable(argument, bindings);
  return subject?.variable.id === variable.id ? "sizeof-pointee" : "other";
}

function eventBase(
  kind: MemoryEvent["kind"],
  variable: DefUseVariable,
  range: TextRange,
  subjectRange: TextRange,
  executionNode: Node,
  nodeId: string,
  repeatableNodeIds: ReadonlySet<string>,
): {
  readonly id: string;
  readonly variableId: string;
  readonly range: TextRange;
  readonly subjectRange: TextRange;
  readonly execution: MemoryEventExecution;
  readonly repeatable: boolean;
} {
  return {
    id: `memory:${kind}:${String(range.from)}:${String(range.to)}:${String(subjectRange.from)}:${variable.id}`,
    variableId: variable.id,
    range: Object.freeze({ ...range }),
    subjectRange: Object.freeze({ ...subjectRange }),
    execution: isConditionallyEvaluated(executionNode) ? "conditional" : "always",
    repeatable: repeatableNodeIds.has(nodeId),
  };
}

function enforceSupportedEventOrder(
  events: readonly OwnedEvent[],
  blockers: Set<MemoryEventDisabledReasonCode>,
): void {
  if (
    events.some(({ event }) => event.kind !== "null-guard" && event.execution === "conditional")
  ) {
    blockers.add("unsupported-memory-effect-order");
  }
  const grouped = new Map<string, MemoryEvent[]>();
  for (const { nodeId, event } of events) {
    const key = `${nodeId}:${event.variableId}`;
    const existing = grouped.get(key) ?? [];
    existing.push(event);
    grouped.set(key, existing);
  }
  if (
    [...grouped.values()].some((group) => group.length > 1 && !isSupportedSameNodeEventGroup(group))
  ) {
    blockers.add("unsupported-memory-effect-order");
  }
}

function isSupportedSameNodeEventGroup(group: readonly MemoryEvent[]): boolean {
  if (group.every((event) => event.kind === "dereference")) return true;
  if (group.some((event) => event.kind !== "dereference" && event.kind !== "escape")) {
    return false;
  }
  const dereferences = group.filter(
    (event): event is MemoryDereferenceEvent => event.kind === "dereference",
  );
  const escapes = group.filter((event): event is MemoryEscapeEvent => event.kind === "escape");
  return (
    dereferences.length > 0 &&
    escapes.length > 0 &&
    dereferences.every((dereference) =>
      escapes.some(
        (escape) =>
          sameRange(escape.subjectRange, dereference.subjectRange) &&
          containsRange(escape.range, dereference.range),
      ),
    )
  );
}

function isDirectAssertOwner(call: Node, owner: CfgNode, sourceLength: number): boolean {
  if (
    owner.nodeType !== "expression_statement" &&
    owner.nodeType !== "for_initializer" &&
    owner.nodeType !== "for_update"
  ) {
    return false;
  }
  let host = call;
  while (host.parent?.type === "parenthesized_expression") host = host.parent;
  const parent = host.parent;
  const parentChildren =
    host.id === call.id && parent?.type === "expression_statement" ? namedChildren(parent) : [];
  if (
    host.id === call.id &&
    parent?.type === "expression_statement" &&
    parentChildren.length === 1 &&
    parentChildren[0]?.id === call.id
  ) {
    host = parent;
  }
  return sameRange(owner.range, checkedNodeRange(host, sourceLength));
}

function escapeContext(identifier: Node): {
  readonly operation: Node;
  readonly origin: MemoryEscapeEvent["origin"];
} {
  let current = addressCancellationRoot(identifier);
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  const directParent = current.parent;
  if (
    directParent?.type === "pointer_expression" &&
    directParent.childForFieldName("operator")?.text === "&"
  ) {
    return { operation: directParent, origin: "address-taken" };
  }
  let ancestor = current.parent;
  while (ancestor !== null && ancestor.type !== "function_definition") {
    if (ancestor.type === "return_statement") return { operation: ancestor, origin: "return" };
    if (ancestor.type === "call_expression") {
      const callee = ancestor.childForFieldName("function");
      if (callee === null || !containsNode(callee, current)) {
        return { operation: ancestor, origin: "call-argument" };
      }
    }
    if (ancestor.type === "assignment_expression") {
      const left = ancestor.childForFieldName("left");
      return {
        operation: ancestor,
        origin: left !== null && containsNode(left, current) ? "overwritten" : "stored-value",
      };
    }
    if (ancestor.type === "init_declarator") {
      return { operation: ancestor, origin: "stored-value" };
    }
    ancestor = ancestor.parent;
  }
  return { operation: current, origin: "unsupported-use" };
}

function derivedValueEscapeContext(node: Node): {
  readonly operation: Node;
  readonly origin: MemoryEscapeEvent["origin"];
} | null {
  const context = escapeContext(node);
  return context.origin === "overwritten" || context.origin === "unsupported-use" ? null : context;
}

function directBuiltinCallName<const T extends string>(
  call: Node,
  bindings: FunctionVariableBindings,
  names: readonly T[],
): T | null {
  const callee = unwrapParentheses(call.childForFieldName("function") ?? call);
  if (callee.type !== "identifier" || !names.includes(callee.text as T)) return null;
  const symbol = bindings.symbolByOccurrenceRange.get(
    rangeKey(textRange(callee.startIndex, callee.endIndex)),
  );
  return symbol?.kind === "builtin-function" && names.includes(symbol.name as T)
    ? (symbol.name as T)
    : null;
}

function isNullConstant(node: Node, bindings: FunctionVariableBindings): boolean {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "number_literal" && candidate.text === "0") return true;
  if (candidate.type === "null") return true;
  if (candidate.type === "identifier" && candidate.text === "NULL") {
    const symbol = bindings.symbolByOccurrenceRange.get(
      rangeKey(textRange(candidate.startIndex, candidate.endIndex)),
    );
    return symbol?.kind === "builtin-object-macro";
  }
  return (
    candidate.type === "cast_expression" &&
    isObjectPointerCast(candidate) &&
    (candidate.childForFieldName("value") === null
      ? false
      : isNullConstant(candidate.childForFieldName("value")!, bindings))
  );
}

function isObjectPointerCast(node: Node): boolean {
  if (node.type !== "cast_expression") return false;
  const type = node.childForFieldName("type");
  if (type === null) return false;
  const pointers = type.descendantsOfType("abstract_pointer_declarator").length;
  return (
    pointers === 1 &&
    type.descendantsOfType("abstract_function_declarator").length === 0 &&
    type.descendantsOfType("abstract_array_declarator").length === 0
  );
}

function unwrapPointerValue(node: Node): Node {
  let current = node;
  while (true) {
    if (current.type === "parenthesized_expression") {
      const children = namedChildren(current);
      if (children.length !== 1 || children[0] === undefined) return current;
      current = children[0];
      continue;
    }
    if (current.type === "cast_expression" && isObjectPointerCast(current)) {
      const value = current.childForFieldName("value");
      if (value === null) return current;
      current = value;
      continue;
    }
    const cancelled = cancelledPointerOperand(current);
    if (cancelled !== null) {
      current = cancelled;
      continue;
    }
    return current;
  }
}

function cancelledPointerOperand(node: Node): Node | null {
  const outer = unwrapParentheses(node);
  if (outer.type !== "pointer_expression") return null;
  const outerOperator = outer.childForFieldName("operator")?.text;
  if (outerOperator !== "*" && outerOperator !== "&") return null;
  const outerArgument = outer.childForFieldName("argument");
  if (outerArgument === null) return null;
  const inner = unwrapParentheses(outerArgument);
  if (inner.type !== "pointer_expression") return null;
  const innerOperator = inner.childForFieldName("operator")?.text;
  if (
    (outerOperator === "*" && innerOperator !== "&") ||
    (outerOperator === "&" && innerOperator !== "*")
  ) {
    return null;
  }
  return inner.childForFieldName("argument");
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === "parenthesized_expression") {
    const children = namedChildren(current);
    if (children.length !== 1 || children[0] === undefined) return current;
    current = children[0];
  }
  return current;
}

function isDirectlyAddressed(node: Node): boolean {
  let current = node;
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  return (
    current.parent?.type === "pointer_expression" &&
    current.parent.childForFieldName("operator")?.text === "&"
  );
}

function evaluationSuppression(node: Node): EvaluationSuppression | null {
  let ambiguous: EvaluationSuppression | null = null;
  let current = node.parent;
  while (current !== null && current.type !== "function_definition") {
    if (
      current.type === "sizeof_expression" ||
      current.type === "alignof_expression" ||
      current.type === "offsetof_expression"
    ) {
      return { kind: "never", operation: current };
    }
    if (current.type === "generic_expression" && ambiguous === null) {
      ambiguous = { kind: "ambiguous", operation: current };
    }
    if (current.type === "call_expression") {
      const callee = unwrapParentheses(current.childForFieldName("function") ?? current);
      if (callee.type === "identifier" && NEVER_EVALUATED_BUILTIN_CALLS.has(callee.text)) {
        return { kind: "never", operation: current };
      }
      if (
        callee.type === "identifier" &&
        callee.text === "__builtin_choose_expr" &&
        ambiguous === null
      ) {
        ambiguous = { kind: "ambiguous", operation: current };
      }
    }
    current = current.parent;
  }
  return ambiguous;
}

function hasUnevaluatedAncestor(node: Node): boolean {
  return evaluationSuppression(node) !== null;
}

function isConditionallyEvaluated(node: Node): boolean {
  let current = node;
  while (current.parent !== null && current.parent.type !== "function_definition") {
    const parent = current.parent;
    if (parent.type === "binary_expression") {
      const operator = parent.childForFieldName("operator")?.text;
      const right = parent.childForFieldName("right");
      if (
        (operator === "&&" || operator === "||") &&
        right !== null &&
        containsNode(right, current)
      ) {
        return true;
      }
    }
    if (parent.type === "conditional_expression") {
      const condition = parent.childForFieldName("condition");
      if (condition === null || !containsNode(condition, current)) return true;
    }
    current = parent;
  }
  return false;
}

function isBenignPointerObservation(identifier: Node): boolean {
  let current = addressCancellationRoot(identifier);
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  const parent = current.parent;
  if (parent?.type === "unary_expression" && parent.childForFieldName("operator")?.text === "!") {
    return true;
  }
  if (parent?.type === "binary_expression") {
    const operator = parent.childForFieldName("operator")?.text;
    return operator === "==" || operator === "!=" || operator === "&&" || operator === "||";
  }
  if (parent?.type === "conditional_expression") {
    const condition = parent.childForFieldName("condition");
    return condition !== null && containsNode(condition, current);
  }
  return false;
}

function isDiscardedPointerObservation(identifier: Node): boolean {
  let current = addressCancellationRoot(identifier);
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  if (current.parent?.type === "cast_expression" && isVoidCast(current.parent)) {
    current = current.parent;
    while (current.parent?.type === "parenthesized_expression") current = current.parent;
  }
  return current.parent?.type === "expression_statement";
}

function addressCancellationRoot(node: Node): Node {
  let current = node;
  while (true) {
    while (current.parent?.type === "parenthesized_expression") current = current.parent;
    const inner = current.parent;
    if (
      inner?.type !== "pointer_expression" ||
      inner.childForFieldName("argument")?.id !== current.id
    ) {
      return current;
    }
    let wrappedInner = inner;
    while (wrappedInner.parent?.type === "parenthesized_expression") {
      wrappedInner = wrappedInner.parent;
    }
    const outer = wrappedInner.parent;
    if (
      outer?.type !== "pointer_expression" ||
      outer.childForFieldName("argument")?.id !== wrappedInner.id
    ) {
      return current;
    }
    const innerOperator = inner.childForFieldName("operator")?.text;
    const outerOperator = outer.childForFieldName("operator")?.text;
    if (!(
      (innerOperator === "&" && outerOperator === "*") ||
      (innerOperator === "*" && outerOperator === "&")
    )) {
      return current;
    }
    current = outer;
  }
}

function isVoidCast(node: Node): boolean {
  if (node.type !== "cast_expression") return false;
  const type = node.childForFieldName("type");
  return type !== null && type.text.trim() === "void";
}

function buildCfgOwnerIndex(cfg: FunctionCfg): CfgOwnerIndex {
  const candidates = cfg.nodes
    .map((node, originalOrder) => ({ node, originalOrder }))
    .filter(({ node }) => node.ownership !== "boundary")
    .sort(
      (left, right) =>
        left.node.range.from - right.node.range.from || left.originalOrder - right.originalOrder,
    );
  let leafCount = 1;
  while (leafCount < candidates.length) leafCount *= 2;
  const maxEnds = Array<number>(leafCount * 2).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < candidates.length; index += 1) {
    maxEnds[leafCount + index] = candidates[index]!.node.range.to;
  }
  for (let index = leafCount - 1; index > 0; index -= 1) {
    maxEnds[index] = Math.max(maxEnds[index * 2]!, maxEnds[index * 2 + 1]!);
  }
  return { candidates, leafCount, maxEnds };
}

function smallestOwningCfgNode(index: CfgOwnerIndex, range: TextRange): CfgNode | null {
  const limit = upperBoundByStart(index.candidates, range.from);
  if (limit === 0) return null;
  let best: IndexedCfgOwner | null = null;
  const pending: Array<readonly [number, number, number]> = [[1, 0, index.leafCount]];
  while (pending.length > 0) {
    const [treeIndex, from, to] = pending.pop()!;
    if (from >= limit || index.maxEnds[treeIndex]! < range.to) continue;
    if (to - from === 1) {
      const candidate = index.candidates[from];
      if (
        candidate !== undefined &&
        containsRange(candidate.node.range, range) &&
        (best === null || compareCfgOwners(candidate, best) < 0)
      ) {
        best = candidate;
      }
      continue;
    }
    const midpoint = from + Math.floor((to - from) / 2);
    pending.push([treeIndex * 2 + 1, midpoint, to], [treeIndex * 2, from, midpoint]);
  }
  return best?.node ?? null;
}

function upperBoundByStart(candidates: readonly IndexedCfgOwner[], start: number): number {
  let lower = 0;
  let upper = candidates.length;
  while (lower < upper) {
    const midpoint = lower + Math.floor((upper - lower) / 2);
    if (candidates[midpoint]!.node.range.from <= start) lower = midpoint + 1;
    else upper = midpoint;
  }
  return lower;
}

function compareCfgOwners(left: IndexedCfgOwner, right: IndexedCfgOwner): number {
  return (
    rangeLength(left.node.range) - rangeLength(right.node.range) ||
    Number(left.node.ownership === "primary") - Number(right.node.ownership === "primary") ||
    left.node.range.from - right.node.range.from ||
    left.originalOrder - right.originalOrder
  );
}

function collectBranchNodeIds(cfg: FunctionCfg): ReadonlySet<string> {
  const branchMasks = new Map<string, number>();
  for (const edge of cfg.edges) {
    const bit = edge.kind === "branch-true" ? 1 : edge.kind === "branch-false" ? 2 : 0;
    if (bit !== 0) branchMasks.set(edge.from, (branchMasks.get(edge.from) ?? 0) | bit);
  }
  return new Set(
    [...branchMasks.entries()].filter(([, mask]) => mask === 3).map(([nodeId]) => nodeId),
  );
}

function collectFalseExitNodeIds(cfg: FunctionCfg): ReadonlySet<string> {
  return new Set(
    cfg.edges
      .filter((edge) => edge.kind === "branch-false" && edge.to === cfg.exitId)
      .map((edge) => edge.from),
  );
}

function nearestDeclaration(node: Node): Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "function_definition") {
    if (current.type === "declaration") return current;
    if (current.type === "parameter_declaration") return null;
    current = current.parent;
  }
  return null;
}

function nearestInitializer(nameNode: Node, declaration: Node): Node | null {
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "init_declarator") return current.childForFieldName("value");
    current = current.parent;
  }
  return null;
}

function nearestAncestorOfType(node: Node, type: string): Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "function_definition") {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

function belongsToFunction(node: Node, functionNode: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current.type === "function_definition") return current.id === functionNode.id;
    current = current.parent;
  }
  return false;
}

function uniqueVariables(variables: readonly DefUseVariable[]): DefUseVariable[] {
  const byId = new Map(variables.map((variable) => [variable.id, variable]));
  return [...byId.values()].sort(
    (left, right) =>
      (left.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) -
        (right.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  );
}

function uniqueSubjects(
  subjects: readonly { readonly variable: DefUseVariable; readonly node: Node }[],
): Array<{ readonly variable: DefUseVariable; readonly node: Node }> {
  const byVariable = new Map<string, { readonly variable: DefUseVariable; readonly node: Node }>();
  for (const subject of subjects) {
    if (!byVariable.has(subject.variable.id)) byVariable.set(subject.variable.id, subject);
  }
  return [...byVariable.values()];
}

function deduplicateEvents(events: readonly OwnedEvent[]): OwnedEvent[] {
  return [...new Map(events.map((owned) => [owned.event.id, owned])).values()];
}

function compareOwnedEvents(left: OwnedEvent, right: OwnedEvent): number {
  return (
    left.event.range.from - right.event.range.from ||
    left.event.range.to - right.event.range.to ||
    left.event.subjectRange.from - right.event.subjectRange.from ||
    left.event.kind.localeCompare(right.event.kind) ||
    left.event.variableId.localeCompare(right.event.variableId)
  );
}

function freezeFunctionMemoryEvents(
  input: FunctionMemoryEventsInput,
  disabledReasons: readonly MemoryEventDisabledReasonCode[],
  handleVariableIds: readonly string[],
  facts: FunctionMemoryEvents["facts"],
): FunctionMemoryEvents {
  return Object.freeze({
    functionId: input.cfg.id,
    functionRange: Object.freeze({ ...input.cfg.range }),
    status: disabledReasons.length === 0 ? "complete" : "disabled",
    disabledReasons: Object.freeze([...disabledReasons]),
    handleVariableIds: Object.freeze([...handleVariableIds]),
    facts: Object.freeze([...facts]),
  });
}

function checkedNodeRange(node: Node, sourceLength: number): TextRange {
  if (
    node.isMissing ||
    !Number.isSafeInteger(node.startIndex) ||
    !Number.isSafeInteger(node.endIndex) ||
    node.startIndex < 0 ||
    node.endIndex <= node.startIndex ||
    node.endIndex > sourceLength
  ) {
    throw new RangeError(
      `memory event 节点 range 非法：[${String(node.startIndex)}, ${String(node.endIndex)})`,
    );
  }
  return textRange(node.startIndex, node.endIndex);
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type !== "comment");
}

function containsNode(parent: Node, child: Node): boolean {
  return child.startIndex >= parent.startIndex && child.endIndex <= parent.endIndex;
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function rangeLength(range: TextRange): number {
  return range.to - range.from;
}

function rangeKey(range: TextRange): string {
  return `${String(range.from)}:${String(range.to)}`;
}
