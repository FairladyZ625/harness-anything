/** Browser-safe public contracts. Runtime, persistence and hashing stay behind index.ts. */
export { mappedWitnessAdapterIds, validateFrozenCompletionContract } from "./domain/completion-contract.ts";
export { validCompletionEvidenceOverride } from "./domain/completion-evidence-override.ts";
export { relationStates } from "./domain/entity-relation.ts";
export type { ContractVersion } from "./domain/contract-version.ts";
export type { FreshnessReason } from "./domain/decision-coverage.ts";
export type { RelationDirection, RelationState, RelationType } from "./domain/entity-relation.ts";
export type { DecisionProjectionRow } from "./projection/decision-event-projection.ts";
export type { FactProjectionRow } from "./projection/fact-event-projection.ts";
export type { FactAnchorRow, RelationFactRow, RelationGraphEdgeRow } from "./projection/relation-graph-projection.ts";
export type { ProjectionWarning } from "./projection/types.ts";
