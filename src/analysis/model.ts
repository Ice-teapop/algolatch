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

export interface DefUseStepEvidence {
  readonly operator: "add" | "subtract";
  /** Positive safe-integer magnitude. */
  readonly delta: number;
  readonly form: "prefix" | "postfix" | "compound" | "self-assignment";
  readonly expressionRange: TextRange;
}

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
  readonly step?: DefUseStepEvidence;
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

export interface ReachingDefinitionUse {
  readonly useEffectId: string;
  readonly availability: "tracked" | "escaped" | "unreachable";
  /** Definition effect ids ordered by the function's deterministic effect universe. */
  readonly definitionEffectIds: readonly string[];
}

export interface ReachingDefinitionFact {
  readonly nodeId: string;
  readonly nodeRange: TextRange;
  readonly inDefinitionEffectIds: readonly string[];
  readonly outDefinitionEffectIds: readonly string[];
  readonly inEscapedVariableIds: readonly string[];
  readonly outEscapedVariableIds: readonly string[];
  /** One resolution per use effect in node effect order. */
  readonly uses: readonly ReachingDefinitionUse[];
}

export type LoopKind = "while" | "do-while" | "for";
export type LoopAvailability = "analyzable" | "unreachable" | "unsupported-control-flow";

export interface LoopRegion {
  readonly id: string;
  readonly kind: LoopKind;
  readonly range: TextRange;
  readonly conditionNodeId: string;
  readonly entryNodeId: string;
  readonly initializerNodeId: string | null;
  readonly updateNodeId: string | null;
  readonly parentLoopId: string | null;
  /** CFG order; excludes this loop's own for initializer but includes nested loop initializers. */
  readonly nodeIds: readonly string[];
  readonly availability: LoopAvailability;
}

export type LoopPredicateVerdict = "yes" | "no" | "unknown";
export type LoopPredicateReason =
  | "escaped"
  | "no-definitions"
  | "has-definitions"
  | "single-definition"
  | "multiple-definitions"
  | "not-constant-step"
  | "weak-step"
  | "no-external-definition"
  | "uninitialized-entry"
  | "nested-step"
  | "no-backedge"
  | "step-not-on-every-backedge"
  | "induction-variable";

export interface LoopPredicateResult {
  readonly verdict: LoopPredicateVerdict;
  readonly reason: LoopPredicateReason;
  readonly definitionEffectIds: readonly string[];
  readonly nodeIds: readonly string[];
}

export interface LoopInductionResult extends LoopPredicateResult {
  readonly stepDefinitionEffectId: string | null;
  readonly delta: number | null;
}

export interface LoopVariablePredicateFact {
  readonly variableId: string;
  readonly isLoopInvariant: LoopPredicateResult;
  readonly singleDefIn: LoopPredicateResult;
  readonly isInductionVar: LoopInductionResult;
}

export interface LoopPredicateFact {
  readonly loopId: string;
  /** Reachable precise scalars referenced by an analyzable loop, in function variable order. */
  readonly variables: readonly LoopVariablePredicateFact[];
}

export type AnalysisFindingConfidence = "certain" | "likely" | "hint";
export type AnalysisFindingReason =
  | "no-entry-path"
  | "all-reaching-definitions-uninitialized"
  | "no-reaching-definition"
  | "negative-literal-index"
  | "literal-index-not-less-than-extent"
  | "inclusive-bound-reaches-fixed-extent"
  | "live-at-all-normal-exits"
  | "live-at-some-normal-exit"
  | "must-freed-before-free"
  | "may-freed-before-free"
  | "must-freed-before-dereference"
  | "may-freed-before-dereference"
  | "pointer-size-used-for-pointee-allocation"
  | "maybe-null-before-dereference"
  | "loop-condition-does-not-constrain-index"
  | "runtime-index-without-proven-bound";
export type AnalysisFindingRuleId =
  | "unreachable-code"
  | "uninitialized-read"
  | "literal-out-of-bounds"
  | "loop-off-by-one"
  | "memory-leak"
  | "possible-memory-leak"
  | "double-free"
  | "possible-double-free"
  | "use-after-free"
  | "possible-use-after-free"
  | "malloc-sizeof-pointer"
  | "unchecked-allocation"
  | "runtime-bound-check"
  | "loop-index-mismatch";
export type AnalysisEvidenceRole =
  | "allocation"
  | "bound"
  | "condition"
  | "definition"
  | "escape"
  | "exit"
  | "free"
  | "index"
  | "path"
  | "state"
  | "unreachable"
  | "use";

export interface AnalysisFindingEvidence {
  readonly role: AnalysisEvidenceRole;
  readonly range: TextRange;
}

export interface AnalysisFinding {
  /** Snapshot-local deterministic identity. */
  readonly id: string;
  readonly functionId: string;
  readonly ruleId: AnalysisFindingRuleId;
  readonly reason: AnalysisFindingReason;
  readonly confidence: AnalysisFindingConfidence;
  readonly primaryRange: TextRange;
  readonly ownerNodeId: string;
  readonly subject: string | null;
  readonly subjectVariableId: string | null;
  readonly evidence: readonly AnalysisFindingEvidence[];
}

export interface FunctionDefUse {
  readonly functionId: string;
  readonly functionRange: TextRange;
  readonly status: "complete" | "disabled";
  readonly disabledReasons: readonly DefUseDisabledReasonCode[];
  readonly variables: readonly DefUseVariable[];
  /** Complete functions contain one fact per CFG node in the same order; disabled functions none. */
  readonly facts: readonly DefUseFact[];
  /** Complete functions contain one reaching-definition fact per CFG node; disabled functions none. */
  readonly reachingDefinitions: readonly ReachingDefinitionFact[];
  /** Source-ordered loop regions derived only for complete functions. */
  readonly loopRegions: readonly LoopRegion[];
  /** One predicate fact per loop region in the same order. */
  readonly loopPredicates: readonly LoopPredicateFact[];
}

export interface ProgramAnalysisSnapshot {
  readonly revision: number;
  readonly sourceLength: number;
  /** Non-cryptographic stale-snapshot guard; source text remains authoritative. */
  readonly sourceFingerprint: string;
  readonly functions: readonly FunctionCfg[];
  /** One-to-one and in the same order as functions; functionId is the stable join key. */
  readonly defUse: readonly FunctionDefUse[];
  /** Source-ordered, deterministic findings from complete function analyses only. */
  readonly findings: readonly AnalysisFinding[];
}

export interface ProgramAnalysisInput {
  readonly source: string;
  readonly revision: number;
  readonly rootNode: import("web-tree-sitter").Node;
  readonly document: SourceDoc;
}
