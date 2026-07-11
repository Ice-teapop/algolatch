import type { SourceDoc, TextRange } from "../core/model.js";

export type CfgNodeKind = "entry" | "exit" | "syntax" | "control";
export type CfgNodeRole = "boundary" | "statement" | "declaration" | "control";
export type CfgNodeOwnership = "boundary" | "primary" | "auxiliary";
export type CfgEdgeKind =
  | "entry"
  | "next"
  | "branch-true"
  | "branch-false"
  | "switch-case"
  | "switch-default"
  | "switch-miss"
  | "break"
  | "continue"
  | "goto"
  | "return"
  | "terminate";

export interface CfgNode {
  /** Snapshot-local deterministic identity. */
  readonly id: string;
  readonly kind: CfgNodeKind;
  readonly role: CfgNodeRole;
  /** Whether this node owns a projected block or only refines its internal control flow. */
  readonly ownership: CfgNodeOwnership;
  readonly nodeType: string | null;
  readonly range: TextRange;
  readonly ownerBlockRange: TextRange;
  readonly reachable: boolean;
}

export interface CfgEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: CfgEdgeKind;
}

export type CfgPartialReasonCode =
  "parse-error" | "unsupported-control-flow" | "unsupported-syntax";

export interface CfgPartialReason {
  readonly code: CfgPartialReasonCode;
  readonly nodeType: string;
  readonly range: TextRange;
}

export interface FunctionCfg {
  readonly id: string;
  readonly name: string;
  readonly range: TextRange;
  readonly entryId: string;
  readonly exitId: string;
  readonly nodes: readonly CfgNode[];
  readonly edges: readonly CfgEdge[];
  readonly partial: boolean;
  readonly partialReasons: readonly CfgPartialReason[];
}

export type DefUseVariableKind = "parameter" | "local";
export type DefUseVariableStorage = "scalar" | "array" | "pointer" | "aggregate" | "unknown";
export type DefUseTrackingMode = "precise" | "weak" | "untracked";
export type DefUseDisabledReasonCode =
  | "cfg-partial"
  | "invalid-function-cst"
  | "parse-error"
  | "preprocessor"
  | "projection-issue"
  | "parse-concern"
  | "raw-block"
  | "missing-function-projection"
  | "unsequenced-conflict"
  | "unsupported-effect-order"
  | "effect-cst-mismatch"
  | "opaque-alias-effect";

export interface DefUseVariable {
  /** Deterministic within the source revision; never exposes the lexical snapshot's symbol id. */
  readonly id: string;
  readonly name: string;
  readonly kind: DefUseVariableKind;
  readonly storage: DefUseVariableStorage;
  /** Intrinsic tracking capability before ordered escape effects are applied. */
  readonly tracking: DefUseTrackingMode;
  readonly declarationRanges: readonly TextRange[];
  readonly confidence: "certain" | "low" | "unknown";
}

export type DefUseEffectOrigin =
  | "parameter"
  | "declaration"
  | "assignment"
  | "compound-assignment"
  | "update"
  | "array-element"
  | "call-argument";

interface DefUseEffectBase {
  readonly id: string;
  readonly variableId: string;
  readonly range: TextRange;
}

export interface DefUseUseEffect extends DefUseEffectBase {
  readonly kind: "use";
  readonly role: "value" | "array-element" | "index";
  readonly execution: "always" | "conditional";
}

export interface DefUseDefinitionEffect extends DefUseEffectBase {
  readonly kind: "def";
  readonly strength: "strong" | "weak";
  readonly valueState: "written" | "uninitialized" | "maybe-written";
  readonly origin: DefUseEffectOrigin;
}

export interface DefUseEscapeEffect extends DefUseEffectBase {
  readonly kind: "escape";
  readonly origin: "stored-address" | "array-decay";
}

export type DefUseEffect = DefUseUseEffect | DefUseDefinitionEffect | DefUseEscapeEffect;

export interface DefUseFact {
  readonly nodeId: string;
  readonly nodeRange: TextRange;
  /**
   * Deterministic transfer order within this node. Unsequenced effects are published only when
   * they commute, so their listed order does not claim to be the runtime evaluation order.
   */
  readonly effects: readonly DefUseEffect[];
}

export interface FunctionDefUse {
  readonly functionId: string;
  readonly functionRange: TextRange;
  readonly status: "complete" | "disabled";
  readonly disabledReasons: readonly DefUseDisabledReasonCode[];
  readonly variables: readonly DefUseVariable[];
  /** Complete functions contain one fact per CFG node in the same order; disabled functions none. */
  readonly facts: readonly DefUseFact[];
}

export interface ProgramAnalysisSnapshot {
  readonly revision: number;
  readonly sourceLength: number;
  /** Non-cryptographic stale-snapshot guard; source text remains authoritative. */
  readonly sourceFingerprint: string;
  readonly functions: readonly FunctionCfg[];
  /** One-to-one and in the same order as functions; functionId is the stable join key. */
  readonly defUse: readonly FunctionDefUse[];
}

export interface ProgramAnalysisInput {
  readonly source: string;
  readonly revision: number;
  readonly rootNode: import("web-tree-sitter").Node;
  readonly document: SourceDoc;
}
