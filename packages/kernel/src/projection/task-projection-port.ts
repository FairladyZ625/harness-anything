import type { ReplicaSequenceRead, ReplicaRevision } from "./replica-sequence.ts";
import type { ArtifactEntityState } from "../domain/artifact-entity-state.ts";
import type { EventListQuery, EventListPage } from "../domain/event-list.ts";
import type { SettingsEventV1 } from "../domain/settings-event.ts";
import type { DecisionDocumentState } from "../domain/decision-event-types.ts";
import type {
  AgentRuntimeEventV1,
  RuntimeDispatchMetrics,
  RuntimeInstallation,
  RuntimeSession,
} from "../domain/agent-runtime.ts";
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
  DecisionCoverageProjectionRead,
  DecisionGraphProjectionRead,
  DecisionProjectionListRead,
  DecisionProjectionRead,
  DocumentProjectionRead,
  FactAnchorProjectionRead,
  FactDomainTypeProjectionRead,
  FactGraphProjectionRead,
  FactProjectionRead,
  FactProjectionSearchRead,
  LeaseInterval,
  PresetSnapshotProjectionRead,
  ProjectionApplyReceipt,
  ProjectionCatchUpReceipt,
  ProjectionRebuildReceipt,
  ReplicaProjectionBasis,
  TaskProgressProjectionRead,
  TaskProjectionListRead,
  TaskProjectionRead,
  TaskRelationNeighborhoodRead,
  TaskRelationProjectionRead,
  TaskRuntimeBatchQuery,
  TaskRuntimeBatchRead,
  WorkspaceSummaryProjectionRead,
} from "./projection-reads.ts";
import type { VersionedRelationProjectionRow } from "./relation-entity-projection.ts";
import type { EntityFreshness, EntityVersion, EntityVersionWitness } from "../domain/entity-freshness.ts";
import type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";

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

export interface SquadRunProjectionRow {
  readonly squadRunId: string;
  readonly revision: number;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface EntityProjectionRow {
  readonly kind: string;
  readonly id: string;
  readonly ownerId: string | null;
  readonly workspaceRevision: number;
  readonly freshness: EntityFreshness;
  readonly currentVersion: EntityVersion | null;
  readonly value: Readonly<Record<string, unknown>>;
}
export interface PinnedEntityProjectionRow {
  readonly entityRef: string;
  readonly pinnedAt: string;
  readonly pinnedBy: string;
}
export interface RuntimeDispatchProjectionRow {
  readonly event: Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;
  readonly metrics: RuntimeDispatchMetrics | null;
  readonly endedAt: string | null;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
}
export interface RuntimeDispatchPage {
  readonly rows: readonly RuntimeDispatchProjectionRow[];
  readonly nextCursor: { readonly startedAt: string; readonly dispatchId: string } | null;
  readonly done: boolean;
}

export interface TaskProjection {
  readonly path: string;
  readonly close: () => void;
  readonly apply: (event: CanonicalEventV1, plan?: FrozenWritePlan) => ProjectionApplyReceipt;
  readonly rebuild: () => ProjectionRebuildReceipt;
  readonly catchUp?: () => ProjectionCatchUpReceipt;
  readonly readStateDigest: () => `sha256:${string}` | null;
  readonly readCut: () => {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly listEntities: (entityKind: string) => readonly EntityProjectionRow[];
  readonly getEntity: (entityKind: string, entityId: string) => EntityProjectionRow | null;
  readonly listPinnedEntities: () => readonly PinnedEntityProjectionRow[];
  readonly read: (taskId: string, presentationStatus?: boolean) => TaskProjectionRead;
  readonly list: (query?: TaskProjectionListQuery) => TaskProjectionListRead;
  readonly readTaskIndex: (
    query?: TaskProjectionListQuery,
  ) => import("./projection-reads.ts").TaskIndexProjectionRead & { readonly page: ProjectionPage | null };
  readonly readTaskChildCounts: (parentTaskIds: readonly string[]) => Readonly<Record<string, number>>;
  /** The raw rows an edge read model replicates, with the projection revision they describe. */
  readonly readEdgeReadModel: <T>(
    read: (model: {
      readonly status: "ready" | "pending";
      readonly sourceRevision: number;
      readonly rows: import("./read-model.ts").EdgeReadModelRows;
    }) => T,
  ) => T;
  readonly readWorkspaceSummary: () => WorkspaceSummaryProjectionRead;
  readonly readTaskRelations: () => TaskRelationProjectionRead;
  readonly readTaskRelationNeighborhood: (
    query: import("./task-query-projection.ts").TaskRelationNeighborhoodQuery,
  ) => TaskRelationNeighborhoodRead;
  readonly readTaskDependencyClosure: (sourceRefs: readonly string[], maxDepth?: number) => TaskRelationProjectionRead;
  readonly readTaskRelationsByTargets: (
    targetRefs: readonly string[],
    relationType: string,
  ) => TaskRelationProjectionRead;
  readonly readTaskRelationsBySources: (
    sourceRefs: readonly string[],
    relationType: string,
  ) => TaskRelationProjectionRead;
  readonly readTaskStatuses: (taskIds?: readonly string[]) => {
    readonly status: "ready" | "pending";
    readonly rows: readonly { readonly taskId: string; readonly status: string | null }[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readTaskExists: (taskId: string) => boolean;
  readonly readTaskByIdempotencyKey: (idempotencyKey: string) => {
    readonly taskId: string;
    readonly status: string;
    readonly packagePath: string | null;
  } | null;
  readonly readTaskRuntimeBatch: (query: TaskRuntimeBatchQuery) => TaskRuntimeBatchRead;
  readonly readRelationQuery: (query?: TaskRelationQuery) => TaskRelationProjectionRead;
  readonly readOperation: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
  readonly readRelationEdge: (relationId: string) => VersionedRelationProjectionRow | null;
  readonly readEntityVersionWitness: (entityRef: string) => EntityVersionWitness;
  readonly readDecisionDocumentState?: (decisionId: string) => DecisionDocumentState | null;
  readonly readTaskOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
  readonly readDocument: (path: string) => DocumentProjectionRead;
  readonly readReplicaRevision: (revision?: number) => ReplicaRevision | null;
  readonly readReplicaSequence: <A>(from: number | null, read: (sequence: ReplicaSequenceRead | null) => A) => A;
  readonly readReplicaBasis: (afterRevision: number | null) => ReplicaProjectionBasis;
  readonly taskIdForDocumentPath: (path: string) => string | null;
  readonly readTaskSubmissionOperation: (taskId: string, executionId: string) => string | null;
  readonly readTaskCompletion: (taskId: string, executionId: string) => TaskEventV1 | null;
  readonly readRuntimeDispatch: (
    runtimeSessionIdValue: string,
    definitionSnapshotRef?: string,
  ) => Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null;
  readonly readRuntimeDispatches: () => readonly Extract<
    AgentRuntimeEventV1,
    { readonly type: "runtime_dispatch_requested" }
  >[];
  readonly readRuntimeDispatchById: (dispatchId: string) => RuntimeDispatchProjectionRow | null;
  readonly readRuntimeDispatchByResumeSource: (dispatchId: string) => RuntimeDispatchProjectionRow | null;
  readonly readRuntimeDispatchesBySession: (runtimeSessionId: string) => readonly RuntimeDispatchProjectionRow[];
  readonly readRuntimeDispatchesByTaskExecution: (
    taskId: string,
    executionId: string,
  ) => readonly RuntimeDispatchProjectionRow[];
  readonly readRuntimeDispatchesByAttemptGroup: (attemptGroupId: string) => readonly RuntimeDispatchProjectionRow[];
  readonly readRuntimeDispatchesByDecision: (decisionId: string) => readonly RuntimeDispatchProjectionRow[];
  readonly readRuntimeDispatchPage: (query: {
    readonly startedAtGte: string;
    readonly cursor?: { readonly startedAt: string; readonly dispatchId: string };
    readonly limit: number;
  }) => RuntimeDispatchPage;
  readonly readRuntimeSessionEvents: (
    runtimeSessionIdValue: string,
    afterRevision: number,
    limit: number,
  ) => readonly AgentRuntimeEventV1[];
  readonly readArtifactEntityState: (kind: string, id: string) => ArtifactEntityState | null;
  readonly readEventList: (query: EventListQuery) => EventListPage;
  readonly readEventSummaries: (
    afterRevision: number,
    limit: number,
  ) => {
    readonly status: "ready" | "pending";
    readonly events: readonly import("../domain/canonical-event-summary.ts").CanonicalEventSummary[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readEventWitness: (
    revision: number,
  ) => Pick<CanonicalEventV1, "workspaceRevision" | "occurredAt" | "actor" | "source"> | null;
  readonly readDocuments: (prefix: string) => {
    readonly status: "ready" | "pending";
    readonly documents: readonly {
      readonly path: string;
      readonly blobSha256: string;
      readonly size: number;
      readonly mediaType: string;
    }[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readCanonicalEvents: (
    afterRevision: number,
    limit: number,
  ) => {
    readonly status: "ready" | "pending";
    readonly events: readonly CanonicalEventV1[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readScheduleEvents: (scheduleId?: string) => {
    readonly status: "ready" | "pending";
    readonly events: readonly CanonicalEventV1[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readReckoningEvents: (query: {
    readonly type: "fact_recorded" | "decision_superseded" | "decision_retired" | "decision_accepted";
    readonly after: string;
    readonly before: string;
  }) => readonly CanonicalEventV1[];
  readonly readScheduleOutputEvents: (runtimeSessionIds: readonly string[]) => readonly CanonicalEventV1[];
  readonly readSettingsEvent: () => SettingsEventV1 | null;
  readonly readCiRunObservations: (
    limit: number,
    beforeRevision?: number,
    selection?: { readonly familyWindow: number },
  ) => {
    readonly status: "ready" | "pending";
    readonly events: readonly import("../domain/ci-run-observation-v4.ts").CiObservationRead[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readPresetSnapshot: (digest: string) => PresetSnapshotProjectionRead;
  readonly readProgress: (taskId: string) => TaskProgressProjectionRead;
  readonly admitFact: (event: FactEventV1) => void;
  readonly readFact: (factId: string) => FactProjectionRead;
  readonly searchFacts: (filters: FactSearchFilters) => FactProjectionSearchRead;
  readonly listFactDomainTypes: () => FactDomainTypeProjectionRead;
  readonly readFactAnchors: (refs?: readonly string[]) => FactAnchorProjectionRead;
  readonly readFactGraph: () => FactGraphProjectionRead;
  readonly admitDecision: (event: DecisionEventV1) => void;
  readonly readDecision: (decisionId: string) => DecisionProjectionRead;
  readonly readDecisions: (decisionIds: readonly string[]) => DecisionProjectionListRead;
  readonly listDecisions: (filters: DecisionListFilters) => DecisionProjectionListRead;
  readonly listDecisionAgendaPage: (query: DecisionPageQuery) => DecisionAgendaProjectionPageRead;
  readonly readDecisionGraph: () => DecisionGraphProjectionRead;
  readonly readDecisionIncomingRelations: (decisionId: string) => DecisionGraphProjectionRead["edges"];
  readonly readDecisionCoverage: (decisionIds: readonly string[]) => DecisionCoverageProjectionRead;
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
  readonly readSquadRun: (squadRunId: string) => SquadRunProjectionRow | null;
  readonly readSquadRuns: () => readonly SquadRunProjectionRow[];
}

export type TaskProjectionWriter = TaskProjection;

export type TaskProjectionQueries = Omit<
  TaskProjection,
  | "close"
  | "apply"
  | "rebuild"
  | "catchUp"
  | "admitFact"
  | "admitDecision"
  | "reserveLease"
  | "activateLease"
  | "renewLease"
  | "releaseLease"
>;

export interface TaskProjectionReader {
  readonly path: string;
  readonly withSession: <A>(read: (queries: TaskProjectionQueries) => A) => A;
  readonly close: () => void;
}
