import type { CanonicalStatus, CloseoutReadiness, PriorityTier, TaskWorkKind } from "../domain/index.ts";
import type { PackageDisposition } from "../domain/package-disposition.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import type { EventBackedRelationTruth } from "./relation-graph-projection.ts";

export type ProjectionFreshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";
export type ProjectionSource = "local-document" | "external-engine" | "snapshot-cache";
export type ProjectionCanonicalStatus = CanonicalStatus | "unknown";
export type CoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";
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

export interface TaskFieldExtensionFilter {
  readonly field: string;
  readonly column: string;
  readonly value: string;
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

export interface TaskProjectionQueryFilters {
  readonly state?: string;
  readonly moduleKey?: string;
  readonly queue?: string;
  readonly preset?: string;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly review?: string;
  readonly lesson?: "present" | "missing";
  readonly missingMaterials?: boolean;
  readonly includeArchived?: boolean;
  readonly search?: string;
  readonly fieldExtensions?: ReadonlyArray<TaskFieldExtensionFilter>;
}

export interface ProjectionWarning {
  readonly code: ProjectionWarningCode;
  readonly source: ProjectionWarningSource;
  readonly severity: ProjectionWarningSeverity;
  readonly message: string;
  readonly repairHint?: string;
}

export interface ProjectionCheckAxisReport {
  readonly axis: ProjectionWarningSource;
  readonly ok: boolean;
  readonly warningCount: number;
  readonly hardFailCount: number;
  readonly codes: ReadonlyArray<ProjectionWarningCode>;
}

export interface ProjectionCheckReport {
  readonly schema: "harness-check-report/v1";
  readonly ok: boolean;
  readonly axes: readonly [ProjectionCheckAxisReport, ProjectionCheckAxisReport, ProjectionCheckAxisReport];
  readonly summary: {
    readonly rowCount: number;
    readonly warningCount: number;
    readonly hardFailCount: number;
  };
}

export interface ProjectionReadResult {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface ProjectionCheckResult extends ProjectionReadResult {
  readonly ok: boolean;
  readonly projectionPath: string;
  readonly report: ProjectionCheckReport;
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
  readonly version?: string;
  readonly sourceHash: string;
  readonly rowsHash: string;
}
