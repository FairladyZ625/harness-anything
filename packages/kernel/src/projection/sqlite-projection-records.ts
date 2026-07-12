import type {
  DecisionProjectionRow,
  EntityAttributionProjection,
  TaskFieldExtensionProjection,
  TaskProjectionRow
} from "./types.ts";

export interface TaskRecord {
  readonly [column: string]: unknown;
  readonly task_id: string;
  readonly title: string;
  readonly parent_task_id: string | null;
  readonly work_kind: string | null;
  readonly risk_tier: string | null;
  readonly urgency: string | null;
  readonly canonical_status: string;
  readonly coordination_status: string;
  readonly raw_status: string;
  readonly package_disposition: string;
  readonly closeout_readiness: string;
  readonly lifecycle_engine: string;
  readonly freshness: string;
  readonly updated_at: string;
  readonly source: string;
  readonly source_path: string;
  readonly vertical: string | null;
  readonly preset: string | null;
  readonly profile: string | null;
  readonly module_key: string | null;
  readonly module_title: string | null;
  readonly has_lesson_candidates: number;
  readonly created_by_json: string | null;
  readonly attribution_json: string;
}

export interface DecisionRecord {
  readonly decision_id: string;
  readonly legacy_id: string | null;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen_json: string;
  readonly rejected_json: string;
  readonly path: string;
  readonly module_keys_json: string;
  readonly product_line_keys_json: string;
  readonly risk_tier: string | null;
  readonly urgency: string | null;
  readonly vertical: string | null;
  readonly preset: string | null;
  readonly decision_class: string | null;
  readonly proposed_by_json: string | null;
  readonly proposed_at: string | null;
  readonly arbiter_json: string | null;
  readonly provenance_json: string | null;
  readonly decided_at: string | null;
  readonly attribution_json: string;
}

export function recordToTaskRow(
  record: TaskRecord,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): TaskProjectionRow {
  const createdBy = record.created_by_json ? JSON.parse(record.created_by_json) as TaskProjectionRow["createdBy"] : undefined;
  const fieldExtensions = readTaskFieldExtensionRecord(record, taskFieldExtensions);
  return {
    schema: "sqlite-task-row/v1",
    taskId: record.task_id,
    title: record.title,
    ...(record.parent_task_id ? { parentTaskId: record.parent_task_id } : {}),
    ...(record.work_kind ? { workKind: record.work_kind as TaskProjectionRow["workKind"] } : {}),
    ...(record.risk_tier ? { riskTier: record.risk_tier as TaskProjectionRow["riskTier"] } : {}),
    ...(record.urgency ? { urgency: record.urgency as TaskProjectionRow["urgency"] } : {}),
    canonicalStatus: record.canonical_status as TaskProjectionRow["canonicalStatus"],
    coordinationStatus: record.coordination_status as TaskProjectionRow["coordinationStatus"],
    rawStatus: record.raw_status,
    packageDisposition: record.package_disposition as TaskProjectionRow["packageDisposition"],
    closeoutReadiness: record.closeout_readiness as TaskProjectionRow["closeoutReadiness"],
    lifecycleEngine: record.lifecycle_engine,
    freshness: record.freshness as TaskProjectionRow["freshness"],
    updatedAt: record.updated_at,
    source: record.source as TaskProjectionRow["source"],
    sourcePath: record.source_path,
    ...(record.vertical ? { vertical: record.vertical } : {}),
    ...(record.preset ? { preset: record.preset } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.module_key ? { moduleKey: record.module_key } : {}),
    ...(record.module_title ? { moduleTitle: record.module_title } : {}),
    hasLessonCandidates: record.has_lesson_candidates === 1,
    ...(createdBy ? { createdBy } : {}),
    attribution: JSON.parse(record.attribution_json) as EntityAttributionProjection,
    ...(fieldExtensions ? { fieldExtensions } : {})
  };
}

export function recordToDecisionRow(record: DecisionRecord): DecisionProjectionRow {
  return {
    schema: "d4-decision-row/v1",
    decisionId: record.decision_id,
    ...(record.legacy_id ? { legacyId: record.legacy_id } : {}),
    state: record.state,
    title: record.title,
    question: record.question,
    chosen: JSON.parse(record.chosen_json) as ReadonlyArray<string>,
    rejected: JSON.parse(record.rejected_json) as DecisionProjectionRow["rejected"],
    path: record.path,
    moduleKeys: JSON.parse(record.module_keys_json) as ReadonlyArray<string>,
    productLineKeys: JSON.parse(record.product_line_keys_json) as ReadonlyArray<string>,
    ...(record.risk_tier ? { riskTier: record.risk_tier as DecisionProjectionRow["riskTier"] } : {}),
    ...(record.urgency ? { urgency: record.urgency as DecisionProjectionRow["urgency"] } : {}),
    ...(record.vertical ? { vertical: record.vertical } : {}),
    ...(record.preset ? { preset: record.preset } : {}),
    ...(record.decision_class ? { decisionClass: record.decision_class as DecisionProjectionRow["decisionClass"] } : {}),
    ...(record.proposed_by_json ? { proposedBy: JSON.parse(record.proposed_by_json) as NonNullable<DecisionProjectionRow["proposedBy"]> } : {}),
    ...(record.proposed_at ? { proposedAt: record.proposed_at } : {}),
    ...(record.arbiter_json ? { arbiter: JSON.parse(record.arbiter_json) as NonNullable<DecisionProjectionRow["arbiter"]> } : {}),
    ...(record.provenance_json ? { provenance: JSON.parse(record.provenance_json) as NonNullable<DecisionProjectionRow["provenance"]> } : {}),
    ...(record.decided_at ? { decidedAt: record.decided_at } : {}),
    attribution: JSON.parse(record.attribution_json) as EntityAttributionProjection
  };
}

function readTaskFieldExtensionRecord(
  record: TaskRecord,
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): Readonly<Record<string, string | null>> | undefined {
  const projected = extensions.filter((extension) => extension.projection.queryable);
  if (projected.length === 0) return undefined;
  const values = Object.fromEntries(projected.map((extension) => {
    const rawValue = record[extension.projection.column];
    return [extension.field, typeof rawValue === "string" ? rawValue : null];
  }));
  return Object.values(values).some((value) => value !== null) ? values : undefined;
}
