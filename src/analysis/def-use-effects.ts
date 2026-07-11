import type { Node } from "web-tree-sitter";
import { textRange, type SourceDoc, type SymbolRecord, type TextRange } from "../core/model.js";
import type {
  CfgNode,
  DefUseDefinitionEffect,
  DefUseDisabledReasonCode,
  DefUseEffect,
  DefUseEscapeEffect,
  DefUseFact,
  DefUseUseEffect,
  DefUseVariable,
  FunctionCfg,
} from "./model.js";

type EffectBlocker = Extract<
  DefUseDisabledReasonCode,
  | "unsequenced-conflict"
  | "unsupported-effect-order"
  | "effect-cst-mismatch"
  | "opaque-alias-effect"
>;

type DraftUseEffect = Omit<DefUseUseEffect, "id">;
type DraftDefinitionEffect = Omit<DefUseDefinitionEffect, "id">;
type DraftEscapeEffect = Omit<DefUseEscapeEffect, "id">;
type DraftEffect = DraftUseEffect | DraftDefinitionEffect | DraftEscapeEffect;

interface EffectPlan {
  readonly effects: readonly DraftEffect[];
  readonly blockers: ReadonlySet<EffectBlocker>;
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
  readonly ordinaryWrites: ReadonlySet<string>;
  readonly callWrites: ReadonlySet<string>;
  readonly pendingWrites: ReadonlySet<string>;
}

interface BindingIndex {
  readonly variableByOccurrenceRange: ReadonlyMap<string, DefUseVariable>;
  readonly declarationNodeByRange: ReadonlyMap<string, Node>;
  readonly symbolByOccurrenceRange: ReadonlyMap<string, SymbolRecord>;
}

interface NodeIndex {
  readonly byRangeAndType: ReadonlyMap<string, readonly Node[]>;
}

interface PointerAliasValue {
  readonly targetIds: ReadonlySet<string>;
  readonly unknown: boolean;
}

type PointerAliasState = ReadonlyMap<string, PointerAliasValue>;

interface ExtractionContext {
  readonly sourceLength: number;
  readonly functionRange: TextRange;
  readonly variables: readonly DefUseVariable[];
  readonly bindings: BindingIndex;
  readonly nodes: NodeIndex;
  readonly pointerAliases: PointerAliasState;
}

interface ValueOptions {
  readonly arrayDecay: "ignore" | "escape" | "queue";
  readonly addressUse: "ignore" | "escape" | "queue";
  readonly queuedCallEffects?: DraftEffect[];
  readonly queuedCallHazardWrites?: Set<string>;
  readonly useRole: DefUseUseEffect["role"];
}

interface LValuePlan {
  readonly plan: EffectPlan;
  readonly target: DefUseVariable | null;
  readonly targetNode: Node | null;
  readonly hazardTargetId?: string | undefined;
  readonly additionalHazardTargetIds?: readonly string[] | undefined;
}

interface ArrayAccessTarget {
  readonly variable: DefUseVariable;
  readonly node: Node;
  readonly indices: readonly Node[];
}

interface DereferenceTarget {
  readonly plan: EffectPlan;
  readonly target: DefUseVariable;
  readonly targetNode: Node;
  readonly dimensionsConsumed: number;
}

interface AddressedScalarTarget {
  readonly plan: EffectPlan;
  readonly target: DefUseVariable;
  readonly targetNode: Node;
}

export interface FunctionEffectInput {
  readonly functionNode: Node;
  readonly cfg: FunctionCfg;
  readonly document: SourceDoc;
  readonly variables: readonly DefUseVariable[];
}

export interface FunctionEffectCollection {
  readonly facts: readonly DefUseFact[];
  readonly disabledReasons: readonly EffectBlocker[];
}

const EMPTY_PLAN: EffectPlan = Object.freeze({
  effects: Object.freeze([]),
  blockers: Object.freeze(new Set<EffectBlocker>()),
  reads: Object.freeze(new Set<string>()),
  writes: Object.freeze(new Set<string>()),
  ordinaryWrites: Object.freeze(new Set<string>()),
  callWrites: Object.freeze(new Set<string>()),
  pendingWrites: Object.freeze(new Set<string>()),
});

const EFFECT_BLOCKER_ORDER_MAP = Object.freeze({
  "effect-cst-mismatch": 0,
  "unsequenced-conflict": 1,
  "unsupported-effect-order": 2,
  "opaque-alias-effect": 3,
} as const satisfies Readonly<Record<EffectBlocker, number>>);
const EFFECT_BLOCKER_ORDER = Object.freeze(
  Object.keys(EFFECT_BLOCKER_ORDER_MAP) as EffectBlocker[],
);

const DEFAULT_VALUE_OPTIONS: ValueOptions = Object.freeze({
  arrayDecay: "ignore",
  addressUse: "ignore",
  useRole: "value",
});
const OPAQUE_POINTEE_HAZARD = "hazard:opaque-pointee";
const EMPTY_POINTER_ALIAS_STATE: PointerAliasState = new Map();

export function collectFunctionEffects(input: FunctionEffectInput): FunctionEffectCollection {
  const functionRange = checkedNodeRange(input.functionNode, input.document.source.length);
  const bindings = buildBindingIndex(
    input.document,
    functionRange,
    input.variables,
    input.functionNode,
  );
  const baseContext: ExtractionContext = {
    sourceLength: input.document.source.length,
    functionRange,
    variables: input.variables,
    bindings,
    nodes: buildNodeIndex(input.functionNode),
    pointerAliases: EMPTY_POINTER_ALIAS_STATE,
  };
  const aliasInByNodeId = collectPointerAliasInStates(input.cfg, baseContext);
  const facts: DefUseFact[] = [];
  const blockers = new Set<EffectBlocker>();
  for (const cfgNode of input.cfg.nodes) {
    const context: ExtractionContext = {
      ...baseContext,
      pointerAliases: aliasInByNodeId.get(cfgNode.id) ?? EMPTY_POINTER_ALIAS_STATE,
    };
    const plan = collectCfgNodePlan(cfgNode, context);
    plan.blockers.forEach((blocker) => blockers.add(blocker));
    facts.push(freezeFact(cfgNode, plan.effects));
  }
  const disabledReasons = Object.freeze(
    EFFECT_BLOCKER_ORDER.filter((blocker) => blockers.has(blocker)),
  );
  return Object.freeze({
    facts: disabledReasons.length === 0 ? Object.freeze(facts) : Object.freeze([]),
    disabledReasons,
  });
}

function collectCfgNodePlan(node: CfgNode, context: ExtractionContext): EffectPlan {
  if (node.kind === "entry") return collectEntryPlan(context);
  if (node.kind === "exit") return EMPTY_PLAN;
  if (node.kind === "control") return collectControlPlan(node, context);
  const syntax = uniqueNode(
    context.nodes.byRangeAndType.get(nodeTypeKey(node.range, node.nodeType)),
  );
  if (syntax === null) return blockedPlan("effect-cst-mismatch");
  return collectSyntaxPayload(syntax, context);
}

function collectEntryPlan(context: ExtractionContext): EffectPlan {
  const plans: EffectPlan[] = [];
  const boundPlans: EffectPlan[] = [];
  const parameters = context.variables
    .filter((variable) => variable.kind === "parameter")
    .sort(compareVariables);
  for (const variable of parameters) {
    const range = variable.declarationRanges[0];
    const nameNode =
      range === undefined
        ? undefined
        : context.bindings.declarationNodeByRange.get(rangeKey(range));
    if (range === undefined || nameNode === undefined) return blockedPlan("effect-cst-mismatch");
    const declaration = nearestAncestorOfType(nameNode, "parameter_declaration");
    if (declaration === null) return blockedPlan("effect-cst-mismatch");
    if (containsBoundTypeDescriptor(declaration, context)) {
      return blockedPlan("unsupported-effect-order");
    }
    const boundPlan = mergeUnsequenced(
      arraySizeExpressions(nameNode, declaration)
        .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex)
        .map((size) =>
          collectValue(size, context, {
            arrayDecay: "ignore",
            addressUse: "ignore",
            useRole: "value",
          }),
        ),
    );
    boundPlans.push(boundPlan);
    const parameterPlan =
      variable.tracking === "untracked"
        ? appendVariableHazardWrite(boundPlan, variable.id)
        : appendEffect(boundPlan, {
            kind: "def",
            variableId: variable.id,
            range,
            strength: "strong",
            valueState: "written",
            origin: "parameter",
          });
    plans.push(parameterPlan);
  }
  const ordered = mergeSequential(plans);
  const boundOrderGate = mergeIndeterminate(boundPlans);
  return makePlan(
    ordered.effects,
    new Set([...ordered.blockers, ...boundOrderGate.blockers]),
    ordered,
  );
}

function collectControlPlan(node: CfgNode, context: ExtractionContext): EffectPlan {
  const ownerType = node.nodeType === "do_condition" ? "do_statement" : "for_statement";
  const owner = uniqueNode(
    context.nodes.byRangeAndType.get(nodeTypeKey(node.ownerBlockRange, ownerType)),
  );
  if (owner === null) return blockedPlan("effect-cst-mismatch");
  const field =
    node.nodeType === "for_initializer"
      ? "initializer"
      : node.nodeType === "for_update"
        ? "update"
        : node.nodeType === "do_condition"
          ? "condition"
          : null;
  const payload = field === null ? null : owner.childForFieldName(field);
  if (
    payload === null ||
    rangeKey(checkedNodeRange(payload, context.sourceLength)) !== rangeKey(node.range)
  ) {
    return blockedPlan("effect-cst-mismatch");
  }
  return payload.type === "declaration"
    ? collectDeclaration(payload, context)
    : collectValue(payload, context, DEFAULT_VALUE_OPTIONS);
}

function collectSyntaxPayload(node: Node, context: ExtractionContext): EffectPlan {
  if (node.type === "declaration") return collectDeclaration(node, context);
  if (node.type === "type_definition") return collectTypeDefinition(node, context);
  if (node.type === "expression_statement") {
    const children = namedChildren(node);
    return children.length <= 1
      ? children[0] === undefined
        ? EMPTY_PLAN
        : collectValue(children[0], context, DEFAULT_VALUE_OPTIONS)
      : blockedPlan("effect-cst-mismatch");
  }
  if (node.type === "return_statement") {
    const children = namedChildren(node);
    if (children.length > 1) return blockedPlan("effect-cst-mismatch");
    const value = children[0];
    return value === undefined
      ? EMPTY_PLAN
      : collectValue(value, context, {
          arrayDecay: "escape",
          addressUse: "escape",
          useRole: "value",
        });
  }
  if (
    node.type === "if_statement" ||
    node.type === "while_statement" ||
    node.type === "for_statement" ||
    node.type === "switch_statement"
  ) {
    const condition = node.childForFieldName("condition");
    return condition === null
      ? node.type === "for_statement"
        ? EMPTY_PLAN
        : blockedPlan("effect-cst-mismatch")
      : collectValue(condition, context, DEFAULT_VALUE_OPTIONS);
  }
  if (
    node.type === "break_statement" ||
    node.type === "case_statement" ||
    node.type === "continue_statement" ||
    node.type === "goto_statement" ||
    node.type === "labeled_statement"
  ) {
    return EMPTY_PLAN;
  }
  return blockedPlan("effect-cst-mismatch");
}

function collectDeclaration(node: Node, context: ExtractionContext): EffectPlan {
  if (containsBoundTypeDescriptor(node, context)) {
    return blockedPlan("unsupported-effect-order");
  }
  const declaredType = node.childForFieldName("type");
  if (
    declaredType?.type === "macro_type_specifier" &&
    containsBoundVariable(declaredType, context)
  ) {
    return blockedPlan("unsupported-effect-order");
  }
  const nodeRange = checkedNodeRange(node, context.sourceLength);
  const declared = context.variables
    .flatMap((variable) =>
      variable.declarationRanges
        .filter((range) => containsRange(nodeRange, range))
        .map((range) => ({ variable, range })),
    )
    .sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
  const plans: EffectPlan[] = [];
  let currentContext = context;
  for (const entry of declared) {
    const nameNode = context.bindings.declarationNodeByRange.get(rangeKey(entry.range));
    if (nameNode === undefined) return blockedPlan("effect-cst-mismatch");
    const sizes = arraySizeExpressions(nameNode, node).sort(
      (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
    );
    const sizeInput = currentContext.pointerAliases;
    plans.push(
      mergeUnsequenced(
        sizes.map((size) =>
          collectValue(size, currentContext, {
            arrayDecay: "ignore",
            addressUse: "ignore",
            useRole: "value",
          }),
        ),
      ),
    );
    const sizeOutputs = sizes.map((size) =>
      transferPointerExpression(size, sizeInput, currentContext),
    );
    if (sizeOutputs.length > 0) {
      currentContext = {
        ...currentContext,
        pointerAliases: sizeOutputs.reduce(joinPointerAliasStates),
      };
    }
    const initializer = nearestInitializer(nameNode, node);
    if (initializer !== null) {
      plans.push(
        collectValue(initializer, currentContext, {
          arrayDecay: "escape",
          addressUse: "escape",
          useRole: "value",
        }),
      );
      currentContext = {
        ...currentContext,
        pointerAliases: transferPointerExpression(
          initializer,
          currentContext.pointerAliases,
          currentContext,
        ),
      };
    }
    if (entry.variable.storage === "pointer") {
      const value =
        initializer === null
          ? unknownPointerAlias()
          : resolvePointerAliasValue(initializer, currentContext.pointerAliases, currentContext);
      currentContext = {
        ...currentContext,
        pointerAliases: setPointerAlias(currentContext.pointerAliases, entry.variable.id, value),
      };
    }
    if (initializer !== null) {
      currentContext = {
        ...currentContext,
        pointerAliases: invalidateAddressedPointers(
          initializer,
          currentContext.pointerAliases,
          currentContext,
        ),
      };
    }
    if (entry.variable.tracking !== "untracked") {
      plans.push(
        plan([
          {
            kind: "def",
            variableId: entry.variable.id,
            range: entry.range,
            strength: "strong",
            valueState: initializer === null ? "uninitialized" : "written",
            origin: "declaration",
          },
        ]),
      );
    }
  }
  return mergeSequential(plans);
}

function collectTypeDefinition(node: Node, context: ExtractionContext): EffectPlan {
  if (containsBoundTypeDescriptor(node, context)) {
    return blockedPlan("unsupported-effect-order");
  }
  const declarators = node.namedChildren.filter(
    (_child, index) => node.fieldNameForNamedChild(index) === "declarator",
  );
  return mergeSequential(
    declarators.map((declarator) =>
      mergeUnsequenced(
        arraySizeExpressionsWithin(declarator)
          .sort(
            (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
          )
          .map((size) =>
            collectValue(size, context, {
              arrayDecay: "ignore",
              addressUse: "ignore",
              useRole: "value",
            }),
          ),
      ),
    ),
  );
}

function collectValue(node: Node, context: ExtractionContext, options: ValueOptions): EffectPlan {
  if (node.type === "comment") return EMPTY_PLAN;
  if (node.type === "compound_statement") return blockedPlan("unsupported-effect-order");
  if (containsBoundTypeDescriptor(node, context)) {
    return blockedPlan("unsupported-effect-order");
  }
  if (node.type === "identifier") return collectIdentifier(node, context, options);
  if (node.type === "assignment_expression") return collectAssignment(node, context, options);
  if (node.type === "update_expression") return collectUpdate(node, context, options);
  if (node.type === "subscript_expression") return collectSubscriptRead(node, context, options);
  if (node.type === "field_expression") return collectFieldRead(node, context, options);
  if (node.type === "call_expression") return collectCall(node, context, options);
  if (node.type === "pointer_expression") return collectPointerExpression(node, context, options);
  if (node.type === "unary_expression") return collectUnary(node, context, options);
  if (node.type === "binary_expression") return collectBinary(node, context, options);
  if (node.type === "comma_expression") {
    const children = namedChildren(node);
    const plans: EffectPlan[] = [];
    let childContext = context;
    children.forEach((child, index) => {
      plans.push(
        collectValue(
          child,
          childContext,
          index === children.length - 1 ? options : DEFAULT_VALUE_OPTIONS,
        ),
      );
      childContext = {
        ...childContext,
        pointerAliases: transferPointerExpression(child, childContext.pointerAliases, childContext),
      };
    });
    const merged = mergeSequential(plans);
    return (containsTrackedAddress(node, context) || containsTrackedArray(node, context)) &&
      merged.writes.has(OPAQUE_POINTEE_HAZARD)
      ? mergeWithBlocker([merged], "unsupported-effect-order")
      : merged;
  }
  if (node.type === "conditional_expression") return collectConditional(node, context, options);
  if (node.type === "cast_expression") {
    const value = node.childForFieldName("value");
    return value === null
      ? blockedPlan("effect-cst-mismatch")
      : collectValue(value, context, options);
  }
  if (node.type === "initializer_list") {
    return mergeIndeterminate(
      namedChildren(node).map((child) => collectValue(child, context, options)),
    );
  }
  if (node.type === "gnu_asm_expression") return blockedPlan("opaque-alias-effect");
  if (node.type === "sizeof_expression") {
    const type = node.childForFieldName("type");
    const value = node.childForFieldName("value");
    return (type !== null && containsBoundVariable(type, context)) ||
      (value !== null && containsBoundTypeDescriptor(value, context))
      ? blockedPlan("unsupported-effect-order")
      : EMPTY_PLAN;
  }
  if (node.type === "generic_expression") {
    return containsBoundVariable(node, context)
      ? blockedPlan("unsupported-effect-order")
      : EMPTY_PLAN;
  }
  if (node.type === "alignof_expression" || node.type === "offsetof_expression") {
    return containsTrackedIdentifier(node, context)
      ? blockedPlan("unsupported-effect-order")
      : EMPTY_PLAN;
  }
  const children = namedChildren(node);
  if (children.length === 0) return EMPTY_PLAN;
  if (children.length === 1) return collectValue(children[0]!, context, options);
  const parts = children.map((child) => collectValue(child, context, options));
  return parts.some(hasModification)
    ? mergeWithBlocker(parts, "unsupported-effect-order")
    : mergeSequential(parts);
}

function collectIdentifier(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const variable = variableForNode(node, context);
  if (variable === null) return EMPTY_PLAN;
  if (variable.storage === "array") {
    if (variable.tracking === "untracked") {
      if (options.arrayDecay === "queue") {
        options.queuedCallHazardWrites?.add(variable.id);
      }
      return EMPTY_PLAN;
    }
    if (options.arrayDecay === "ignore") return EMPTY_PLAN;
    const effect: DraftEscapeEffect = {
      kind: "escape",
      variableId: variable.id,
      range: checkedNodeRange(node, context.sourceLength),
      origin: "array-decay",
    };
    if (options.arrayDecay === "queue" && options.queuedCallEffects !== undefined) {
      options.queuedCallEffects.push(effect);
      return EMPTY_PLAN;
    }
    return plan([effect]);
  }
  if (variable.tracking === "untracked") {
    if (
      options.arrayDecay === "queue" &&
      (variable.storage === "pointer" ||
        variable.storage === "unknown" ||
        variable.storage === "aggregate")
    ) {
      pointeeHazardIds(node, context).forEach((hazardId) =>
        options.queuedCallHazardWrites?.add(hazardId),
      );
    }
    return hazardPlan(variable.id, "read");
  }
  return plan([useEffect(variable, node, context, options.useRole)]);
}

function collectAssignment(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  const operator = node.childForFieldName("operator")?.text;
  if (left === null || right === null || operator === undefined) {
    return blockedPlan("effect-cst-mismatch");
  }
  const lvalue = collectLValue(left, operator !== "=", context, options.useRole);
  const rightPlan = collectValue(right, context, {
    arrayDecay: "escape",
    addressUse: "escape",
    useRole: options.useRole,
  });
  let operands = mergeUnsequenced([lvalue.plan, rightPlan]);
  const targetIds = lvalueTargetIds(lvalue);
  if (operator === "=" && targetIds.some((targetId) => rightPlan.pendingWrites.has(targetId))) {
    operands = mergeWithBlocker([operands], "unsequenced-conflict");
  }
  if (lvalue.target === null || lvalue.targetNode === null) return operands;
  if (targetIds.some((targetId) => lvalue.plan.pendingWrites.has(targetId))) {
    operands = mergeWithBlocker([operands], "unsequenced-conflict");
  }
  const origin =
    lvalue.target.storage === "array"
      ? "array-element"
      : operator === "="
        ? "assignment"
        : "compound-assignment";
  return appendLValueWrite(operands, lvalue, context, origin);
}

function collectUpdate(node: Node, context: ExtractionContext, options: ValueOptions): EffectPlan {
  const argument = node.childForFieldName("argument");
  if (argument === null) return blockedPlan("effect-cst-mismatch");
  const lvalue = collectLValue(argument, true, context, options.useRole);
  if (lvalue.target === null || lvalue.targetNode === null) return lvalue.plan;
  return appendLValueWrite(
    lvalue.plan,
    lvalue,
    context,
    lvalue.target.storage === "array" ? "array-element" : "update",
  );
}

function collectFieldRead(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const argument = node.childForFieldName("argument");
  if (argument === null) return blockedPlan("effect-cst-mismatch");
  if (options.arrayDecay === "queue") {
    options.queuedCallHazardWrites?.add(OPAQUE_POINTEE_HAZARD);
  }
  const owner = fieldOwnerForNode(argument, context);
  if (owner === null) {
    const argumentPlan = collectValue(argument, context, DEFAULT_VALUE_OPTIONS);
    if (fieldOperator(node) !== "->") return argumentPlan;
    const readPlan = appendHazardReadsAfterEvaluation(
      argumentPlan,
      pointeeHazardIds(argument, context),
    );
    return mayAliasTrackedArrayParameter(context)
      ? mergeWithBlocker([readPlan], "opaque-alias-effect")
      : readPlan;
  }
  const directOwner = unwrapParentheses(argument).type === "identifier";
  const evaluatesOwnerValue = !directOwner || fieldOperator(node) === "->";
  const ownerPlan = evaluatesOwnerValue
    ? collectValue(argument, context, DEFAULT_VALUE_OPTIONS)
    : EMPTY_PLAN;
  return appendHazardReadsAfterEvaluation(
    ownerPlan,
    fieldAccessHazardIds(node, owner.variable, context),
  );
}

function collectSubscriptRead(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const argument = node.childForFieldName("argument");
  const index = node.childForFieldName("index");
  if (argument === null || index === null) return blockedPlan("effect-cst-mismatch");
  const addressedScalar = resolveAddressedScalarSubscript(argument, index, context);
  if (addressedScalar !== null) {
    return appendVariableRead(
      addressedScalar.plan,
      addressedScalar.target,
      addressedScalar.targetNode,
      context,
      options.useRole,
    );
  }
  const target = flattenArrayAccess(node, context);
  if (target !== null) {
    const indexPlans = target.indices.map((candidate) =>
      collectValue(candidate, context, {
        arrayDecay: "ignore",
        addressUse: "ignore",
        useRole: "index",
      }),
    );
    const indexEvaluation = mergeUnsequenced(indexPlans);
    const rank = arrayRank(target.variable, context);
    if (target.indices.length > rank) {
      return mergeWithBlocker([indexEvaluation], "unsupported-effect-order");
    }
    if (target.indices.length < rank) {
      return mergeUnsequenced([indexEvaluation, collectIdentifier(target.node, context, options)]);
    }
    const basePlan = appendVariableRead(
      indexEvaluation,
      target.variable,
      target.node,
      context,
      "array-element",
    );
    return indexEvaluation.pendingWrites.has(target.variable.id)
      ? mergeWithBlocker([basePlan], "unsequenced-conflict")
      : basePlan;
  }
  const indexPlan = collectValue(index, context, {
    arrayDecay: "ignore",
    addressUse: "ignore",
    useRole: "index",
  });
  const basePlan = collectValue(argument, context, {
    ...options,
    arrayDecay: "ignore",
    addressUse: "ignore",
  });
  let merged = mergeUnsequenced([basePlan, indexPlan]);
  const owner = untrackedOwnerForNode(node, context);
  if (owner !== null) {
    merged = appendHazardReadsAfterEvaluation(
      merged,
      pointeeHazardIds(subscriptPointerOperand(argument, index, context), context),
    );
  }
  return containsTrackedArray(argument, context)
    ? mergeWithBlocker([merged], "unsupported-effect-order")
    : containsTrackedAddress(argument, context)
      ? mergeWithBlocker([merged], "unsupported-effect-order")
      : containsOpaqueAliasCandidate(node, context) && mayAliasTrackedArrayParameter(context)
        ? mergeWithBlocker([merged], "opaque-alias-effect")
        : merged;
}

function collectCall(node: Node, context: ExtractionContext, options: ValueOptions): EffectPlan {
  const callee = node.childForFieldName("function");
  const argumentsNode = node.childForFieldName("arguments");
  if (callee === null || argumentsNode === null || argumentsNode.type !== "argument_list") {
    return blockedPlan("effect-cst-mismatch");
  }
  const argumentsList = namedChildren(argumentsNode);
  if (
    callee.type === "identifier" &&
    callee.text === "assert" &&
    isUnshadowedSpecialCall(callee, context)
  ) {
    const condition = argumentsList[0];
    return argumentsList.length === 1 && condition !== undefined
      ? collectValue(condition, context, { ...DEFAULT_VALUE_OPTIONS, useRole: options.useRole })
      : blockedPlan("effect-cst-mismatch");
  }
  const postCall: DraftEffect[] = [];
  const postCallHazardWrites = new Set<string>();
  const parts: EffectPlan[] = [collectValue(callee, context, DEFAULT_VALUE_OPTIONS)];
  for (const argument of argumentsList) {
    const directAddress = unwrapParentheses(argument);
    if (directAddress.type === "pointer_expression" && pointerOperator(directAddress) === "&") {
      const targetNode = directAddress.childForFieldName("argument");
      if (targetNode === null) return blockedPlan("effect-cst-mismatch");
      const target = collectAddressTarget(targetNode, context);
      let targetPlan = target.plan;
      if (target.target !== null && target.targetNode !== null) {
        if (
          target.target.kind === "parameter" &&
          target.target.storage === "array" &&
          unwrapParentheses(targetNode).type === "identifier"
        ) {
          targetPlan = mergeWithBlocker([targetPlan], "unsupported-effect-order");
        }
        if (target.target.tracking === "untracked") {
          postCallHazardWrites.add(target.target.id);
          if (
            target.target.storage === "pointer" ||
            target.target.storage === "unknown" ||
            target.target.storage === "aggregate"
          ) {
            postCallHazardWrites.add(OPAQUE_POINTEE_HAZARD);
            if (mayAliasTrackedArrayParameter(context)) {
              targetPlan = mergeWithBlocker([targetPlan], "opaque-alias-effect");
            }
          }
        } else {
          postCall.push({
            kind: "def",
            variableId: target.target.id,
            range: checkedNodeRange(target.targetNode, context.sourceLength),
            strength: "weak",
            valueState: "maybe-written",
            origin: "call-argument",
          });
        }
      }
      parts.push(targetPlan);
      continue;
    }
    let argumentPlan = collectValue(argument, context, {
      arrayDecay: "queue",
      addressUse: "queue",
      queuedCallEffects: postCall,
      queuedCallHazardWrites: postCallHazardWrites,
      useRole: options.useRole,
    });
    if (containsPointerResultAssignment(argument, context)) {
      argumentPlan = mergeWithBlocker([argumentPlan], "unsupported-effect-order");
    }
    parts.push(
      containsOpaqueAliasCandidate(argument, context) && mayAliasTrackedArrayParameter(context)
        ? mergeWithBlocker([argumentPlan], "opaque-alias-effect")
        : argumentPlan,
    );
  }
  const evaluation = mergeUnsequenced(parts);
  postCall
    .filter((effect) => effect.kind === "escape")
    .forEach((effect) => postCallHazardWrites.add(effect.variableId));
  const postPlan = markWritesAsCall(
    mergeSequential([
      plan(deduplicatePostCallEffects(postCall)),
      ...[...postCallHazardWrites].map((variableId) => hazardPlan(variableId, "write")),
    ]),
  );
  return withPendingWritesCleared(mergeSequential([evaluation, postPlan]));
}

function collectPointerExpression(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const argument = node.childForFieldName("argument");
  const operator = pointerOperator(node);
  if (argument === null || operator === null) return blockedPlan("effect-cst-mismatch");
  if (operator !== "&") return collectDereferenceRead(node, argument, context, options);
  const target = collectAddressTarget(argument, context);
  if (target.target === null || target.targetNode === null) return target.plan;
  if (target.target.tracking === "untracked" || options.addressUse === "ignore") {
    return target.plan;
  }
  const escape: DraftEscapeEffect = {
    kind: "escape",
    variableId: target.target.id,
    range: checkedNodeRange(target.targetNode, context.sourceLength),
    origin: "stored-address",
  };
  if (options.addressUse === "queue" && options.queuedCallEffects !== undefined) {
    options.queuedCallEffects.push(escape);
    return target.plan;
  }
  return appendEffect(target.plan, escape);
}

function collectBinary(node: Node, context: ExtractionContext, options: ValueOptions): EffectPlan {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  const operator = node.childForFieldName("operator")?.text;
  if (left === null || right === null || operator === undefined) {
    return blockedPlan("effect-cst-mismatch");
  }
  const pointerDifference =
    operator === "-" &&
    expressionMayBePointer(left, context) &&
    expressionMayBePointer(right, context);
  const preservesPointer = operator === "+" || (operator === "-" && !pointerDifference);
  const childOptions: ValueOptions = {
    ...options,
    arrayDecay: preservesPointer ? options.arrayDecay : "ignore",
    addressUse: preservesPointer ? options.addressUse : "ignore",
  };
  if (operator === "&&" || operator === "||") {
    const leftPlan = collectValue(left, context, childOptions);
    const rightContext: ExtractionContext = {
      ...context,
      pointerAliases: transferPointerExpression(left, context.pointerAliases, context),
    };
    const rightPlan = collectValue(right, rightContext, childOptions);
    if (hasModification(rightPlan)) {
      return mergeWithBlocker([leftPlan, rightPlan], "unsupported-effect-order");
    }
    return mergeSequential([leftPlan, conditionalizeUses(rightPlan)]);
  }
  const leftPlan = collectValue(left, context, childOptions);
  const rightPlan = collectValue(right, context, childOptions);
  return mergeUnsequenced([leftPlan, rightPlan]);
}

function collectUnary(node: Node, context: ExtractionContext, options: ValueOptions): EffectPlan {
  const argument = node.childForFieldName("argument");
  if (argument === null) return blockedPlan("effect-cst-mismatch");
  return collectValue(argument, context, {
    ...options,
    arrayDecay: "ignore",
    addressUse: "ignore",
  });
}

function collectConditional(
  node: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const condition = node.childForFieldName("condition");
  const consequence = node.childForFieldName("consequence");
  const alternative = node.childForFieldName("alternative");
  if (condition === null || consequence === null || alternative === null) {
    return blockedPlan("effect-cst-mismatch");
  }
  const conditionPlan = collectValue(condition, context, {
    arrayDecay: "ignore",
    addressUse: "ignore",
    useRole: options.useRole,
  });
  const branchContext: ExtractionContext = {
    ...context,
    pointerAliases: transferPointerExpression(condition, context.pointerAliases, context),
  };
  const consequencePlan = collectValue(consequence, branchContext, options);
  const alternativePlan = collectValue(alternative, branchContext, options);
  if (hasModification(consequencePlan) || hasModification(alternativePlan)) {
    return mergeWithBlocker(
      [conditionPlan, consequencePlan, alternativePlan],
      "unsupported-effect-order",
    );
  }
  return mergeSequential([
    conditionPlan,
    conditionalizeUses(consequencePlan),
    conditionalizeUses(alternativePlan),
  ]);
}

function collectLValue(
  node: Node,
  read: boolean,
  context: ExtractionContext,
  useRole: DefUseUseEffect["role"],
): LValuePlan {
  const unwrapped = unwrapParentheses(node);
  if (unwrapped.type === "identifier") {
    const target = variableForNode(unwrapped, context);
    if (target === null) {
      return { plan: EMPTY_PLAN, target: null, targetNode: null };
    }
    if (target.storage === "array") {
      return {
        plan:
          target.tracking === "untracked" ? EMPTY_PLAN : blockedPlan("unsupported-effect-order"),
        target: null,
        targetNode: null,
      };
    }
    const readPlan =
      target.tracking === "untracked"
        ? hazardPlan(target.id, "read")
        : plan([useEffect(target, unwrapped, context, useRole)]);
    return {
      plan: read ? readPlan : EMPTY_PLAN,
      target,
      targetNode: unwrapped,
    };
  }
  if (unwrapped.type === "field_expression") {
    const argument = unwrapped.childForFieldName("argument");
    if (argument === null) {
      return { plan: blockedPlan("effect-cst-mismatch"), target: null, targetNode: null };
    }
    const owner =
      fieldOwnerForNode(argument, context) ??
      (fieldOperator(unwrapped) === "->" ? untrackedOwnerForNode(argument, context) : null);
    if (owner === null) {
      const unknownTargetPlan = collectValue(argument, context, DEFAULT_VALUE_OPTIONS);
      return {
        plan: mayAliasTrackedArrayParameter(context)
          ? mergeWithBlocker([unknownTargetPlan], "opaque-alias-effect")
          : unknownTargetPlan,
        target: null,
        targetNode: null,
      };
    }
    const directOwner = unwrapParentheses(argument).type === "identifier";
    const evaluatesOwnerValue = !directOwner || fieldOperator(unwrapped) === "->";
    const [hazardTargetId = owner.variable.id, ...additionalHazardTargetIds] = fieldAccessHazardIds(
      unwrapped,
      owner.variable,
      context,
    );
    let ownerPlan = evaluatesOwnerValue
      ? collectValue(argument, context, DEFAULT_VALUE_OPTIONS)
      : EMPTY_PLAN;
    if (read) {
      ownerPlan = appendHazardReadsAfterEvaluation(ownerPlan, [
        hazardTargetId,
        ...additionalHazardTargetIds,
      ]);
    }
    return {
      plan: ownerPlan,
      target: owner.variable,
      targetNode: owner.node,
      hazardTargetId,
      additionalHazardTargetIds,
    };
  }
  if (unwrapped.type === "pointer_expression" && pointerOperator(unwrapped) === "*") {
    const argument = unwrapped.childForFieldName("argument");
    if (argument === null) {
      return { plan: blockedPlan("effect-cst-mismatch"), target: null, targetNode: null };
    }
    const resolved = resolveDereferenceTarget(unwrapped, context);
    if (resolved !== null) {
      if (
        resolved.target.storage === "array" &&
        resolved.dimensionsConsumed !== arrayRank(resolved.target, context)
      ) {
        return {
          plan: blockedPlan("unsupported-effect-order"),
          target: null,
          targetNode: null,
        };
      }
      let readPlan = resolved.plan;
      if (read) {
        const appended = appendVariableRead(
          readPlan,
          resolved.target,
          resolved.targetNode,
          context,
          resolved.target.storage === "array" ? "array-element" : useRole,
        );
        readPlan = readPlan.pendingWrites.has(resolved.target.id)
          ? mergeWithBlocker([appended], "unsequenced-conflict")
          : appended;
      }
      return {
        plan: readPlan,
        target: resolved.target,
        targetNode: resolved.targetNode,
      };
    }
    if (containsTrackedAddress(argument, context)) {
      return {
        plan: blockedPlan("unsupported-effect-order"),
        target: null,
        targetNode: null,
      };
    }
    const owner = untrackedOwnerForNode(argument, context);
    if (owner !== null) {
      const [hazardTargetId = OPAQUE_POINTEE_HAZARD, ...additionalHazardTargetIds] =
        pointeeHazardIds(argument, context);
      let ownerPlan = collectValue(argument, context, DEFAULT_VALUE_OPTIONS);
      if (
        containsOpaqueAliasCandidate(argument, context) &&
        mayAliasTrackedArrayParameter(context)
      ) {
        ownerPlan = mergeWithBlocker([ownerPlan], "opaque-alias-effect");
      }
      if (read) {
        ownerPlan = appendHazardReadsAfterEvaluation(ownerPlan, [
          hazardTargetId,
          ...additionalHazardTargetIds,
        ]);
      }
      return {
        plan: ownerPlan,
        target: owner.variable,
        targetNode: owner.node,
        hazardTargetId,
        additionalHazardTargetIds,
      };
    }
  }
  if (unwrapped.type === "subscript_expression") {
    const argument = unwrapped.childForFieldName("argument");
    const index = unwrapped.childForFieldName("index");
    if (argument === null || index === null) {
      return { plan: blockedPlan("effect-cst-mismatch"), target: null, targetNode: null };
    }
    const addressedScalar = resolveAddressedScalarSubscript(argument, index, context);
    if (addressedScalar !== null) {
      const addressedPlan = read
        ? appendVariableRead(
            addressedScalar.plan,
            addressedScalar.target,
            addressedScalar.targetNode,
            context,
            useRole,
          )
        : addressedScalar.plan;
      return {
        plan: addressedPlan,
        target: addressedScalar.target,
        targetNode: addressedScalar.targetNode,
      };
    }
    const target = flattenArrayAccess(unwrapped, context);
    if (target === null) {
      const indexPlan = collectValue(index, context, {
        arrayDecay: "ignore",
        addressUse: "ignore",
        useRole: "index",
      });
      const basePlan = collectValue(argument, context, DEFAULT_VALUE_OPTIONS);
      let unknownTargetPlan = mergeUnsequenced([basePlan, indexPlan]);
      if (
        containsOpaqueAliasCandidate(argument, context) &&
        mayAliasTrackedArrayParameter(context)
      ) {
        unknownTargetPlan = mergeWithBlocker([unknownTargetPlan], "opaque-alias-effect");
      }
      const owner = untrackedOwnerForNode(unwrapped, context);
      const [hazardTargetId, ...additionalHazardTargetIds] =
        owner === null
          ? []
          : pointeeHazardIds(subscriptPointerOperand(argument, index, context), context);
      if (read && hazardTargetId !== undefined) {
        unknownTargetPlan = appendHazardReadsAfterEvaluation(unknownTargetPlan, [
          hazardTargetId,
          ...additionalHazardTargetIds,
        ]);
      }
      return {
        plan: containsTrackedArray(argument, context)
          ? mergeWithBlocker([unknownTargetPlan], "unsupported-effect-order")
          : containsTrackedAddress(argument, context)
            ? mergeWithBlocker([unknownTargetPlan], "unsupported-effect-order")
            : unknownTargetPlan,
        target: owner?.variable ?? null,
        targetNode: owner?.node ?? null,
        hazardTargetId,
        additionalHazardTargetIds,
      };
    }
    const rank = arrayRank(target.variable, context);
    if (target.indices.length !== rank) {
      return {
        plan: blockedPlan("unsupported-effect-order"),
        target: null,
        targetNode: null,
      };
    }
    const indexPlans = target.indices.map((candidate) =>
      collectValue(candidate, context, {
        arrayDecay: "ignore",
        addressUse: "ignore",
        useRole: "index",
      }),
    );
    let evaluation = mergeUnsequenced(indexPlans);
    if (read) {
      const readPlan = appendVariableRead(
        evaluation,
        target.variable,
        target.node,
        context,
        "array-element",
      );
      evaluation = evaluation.pendingWrites.has(target.variable.id)
        ? mergeWithBlocker([readPlan], "unsequenced-conflict")
        : readPlan;
    }
    return {
      plan: evaluation,
      target: target.variable,
      targetNode: target.node,
    };
  }
  const unknownTargetPlan = collectValue(unwrapped, context, DEFAULT_VALUE_OPTIONS);
  const mayAlias =
    (unwrapped.type === "pointer_expression" || unwrapped.type === "subscript_expression") &&
    mayAliasTrackedArrayParameter(context);
  return {
    plan: containsTrackedArray(unwrapped, context)
      ? mergeWithBlocker([unknownTargetPlan], "unsupported-effect-order")
      : mayAlias
        ? mergeWithBlocker([unknownTargetPlan], "opaque-alias-effect")
        : unknownTargetPlan,
    target: null,
    targetNode: null,
  };
}

function collectAddressTarget(node: Node, context: ExtractionContext): LValuePlan {
  const unwrapped = unwrapParentheses(node);
  if (unwrapped.type === "identifier") {
    const target = variableForNode(unwrapped, context);
    return { plan: EMPTY_PLAN, target, targetNode: target === null ? null : unwrapped };
  }
  if (unwrapped.type === "pointer_expression" && pointerOperator(unwrapped) === "*") {
    const resolved = resolveDereferenceTarget(unwrapped, context);
    if (resolved !== null) {
      return {
        plan: resolved.plan,
        target: resolved.target,
        targetNode: resolved.targetNode,
      };
    }
  }
  if (unwrapped.type === "subscript_expression") {
    const argument = unwrapped.childForFieldName("argument");
    const index = unwrapped.childForFieldName("index");
    if (argument === null || index === null) {
      return { plan: blockedPlan("effect-cst-mismatch"), target: null, targetNode: null };
    }
    const target = flattenArrayAccess(unwrapped, context);
    const indexPlan = collectValue(index, context, {
      arrayDecay: "ignore",
      addressUse: "ignore",
      useRole: "index",
    });
    return {
      plan:
        target === null
          ? mergeWithBlocker([indexPlan], "unsupported-effect-order")
          : mergeUnsequenced(
              target.indices.map((candidate) =>
                collectValue(candidate, context, {
                  arrayDecay: "ignore",
                  addressUse: "ignore",
                  useRole: "index",
                }),
              ),
            ),
      target: target?.variable ?? null,
      targetNode: target?.node ?? null,
    };
  }
  return {
    plan: mergeWithBlocker(
      [collectValue(unwrapped, context, DEFAULT_VALUE_OPTIONS)],
      "unsupported-effect-order",
    ),
    target: null,
    targetNode: null,
  };
}

function flattenArrayAccess(node: Node, context: ExtractionContext): ArrayAccessTarget | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "identifier") {
    const variable = variableForNode(candidate, context);
    return variable?.storage === "array" ? { variable, node: candidate, indices: [] } : null;
  }
  if (candidate.type !== "subscript_expression") return null;
  const argument = candidate.childForFieldName("argument");
  const index = candidate.childForFieldName("index");
  if (argument === null || index === null) return null;
  const ordinary = flattenArrayAccess(argument, context);
  if (ordinary !== null) {
    return { ...ordinary, indices: [...ordinary.indices, index] };
  }
  const reversed = flattenArrayAccess(index, context);
  return reversed === null ? null : { ...reversed, indices: [argument, ...reversed.indices] };
}

function resolveDereferenceTarget(
  node: Node,
  context: ExtractionContext,
): DereferenceTarget | null {
  const argument = node.childForFieldName("argument");
  if (argument === null) return null;
  const candidate = unwrapParentheses(argument);
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "&") {
    const addressed = candidate.childForFieldName("argument");
    if (addressed === null) return null;
    const target = collectAddressTarget(addressed, context);
    const arrayAccess = flattenArrayAccess(addressed, context);
    return target.target === null || target.targetNode === null
      ? null
      : {
          plan: target.plan,
          target: target.target,
          targetNode: target.targetNode,
          dimensionsConsumed: arrayAccess?.indices.length ?? 0,
        };
  }
  const addressedScalar = resolveAddressedScalarPointer(candidate, context);
  if (addressedScalar !== null) {
    return { ...addressedScalar, dimensionsConsumed: 0 };
  }
  const pointer = resolveArrayPointerValue(candidate, context);
  return pointer === null
    ? null
    : { ...pointer, dimensionsConsumed: pointer.dimensionsConsumed + 1 };
}

function resolveArrayPointerValue(
  node: Node,
  context: ExtractionContext,
): DereferenceTarget | null {
  const candidate = unwrapParentheses(node);
  const direct = flattenArrayAccess(candidate, context);
  if (direct !== null && direct.indices.length < arrayRank(direct.variable, context)) {
    return {
      plan: mergeUnsequenced(
        direct.indices.map((index) =>
          collectValue(index, context, {
            arrayDecay: "ignore",
            addressUse: "ignore",
            useRole: "index",
          }),
        ),
      ),
      target: direct.variable,
      targetNode: direct.node,
      dimensionsConsumed: direct.indices.length,
    };
  }
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "*") {
    const nested = resolveDereferenceTarget(candidate, context);
    return nested !== null &&
      nested.target.storage === "array" &&
      nested.dimensionsConsumed < arrayRank(nested.target, context)
      ? nested
      : null;
  }
  if (
    candidate.type !== "binary_expression" ||
    candidate.childForFieldName("operator")?.text !== "+"
  ) {
    return null;
  }
  const left = candidate.childForFieldName("left");
  const right = candidate.childForFieldName("right");
  if (left === null || right === null) return null;
  const leftPointer = resolveArrayPointerValue(left, context);
  const rightPointer = resolveArrayPointerValue(right, context);
  if ((leftPointer === null) === (rightPointer === null)) return null;
  const pointer = leftPointer ?? rightPointer;
  const index = leftPointer === null ? left : right;
  if (pointer === null) return null;
  const indexPlan = collectValue(index, context, {
    arrayDecay: "ignore",
    addressUse: "ignore",
    useRole: "index",
  });
  return {
    ...pointer,
    plan: mergeUnsequenced([pointer.plan, indexPlan]),
  };
}

function resolveAddressedScalarSubscript(
  argument: Node,
  index: Node,
  context: ExtractionContext,
): AddressedScalarTarget | null {
  const ordinary = isIntegerZero(index) ? directAddressedObject(argument, context) : null;
  if (ordinary !== null) return ordinary;
  return isIntegerZero(argument) ? directAddressedObject(index, context) : null;
}

function resolveAddressedScalarPointer(
  node: Node,
  context: ExtractionContext,
): AddressedScalarTarget | null {
  if (node.type !== "binary_expression" || node.childForFieldName("operator")?.text !== "+") {
    return null;
  }
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return null;
  const ordinary = isIntegerZero(right) ? directAddressedObject(left, context) : null;
  if (ordinary !== null) return ordinary;
  return isIntegerZero(left) ? directAddressedObject(right, context) : null;
}

function directAddressedObject(
  node: Node,
  context: ExtractionContext,
): AddressedScalarTarget | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "pointer_expression" || pointerOperator(candidate) !== "&") return null;
  const argument = candidate.childForFieldName("argument");
  if (argument === null) return null;
  const target = collectAddressTarget(argument, context);
  return target.target === null || target.targetNode === null || target.target.storage === "array"
    ? null
    : { plan: target.plan, target: target.target, targetNode: target.targetNode };
}

function isIntegerZero(node: Node): boolean {
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "number_literal") return false;
  return /^(?:0+|0[xX]0+)[uUlL]*$/.test(candidate.text);
}

function collectDereferenceRead(
  node: Node,
  argument: Node,
  context: ExtractionContext,
  options: ValueOptions,
): EffectPlan {
  const target = resolveDereferenceTarget(node, context);
  if (target !== null) {
    if (target.target.storage === "array") {
      const rank = arrayRank(target.target, context);
      if (target.dimensionsConsumed > rank) {
        return mergeWithBlocker([target.plan], "unsupported-effect-order");
      }
      if (target.dimensionsConsumed < rank) {
        return mergeUnsequenced([
          target.plan,
          collectIdentifier(target.targetNode, context, options),
        ]);
      }
    }
    const readPlan = appendVariableRead(
      target.plan,
      target.target,
      target.targetNode,
      context,
      target.target.storage === "array" ? "array-element" : options.useRole,
    );
    return target.plan.pendingWrites.has(target.target.id)
      ? mergeWithBlocker([readPlan], "unsequenced-conflict")
      : readPlan;
  }
  let argumentPlan = collectValue(argument, context, DEFAULT_VALUE_OPTIONS);
  const owner = untrackedOwnerForNode(argument, context);
  if (owner !== null) {
    argumentPlan = appendHazardReadsAfterEvaluation(
      argumentPlan,
      pointeeHazardIds(argument, context),
    );
  }
  return containsTrackedArray(argument, context)
    ? mergeWithBlocker([argumentPlan], "unsupported-effect-order")
    : containsTrackedAddress(argument, context)
      ? mergeWithBlocker([argumentPlan], "unsupported-effect-order")
      : containsOpaqueAliasCandidate(argument, context) && mayAliasTrackedArrayParameter(context)
        ? mergeWithBlocker([argumentPlan], "opaque-alias-effect")
        : argumentPlan;
}

function definitionEffect(
  variable: DefUseVariable,
  node: Node,
  context: ExtractionContext,
  origin: DefUseDefinitionEffect["origin"],
): DraftDefinitionEffect {
  return {
    kind: "def",
    variableId: variable.id,
    range: checkedNodeRange(node, context.sourceLength),
    strength: variable.storage === "array" ? "weak" : "strong",
    valueState: "written",
    origin,
  };
}

function useEffect(
  variable: DefUseVariable,
  node: Node,
  context: ExtractionContext,
  role: DefUseUseEffect["role"],
): DraftUseEffect {
  return {
    kind: "use",
    variableId: variable.id,
    range: checkedNodeRange(node, context.sourceLength),
    role,
    execution: "always",
  };
}

function mergeSequential(plans: readonly EffectPlan[]): EffectPlan {
  const effects: DraftEffect[] = [];
  const blockers = new Set<EffectBlocker>();
  for (const candidate of plans) {
    effects.push(...candidate.effects);
    candidate.blockers.forEach((blocker) => blockers.add(blocker));
  }
  return makePlan(effects, blockers, {
    reads: unionSets(plans.map((candidate) => candidate.reads)),
    writes: unionSets(plans.map((candidate) => candidate.writes)),
    ordinaryWrites: unionSets(plans.map((candidate) => candidate.ordinaryWrites)),
    callWrites: unionSets(plans.map((candidate) => candidate.callWrites)),
    pendingWrites: plans.at(-1)?.pendingWrites ?? new Set(),
  });
}

function mergeUnsequenced(plans: readonly EffectPlan[]): EffectPlan {
  const merged = mergeSequential(plans);
  const blockers = new Set(merged.blockers);
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      if (left !== undefined && right !== undefined) {
        if (ordinaryPlansConflict(left, right)) {
          blockers.add("unsequenced-conflict");
        } else if (callPlansConflict(left, right)) {
          blockers.add("unsupported-effect-order");
        }
      }
    }
  }
  return makePlan(merged.effects, blockers, {
    reads: merged.reads,
    writes: merged.writes,
    ordinaryWrites: merged.ordinaryWrites,
    callWrites: merged.callWrites,
    pendingWrites: unionSets(plans.map((candidate) => candidate.pendingWrites)),
  });
}

function mergeIndeterminate(plans: readonly EffectPlan[]): EffectPlan {
  const merged = mergeSequential(plans);
  const blockers = new Set(merged.blockers);
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      if (left !== undefined && right !== undefined && plansConflict(left, right)) {
        blockers.add("unsupported-effect-order");
      }
    }
  }
  return makePlan(merged.effects, blockers, {
    reads: merged.reads,
    writes: merged.writes,
    ordinaryWrites: merged.ordinaryWrites,
    callWrites: merged.callWrites,
    pendingWrites: unionSets(plans.map((candidate) => candidate.pendingWrites)),
  });
}

function ordinaryPlansConflict(left: EffectPlan, right: EffectPlan): boolean {
  return (
    intersects(left.ordinaryWrites, unionSets([right.reads, right.ordinaryWrites])) ||
    intersects(right.ordinaryWrites, unionSets([left.reads, left.ordinaryWrites]))
  );
}

function callPlansConflict(left: EffectPlan, right: EffectPlan): boolean {
  return (
    intersects(left.callWrites, unionSets([right.reads, right.writes])) ||
    intersects(right.callWrites, unionSets([left.reads, left.writes]))
  );
}

function plansConflict(left: EffectPlan, right: EffectPlan): boolean {
  return (
    intersects(left.writes, unionSets([right.reads, right.writes])) ||
    intersects(right.writes, unionSets([left.reads, left.writes]))
  );
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function conditionalizeUses(candidate: EffectPlan): EffectPlan {
  return makePlan(
    candidate.effects.map((effect) =>
      effect.kind === "use" ? { ...effect, execution: "conditional" } : effect,
    ),
    candidate.blockers,
    candidate,
  );
}

function appendEffect(candidate: EffectPlan, effect: DraftEffect): EffectPlan {
  const footprint = footprintForEffects([effect]);
  return makePlan([...candidate.effects, effect], candidate.blockers, {
    reads: unionSets([candidate.reads, footprint.reads]),
    writes: unionSets([candidate.writes, footprint.writes]),
    ordinaryWrites: unionSets([candidate.ordinaryWrites, footprint.writes]),
    callWrites: candidate.callWrites,
    pendingWrites: unionSets([candidate.pendingWrites, footprint.writes]),
  });
}

function appendVariableWrite(
  candidate: EffectPlan,
  variable: DefUseVariable,
  node: Node,
  context: ExtractionContext,
  origin: DefUseDefinitionEffect["origin"],
  hazardTargetId?: string,
): EffectPlan {
  if (variable.tracking !== "untracked") {
    return appendEffect(candidate, definitionEffect(variable, node, context, origin));
  }
  return appendVariableHazardWrite(candidate, hazardTargetId ?? variable.id);
}

function appendLValueWrite(
  candidate: EffectPlan,
  lvalue: LValuePlan,
  context: ExtractionContext,
  origin: DefUseDefinitionEffect["origin"],
): EffectPlan {
  if (lvalue.target === null || lvalue.targetNode === null) return candidate;
  let output = appendVariableWrite(
    candidate,
    lvalue.target,
    lvalue.targetNode,
    context,
    origin,
    lvalue.hazardTargetId,
  );
  for (const hazardId of lvalue.additionalHazardTargetIds ?? []) {
    if (hazardId !== lvalue.hazardTargetId) {
      output = appendVariableHazardWrite(output, hazardId);
    }
  }
  return output;
}

function appendVariableRead(
  candidate: EffectPlan,
  variable: DefUseVariable,
  node: Node,
  context: ExtractionContext,
  role: DefUseUseEffect["role"],
): EffectPlan {
  if (variable.tracking !== "untracked") {
    return appendEffect(candidate, useEffect(variable, node, context, role));
  }
  const read = hazardPlan(variable.id, "read");
  return makePlan(candidate.effects, candidate.blockers, {
    reads: unionSets([candidate.reads, read.reads]),
    writes: candidate.writes,
    ordinaryWrites: candidate.ordinaryWrites,
    callWrites: candidate.callWrites,
    pendingWrites: candidate.pendingWrites,
  });
}

function appendHazardRead(candidate: EffectPlan, hazardId: string): EffectPlan {
  const read = hazardPlan(hazardId, "read");
  return makePlan(candidate.effects, candidate.blockers, {
    reads: unionSets([candidate.reads, read.reads]),
    writes: candidate.writes,
    ordinaryWrites: candidate.ordinaryWrites,
    callWrites: candidate.callWrites,
    pendingWrites: candidate.pendingWrites,
  });
}

function appendHazardReadAfterEvaluation(candidate: EffectPlan, hazardId: string): EffectPlan {
  const readPlan = appendHazardRead(candidate, hazardId);
  return candidate.pendingWrites.has(hazardId)
    ? mergeWithBlocker([readPlan], "unsequenced-conflict")
    : readPlan;
}

function appendHazardReadsAfterEvaluation(
  candidate: EffectPlan,
  hazardIds: readonly string[],
): EffectPlan {
  const uniqueIds = [...new Set(hazardIds)];
  const readPlan = uniqueIds.reduce(
    (current, hazardId) => appendHazardRead(current, hazardId),
    candidate,
  );
  return uniqueIds.some((hazardId) => candidate.pendingWrites.has(hazardId))
    ? mergeWithBlocker([readPlan], "unsequenced-conflict")
    : readPlan;
}

function appendVariableHazardWrite(candidate: EffectPlan, variableId: string): EffectPlan {
  const write = hazardPlan(variableId, "write");
  return makePlan(candidate.effects, candidate.blockers, {
    reads: candidate.reads,
    writes: unionSets([candidate.writes, write.writes]),
    ordinaryWrites: unionSets([candidate.ordinaryWrites, write.writes]),
    callWrites: candidate.callWrites,
    pendingWrites: unionSets([candidate.pendingWrites, write.pendingWrites]),
  });
}

function mergeWithBlocker(plans: readonly EffectPlan[], blocker: EffectBlocker): EffectPlan {
  const merged = mergeSequential(plans);
  return makePlan(merged.effects, new Set([...merged.blockers, blocker]), merged);
}

function blockedPlan(blocker: EffectBlocker): EffectPlan {
  return makePlan([], new Set([blocker]));
}

function plan(effects: readonly DraftEffect[]): EffectPlan {
  return makePlan(effects, new Set());
}

function makePlan(
  effects: readonly DraftEffect[],
  blockers: ReadonlySet<EffectBlocker>,
  footprint?: {
    readonly reads: ReadonlySet<string>;
    readonly writes: ReadonlySet<string>;
    readonly ordinaryWrites: ReadonlySet<string>;
    readonly callWrites: ReadonlySet<string>;
    readonly pendingWrites: ReadonlySet<string>;
  },
): EffectPlan {
  const derived = footprintForEffects(effects);
  return {
    effects,
    blockers,
    reads: footprint?.reads ?? derived.reads,
    writes: footprint?.writes ?? derived.writes,
    ordinaryWrites: footprint?.ordinaryWrites ?? derived.writes,
    callWrites: footprint?.callWrites ?? new Set(),
    pendingWrites: footprint?.pendingWrites ?? derived.writes,
  };
}

function hasModification(candidate: EffectPlan): boolean {
  return candidate.writes.size > 0 || candidate.effects.some((effect) => effect.kind === "escape");
}

function footprintForEffects(effects: readonly DraftEffect[]): {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
} {
  return {
    reads: new Set(
      effects.filter((effect) => effect.kind === "use").map((effect) => effect.variableId),
    ),
    writes: new Set(
      effects.filter((effect) => effect.kind === "def").map((effect) => effect.variableId),
    ),
  };
}

function unionSets(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function hazardPlan(variableId: string, mode: "read" | "write"): EffectPlan {
  const values = new Set([variableId]);
  return makePlan([], new Set(), {
    reads: mode === "read" ? values : new Set(),
    writes: mode === "write" ? values : new Set(),
    ordinaryWrites: mode === "write" ? values : new Set(),
    callWrites: new Set(),
    pendingWrites: mode === "write" ? values : new Set(),
  });
}

function markWritesAsCall(candidate: EffectPlan): EffectPlan {
  return makePlan(candidate.effects, candidate.blockers, {
    reads: candidate.reads,
    writes: candidate.writes,
    ordinaryWrites: new Set(),
    callWrites: unionSets([candidate.ordinaryWrites, candidate.callWrites]),
    pendingWrites: candidate.pendingWrites,
  });
}

function withPendingWritesCleared(candidate: EffectPlan): EffectPlan {
  return makePlan(candidate.effects, candidate.blockers, {
    reads: candidate.reads,
    writes: candidate.writes,
    ordinaryWrites: candidate.ordinaryWrites,
    callWrites: candidate.callWrites,
    pendingWrites: new Set(),
  });
}

function freezeFact(node: CfgNode, drafts: readonly DraftEffect[]): DefUseFact {
  const effects = Object.freeze(
    drafts.map(
      (draft, index): DefUseEffect =>
        Object.freeze({
          id: `effect:${node.id}:${String(index)}:${draft.kind}`,
          ...draft,
        }) as DefUseEffect,
    ),
  );
  return Object.freeze({ nodeId: node.id, nodeRange: node.range, effects });
}

function deduplicatePostCallEffects(effects: readonly DraftEffect[]): readonly DraftEffect[] {
  const seen = new Set<string>();
  return effects.filter((effect) => {
    const key = `${effect.kind}:${effect.variableId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildBindingIndex(
  document: SourceDoc,
  functionRange: TextRange,
  variables: readonly DefUseVariable[],
  functionNode: Node,
): BindingIndex {
  const variableById = new Map(variables.map((variable) => [variable.id, variable]));
  const symbolById = new Map(document.symbols.symbols.map((symbol) => [symbol.id, symbol]));
  const variableBySymbolId = new Map<string, DefUseVariable>();
  for (const symbol of document.symbols.symbols) {
    if (symbol.kind !== "parameter" && symbol.kind !== "local-variable") continue;
    const declarations = symbol.declarationRanges
      .filter((range) => containsRange(functionRange, range))
      .sort((left, right) => left.from - right.from || left.to - right.to);
    const first = declarations[0];
    if (first === undefined) continue;
    const kind = symbol.kind === "parameter" ? "parameter" : "local";
    const variable = variableById.get(`variable:${kind}:${first.from}:${first.to}`);
    if (variable !== undefined) variableBySymbolId.set(symbol.id, variable);
  }
  const variableByOccurrenceRange = new Map<string, DefUseVariable>();
  const symbolByOccurrenceRange = new Map<string, SymbolRecord>();
  for (const occurrence of document.symbols.occurrences) {
    const occurrenceRange = rangeKey(occurrence.range);
    const symbol = symbolById.get(occurrence.symbolId);
    if (symbol !== undefined && containsRange(functionRange, occurrence.range)) {
      symbolByOccurrenceRange.set(occurrenceRange, symbol);
    }
    const variable = variableBySymbolId.get(occurrence.symbolId);
    if (variable !== undefined && containsRange(functionRange, occurrence.range)) {
      variableByOccurrenceRange.set(occurrenceRange, variable);
    }
  }
  const declarationNodeByRange = new Map<string, Node>();
  for (const identifier of functionNode.descendantsOfType("identifier")) {
    const range = checkedNodeRange(identifier, document.source.length);
    if (
      variables.some((variable) =>
        variable.declarationRanges.some((item) => sameRange(item, range)),
      )
    ) {
      declarationNodeByRange.set(rangeKey(range), identifier);
    }
  }
  return { variableByOccurrenceRange, declarationNodeByRange, symbolByOccurrenceRange };
}

function collectPointerAliasInStates(
  cfg: FunctionCfg,
  context: ExtractionContext,
): ReadonlyMap<string, PointerAliasState> {
  const nodesById = new Map(cfg.nodes.map((node) => [node.id, node]));
  const successors = new Map<string, string[]>();
  for (const edge of cfg.edges) {
    const values = successors.get(edge.from) ?? [];
    if (!values.includes(edge.to)) values.push(edge.to);
    successors.set(edge.from, values);
  }
  const initial = new Map<string, PointerAliasValue>();
  for (const variable of context.variables) {
    if (variable.storage === "pointer") initial.set(variable.id, unknownPointerAlias());
  }
  const inByNodeId = new Map<string, PointerAliasState>([[cfg.entryId, initial]]);
  const outByNodeId = new Map<string, PointerAliasState>();
  const queue = [cfg.entryId];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    queued.delete(nodeId);
    const node = nodesById.get(nodeId);
    if (node === undefined) continue;
    const input = inByNodeId.get(nodeId) ?? EMPTY_POINTER_ALIAS_STATE;
    const output = transferPointerAliases(node, input, context);
    const previousOutput = outByNodeId.get(nodeId);
    if (previousOutput !== undefined && pointerAliasStatesEqual(previousOutput, output)) continue;
    outByNodeId.set(nodeId, output);
    for (const successorId of successors.get(nodeId) ?? []) {
      const successor = nodesById.get(successorId);
      if (successor === undefined || (!successor.reachable && successor.id !== cfg.exitId))
        continue;
      const previousInput = inByNodeId.get(successorId);
      const nextInput =
        previousInput === undefined ? output : joinPointerAliasStates(previousInput, output);
      if (previousInput !== undefined && pointerAliasStatesEqual(previousInput, nextInput))
        continue;
      inByNodeId.set(successorId, nextInput);
      if (!queued.has(successorId)) {
        queue.push(successorId);
        queued.add(successorId);
      }
    }
  }
  return inByNodeId;
}

function transferPointerAliases(
  cfgNode: CfgNode,
  input: PointerAliasState,
  context: ExtractionContext,
): PointerAliasState {
  const payload = aliasPayloadForCfgNode(cfgNode, context);
  if (payload === null) return input;
  if (payload.type === "declaration") {
    return transferPointerDeclaration(payload, input, context);
  }
  if (payload.type === "type_definition") {
    return transferPointerTypeDefinition(payload, input, context);
  }
  return transferPointerExpression(payload, input, context);
}

function aliasPayloadForCfgNode(cfgNode: CfgNode, context: ExtractionContext): Node | null {
  if (cfgNode.kind === "entry" || cfgNode.kind === "exit") return null;
  if (cfgNode.kind === "control") {
    const ownerType = cfgNode.nodeType === "do_condition" ? "do_statement" : "for_statement";
    const owner = uniqueNode(
      context.nodes.byRangeAndType.get(nodeTypeKey(cfgNode.ownerBlockRange, ownerType)),
    );
    if (owner === null) return null;
    const field =
      cfgNode.nodeType === "for_initializer"
        ? "initializer"
        : cfgNode.nodeType === "for_update"
          ? "update"
          : cfgNode.nodeType === "do_condition"
            ? "condition"
            : null;
    return field === null ? null : owner.childForFieldName(field);
  }
  const syntax = uniqueNode(
    context.nodes.byRangeAndType.get(nodeTypeKey(cfgNode.range, cfgNode.nodeType)),
  );
  if (syntax === null) return null;
  if (syntax.type === "declaration" || syntax.type === "type_definition") return syntax;
  if (syntax.type === "expression_statement" || syntax.type === "return_statement") {
    const children = namedChildren(syntax);
    return children.length === 1 ? (children[0] ?? null) : null;
  }
  if (
    syntax.type === "if_statement" ||
    syntax.type === "while_statement" ||
    syntax.type === "for_statement" ||
    syntax.type === "switch_statement"
  ) {
    return syntax.childForFieldName("condition");
  }
  return null;
}

function transferPointerDeclaration(
  declaration: Node,
  input: PointerAliasState,
  context: ExtractionContext,
): PointerAliasState {
  const declarationRange = checkedNodeRange(declaration, context.sourceLength);
  const entries = context.variables
    .filter((variable) =>
      variable.declarationRanges.some((range) => containsRange(declarationRange, range)),
    )
    .map((variable) => ({ variable, range: variable.declarationRanges[0] }))
    .filter(
      (entry): entry is { variable: DefUseVariable; range: TextRange } => entry.range !== undefined,
    )
    .sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
  let output = input;
  for (const { variable, range } of entries) {
    const nameNode = context.bindings.declarationNodeByRange.get(rangeKey(range));
    if (nameNode === undefined) continue;
    const sizes = arraySizeExpressions(nameNode, declaration).sort(
      (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
    );
    if (sizes.length > 0) {
      output = sizes
        .map((size) => transferPointerExpression(size, output, context))
        .reduce(joinPointerAliasStates);
    }
    const initializer = nearestInitializer(nameNode, declaration);
    const initializerOutput =
      initializer === null ? output : transferPointerExpression(initializer, output, context);
    output = initializerOutput;
    if (variable.storage === "pointer") {
      const value =
        initializer === null
          ? unknownPointerAlias()
          : resolvePointerAliasValue(initializer, initializerOutput, context);
      output = setPointerAlias(output, variable.id, value);
    }
    if (initializer !== null) {
      output = invalidateAddressedPointers(initializer, output, context);
    }
  }
  return output;
}

function transferPointerTypeDefinition(
  definition: Node,
  input: PointerAliasState,
  context: ExtractionContext,
): PointerAliasState {
  const bounds = definition.namedChildren
    .filter((_child, index) => definition.fieldNameForNamedChild(index) === "declarator")
    .flatMap(arraySizeExpressionsWithin)
    .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  return bounds.reduce((state, bound) => transferPointerExpression(bound, state, context), input);
}

function transferPointerExpression(
  node: Node,
  input: PointerAliasState,
  context: ExtractionContext,
): PointerAliasState {
  const candidate = unwrapParentheses(node);
  if (
    candidate.type === "sizeof_expression" ||
    candidate.type === "alignof_expression" ||
    candidate.type === "offsetof_expression" ||
    candidate.type === "generic_expression" ||
    candidate.type === "typeof_expression"
  ) {
    return input;
  }
  if (candidate.type === "assignment_expression") {
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    const operator = candidate.childForFieldName("operator")?.text;
    if (left === null || right === null || operator === undefined) return input;
    const rightOutput = transferPointerExpression(right, input, context);
    const pointer = directPointerLValue(left, rightOutput, context);
    let output = rightOutput;
    if (pointer !== null) {
      output = setPointerAlias(
        output,
        pointer.id,
        operator === "="
          ? resolvePointerAliasValue(right, rightOutput, context)
          : operator === "+=" || operator === "-="
            ? (rightOutput.get(pointer.id) ?? unknownPointerAlias())
            : unknownPointerAlias(),
      );
    } else {
      output = joinPointerAliasStates(transferPointerExpression(left, input, context), rightOutput);
    }
    return invalidateAddressedPointers(right, output, context);
  }
  if (candidate.type === "update_expression") {
    const argument = candidate.childForFieldName("argument");
    return argument === null ? input : transferPointerExpression(argument, input, context);
  }
  if (candidate.type === "comma_expression") {
    return namedChildren(candidate).reduce(
      (state, child) => transferPointerExpression(child, state, context),
      input,
    );
  }
  if (candidate.type === "conditional_expression") {
    const condition = candidate.childForFieldName("condition");
    const consequence = candidate.childForFieldName("consequence");
    const alternative = candidate.childForFieldName("alternative");
    if (condition === null || consequence === null || alternative === null) return input;
    const conditionOutput = transferPointerExpression(condition, input, context);
    return joinPointerAliasStates(
      transferPointerExpression(consequence, conditionOutput, context),
      transferPointerExpression(alternative, conditionOutput, context),
    );
  }
  if (candidate.type === "binary_expression") {
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    if (left === null || right === null) return input;
    if (["&&", "||"].includes(candidate.childForFieldName("operator")?.text ?? "")) {
      const leftOutput = transferPointerExpression(left, input, context);
      return joinPointerAliasStates(
        leftOutput,
        transferPointerExpression(right, leftOutput, context),
      );
    }
    return joinPointerAliasStates(
      input,
      joinPointerAliasStates(
        transferPointerExpression(left, input, context),
        transferPointerExpression(right, input, context),
      ),
    );
  }
  if (candidate.type === "call_expression") {
    const callee = candidate.childForFieldName("function");
    const argumentsNode = candidate.childForFieldName("arguments");
    if (callee === null || argumentsNode === null) return input;
    const parts = [callee, ...namedChildren(argumentsNode)];
    let output = parts
      .map((part) => transferPointerExpression(part, input, context))
      .reduce(joinPointerAliasStates);
    for (const part of parts) {
      output = invalidateAddressedPointers(part, output, context);
    }
    return output;
  }
  const children = namedChildren(candidate);
  if (children.length === 1 && children[0] !== undefined) {
    return transferPointerExpression(children[0], input, context);
  }
  if (children.length > 1) {
    return children.reduce(
      (state, child) =>
        joinPointerAliasStates(state, transferPointerExpression(child, input, context)),
      input,
    );
  }
  return input;
}

function resolvePointerAliasValue(
  node: Node,
  state: PointerAliasState,
  context: ExtractionContext,
): PointerAliasValue {
  let candidate = unwrapParentheses(node);
  while (candidate.type === "cast_expression") {
    const value = candidate.childForFieldName("value");
    if (value === null) return unknownPointerAlias();
    candidate = unwrapParentheses(value);
  }
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "&") {
    const argument = candidate.childForFieldName("argument");
    return argument === null
      ? unknownPointerAlias()
      : resolveAddressedAliasValue(argument, state, context);
  }
  if (candidate.type === "identifier") {
    const variable = variableForNode(candidate, context);
    if (variable?.storage === "array") {
      return exactPointerAlias(variable.id);
    }
    if (variable?.storage === "pointer") {
      return state.get(variable.id) ?? unknownPointerAlias();
    }
    return unknownPointerAlias();
  }
  if (candidate.type === "assignment_expression") {
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    const operator = candidate.childForFieldName("operator")?.text;
    if (left === null || right === null || operator === undefined) return unknownPointerAlias();
    const rightOutput = transferPointerExpression(right, state, context);
    if (operator === "=") return resolvePointerAliasValue(right, rightOutput, context);
    const pointer = directPointerLValue(left, rightOutput, context);
    return pointer === null
      ? unknownPointerAlias()
      : (rightOutput.get(pointer.id) ?? unknownPointerAlias());
  }
  if (candidate.type === "binary_expression") {
    const operator = candidate.childForFieldName("operator")?.text;
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    if (left === null || right === null || (operator !== "+" && operator !== "-")) {
      return unknownPointerAlias();
    }
    const stateContext = { ...context, pointerAliases: state };
    const leftPointer = expressionMayBePointer(left, stateContext);
    const rightPointer = expressionMayBePointer(right, stateContext);
    if (leftPointer && !rightPointer) return resolvePointerAliasValue(left, state, context);
    if (operator === "+" && rightPointer && !leftPointer) {
      return resolvePointerAliasValue(right, state, context);
    }
    return unknownPointerAlias();
  }
  if (candidate.type === "comma_expression") {
    const children = namedChildren(candidate);
    const last = children.at(-1);
    if (last === undefined) return unknownPointerAlias();
    const lastInput = children
      .slice(0, -1)
      .reduce((current, child) => transferPointerExpression(child, current, context), state);
    return resolvePointerAliasValue(last, lastInput, context);
  }
  if (candidate.type === "conditional_expression") {
    const condition = candidate.childForFieldName("condition");
    const consequence = candidate.childForFieldName("consequence");
    const alternative = candidate.childForFieldName("alternative");
    if (condition === null || consequence === null || alternative === null) {
      return unknownPointerAlias();
    }
    const branchInput = transferPointerExpression(condition, state, context);
    return joinPointerAliasValues(
      resolvePointerAliasValue(consequence, branchInput, context),
      resolvePointerAliasValue(alternative, branchInput, context),
    );
  }
  return isIntegerZero(candidate) ? knownEmptyPointerAlias() : unknownPointerAlias();
}

function subscriptPointerOperand(argument: Node, index: Node, context: ExtractionContext): Node {
  const argumentIsPointer = expressionMayBePointer(argument, context);
  const indexIsPointer = expressionMayBePointer(index, context);
  return indexIsPointer && !argumentIsPointer ? index : argument;
}

function resolveAddressedAliasValue(
  node: Node,
  state: PointerAliasState,
  context: ExtractionContext,
): PointerAliasValue {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "*") {
    const argument = candidate.childForFieldName("argument");
    return argument === null
      ? unknownPointerAlias()
      : resolvePointerAliasValue(argument, state, context);
  }
  if (candidate.type === "subscript_expression") {
    const argument = candidate.childForFieldName("argument");
    const index = candidate.childForFieldName("index");
    if (argument === null || index === null) return unknownPointerAlias();
    const direct = addressedRootVariable(candidate, context.bindings);
    if (direct !== null) return exactPointerAlias(direct.id);
    const stateContext = { ...context, pointerAliases: state };
    if (expressionMayBePointer(argument, stateContext)) {
      return resolvePointerAliasValue(argument, state, context);
    }
    if (expressionMayBePointer(index, stateContext)) {
      return resolvePointerAliasValue(index, state, context);
    }
    return unknownPointerAlias();
  }
  const target = addressedRootVariable(candidate, context.bindings);
  return target === null ? unknownPointerAlias() : exactPointerAlias(target.id);
}

function directPointerVariable(node: Node, context: ExtractionContext): DefUseVariable | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "identifier") return null;
  const variable = variableForNode(candidate, context);
  return variable?.storage === "pointer" ? variable : null;
}

function directPointerLValue(
  node: Node,
  state: PointerAliasState,
  context: ExtractionContext,
): DefUseVariable | null {
  const direct = directPointerVariable(node, context);
  if (direct !== null) return direct;
  const candidate = unwrapParentheses(node);
  const stateContext: ExtractionContext = { ...context, pointerAliases: state };
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "*") {
    const resolved = resolveDereferenceTarget(candidate, stateContext);
    return resolved?.dimensionsConsumed === 0 && resolved.target.storage === "pointer"
      ? resolved.target
      : null;
  }
  if (candidate.type === "subscript_expression") {
    const argument = candidate.childForFieldName("argument");
    const index = candidate.childForFieldName("index");
    const resolved =
      argument === null || index === null
        ? null
        : resolveAddressedScalarSubscript(argument, index, stateContext);
    return resolved?.target.storage === "pointer" ? resolved.target : null;
  }
  return null;
}

function invalidateAddressedPointers(
  node: Node,
  input: PointerAliasState,
  context: ExtractionContext,
): PointerAliasState {
  const addresses =
    node.type === "pointer_expression" ? [node] : node.descendantsOfType("pointer_expression");
  let output = input;
  for (const address of addresses) {
    if (pointerOperator(address) !== "&") continue;
    const argument = address.childForFieldName("argument");
    if (argument === null) continue;
    const pointer = directPointerVariable(argument, context);
    if (pointer === null) continue;
    const current = output.get(pointer.id) ?? unknownPointerAlias();
    output = setPointerAlias(output, pointer.id, {
      targetIds: current.targetIds,
      unknown: true,
    });
  }
  return output;
}

function setPointerAlias(
  input: PointerAliasState,
  pointerId: string,
  value: PointerAliasValue,
): PointerAliasState {
  const output = new Map(input);
  output.set(pointerId, {
    targetIds: new Set(value.targetIds),
    unknown: value.unknown,
  });
  return output;
}

function joinPointerAliasStates(
  left: PointerAliasState,
  right: PointerAliasState,
): PointerAliasState {
  const output = new Map<string, PointerAliasValue>();
  for (const pointerId of new Set([...left.keys(), ...right.keys()])) {
    const leftValue = left.get(pointerId);
    const rightValue = right.get(pointerId);
    if (leftValue === undefined) {
      if (rightValue !== undefined) output.set(pointerId, rightValue);
      continue;
    }
    output.set(
      pointerId,
      rightValue === undefined ? leftValue : joinPointerAliasValues(leftValue, rightValue),
    );
  }
  return output;
}

function joinPointerAliasValues(
  left: PointerAliasValue,
  right: PointerAliasValue,
): PointerAliasValue {
  return {
    targetIds: new Set([...left.targetIds, ...right.targetIds]),
    unknown: left.unknown || right.unknown,
  };
}

function pointerAliasStatesEqual(left: PointerAliasState, right: PointerAliasState): boolean {
  if (left.size !== right.size) return false;
  for (const [pointerId, leftValue] of left) {
    const rightValue = right.get(pointerId);
    if (
      rightValue === undefined ||
      leftValue.unknown !== rightValue.unknown ||
      leftValue.targetIds.size !== rightValue.targetIds.size ||
      [...leftValue.targetIds].some((targetId) => !rightValue.targetIds.has(targetId))
    ) {
      return false;
    }
  }
  return true;
}

function exactPointerAlias(targetId: string): PointerAliasValue {
  return { targetIds: new Set([targetId]), unknown: false };
}

function knownEmptyPointerAlias(): PointerAliasValue {
  return { targetIds: new Set(), unknown: false };
}

function unknownPointerAlias(): PointerAliasValue {
  return { targetIds: new Set(), unknown: true };
}

function addressedRootVariable(node: Node, bindings: BindingIndex): DefUseVariable | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "identifier") return bindingVariableForNode(candidate, bindings);
  if (candidate.type === "field_expression" || candidate.type === "subscript_expression") {
    const argument = candidate.childForFieldName("argument");
    return argument === null ? null : addressedRootVariable(argument, bindings);
  }
  return null;
}

function bindingVariableForNode(node: Node, bindings: BindingIndex): DefUseVariable | null {
  return (
    bindings.variableByOccurrenceRange.get(rangeKey(textRange(node.startIndex, node.endIndex))) ??
    null
  );
}

function buildNodeIndex(functionNode: Node): NodeIndex {
  const byRangeAndType = new Map<string, Node[]>();
  const visit = (node: Node): void => {
    if (!node.isNamed) return;
    const range = textRange(node.startIndex, node.endIndex);
    pushMap(byRangeAndType, nodeTypeKey(range, node.type), node);
    node.namedChildren.forEach(visit);
  };
  visit(functionNode);
  return { byRangeAndType };
}

function pushMap(map: Map<string, Node[]>, key: string, node: Node): void {
  const values = map.get(key) ?? [];
  values.push(node);
  map.set(key, values);
}

function trackedVariableForNode(node: Node, context: ExtractionContext): DefUseVariable | null {
  const variable = variableForNode(node, context);
  return variable?.tracking === "untracked" ? null : variable;
}

function variableForNode(node: Node, context: ExtractionContext): DefUseVariable | null {
  return (
    context.bindings.variableByOccurrenceRange.get(
      rangeKey(checkedNodeRange(node, context.sourceLength)),
    ) ?? null
  );
}

function pointeeHazardIds(node: Node, context: ExtractionContext): readonly string[] {
  const aliases = resolvePointerAliasValue(node, context.pointerAliases, context);
  const output = new Set(aliases.targetIds);
  if (output.size === 0 || aliases.unknown) output.add(OPAQUE_POINTEE_HAZARD);
  return [...output];
}

function isUnshadowedSpecialCall(node: Node, context: ExtractionContext): boolean {
  const symbol = context.bindings.symbolByOccurrenceRange.get(
    rangeKey(checkedNodeRange(node, context.sourceLength)),
  );
  return (
    symbol === undefined || symbol.kind === "unknown-external" || symbol.kind === "builtin-function"
  );
}

function containsTrackedIdentifier(node: Node, context: ExtractionContext): boolean {
  const identifiers = node.type === "identifier" ? [node] : node.descendantsOfType("identifier");
  return identifiers.some((identifier) => trackedVariableForNode(identifier, context) !== null);
}

function containsBoundVariable(node: Node, context: ExtractionContext): boolean {
  const identifiers = node.type === "identifier" ? [node] : node.descendantsOfType("identifier");
  return identifiers.some((identifier) => variableForNode(identifier, context) !== null);
}

function containsBoundTypeDescriptor(node: Node, context: ExtractionContext): boolean {
  const descriptors =
    node.type === "type_descriptor" ? [node] : node.descendantsOfType("type_descriptor");
  return descriptors.some((descriptor) => containsBoundVariable(descriptor, context));
}

function expressionMayBePointer(node: Node, context: ExtractionContext): boolean {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "&") return true;
  if (candidate.type === "field_expression" || candidate.type === "call_expression") return true;
  if (candidate.type === "cast_expression") {
    const type = candidate.childForFieldName("type");
    return type?.descendantsOfType("pointer_declarator").length !== 0;
  }
  if (candidate.type === "identifier") {
    const variable = variableForNode(candidate, context);
    return (
      variable?.storage === "array" ||
      variable?.storage === "pointer" ||
      variable?.storage === "unknown"
    );
  }
  if (candidate.type === "binary_expression") {
    const operator = candidate.childForFieldName("operator")?.text;
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    if (left === null || right === null) return false;
    const leftPointer = expressionMayBePointer(left, context);
    const rightPointer = expressionMayBePointer(right, context);
    if (operator === "+") return leftPointer || rightPointer;
    if (operator === "-") return leftPointer && !rightPointer;
  }
  if (candidate.type === "conditional_expression") {
    const consequence = candidate.childForFieldName("consequence");
    const alternative = candidate.childForFieldName("alternative");
    return (
      consequence !== null &&
      alternative !== null &&
      (expressionMayBePointer(consequence, context) || expressionMayBePointer(alternative, context))
    );
  }
  if (candidate.type === "comma_expression") {
    const last = namedChildren(candidate).at(-1);
    return last !== undefined && expressionMayBePointer(last, context);
  }
  const array = flattenArrayAccess(candidate, context);
  return array !== null && array.indices.length < arrayRank(array.variable, context);
}

function containsTrackedArray(node: Node, context: ExtractionContext): boolean {
  const identifiers = node.type === "identifier" ? [node] : node.descendantsOfType("identifier");
  return identifiers.some(
    (identifier) => trackedVariableForNode(identifier, context)?.storage === "array",
  );
}

function containsTrackedAddress(node: Node, context: ExtractionContext): boolean {
  const pointers =
    node.type === "pointer_expression" ? [node] : node.descendantsOfType("pointer_expression");
  return pointers.some((pointer) => {
    if (pointerOperator(pointer) !== "&") return false;
    const argument = pointer.childForFieldName("argument");
    return argument !== null && containsTrackedIdentifier(argument, context);
  });
}

function containsPointerResultAssignment(node: Node, context: ExtractionContext): boolean {
  const assignments =
    node.type === "assignment_expression"
      ? [node]
      : node.descendantsOfType("assignment_expression");
  return assignments.some(
    (assignment) =>
      containsTrackedAddress(assignment, context) || containsTrackedArray(assignment, context),
  );
}

function mayAliasTrackedArrayParameter(context: ExtractionContext): boolean {
  return context.variables.some(
    (variable) =>
      variable.kind === "parameter" &&
      variable.storage === "array" &&
      variable.tracking !== "untracked",
  );
}

function arrayRank(variable: DefUseVariable, context: ExtractionContext): number {
  const declaration = variable.declarationRanges[0];
  const nameNode =
    declaration === undefined
      ? undefined
      : context.bindings.declarationNodeByRange.get(rangeKey(declaration));
  if (nameNode === undefined) return 1;
  let rank = 0;
  let current = nameNode.parent;
  while (current !== null) {
    if (current.type === "array_declarator") rank += 1;
    if (current.type === "declaration" || current.type === "parameter_declaration") break;
    current = current.parent;
  }
  return Math.max(rank, 1);
}

function containsOpaqueAliasCandidate(node: Node, context: ExtractionContext): boolean {
  if (node.type === "field_expression" || node.descendantsOfType("field_expression").length > 0) {
    return true;
  }
  const identifiers = node.type === "identifier" ? [node] : node.descendantsOfType("identifier");
  return identifiers.some((identifier) => {
    const variable = variableForNode(identifier, context);
    if (variable === null) return true;
    return (
      variable.tracking === "untracked" &&
      (variable.storage === "pointer" ||
        variable.storage === "unknown" ||
        variable.storage === "aggregate")
    );
  });
}

function untrackedOwnerForNode(
  node: Node,
  context: ExtractionContext,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  const identifiers = node.type === "identifier" ? [node] : node.descendantsOfType("identifier");
  for (const identifier of identifiers) {
    const variable = variableForNode(identifier, context);
    if (variable?.tracking === "untracked") return { variable, node: identifier };
  }
  return null;
}

function fieldOwnerForNode(
  node: Node,
  context: ExtractionContext,
): { readonly variable: DefUseVariable; readonly node: Node } | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "identifier") return untrackedOwnerForNode(candidate, context);
  if (candidate.type === "field_expression") {
    const argument = candidate.childForFieldName("argument");
    return argument === null ? null : fieldOwnerForNode(argument, context);
  }
  if (candidate.type === "subscript_expression") {
    const argument = candidate.childForFieldName("argument");
    return argument === null ? null : untrackedOwnerForNode(argument, context);
  }
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "*") {
    const argument = candidate.childForFieldName("argument");
    return argument === null ? null : untrackedOwnerForNode(argument, context);
  }
  return null;
}

function lvalueTargetIds(lvalue: LValuePlan): readonly string[] {
  const primary = lvalue.hazardTargetId ?? lvalue.target?.id;
  return primary === undefined
    ? []
    : [...new Set([primary, ...(lvalue.additionalHazardTargetIds ?? [])])];
}

function fieldAccessHazardIds(
  node: Node,
  owner: DefUseVariable,
  context: ExtractionContext,
): readonly string[] {
  const argument = node.childForFieldName("argument");
  if (argument === null) return [OPAQUE_POINTEE_HAZARD];
  if (fieldOperator(node) === "->") {
    return pointeeHazardIds(argument, context);
  }
  const candidate = unwrapParentheses(argument);
  if (candidate.type === "identifier") return [owner.id];
  if (candidate.type === "field_expression") {
    return fieldAccessHazardIds(candidate, owner, context);
  }
  if (candidate.type === "pointer_expression" && pointerOperator(candidate) === "*") {
    const resolved = resolveDereferenceTarget(candidate, context);
    return resolved?.target.id === owner.id && resolved.dimensionsConsumed === 0
      ? [owner.id]
      : [OPAQUE_POINTEE_HAZARD];
  }
  if (candidate.type === "subscript_expression") {
    const base = candidate.childForFieldName("argument");
    const index = candidate.childForFieldName("index");
    const resolved =
      base === null || index === null
        ? null
        : resolveAddressedScalarSubscript(base, index, context);
    if (resolved?.target.id === owner.id) return [owner.id];
    if (base?.type === "field_expression") {
      const baseIds = fieldAccessHazardIds(base, owner, context);
      return baseIds.includes(owner.id)
        ? [owner.id, OPAQUE_POINTEE_HAZARD]
        : [OPAQUE_POINTEE_HAZARD];
    }
    return owner.storage === "aggregate" || owner.storage === "unknown"
      ? [owner.id, OPAQUE_POINTEE_HAZARD]
      : [OPAQUE_POINTEE_HAZARD];
  }
  return [OPAQUE_POINTEE_HAZARD];
}

function nearestInitializer(nameNode: Node, declaration: Node): Node | null {
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "init_declarator") return current.childForFieldName("value");
    current = current.parent;
  }
  return null;
}

function nearestAncestorOfType(node: Node, nodeType: string): Node | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === nodeType) return current;
    if (current.type === "function_definition") return null;
    current = current.parent;
  }
  return null;
}

function arraySizeExpressions(nameNode: Node, declaration: Node): Node[] {
  const output: Node[] = [];
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "array_declarator") {
      const size = current.childForFieldName("size");
      if (size !== null) output.push(size);
    }
    current = current.parent;
  }
  return output;
}

function arraySizeExpressionsWithin(declarator: Node): Node[] {
  return declarator
    .descendantsOfType("array_declarator")
    .map((candidate) => candidate.childForFieldName("size"))
    .filter((size): size is Node => size !== null);
}

function pointerOperator(node: Node): string | null {
  return node.childForFieldName("operator")?.text ?? null;
}

function fieldOperator(node: Node): string | null {
  return node.childForFieldName("operator")?.text ?? null;
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

function uniqueNode(nodes: readonly Node[] | undefined): Node | null {
  return nodes?.length === 1 ? (nodes[0] ?? null) : null;
}

function namedChildren(node: Node): readonly Node[] {
  return node.namedChildren.filter((child) => child.type !== "comment");
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
    throw new RangeError(`def-use effect 节点 range 非法：[${node.startIndex}, ${node.endIndex})`);
  }
  return textRange(node.startIndex, node.endIndex);
}

function compareVariables(left: DefUseVariable, right: DefUseVariable): number {
  return (
    (left.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) -
      (right.declarationRanges[0]?.from ?? Number.POSITIVE_INFINITY) ||
    left.name.localeCompare(right.name)
  );
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.from === right.from && left.to === right.to;
}

function rangeKey(range: TextRange): string {
  return `${range.from}:${range.to}`;
}

function nodeTypeKey(range: TextRange, nodeType: string | null): string {
  return `${rangeKey(range)}:${nodeType ?? "<null>"}`;
}
