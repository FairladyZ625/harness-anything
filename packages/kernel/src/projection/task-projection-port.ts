import type { AgentRuntimeEventV1, RuntimeInstallation, RuntimeSession } from "../domain/agent-runtime.ts";
import type { DecisionEventV1 } from "../domain/decision-event.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import type { FactEventV1 } from "../domain/fact-event.ts";
import type { LeaseV1 } from "../domain/execution.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import type { FrozenWritePlan } from "../domain/write-chain.contract.ts";
import type { DecisionListFilters, DecisionPageQuery } from "./decision-event-projection.ts";
import type { FactSearchFilters } from "./fact-event-projection.ts";
import type {
  DecisionAgendaProjectionPageRead,
  DecisionGraphProjectionRead,
  DecisionProjectionListRead,
  DecisionProjectionRead,
  DocumentProjectionRead,
  FactAnchorProjectionRead,
  FactGraphProjectionRead,
  FactProjectionRead,
  FactProjectionSearchRead,
  LeaseInterval,
  PresetSnapshotProjectionRead,
  ProjectionApplyReceipt,
  ProjectionRebuildReceipt,
  ReplicaProjectionBasis,
  TaskProgressProjectionRead,
  TaskProjectionListRead,
  TaskProjectionRead,
  TaskRelationProjectionRead,
  TaskRuntimeBatchQuery,
  TaskRuntimeBatchRead,
  WorkspaceSummaryProjectionRead,
} from "./projection-reads.ts";
import type { EventBackedRelationTruth } from "./relation-graph-projection.ts";
import type { TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";

export interface RuntimeSessionPageQuery {
  readonly taskId?: string;
  readonly limit: number;
  readonly afterRuntimeSessionId?: string;
}
export interface RuntimeSessionPageRead {
  readonly rows: readonly RuntimeSession[];
  readonly nextRuntimeSessionId: string | null;
  readonly remainingCount: number;
}

export interface EntityProjectionRow {
  readonly kind: string;
  readonly id: string;
  readonly ownerId: string | null;
  readonly workspaceRevision: number;
  readonly value: Readonly<Record<string, unknown>>;
}
export interface TaskProjection {
  readonly path: string;
  readonly close: () => void;
  readonly apply: (event: CanonicalEventV1, plan?: FrozenWritePlan) => ProjectionApplyReceipt;
  readonly rebuild: () => ProjectionRebuildReceipt;
  readonly readStateDigest: () => `sha256:${string}` | null;
  readonly listEntities: (entityKind: string) => readonly EntityProjectionRow[];
  readonly getEntity: (entityKind: string, entityId: string) => EntityProjectionRow | null;
  readonly read: (taskId: string) => TaskProjectionRead;
  readonly list: (query?: TaskProjectionListQuery) => TaskProjectionListRead;
  readonly readWorkspaceSummary: () => WorkspaceSummaryProjectionRead;
  readonly readTaskRelations: () => TaskRelationProjectionRead;
  readonly readTaskDependencyClosure: (sourceRefs: readonly string[], maxDepth?: number) => TaskRelationProjectionRead;
  readonly readTaskRelationsByTargets: (
    targetRefs: readonly string[],
    relationType: string,
  ) => TaskRelationProjectionRead;
  readonly readTaskStatuses: (taskIds?: readonly string[]) => {
    readonly status: "ready" | "pending";
    readonly rows: readonly { readonly taskId: string; readonly status: string | null }[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readTaskRuntimeBatch: (query: TaskRuntimeBatchQuery) => TaskRuntimeBatchRead;
  readonly readRelationQuery: (query?: TaskRelationQuery) => TaskRelationProjectionRead;
  readonly readOperation: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
  readonly readRelationTruth: () => EventBackedRelationTruth;
  readonly readTaskOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
  readonly readDocument: (path: string) => DocumentProjectionRead;
  readonly readReplicaBasis: (afterRevision: number | null) => ReplicaProjectionBasis;
  readonly taskIdForDocumentPath: (path: string) => string | null;
  readonly readTaskCompletion: (taskId: string, executionId: string) => TaskEventV1 | null;
  readonly readRuntimeDispatch: (
    runtimeSessionIdValue: string,
    definitionSnapshotRef: string,
  ) => Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null;
  readonly readRuntimeDispatches: () => readonly Extract<
    AgentRuntimeEventV1,
    { readonly type: "runtime_dispatch_requested" }
  >[];
  readonly readRuntimeSessionEvents: (
    runtimeSessionIdValue: string,
    afterRevision: number,
    limit: number,
  ) => readonly AgentRuntimeEventV1[];
  readonly readPresetSnapshot: (digest: string) => PresetSnapshotProjectionRead;
  readonly readProgress: (taskId: string) => TaskProgressProjectionRead;
  readonly admitFact: (event: FactEventV1) => void;
  readonly readFact: (taskId: string, factId: string) => FactProjectionRead;
  readonly searchFacts: (filters: FactSearchFilters) => FactProjectionSearchRead;
  readonly readFactAnchors: (refs?: readonly string[]) => FactAnchorProjectionRead;
  readonly readFactGraph: () => FactGraphProjectionRead;
  readonly admitDecision: (event: DecisionEventV1) => void;
  readonly readDecision: (decisionId: string) => DecisionProjectionRead;
  readonly readDecisions: (decisionIds: readonly string[]) => DecisionProjectionListRead;
  readonly listDecisions: (filters: DecisionListFilters) => DecisionProjectionListRead;
  readonly listDecisionAgendaPage: (query: DecisionPageQuery) => DecisionAgendaProjectionPageRead;
  readonly readDecisionGraph: () => DecisionGraphProjectionRead;
  readonly readLeaseIntervals: (taskId: string) => readonly LeaseInterval[];
  readonly currentLease: (taskId: string, now?: string) => LeaseV1 | null;
  readonly currentLeaseForExecution: (executionId: string, now?: string) => LeaseV1 | null;
  readonly reserveLease: (lease: LeaseV1, now: string) => LeaseV1;
  readonly activateLease: (lease: LeaseV1) => LeaseV1;
  readonly renewLease: (lease: LeaseV1, expiresAt: string) => LeaseV1;
  readonly releaseLease: (lease: LeaseV1) => LeaseV1;
  readonly readRuntimeInstallation: (installationId: string) => RuntimeInstallation | null;
  readonly readRuntimeInstallations: () => readonly RuntimeInstallation[];
  readonly readRuntimeSession: (runtimeSessionId: string) => RuntimeSession | null;
  readonly readRuntimeSessions: () => readonly RuntimeSession[];
  readonly readRuntimeSessionsForTask: (taskId: string) => readonly RuntimeSession[];
  readonly readRuntimeSessionPage: (query: RuntimeSessionPageQuery) => RuntimeSessionPageRead;
}
