import type { PresetSyntaxAncestorCapability, PresetSyntaxSlotKind } from "../learning/index.js";

/** Maps the immediate parent node type onto the structural slot a preset supports. */
export function syntaxSlotForParent(nodeType: string | null): PresetSyntaxSlotKind | null {
  if (nodeType === "function_definition") return "function-body";
  if (nodeType !== null && isLoopNodeType(nodeType)) return "loop-body";
  if (nodeType !== null && isSwitchNodeType(nodeType)) return "switch-case";
  if (nodeType === "if_statement" || nodeType === "compound_statement") {
    return "compound-body";
  }
  return null;
}

export function isLoopNodeType(nodeType: string): boolean {
  return (
    nodeType === "for_statement" || nodeType === "while_statement" || nodeType === "do_statement"
  );
}

export function isSwitchNodeType(nodeType: string): boolean {
  return nodeType === "switch_statement" || nodeType === "case_statement";
}

export function ancestorCapabilityForNodeType(
  nodeType: string,
): PresetSyntaxAncestorCapability | null {
  if (isLoopNodeType(nodeType)) return "loop";
  if (isSwitchNodeType(nodeType)) return "switch";
  return null;
}
