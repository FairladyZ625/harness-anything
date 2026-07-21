// Documented B7 coupling for the daemon-owned runtime. A proper kernel port is follow-up work.
export { createRuntimeAdmissionBudget } from "./daemon/runtime-admission.ts";
export type {
  DaemonAdmissionBudgetSnapshot,
  DaemonAdmissionReservation
} from "./daemon/admission-budget.ts";
export type { DaemonQueueDrainTarget } from "./daemon/drain-timeout.ts";
export {
  acquireDaemonGlobalLock,
  assertDaemonGlobalLockHeld
} from "./write-coordination/journal/locks.ts";
export type { DaemonGlobalLock } from "./write-coordination/journal/locks.ts";
export { recoverJournaledWrites } from "./write-coordination/journal/coordinator.ts";
export {
  singleWriteIntegrityDomain,
  type WriteIntegrityDomain
} from "./write-coordination/journal/integrity-domain.ts";
export { writeOpTouchedPaths } from "./write-coordination/journal/operations/transaction-plan.ts";
export {
  ProjectionGenerationChangedError,
  type ReadyProjectionGeneration
} from "./projection/projection-generation-readiness.ts";
export {
  ensureExecutionEvidenceGenerationReady,
  updateExecutionEvidenceProjectionIncrementally,
  type EnsureExecutionEvidenceGenerationResult
} from "./projection/sqlite-execution-evidence-store.ts";
export {
  queryExecutionEvidencePageFromReadyGeneration,
  type ExecutionEvidencePage,
  type ExecutionEvidencePageQuery
} from "./projection/sqlite-execution-evidence-reader.ts";
export {
  createProjectionChangePublisher,
  type ProjectionChangePublisher
} from "./projection/projection-change-publisher.ts";
export type { ProjectionChangeEvent } from "./projection/projection-change-event.ts";
export type {
  ProjectionSourceFenceFactory,
  StableProjectionSourceFence
} from "./ports/projection-source-fence.ts";
