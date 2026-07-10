export { applyEditPlan, applyTextPatches, createEditPlan, createTextPatch } from "./patch.js";
export type { EditApplication, EditDiff, EditPlan, TextPatch } from "./model.js";
export {
  planStructuredEdit,
  StructuredEditError,
  type BinaryOperatorEditRequest,
  type ForFieldsEditRequest,
  type IfConditionEditRequest,
  type LiteralEditRequest,
  type StructuredEditAnalyzer,
  type StructuredEditContext,
  type StructuredEditErrorCode,
  type StructuredEditPlan,
  type StructuredEditRequest,
} from "./engine.js";
export {
  BINARY_OPERATORS,
  BINARY_OPERATOR_PRECEDENCE,
  planBinaryOperatorPatches,
  precedence,
  type BinaryOperator,
} from "./operators.js";
export {
  extractEditTargets,
  type BinaryExpressionEditTarget,
  type EditTarget,
  type EditTargetSnapshot,
  type ForStatementEditTarget,
  type IfStatementEditTarget,
  type LiteralEditTarget,
  type LiteralKind,
} from "./targets.js";
export {
  extractStatementEditTargets,
  planStatementOperation,
  StatementOperationError,
  type DeleteStatementRequest,
  type InsertStatementRequest,
  type StatementEditBlocker,
  type StatementEditTarget,
  type StatementEditTargetSnapshot,
  type StatementOperationErrorCode,
  type StatementOperationPlan,
  type StatementOperationRequest,
  type StatementParentMode,
  type SwapAdjacentStatementsRequest,
} from "./statements.js";
export {
  LocalRenameError,
  planConservativeLocalRename,
  type ConservativeLocalRenamePlan,
  type ConservativeLocalRenameRequest,
  type LocalRenameAnalysis,
  type LocalRenameErrorCode,
} from "./rename.js";
export {
  M3bEditError,
  planM3bEdit,
  type LocalRenameEditRequest,
  type M3bEditAnalyzer,
  type M3bEditContext,
  type M3bEditErrorCode,
  type M3bEditPlan,
  type M3bEditRequest,
  type ValidatedLocalRenameEditPlan,
  type ValidatedStatementEditPlan,
} from "./m3b-engine.js";
