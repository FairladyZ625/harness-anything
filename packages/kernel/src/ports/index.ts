// Curated port surface. artifact-store-writer.ts is deliberately absent:
// the write seam is flusher-only and must not be reachable from here.
export { ArtifactStore } from "./artifact-store.ts";
export type { ArtifactDocument, ArtifactDocumentKind, AuthoredDocumentDescriptor, TaskPackageRead } from "./artifact-store.ts";

export { LifecycleEngine } from "./lifecycle-engine.ts";
export type { TaskEngineRef, TaskListFilter, EngineCapabilities, NoteRef } from "./lifecycle-engine.ts";

export { LockRegistry } from "./lock-registry.ts";
export type { LockLease, LockRegistry as LockRegistryPort, LockRegistryError, LockRequest } from "./lock-registry.ts";

export { TemplateLibrary } from "./template-library.ts";
export type { Locale, TemplateRef, TemplateDocument } from "./template-library.ts";

export { VersionControlSystem, VcsCommandError } from "./version-control-system.ts";
export type {
  VcsCommitAuthor,
  VcsCommitPhase,
  VersionControlSystem as VersionControlSystemPort
} from "./version-control-system.ts";

export type {
  ProjectionSourceFence,
  ProjectionSourceFenceReader
} from "./projection-source-fence.ts";

export { CurrentSessionProbe } from "./current-session-probe.ts";
export type {
  CurrentSessionProbe as CurrentSessionProbePort,
  CurrentSessionRef,
  CurrentSessionRuntime,
  CurrentSessionSource
} from "./current-session-probe.ts";

export {
  WriteCoordinator,
  createExactWriteScope,
  createJournaledBatch,
  isIndeterminateFlushControlOutcome,
  isIndeterminateFlushReport,
  withExactCommit
} from "./write-coordinator.ts";
export type {
  AuthorityOperationIntegrity,
  ExactWriteScope,
  ExactWriteCoordinator,
  WriteOp,
  WriteOpKind,
  TaskWriteOpKind,
  DecisionWriteOpKind,
  LocalTransitionWriteOp,
  ProvenancePayload,
  WriteAck,
  JournaledBatchEntry,
  FlushReason,
  DeterminateFlushReport,
  IndeterminateFlushReport,
  IndeterminateFlushControlOutcome,
  WriteControl,
  FlushReport,
  RecoveryReport
} from "./write-coordinator.ts";
