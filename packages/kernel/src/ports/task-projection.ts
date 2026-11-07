import type { ArtifactEntityState } from "../domain/artifact-entity-state.ts";
import type { EventListQuery, EventListPage } from "../domain/event-list.ts";
import type { SettingsEventV1 } from "../domain/settings-event.ts";
import type { DecisionDocumentState } from "../domain/decision-event-types.ts";
import type {
  AgentRuntimeEventType,
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
import type {
  ArtifactTimelineQuery,
  ArtifactTimelineRead,
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
import type {
  FactSearchFilters,
  ProjectionPage,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
  VersionedRelationProjectionRow,
} from "./projection-contracts.ts";
import type { DecisionListFilters, DecisionPageQuery } from "./decision-projection-model.ts";
import type { EntityFreshness, EntityVersion, EntityVersionWitness } from "../domain/entity-freshness.ts";

export interface RuntimeSessionReadQuery {
  /** Point lookup for a local live stream whose canonical session may already be settled. */
  readonly runtimeSessionId?: string;
  /** Sessions bound to this provider session, settled or not. A resume names one native session. */
  readonly providerSessionId?: string;
  /** Sessions whose canonical liveness has not exited. */
  readonly nonExitedOnly?: boolean;
  /** Inclusive observation range; compares instants rather than timestamp spellings. */
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  /** The activity window includes live sessions regardless of their last observation. */
  readonly activitySince?: string;
  /** Only sessions whose canonical outcome is still unset. Recovery must not scan settled history. */
  readonly unsettledOnly?: boolean;
  /**
   * The current in-flight set as a bounded projection (home aggregation). Unlike
   * `unsettledOnly`, a backend may serve this from a write-maintained current-set table so the
   * read is sized by what is running now, not by the history of settled sessions.
   */
  readonly inFlightOnly?: boolean;
  /** Only sessions whose canonical dispatch names this execution node as its source. Edge recovery
   *  must not traverse another node's unsettled runtimes. */
  readonly executionOwnerNodeId?: string;
}
export interface RuntimeSessionPageQuery {
  readonly taskId?: string;
  readonly limit: number;
  readonly afterRuntimeSessionId?: string;
  /** Explicit compatibility request: exact totals scan the remaining matching set. */
  readonly includeRemainingCount?: boolean;
}
export interface RuntimeSessionPageRead {
  readonly rows: readonly RuntimeSession[];
  readonly nextRuntimeSessionId: string | null;
  /** Null when another page exists and an exact count was not requested; zero at the end. */
  readonly remainingCount: number | null;
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
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
}
export interface RuntimeDispatchPage {
  readonly rows: readonly RuntimeDispatchProjectionRow[];
  readonly nextCursor: { readonly startedAt: string; readonly dispatchId: string } | null;
  readonly done: boolean;
}
export interface RuntimeDispatchMemberSession {
  readonly runtimeSessionId: string;
  /** Distinct task ids from the session's bindings (the projection's binding table). */
  readonly taskIds: readonly string[];
  /** The member's latest dispatch on this session when it is a decision review; otherwise null. */
  readonly latestDecisionId: string | null;
}
export interface RuntimeDispatchMemberRead {
  /** The member's newest dispatch events first; bounded by the caller's limit. */
  readonly rows: readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[];
  readonly truncated: boolean;
  /**
   * Every session the member ever dispatched, with the ingredients the shared task-group
   * normalization needs. Totals are derived from this by the caller so the full-history count and
   * the window groups share one definition.
   */
  readonly sessions: readonly RuntimeDispatchMemberSession[];
}

export interface TaskProjection {
  readonly path: string;
  readonly close: () => void;
  readonly apply: (event: CanonicalEventV1, plan?: FrozenWritePlan) => ProjectionApplyReceipt;
  readonly rebuild: () => ProjectionRebuildReceipt;
  readonly catchUp?: () => ProjectionCatchUpReceipt;
  /** Catch up while yielding between bounded source batches. */
  readonly catchUpAsync?: () => Promise<ProjectionCatchUpReceipt>;
  readonly readStateDigest: () => `sha256:${string}` | null;
  readonly readCut: () => {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly listEntities: (entityKind: string) => readonly EntityProjectionRow[];
  /** Row count for one kind whose value matches every named top-level field. Counted at the
   *  storage boundary so a caller that only needs a number never materializes the collection. */
  readonly countEntities: (
    entityKind: string,
    valueEquals: Readonly<Record<string, string | number | boolean>>,
  ) => number;
  readonly getEntity: (entityKind: string, entityId: string) => EntityProjectionRow | null;
  readonly listPinnedEntities: () => readonly PinnedEntityProjectionRow[];
  /**
   * Raw task read. `presentationStatus` selects the presentation snapshot. `presentationRollup`
   * (default true) says whether the backend may compute that rollup when the caller discards it;
   * a hot raw reader passes false to skip the subtree scan.
   */
  readonly read: (taskId: string, presentationStatus?: boolean, presentationRollup?: boolean) => TaskProjectionRead;
  /** Migration-only access to the aggregate before TaskV2 validation. Normal reads must use `read`. */
  readonly readForTaskContractMigration: (taskId: string) => TaskProjectionRead;
  readonly readTaskIdsForTaskContractMigration: () => readonly string[];
  readonly list: (query?: TaskProjectionListQuery) => TaskProjectionListRead;
  readonly readTaskIndex: (
    query?: TaskProjectionListQuery,
  ) => import("./projection-reads.ts").TaskIndexProjectionRead & { readonly page: ProjectionPage | null };
  readonly readTaskChildCounts: (parentTaskIds: readonly string[]) => Readonly<Record<string, number>>;
  readonly readWorkspaceSummary: () => WorkspaceSummaryProjectionRead;
  readonly readTaskRelations: () => TaskRelationProjectionRead;
  readonly readTaskRelationNeighborhood: (query: TaskRelationNeighborhoodQuery) => TaskRelationNeighborhoodRead;
  readonly readTaskDependencyClosure: (
    sourceRefs: readonly string[],
    maxDepth?: number,
    /** Aggregate readers request one indexed seek per endpoint; default keeps the batch read. */
    narrow?: boolean,
  ) => TaskRelationProjectionRead;
  readonly readTaskRelationsByTargets: (
    targetRefs: readonly string[],
    relationType: string,
    narrow?: boolean,
  ) => TaskRelationProjectionRead;
  readonly readTaskRelationsBySources: (
    sourceRefs: readonly string[],
    relationType: string,
    narrow?: boolean,
  ) => TaskRelationProjectionRead;
  readonly readTaskStatuses: (taskIds?: readonly string[]) => {
    readonly status: "ready" | "pending";
    readonly rows: readonly { readonly taskId: string; readonly status: string | null }[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readTaskExists: (taskId: string) => boolean;
  /** Canonical-stream existence from the event index, not the snapshot rows: a snapshot row lost
   * to cache damage still has its events here, so a not-found judgment can tell a task the
   * repository never had from a task whose projection alone went missing. */
  readonly readTaskEventExists: (taskId: string) => boolean;
  readonly readTaskByIdempotencyKey: (idempotencyKey: string) => {
    readonly taskId: string;
    readonly status: string;
    readonly packagePath: string | null;
  } | null;
  readonly readTaskRuntimeBatch: (query: TaskRuntimeBatchQuery) => TaskRuntimeBatchRead;
  readonly readRelationQuery: (query?: TaskRelationQuery) => TaskRelationProjectionRead;
  /** Read-only typed-cycle stock audit at this projection cut; rebuild and doctor only. */
  readonly readRelationCycleAudit: () => import("./projection-contracts.ts").RelationCycleAuditRead;
  readonly readOperation: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
  readonly readRelationEdge: (relationId: string) => VersionedRelationProjectionRow | null;
  readonly readEntityVersionWitness: (entityRef: string) => EntityVersionWitness;
  readonly readDecisionDocumentState?: (decisionId: string) => DecisionDocumentState | null;
  readonly readTaskOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
  readonly readDocument: (path: string) => DocumentProjectionRead;
  readonly readDocumentMetadata: (path: string) => Omit<DocumentProjectionRead, "document"> & {
    readonly document: { readonly path: string; readonly workspaceRevision: number } | null;
  };
  readonly readReplicaBasis: (afterRevision: number | null) => ReplicaProjectionBasis;
  readonly taskIdForDocumentPath: (path: string) => string | null;
  readonly readTaskSubmissionOperation: (taskId: string, executionId: string) => string | null;
  readonly readTaskCompletion: (taskId: string, executionId: string | null) => TaskEventV1 | null;
  readonly readRuntimeDispatch: (
    runtimeSessionIdValue: string,
    definitionSnapshotRef?: string,
  ) => Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null;
  readonly readRuntimeDispatchById: (dispatchId: string) => RuntimeDispatchProjectionRow | null;
  readonly readRuntimeDispatchByDispatchKey: (dispatchKey: string) => RuntimeDispatchProjectionRow | null;
  readonly readRuntimeDispatchByResumeSource: (dispatchId: string) => RuntimeDispatchProjectionRow | null;
  readonly readRuntimeDispatchesBySession: (runtimeSessionId: string) => readonly RuntimeDispatchProjectionRow[];
  /** A session's dispatch events only: callers that need no outcome row skip its extra lookup. */
  readonly readRuntimeDispatchEventsBySession: (
    runtimeSessionId: string,
  ) => readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[];
  /** Every dispatch bound to one of the requested tasks, revision order. At most 500 task ids. */
  readonly readRuntimeDispatchesByTaskIds: (
    taskIds: readonly string[],
  ) => readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[];
  /**
   * The newest dispatch per requested task (startedAt desc, revision desc), one index seek per id.
   * Aggregate reads that only show a task's current dispatch must use this instead of the full
   * history read. At most 500 task ids.
   */
  readonly readLatestRuntimeDispatchesByTaskIds: (
    taskIds: readonly string[],
  ) => readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[];
  /** The newest dispatch for one runtime session; never its session history. */
  readonly readLatestRuntimeDispatchBySession: (
    runtimeSessionId: string,
  ) => Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> | null;
  /** Dispatch ids starting with `prefix`, id order, capped at `limit` (`1..500`). */
  readonly readRuntimeDispatchByDispatchIdPrefix: (
    prefix: string,
    limit: number,
  ) => readonly RuntimeDispatchProjectionRow[];
  /** One agent's dispatch count, without materializing the dispatch events. */
  readonly countRuntimeDispatchesByAgent: (agentId: string) => number;
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
  readonly readRuntimeDispatchesByMember: (query: {
    readonly agentId?: string;
    readonly squadId?: string;
    readonly limit: number;
  }) => RuntimeDispatchMemberRead;
  readonly readRuntimeSessionEvents: (
    runtimeSessionIdValue: string,
    afterRevision: number,
    limit: number,
  ) => readonly AgentRuntimeEventV1[];
  /**
   * One session's events narrowed to the requested types, revision ascending. Callers that need
   * the newest outcome or liveness event read only the matching rows, never the whole session.
   */
  readonly readRuntimeSessionEventsByType: (
    runtimeSessionIdValue: string,
    types: readonly AgentRuntimeEventType[],
  ) => readonly AgentRuntimeEventV1[];
  readonly readArtifactEntityState: (kind: string, id: string) => ArtifactEntityState | null;
  readonly readEventList: (query: EventListQuery) => EventListPage;
  readonly readEventSummaries: (
    afterRevision: number,
    limit: number,
    /** Header-only projection for aggregate tails; omitted reads return the canonical summary. */
    fields?: "fleet" | { readonly taskIds: readonly string[] },
  ) => {
    readonly status: "ready" | "pending";
    readonly events: readonly import("../domain/canonical-event-summary.ts").CanonicalEventSummary[];
    /** Present for the newest task-scoped window. */
    readonly hasMore?: boolean;
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readEventWitness: (
    revision: number,
  ) => Pick<CanonicalEventV1, "workspaceRevision" | "occurredAt" | "actor" | "source"> | null;
  readonly readDocuments: (
    prefix: string,
    page?: { readonly limit: number; readonly afterPath?: string },
  ) => {
    readonly status: "ready" | "pending";
    readonly documents: readonly {
      readonly path: string;
      readonly blobSha256: string;
      readonly size: number;
      readonly mediaType: string;
      readonly policyId: string | null;
    }[];
    /** Present for an explicit keyset read; null is the authoritative end signal. */
    readonly page?: { readonly nextPath: string | null };
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  /** Task-package artifact timeline, ordered by ledger time desc then package-relative path.
   * Backed by the projection's artifact index so one page costs the page, never the repository's
   * output history. Counts are maintained totals, not a scan of the matching set. */
  readonly readArtifactTimelinePage: (query: ArtifactTimelineQuery) => ArtifactTimelineRead;
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
  readonly readPresetSnapshot: (digest: string) => PresetSnapshotProjectionRead;
  readonly readProgress: (taskId: string) => TaskProgressProjectionRead;
  readonly admitFact: (event: FactEventV1) => void;
  readonly readFact: (factId: string) => FactProjectionRead;
  readonly searchFacts: (filters: FactSearchFilters) => FactProjectionSearchRead;
  readonly listFactDomainTypes: () => FactDomainTypeProjectionRead;
  readonly readFactAnchors: (refs?: readonly string[]) => FactAnchorProjectionRead;
  readonly readFactGraph: () => FactGraphProjectionRead;
  readonly admitDecision: (event: DecisionEventV1) => void;
  readonly readDecision: (decisionId: string, withBody?: boolean) => DecisionProjectionRead;
  readonly readDecisions: (decisionIds: readonly string[], withBody?: boolean) => DecisionProjectionListRead;
  readonly listDecisions: (filters: DecisionListFilters) => DecisionProjectionListRead;
  readonly listDecisionAgendaPage: (query: DecisionPageQuery) => DecisionAgendaProjectionPageRead;
  readonly readDecisionGraph: () => DecisionGraphProjectionRead;
  readonly readDecisionIncomingRelations: (decisionId: string) => DecisionGraphProjectionRead["edges"];
  readonly readDecisionCoverage: (decisionIds: readonly string[]) => DecisionCoverageProjectionRead;
  readonly readLeaseIntervals: (taskId: string) => readonly LeaseInterval[];
  /** The newest acquisition for one execution; uses the task/execution index without reading other rounds. */
  readonly readLatestLeaseIntervalForExecution: (taskId: string, executionId: string) => LeaseInterval | null;
  /** The task's newest acquisition only (highest acquiredRevision), one index seek rather than its
   * re-entry history. `null` means no lease was ever acquired for the task. */
  readonly readLatestLeaseInterval: (taskId: string) => LeaseInterval | null;
  readonly currentLease: (taskId: string, now?: string) => LeaseV1 | null;
  readonly currentLeaseForExecution: (executionId: string, now?: string) => LeaseV1 | null;
  readonly reserveLease: (lease: LeaseV1, now: string) => LeaseV1;
  readonly activateLease: (lease: LeaseV1) => LeaseV1;
  readonly renewLease: (lease: LeaseV1, expiresAt: string) => LeaseV1;
  readonly releaseLease: (lease: LeaseV1) => LeaseV1;
  readonly readRuntimeInstallation: (installationId: string) => RuntimeInstallation | null;
  readonly readRuntimeInstallations: () => readonly RuntimeInstallation[];
  readonly readRuntimeSession: (runtimeSessionId: string) => RuntimeSession | null;
  readonly readRuntimeSessions: (query?: RuntimeSessionReadQuery) => readonly RuntimeSession[];
  readonly readRuntimeSessionsForTask: (taskId: string) => readonly RuntimeSession[];
  readonly readRuntimeSessionPage: (query: RuntimeSessionPageQuery) => RuntimeSessionPageRead;
  readonly readSquadRun: (squadRunId: string) => SquadRunProjectionRow | null;
  readonly readSquadRuns: () => readonly SquadRunProjectionRow[];
}

/** Cross-backend projection methods stay synchronous; PG adapters use the storage worker bridge. */
export type TaskProjectionPort = TaskProjection;

export type TaskProjectionWriter = TaskProjection;

export type TaskProjectionQueries = Omit<
  TaskProjection,
  | "close"
  | "apply"
  | "rebuild"
  | "catchUp"
  | "catchUpAsync"
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

export type TaskProjectionQueriesPort = TaskProjectionQueries;
export type TaskProjectionReaderPort = TaskProjectionReader;
