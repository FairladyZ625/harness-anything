import type { LeaseChangeReason, TaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import type { CanonicalEventV1, DocumentState } from "../domain/doc-sync.contract.ts";
import type { LeaseHolder } from "../domain/execution.ts";
import type { RuntimeSession } from "../domain/agent-runtime.ts";
import type { TaskProgressEventV1 } from "../domain/task-progress-event.ts";
import { readDecisionGraphRows, readFactAnchorRows, readFactGraphRows, type DecisionAgendaProjectionRow, type DecisionProjectionRow, type FactProjectionRow, type FactSearchPage } from "./fact-event-projection.ts";
import type { ProjectionPage, TaskRelationProjectionRow } from "./task-query-projection.ts";

export type TaskProjectionWarning = "projection_missing";
export interface TaskProjectionRead {
  readonly status: "ready" | "pending"; readonly snapshot: TaskLifecycleSnapshot; readonly packagePath: string | null; readonly watermark: number;
  readonly sourceRevision: number; readonly warnings: readonly TaskProjectionWarning[];
  readonly catchUp: { readonly maxItems: number; readonly reducedItems: number; readonly sqliteTransactions: 0 | 1 };
}
export interface TaskProjectionListRow { readonly taskId: string; readonly packagePath: string | null; readonly generation: "v0" | "v1"; readonly workspaceRevision: number; readonly updatedAt: string; readonly snapshot: TaskLifecycleSnapshot }
export interface TaskProjectionListRead { readonly status: "ready" | "pending"; readonly rows: readonly TaskProjectionListRow[]; readonly watermark: number; readonly sourceRevision: number; readonly warnings: readonly TaskProjectionWarning[]; readonly page?: ProjectionPage }
export interface TaskRuntimeBatchQuery { readonly taskIds: readonly string[]; readonly limit?: number; readonly cursor?: string }
export interface TaskRuntimeBatchRow { readonly taskId: string; readonly packagePath: string | null; readonly sessions: readonly RuntimeSession[] }
export interface TaskRuntimeBatchRead { readonly status: "ready" | "pending"; readonly taskIds: readonly string[]; readonly rows: readonly TaskRuntimeBatchRow[]; readonly watermark: number; readonly sourceRevision: number; readonly page: ProjectionPage }
export interface TaskRelationProjectionRead { readonly status: "ready" | "pending"; readonly rows: readonly TaskRelationProjectionRow[]; readonly watermark: number; readonly sourceRevision: number; readonly page?: ProjectionPage }
export interface ProjectionApplyReceipt { readonly metrics: { readonly sqliteTransactions: 1; readonly reducedItems: number } }
export interface ProjectionRebuildReceipt {
  readonly watermark: number; readonly stateDigest: `sha256:${string}`; readonly metrics: { readonly sqliteTransactions: number; readonly reducedItems: number; readonly maxBatchItems: number };
}
export interface LeaseInterval {
  readonly taskId: string; readonly executionId: string; readonly holder: LeaseHolder; readonly previousHolder: LeaseHolder | null;
  readonly acquiredRevision: number; readonly releasedRevision: number | null; readonly leaseExpiresAt: string; readonly reason: LeaseChangeReason;
}
export interface DocumentProjectionRead { readonly status: "ready" | "pending"; readonly document: DocumentState | null; readonly watermark: number; readonly sourceRevision: number }
export interface ReplicaProjectionDocument { readonly path: string; readonly blobSha256: string; readonly size: number; readonly mediaType: string }
export interface ReplicaProjectionBasis { readonly watermark: number; readonly sourceRevision: number; readonly headEvent: CanonicalEventV1 | null; readonly events: readonly CanonicalEventV1[]; readonly documents: readonly ReplicaProjectionDocument[] }
export interface PresetSnapshotProjectionRead { readonly status: "ready" | "pending"; readonly snapshot: unknown | null; readonly watermark: number; readonly sourceRevision: number }
export interface FactProjectionRead { readonly status: "ready" | "pending"; readonly fact: FactProjectionRow | null; readonly watermark: number; readonly sourceRevision: number }
export interface TaskProgressProjectionRead { readonly status: "ready" | "pending"; readonly rows: readonly TaskProgressEventV1[]; readonly watermark: number; readonly sourceRevision: number }
export interface FactProjectionSearchRead { readonly status: "ready" | "pending"; readonly facts: readonly FactProjectionRow[]; readonly watermark: number; readonly sourceRevision: number; readonly page?: FactSearchPage }
export interface FactAnchorProjectionRead { readonly status: "ready" | "pending"; readonly rows: ReturnType<typeof readFactAnchorRows>; readonly watermark: number; readonly sourceRevision: number }
export interface FactGraphProjectionRead { readonly status: "ready" | "pending"; readonly edges: ReturnType<typeof readFactGraphRows>["edges"]; readonly factAnchors: ReturnType<typeof readFactGraphRows>["factAnchors"]; readonly facts: readonly FactProjectionRow[]; readonly watermark: number; readonly sourceRevision: number }
export interface DecisionProjectionRead { readonly status: "ready" | "pending"; readonly decision: DecisionProjectionRow | null; readonly watermark: number; readonly sourceRevision: number }
export interface DecisionProjectionListRead { readonly status: "ready" | "pending"; readonly decisions: readonly DecisionProjectionRow[]; readonly watermark: number; readonly sourceRevision: number }
export interface DecisionAgendaProjectionPageRead { readonly status: "ready" | "pending"; readonly decisions: readonly DecisionAgendaProjectionRow[]; readonly watermark: number; readonly sourceRevision: number; readonly page: ProjectionPage }
export interface DecisionGraphProjectionRead { readonly status: "ready" | "pending"; readonly edges: ReturnType<typeof readDecisionGraphRows>["edges"]; readonly decisionAnchors: ReturnType<typeof readDecisionGraphRows>["decisionAnchors"]; readonly coverageRows: ReturnType<typeof readDecisionGraphRows>["coverageRows"]; readonly watermark: number; readonly sourceRevision: number }
