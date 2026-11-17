import type {
  ActorIdentity,
  AuthorizationDecision,
  CanonicalEventStore,
  DecisionAcceptReviewReadiness,
  DecisionProjectionRow,
  DecisionReadSurface,
  DispatchLifecycleSummary,
  ProjectionWarning,
  ReceiptDiagnostic,
  RelationFactRow,
  RelationGraphEdgeRow,
  TaskProjection,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
  TaskWipSnapshotEntryV1,
  WriteReceiptDraft,
  WriteSource,
} from "@harness-anything/kernel";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import type * as WorkspaceSummary from "@harness-anything/kernel/internal/domain/workspace-summary";

export type QueryAction = Readonly<Record<string, unknown>> & { readonly kind: string };

export interface QueryBinding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly authorizationDecision?: AuthorizationDecision;
}

export interface QueryOperationPort {
  readonly input: { readonly repoId: string };
  readonly projection: TaskProjection;
  readonly operationId: (
    action: QueryAction,
    binding: QueryBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly readResult: (
    opId: string,
    value: object,
    revision: number,
    worktreeVisible: boolean | null,
    cut?: {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly watermark: number;
      readonly sourceRevision: number;
    },
  ) => WriteReceiptDraft;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
}

export interface EventQueryPort extends QueryOperationPort {
  readonly store: CanonicalEventStore;
}

export interface RelationGraphNeighborhoodResult {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly edges: readonly (RelationGraphEdgeRow & { readonly current: boolean })[];
  readonly facts: readonly RelationFactRow[];
  readonly warnings: readonly ProjectionWarning[];
  readonly truncated?: boolean;
}

export interface WorkQueryReadModel {
  readonly relationGraphNeighborhood: (query: TaskRelationNeighborhoodQuery) => RelationGraphNeighborhoodResult;
}

export interface WorkQueryCell extends QueryOperationPort {
  readonly rootDir: string;
  readonly taskListQueryFromAction?: (action: QueryAction) => TaskProjectionListQuery;
  readonly relationQueryFromAction?: (action: QueryAction) => TaskRelationQuery;
  readonly queryRead: () => WorkQueryReadModel;
  readonly wipSnapshotEntries?: (activatingTaskId: string) => readonly TaskWipSnapshotEntryV1[];
}

export interface ApiPayloadQueryContext {
  readonly projection: TaskProjection;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
}

export interface WorkspaceSummaryResult {
  readonly schema: "daemon.workspace-summary/v1";
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly tasks: WorkspaceSummary.WorkspaceTaskSummary;
  readonly decisions: WorkspaceSummary.WorkspaceDecisionSummary;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
}

export interface DecisionReviewDispatchSummaryRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly status: Extract<DispatchLifecycleSummary["displayStatus"], "running" | "succeeded" | "failed" | "unknown">;
  readonly reviewContentDigest: string;
  readonly reportRef: string | null;
  readonly reviewer: string | null;
  readonly findingCount: number | null;
}

export type DecisionFullListRow = DecisionProjectionRow & {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
  readonly reviewDispatches: readonly DecisionReviewDispatchSummaryRow[];
};

export type TaskDispatchesPayload = {
  readonly advisorySurface?: DecisionReadSurface;
  readonly latestOnly?: boolean;
} & (
  | {
      readonly taskId: string;
      readonly taskIds?: never;
      readonly limit?: never;
      readonly cursor?: never;
      readonly agentId?: never;
      readonly squadId?: never;
    }
  | {
      readonly taskId?: never;
      readonly taskIds: readonly string[];
      readonly limit?: number;
      readonly cursor?: string;
      readonly agentId?: never;
      readonly squadId?: never;
    }
  | {
      readonly taskId?: never;
      readonly taskIds?: never;
      readonly limit: number;
      readonly cursor?: never;
      readonly agentId: string;
      readonly squadId?: never;
    }
  | {
      readonly taskId?: never;
      readonly taskIds?: never;
      readonly limit: number;
      readonly cursor?: never;
      readonly agentId?: never;
      readonly squadId: string;
    }
);
