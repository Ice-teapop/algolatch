import type { Node } from "web-tree-sitter";
import { textRange, type SourceDoc, type TextRange } from "../core/model.js";
import { buildFunctionVariableBindings } from "./function-bindings.js";
import type {
  ArrayAccessFact,
  ArrayAccessIndexFact,
  ArrayDimensionFact,
  ArrayShapeFact,
  DefUseVariable,
  FunctionCfg,
} from "./model.js";

export interface FunctionArrayFactsInput {
  readonly functionNode: Node;
  readonly cfg: FunctionCfg;
  readonly document: SourceDoc;
  readonly variables: readonly DefUseVariable[];
}

export interface FunctionArrayFacts {
  readonly shapes: readonly ArrayShapeFact[];
  readonly accesses: readonly ArrayAccessFact[];
}

/**
 * Publishes only rank-one automatic local arrays with exact decimal extents and direct accesses.
 * Wider C syntax remains outside the certain literal-bounds domain.
 */
export function collectFunctionArrayFacts(input: FunctionArrayFactsInput): FunctionArrayFacts {
  const bindings = buildFunctionVariableBindings({
    document: input.document,
    functionRange: input.cfg.range,
    variables: input.variables,
    functionNode: input.functionNode,
  });
  const shapes = collectShapes(input, bindings.declarationNodeByRange);
  const shapesByVariableId = new Map(shapes.map((shape) => [shape.variableId, shape]));
  const accesses = input.functionNode
    .descendantsOfType("subscript_expression")
    .map((node) =>
      collectAccess(
        node,
        input.cfg,
        bindings.variableByOccurrenceRange,
        shapesByVariableId,
        input.document.source.length,
      ),
    )
    .filter((access): access is ArrayAccessFact => access !== null)
    .sort(
      (left, right) =>
        left.expressionRange.from - right.expressionRange.from ||
        left.expressionRange.to - right.expressionRange.to ||
        left.variableId.localeCompare(right.variableId),
    );
  return Object.freeze({ shapes: Object.freeze(shapes), accesses: Object.freeze(accesses) });
}

function collectShapes(
  input: FunctionArrayFactsInput,
  declarationNodeByRange: ReadonlyMap<string, Node>,
): ArrayShapeFact[] {
  const shapes: ArrayShapeFact[] = [];
  for (const variable of input.variables) {
    if (
      variable.kind !== "local" ||
      variable.storage !== "array" ||
      variable.tracking !== "weak" ||
      variable.confidence !== "certain" ||
      variable.declarationRanges.length !== 1
    ) {
      continue;
    }
    const declarationRange = variable.declarationRanges[0];
    const nameNode =
      declarationRange === undefined
        ? undefined
        : declarationNodeByRange.get(rangeKey(declarationRange));
    if (declarationRange === undefined || nameNode === undefined) continue;
    const declaration = nearestDeclaration(nameNode);
    if (declaration === null || hasPointerOrFunctionDeclarator(nameNode, declaration)) continue;
    const declarators = arrayDeclarators(nameNode, declaration);
    const size = declarators.length === 1 ? declarators[0]?.childForFieldName("size") : null;
    if (size === null || size === undefined) continue;
    const extent = parsePositiveDecimalLiteral(size);
    if (extent === null) continue;
    const dimension: ArrayDimensionFact = Object.freeze({
      dimension: 0,
      extent,
      extentRange: checkedNodeRange(size, input.document.source.length),
    });
    shapes.push(
      Object.freeze({
        variableId: variable.id,
        declarationRange: Object.freeze({ ...declarationRange }),
        dimensions: Object.freeze([dimension]),
      }),
    );
  }
  return shapes;
}

function collectAccess(
  node: Node,
  cfg: FunctionCfg,
  variableByOccurrenceRange: ReadonlyMap<string, DefUseVariable>,
  shapesByVariableId: ReadonlyMap<string, ArrayShapeFact>,
  sourceLength: number,
): ArrayAccessFact | null {
  if (
    hasUnevaluatedAncestor(node) ||
    hasUnsupportedOrDeadControlAncestor(node, variableByOccurrenceRange, sourceLength)
  ) {
    return null;
  }
  const argument = node.childForFieldName("argument");
  const index = node.childForFieldName("index");
  if (argument === null || index === null) return null;
  const base = unwrapParentheses(argument);
  if (base.type !== "identifier") return null;
  const variable = variableByOccurrenceRange.get(rangeKey(checkedNodeRange(base, sourceLength)));
  if (variable === undefined || !shapesByVariableId.has(variable.id)) return null;
  const expressionRange = checkedNodeRange(node, sourceLength);
  const cfgNode = smallestOwningCfgNode(cfg, expressionRange);
  if (cfgNode === null) return null;
  const indexFact: ArrayAccessIndexFact = Object.freeze({
    dimension: 0,
    indexRange: checkedNodeRange(index, sourceLength),
    literalIndex: parseSignedDecimalLiteral(index),
  });
  return Object.freeze({
    id: `array-access:${String(expressionRange.from)}:${String(expressionRange.to)}:${variable.id}`,
    variableId: variable.id,
    nodeId: cfgNode.id,
    expressionRange: Object.freeze({ ...expressionRange }),
    mode: explicitAddressMode(node) ? "address" : "value",
    execution: isConditionallyEvaluated(node) ? "conditional" : "always",
    indices: Object.freeze([indexFact]),
  });
}

function parsePositiveDecimalLiteral(node: Node): number | null {
  const value = parseSignedDecimalLiteral(node);
  return value !== null && value > 0 ? value : null;
}

function parseSignedDecimalLiteral(node: Node): number | null {
  const candidate = unwrapParentheses(node);
  if (candidate.type !== "number_literal" || !/^-?(?:0|[1-9][0-9]*)$/u.test(candidate.text)) {
    return null;
  }
  let value: bigint;
  try {
    value = BigInt(candidate.text);
  } catch {
    return null;
  }
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;
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

function hasPointerOrFunctionDeclarator(nameNode: Node, declaration: Node): boolean {
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "pointer_declarator" || current.type === "function_declarator")
      return true;
    current = current.parent;
  }
  return false;
}

function arrayDeclarators(nameNode: Node, declaration: Node): Node[] {
  const output: Node[] = [];
  let current = nameNode.parent;
  while (current !== null && current.id !== declaration.id) {
    if (current.type === "array_declarator") output.push(current);
    current = current.parent;
  }
  return output;
}

function smallestOwningCfgNode(cfg: FunctionCfg, range: TextRange) {
  return (
    cfg.nodes
      .filter((node) => node.ownership !== "boundary" && containsRange(node.range, range))
      .sort(
        (left, right) =>
          rangeLength(left.range) - rangeLength(right.range) ||
          Number(left.ownership === "primary") - Number(right.ownership === "primary") ||
          left.range.from - right.range.from,
      )[0] ?? null
  );
}

function explicitAddressMode(node: Node): boolean {
  let current = node;
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  const address = current.parent;
  if (
    address?.type !== "pointer_expression" ||
    address.childForFieldName("operator")?.text !== "&"
  ) {
    return false;
  }
  return !isDirectlyDereferenced(address);
}

function isDirectlyDereferenced(address: Node): boolean {
  let current = address;
  while (true) {
    const parent = current.parent;
    if (parent?.type === "parenthesized_expression") {
      current = parent;
      continue;
    }
    if (
      parent?.type === "cast_expression" &&
      parent.childForFieldName("value")?.id === current.id
    ) {
      current = parent;
      continue;
    }
    if (
      parent?.type === "pointer_expression" &&
      parent.childForFieldName("operator")?.text === "*"
    ) {
      const cancellingAddress = directlyAddressingPointer(parent);
      if (cancellingAddress !== null) {
        current = cancellingAddress;
        continue;
      }
      return true;
    }
    if (parent?.type === "subscript_expression") return true;
    if (
      parent?.type === "field_expression" &&
      parent.childForFieldName("operator")?.text === "->"
    ) {
      return true;
    }
    return false;
  }
}

function directlyAddressingPointer(dereference: Node): Node | null {
  let current = dereference;
  while (current.parent?.type === "parenthesized_expression") current = current.parent;
  const parent = current.parent;
  return parent?.type === "pointer_expression" && parent.childForFieldName("operator")?.text === "&"
    ? parent
    : null;
}

function hasUnevaluatedAncestor(node: Node): boolean {
  let current = node.parent;
  while (current !== null && current.type !== "function_definition") {
    if (
      current.type === "sizeof_expression" ||
      current.type === "alignof_expression" ||
      current.type === "offsetof_expression" ||
      current.type === "generic_expression"
    ) {
      return true;
    }
    if (current.type === "call_expression") {
      const callee = unwrapParentheses(current.childForFieldName("function") ?? current);
      if (callee.type === "identifier" && callee.text.startsWith("__builtin_")) return true;
    }
    current = current.parent;
  }
  return false;
}

function hasUnsupportedOrDeadControlAncestor(
  node: Node,
  variableByOccurrenceRange: ReadonlyMap<string, DefUseVariable>,
  sourceLength: number,
): boolean {
  let current = node;
  while (current.parent !== null && current.parent.type !== "function_definition") {
    const parent = current.parent;
    if (parent.type === "switch_statement") return true;
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      const truth =
        condition === null
          ? "unsupported"
          : controlTruthiness(condition, variableByOccurrenceRange, sourceLength);
      const inConsequence = consequence !== null && containsNode(consequence, current);
      const inAlternative = alternative !== null && containsNode(alternative, current);
      if (
        (truth === "unsupported" && (inConsequence || inAlternative)) ||
        (truth === false && inConsequence) ||
        (truth === true && inAlternative)
      ) {
        return true;
      }
    }
    if (parent.type === "while_statement" || parent.type === "for_statement") {
      const condition = parent.childForFieldName("condition");
      const body = parent.childForFieldName("body");
      const update = parent.type === "for_statement" ? parent.childForFieldName("update") : null;
      const truth =
        condition === null
          ? true
          : controlTruthiness(condition, variableByOccurrenceRange, sourceLength);
      const inBody = body !== null && containsNode(body, current);
      const inUpdate = update !== null && containsNode(update, current);
      if ((truth === "unsupported" || truth === false) && (inBody || inUpdate)) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

type ControlTruth = boolean | "unsupported";

function controlTruthiness(
  node: Node,
  variableByOccurrenceRange: ReadonlyMap<string, DefUseVariable>,
  sourceLength: number,
): ControlTruth {
  const candidate = unwrapParentheses(node);
  if (candidate.type === "true") return true;
  if (candidate.type === "false" || candidate.type === "null") return false;
  const value = parseSignedDecimalLiteral(candidate);
  if (value !== null) return value !== 0;
  if (candidate.type === "identifier") {
    const variable = variableByOccurrenceRange.get(
      rangeKey(checkedNodeRange(candidate, sourceLength)),
    );
    return variable?.kind === "local" && variable.storage === "array" ? true : "unsupported";
  }
  if (candidate.type === "unary_expression") {
    const operator = candidate.childForFieldName("operator")?.text;
    const argument = candidate.childForFieldName("argument");
    if (operator !== "!" || argument === null) return "unsupported";
    const argumentTruth = controlTruthiness(argument, variableByOccurrenceRange, sourceLength);
    return typeof argumentTruth === "boolean" ? !argumentTruth : argumentTruth;
  }
  if (candidate.type === "binary_expression") {
    const operator = candidate.childForFieldName("operator")?.text;
    const left = candidate.childForFieldName("left");
    const right = candidate.childForFieldName("right");
    if ((operator !== "&&" && operator !== "||") || left === null || right === null) {
      return "unsupported";
    }
    return combineLogicalTruth(
      operator,
      controlTruthiness(left, variableByOccurrenceRange, sourceLength),
      controlTruthiness(right, variableByOccurrenceRange, sourceLength),
    );
  }
  return "unsupported";
}

function combineLogicalTruth(
  operator: "&&" | "||",
  left: ControlTruth,
  right: ControlTruth,
): ControlTruth {
  if (operator === "&&") {
    if (left === false || right === false) return false;
    if (left === true) return right;
    if (right === true) return left;
    return "unsupported";
  }
  if (left === true || right === true) return true;
  if (left === false) return right;
  if (right === false) return left;
  return "unsupported";
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

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === "parenthesized_expression") {
    const children = current.namedChildren.filter((child) => child.type !== "comment");
    if (children.length !== 1 || children[0] === undefined) return current;
    current = children[0];
  }
  return current;
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
      `array fact 节点 range 非法：[${String(node.startIndex)}, ${String(node.endIndex)})`,
    );
  }
  return textRange(node.startIndex, node.endIndex);
}

function containsNode(parent: Node, child: Node): boolean {
  return child.startIndex >= parent.startIndex && child.endIndex <= parent.endIndex;
}

function containsRange(parent: TextRange, child: TextRange): boolean {
  return child.from >= parent.from && child.to <= parent.to;
}

function rangeLength(range: TextRange): number {
  return range.to - range.from;
}

function rangeKey(range: TextRange): string {
  return `${String(range.from)}:${String(range.to)}`;
}
