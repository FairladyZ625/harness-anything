import type { LeaseChangeReason, TaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import type { CanonicalEventV1, DocumentState } from "../domain/doc-sync.contract.ts";
import type { LeaseHolder } from "../domain/execution.ts";
import type { RuntimeSession } from "../domain/agent-runtime.ts";
import type { TaskProgressEventV1 } from "../domain/task-progress-event.ts";
import type { WorkspaceSummary } from "../domain/workspace-summary.ts";
import type {
  FactAnchorRow,
  FactDomainTypeRow,
  FactProjectionRow,
  FactRelationEdgeRow,
  FactSearchPage,
  ProjectionPage,
  RelationCycleAudit,
  TaskRelationProjectionRow,
} from "./projection-contracts.ts";
import type {
  DecisionAnchorRow,
  DecisionAgendaProjectionRow,
  DecisionCoverageRow,
  DecisionProjectionRow,
  DecisionRelationEdgeRow,
} from "./decision-projection-model.ts";

export type TaskProjectionWarning = "projection_missing";
export interface TaskProjectionRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly packagePath: string | null;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly catchUp: { readonly maxItems: number; readonly reducedItems: number; readonly storeTransactions: 0 | 1 };
}
export interface TaskProjectionListRow {
  readonly taskId: string;
  readonly packagePath: string | null;
  readonly generation: "v0" | "v1";
  readonly workspaceRevision: number;
  readonly createdAt: string | null;
  /** OccurredAt of the canonical transition that first entered done, if any. */
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly snapshot: TaskLifecycleSnapshot;
}
export interface TaskProjectionListRead {
  readonly status: "ready" | "pending";
  readonly rows: readonly TaskProjectionListRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly page?: ProjectionPage;
}
export interface TaskIndexProjectionRow {
  readonly supersededBy: string | null;
  readonly taskId: string;
  readonly title: string;
  readonly status: import("../domain/task.ts").TaskV2["status"];
  readonly pinned: boolean;
  readonly parentTaskId: string | null;
  readonly workKind: import("../domain/task.ts").TaskMetadataV1["workKind"];
  readonly riskTier: import("../domain/task.ts").TaskMetadataV1["riskTier"];
  readonly urgency: import("../domain/task.ts").TaskMetadataV1["urgency"];
  readonly taskClass: import("../domain/task.ts").TaskV2["taskClass"];
  readonly packageDisposition: import("../domain/task.ts").TaskPackageDisposition;
  readonly packagePath: string | null;
  readonly updatedAt: string;
}
export interface TaskIndexProjectionRead {
  readonly schema: "task-index-projection/v1";
  readonly status: "ready" | "pending";
  readonly rows: readonly TaskIndexProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
}
export interface TaskRuntimeBatchQuery {
  readonly taskIds: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TaskRuntimeBatchRow {
  readonly taskId: string;
  readonly title: string;
  readonly packagePath: string | null;
  readonly sessions: readonly RuntimeSession[];
}
export interface TaskRuntimeBatchRead {
  readonly status: "ready" | "pending";
  readonly taskIds: readonly string[];
  readonly rows: readonly TaskRuntimeBatchRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly page: ProjectionPage;
}
export interface WorkspaceSummaryProjectionRead {
  readonly status: "ready" | "pending";
  readonly summary: WorkspaceSummary;
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface TaskRelationProjectionRead {
  readonly status: "ready" | "pending";
  readonly rows: readonly TaskRelationProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly page?: ProjectionPage;
}
export interface TaskRelationNeighborhoodRead extends TaskRelationProjectionRead {
  /** True when traversable edges exist beyond the query's maxDepth window. */
  readonly truncated: boolean;
}
export interface ProjectionApplyReceipt {
  readonly metrics: { readonly storeTransactions: 1; readonly reducedItems: number };
}
export interface ProjectionRebuildReceipt extends ProjectionCatchUpReceipt {
  readonly stateDigest: `sha256:${string}`;
  /** Read-only stock cycle audit over the rebuilt projection; issues never mutate the ledger. */
  readonly relationCycleAudit: RelationCycleAudit;
}
export interface ProjectionCatchUpReceipt {
  readonly watermark: number;
  readonly metrics: {
    readonly storeTransactions: number;
    readonly reducedItems: number;
    readonly maxBatchItems: number;
  };
}
export interface LeaseInterval {
  readonly taskId: string;
  readonly executionId: string;
  readonly holder: LeaseHolder;
  readonly previousHolder: LeaseHolder | null;
  readonly acquiredRevision: number;
  readonly releasedRevision: number | null;
  readonly leaseExpiresAt: string;
  readonly reason: LeaseChangeReason;
}
export interface DocumentProjectionRead {
  readonly status: "ready" | "pending";
  readonly document: DocumentState | null;
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface ReplicaProjectionDocument {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** The policy this row was written under; `null` only for a fixture-inserted row without one. */
  readonly policyId: string | null;
}
export interface ReplicaProjectionBasis {
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly headEvent: CanonicalEventV1 | null;
  readonly events: readonly CanonicalEventV1[];
  readonly documents: readonly ReplicaProjectionDocument[];
}
export interface PresetSnapshotProjectionRead {
  readonly status: "ready" | "pending";
  readonly snapshot: unknown | null;
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface FactProjectionRead {
  readonly status: "ready" | "pending";
  readonly fact: FactProjectionRow | null;
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface TaskProgressProjectionRead {
  readonly status: "ready" | "pending";
  readonly rows: readonly TaskProgressEventV1[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface FactProjectionSearchRead {
  readonly status: "ready" | "pending";
  readonly facts: readonly FactProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly page?: FactSearchPage;
}
export interface FactDomainTypeProjectionRead {
  readonly status: "ready" | "pending";
  readonly domainTypes: readonly FactDomainTypeRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface FactAnchorProjectionRead {
  readonly status: "ready" | "pending";
  readonly rows: readonly FactAnchorRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface FactGraphProjectionRead {
  readonly status: "ready" | "pending";
  readonly edges: readonly FactRelationEdgeRow[];
  readonly factAnchors: readonly FactAnchorRow[];
  readonly facts: readonly FactProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface DecisionProjectionRead {
  readonly status: "ready" | "pending";
  readonly decision: DecisionProjectionRow | null;
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface DecisionProjectionListRead {
  readonly status: "ready" | "pending";
  readonly decisions: readonly DecisionProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly page?: ProjectionPage;
}
export interface DecisionAgendaProjectionPageRead {
  readonly status: "ready" | "pending";
  readonly decisions: readonly DecisionAgendaProjectionRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly page: ProjectionPage;
}
export interface DecisionGraphProjectionRead {
  readonly status: "ready" | "pending";
  readonly edges: readonly DecisionRelationEdgeRow[];
  readonly decisionAnchors: readonly DecisionAnchorRow[];
  readonly coverageRows: readonly DecisionCoverageRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
export interface DecisionCoverageProjectionRead {
  readonly status: "ready" | "pending";
  readonly coverageRows: readonly DecisionCoverageRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
}
