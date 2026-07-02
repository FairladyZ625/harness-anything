import type { CloseoutReadiness, DomainStatus, PackageDisposition } from "../domain/index.ts";
import type { HarnessLayoutOverrides } from "../layout/index.ts";

export type ProjectionFreshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";
export type ProjectionSource = "local-document" | "external-engine" | "snapshot-cache";
export type ProjectionCanonicalStatus = DomainStatus | "unknown";
export type CoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";
export type ProjectionWarningSource = "source-package" | "generated-cache" | "collaboration-gate";
export type ProjectionWarningSeverity = "warning" | "hard-fail";
export type ProjectionWarningCode =
  | "projection_missing"
  | "projection_stale"
  | "projection_tampered"
  | "source_malformed"
  | "duplicate_task_id"
  | "duplicate_external_binding"
  | "generated_tracked"
  | "binding_tampered"
  | "conflict_marker_present"
  | "decision_watermark_missing"
  | "decision_watermark_duplicate"
  | "dangling_entity_ref"
  | "relation_cycle_detected";

export interface TaskCreatedBy {
  readonly name: string;
  readonly email: string;
}

export interface TaskProjectionRow {
  readonly schema: "sqlite-task-row/v1";
  readonly taskId: string;
  readonly title: string;
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
}

export interface ProjectionMeta {
  readonly sourceHash: string;
  readonly rowsHash: string;
}
