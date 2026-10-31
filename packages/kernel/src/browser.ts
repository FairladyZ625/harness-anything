/** Browser-safe public contracts. Runtime, persistence and hashing stay behind index.ts. */
export { validateFrozenCompletionContract } from "./domain/completion-contract.ts";
export { validCompletionEvidenceOverride } from "./domain/completion-evidence-override.ts";
export { relationStates } from "./domain/relation-state.ts";
export { validSquadRunSubject } from "./domain/squad-run.ts";
export type { ContractVersion } from "./domain/contract-version.ts";
export type { FreshnessReason } from "./domain/decision-coverage.ts";
export type { RelationDirection, RelationState, RelationType } from "./domain/entity-relation.ts";
export type { DecisionProjectionRow } from "./ports/decision-projection-model.ts";
export type {
  FactAnchorRow,
  FactProjectionRow,
  RelationFactRow,
  RelationGraphEdgeRow,
} from "./ports/projection-contracts.ts";
export type { ProjectionWarning } from "./ports/projection-types.ts";

export { todoIsOpen, type Todo } from "./domain/todo.ts";
