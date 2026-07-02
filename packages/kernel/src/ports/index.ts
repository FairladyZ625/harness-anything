// Curated port surface. artifact-store-writer.ts is deliberately absent:
// the write seam is flusher-only and must not be reachable from here.
export { ArtifactStore } from "./artifact-store.ts";
export type { ArtifactDocument, TaskPackageRead } from "./artifact-store.ts";

export { LifecycleEngine } from "./lifecycle-engine.ts";
export type { TaskEngineRef, TaskListFilter, EngineCapabilities, NoteRef } from "./lifecycle-engine.ts";

export { TemplateLibrary } from "./template-library.ts";
export type { Locale, TemplateRef, TemplateDocument } from "./template-library.ts";

export { CurrentSessionProbe } from "./current-session-probe.ts";
export type {
  CurrentSessionProbe as CurrentSessionProbePort,
  CurrentSessionRef,
  CurrentSessionRuntime,
  CurrentSessionSource
} from "./current-session-probe.ts";

export { WriteCoordinator } from "./write-coordinator.ts";
export type {
  WriteOp,
  WriteOpKind,
  TaskWriteOpKind,
  DecisionWriteOpKind,
  LocalTransitionWriteOp,
  ProvenancePayload,
  WriteAck,
  FlushReason,
  FlushReport,
  RecoveryReport
} from "./write-coordinator.ts";
