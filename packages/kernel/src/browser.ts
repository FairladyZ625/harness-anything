/** Browser-safe public contracts. Runtime, persistence and hashing stay behind index.ts. */
export { validateFrozenCompletionContract } from "./domain/completion-contract.ts";
export { validCompletionEvidenceOverride } from "./domain/completion-evidence-override.ts";
export { relationStates } from "./domain/relation-state.ts";
export { validSquadRunSubject } from "./domain/squad-run.ts";
export { guiQueryPacing } from "./domain/gui-query-pacing.ts";
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

export { openTodoValueEquals, todoIsOpen, type Todo } from "./domain/todo.ts";
export type {
  RepoRegistrationState,
  RuntimeReadinessStatus,
  SupplyChainReadinessStatus,
  RepoCellState,
  RepoLockState,
  DaemonControlPhase,
  ProjectionFreshness,
  RuntimeIsolationState,
} from "./domain/operational-status.ts";
export type {
  UpdateCheckState,
  UpdateArtifactState,
  AnswerFeedbackState,
  CadenceFeedStatus,
  DegradedEntityState,
  AgentPlanStepStatus,
  AgentPlanPhase,
  SteerNoteState,
  ApprovalVerdict,
  PromptCacheTtlState,
  AttentionState,
  ConnectionVisualState,
  BindingCoverageState,
  ObserveTailStatus,
  DaemonStartupPhase,
  MutationFeedbackState,
  CatalogReadState,
  EntityContentOutcome,
  EntityWriteState,
  EntityLocatorReadOutcome,
  DaemonHealthState,
  ScheduleVerdict,
  SessionVerdict,
  ToolCallStatus,
  TranscriptPlanStepStatus,
  SteeringEntryStatus,
  TranscriptTurnStatus,
  StartWorkPreconditionState,
  TerminalAttachStatus,
  TerminalTabState,
  TerminalRestartState,
  DispatchActivityStatus,
} from "./domain/client-view-status.ts";
export type { WriteReceiptOutcome } from "./domain/write-chain.contract.ts";
export type { ReadSetProjectionCut } from "./domain/task-read-set.ts";
export {
  daemonControlPhaseWords,
  repoCellStateWords,
  repoRegistrationStateWords,
} from "./domain/operational-status.ts";
export type { ReviewResponseDisposition, ReviewVerdict } from "./domain/review.ts";
export type { BlockingAvailabilityState } from "./domain/task-blocking.ts";
export type { RuntimeLiveness } from "./domain/agent-runtime.ts";
export type { CloseoutGateStatus } from "./domain/status-word-register-closeout.ts";
export { writeReceiptOutcomes } from "./domain/write-chain.contract.ts";
