import type { CanonicalStatus, CloseoutReadiness, PriorityTier, TaskWorkKind } from "../domain/index.ts";
import type { ContractVersion } from "../domain/contract-version.ts";
import type { TaskBoardColumnId } from "../domain/task-board-projection.ts";
import type { PackageDisposition } from "../domain/package-disposition.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import type { EventBackedRelationTruth } from "./relation-graph-projection.ts";

export type ProjectionFreshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";
export type ProjectionSource = "local-document" | "external-engine" | "snapshot-cache";
export type ProjectionCanonicalStatus = CanonicalStatus | "unknown";
export type CoordinationStatus = TaskBoardColumnId | "unknown";
export type ProjectionWarningSource = "source-package" | "generated-cache" | "collaboration-gate";
export type ProjectionWarningSeverity = "warning" | "hard-fail";
export type ProjectionWarningCode =
  | "projection_missing"
  | "projection_stale"
  | "projection_tampered"
  | "relation_truth_unavailable"
  | "source_malformed"
  | "duplicate_task_id"
  | "duplicate_external_binding"
  | "generated_tracked"
  | "binding_tampered"
  | "conflict_marker_present"
  | "dangling_entity_ref"
  | "invalid_relation_endpoint"
  | "relation_host_source_mismatch"
  | "invalid_relation_type_subset"
  | "relation_provenance_inheritance_mismatch"
  | "relation_id_mismatch"
  | "duplicate_relation_id"
  | "relation_rationale_missing"
  | "relation_endpoint_unknown"
  | "relation_cycle_detected";

export interface TaskCreatedBy {
  readonly name: string;
  readonly email: string;
}

export interface TaskFieldExtensionProjection {
  readonly field: string;
  readonly values: ReadonlyArray<string>;
  readonly default: null;
  readonly projection: {
    readonly column: string;
    readonly queryable: boolean;
  };
}

export interface TaskProjectionRow {
  readonly schema: "sqlite-task-row/v1";
  readonly taskId: string;
  readonly title: string;
  readonly parentTaskId?: string;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly canonicalStatus: ProjectionCanonicalStatus;
  readonly coordinationStatus: CoordinationStatus;
  readonly rawStatus: string;
  readonly packageDisposition: PackageDisposition;
  readonly closeoutReadiness: CloseoutReadiness;
  readonly lifecycleEngine: string;
  readonly freshness: ProjectionFreshness;
  readonly updatedAt: string;
  readonly source: ProjectionSource;
  readonly sourcePath: string;
  readonly vertical?: string;
  readonly preset?: string;
  readonly profile?: string;
  readonly moduleKey?: string;
  readonly moduleTitle?: string;
  readonly hasLessonCandidates?: boolean;
  readonly createdBy?: TaskCreatedBy;
  readonly fieldExtensions?: Readonly<Record<string, string | null>>;
}

export interface ProjectionWarning {
  readonly code: ProjectionWarningCode;
  readonly source: ProjectionWarningSource;
  readonly severity: ProjectionWarningSeverity;
  readonly message: string;
  readonly repairHint?: string;
}

export interface ProjectionReadResult {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface TaskProjectionOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly projectionPath?: string;
  readonly postMerge?: boolean;
  readonly eventRelationTruth?: EventBackedRelationTruth;
  readonly taskFieldExtensions?: ReadonlyArray<TaskFieldExtensionProjection>;
}

export interface ProjectionMeta {
  readonly version?: ContractVersion | null;
  readonly sourceHash: string;
  readonly rowsHash: string;
}
