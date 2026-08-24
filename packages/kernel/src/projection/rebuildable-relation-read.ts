import type { RelationCoverageRow, RelationFactRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import type { TaskProjectionRow } from "./types.ts";

export interface RebuildableRelationRead {
  readonly ok: true;
  readonly edges: readonly RelationGraphEdgeRow[];
  readonly coverageRows: readonly RelationCoverageRow[];
  readonly factAnchors: readonly {
    readonly factRef: string;
    readonly taskId: string;
    readonly factId: string;
    readonly sourcePath: string;
  }[];
  readonly facts: readonly RelationFactRow[];
  readonly taskRows: readonly TaskProjectionRow[];
}
export interface RebuildableRelationUnavailable {
  readonly ok: false;
  readonly reason: string;
}
export interface RebuildableRelationRecords {
  readonly edges: readonly EdgeRecord[];
  readonly coverageRows: readonly CoverageRecord[];
  readonly factAnchors: readonly FactAnchorRecord[];
  readonly facts: readonly FactRecord[];
  readonly taskRows: readonly TaskRecord[];
}
export const rebuildableRelationRequiredColumns = {
  task_projection: [
    "task_id",
    "title",
    "parent_task_id",
    "canonical_status",
    "coordination_status",
    "raw_status",
    "package_disposition",
    "closeout_readiness",
    "lifecycle_engine",
    "freshness",
    "updated_at",
    "source",
    "source_path",
    "work_kind",
    "risk_tier",
    "urgency",
    "vertical",
    "preset",
    "profile",
    "module_key",
    "module_title",
    "has_lesson_candidates",
  ],
  relation_edges: [
    "relation_id",
    "source_ref",
    "target_ref",
    "relation_type",
    "direction",
    "strength",
    "origin",
    "state",
    "rationale",
    "owner_ref",
    "source_path",
    "record_index",
  ],
  relation_coverage: [
    "claim_ref",
    "decision_ref",
    "status",
    "fulfillment",
    "covering_fact_ref",
    "refuting_fact_refs_json",
    "relation_path_json",
  ],
  task_fact_anchors: ["fact_ref", "task_id", "fact_id", "source_path"],
  task_fact_projection: [
    "fact_ref",
    "task_id",
    "fact_id",
    "schema_name",
    "statement",
    "source",
    "observed_at",
    "confidence",
    "memory_class",
    "memory_tags_json",
    "provenance_json",
    "liveness",
  ],
} as const;

export function decodeRebuildableRelationRecords(records: RebuildableRelationRecords): RebuildableRelationRead {
  return {
    ok: true,
    edges: records.edges.map(edgeRow),
    coverageRows: records.coverageRows.map(coverageRow),
    factAnchors: records.factAnchors.map((row) => ({
      factRef: row.fact_ref,
      taskId: row.task_id,
      factId: row.fact_id,
      sourcePath: row.source_path,
    })),
    facts: records.facts.map(factRow),
    taskRows: records.taskRows.map(taskRow),
  };
}
function edgeRow(row: EdgeRecord): RelationGraphEdgeRow {
  return {
    relationId: row.relation_id,
    sourceRef: row.source_ref,
    targetRef: row.target_ref,
    relationType: row.relation_type as RelationGraphEdgeRow["relationType"],
    direction: row.direction as RelationGraphEdgeRow["direction"],
    strength: row.strength as RelationGraphEdgeRow["strength"],
    origin: row.origin as RelationGraphEdgeRow["origin"],
    state: row.state as RelationGraphEdgeRow["state"],
    rationale: row.rationale,
    ownerRef: row.owner_ref,
    sourcePath: row.source_path,
    recordIndex: row.record_index,
  };
}
function coverageRow(row: CoverageRecord): RelationCoverageRow {
  return {
    decisionRef: row.decision_ref,
    claimRef: row.claim_ref,
    status: row.status as RelationCoverageRow["status"],
    fulfillment: row.fulfillment as RelationCoverageRow["fulfillment"],
    ...(row.covering_fact_ref ? { coveringFactRef: row.covering_fact_ref } : {}),
    refutingFactRefs: jsonStrings(row.refuting_fact_refs_json),
    relationPath: jsonStrings(row.relation_path_json),
  };
}
function factRow(row: FactRecord): RelationFactRow {
  const schema = row.schema_name;
  if (schema !== "task-fact-row/v1" || (row.liveness !== "standing" && row.liveness !== "superseded_fact"))
    throw new Error(`Unsupported relation fact row: ${schema}/${row.liveness}`);
  return {
    schema,
    ref: row.fact_ref,
    taskId: row.task_id,
    factId: row.fact_id,
    statement: row.statement,
    source: row.source,
    observedAt: row.observed_at,
    confidence: row.confidence as RelationFactRow["confidence"],
    memoryClass: row.memory_class as RelationFactRow["memoryClass"],
    memoryTags: jsonStrings(row.memory_tags_json),
    provenance: jsonRecords(row.provenance_json),
    liveness: row.liveness,
  };
}
function taskRow(row: TaskRecord): TaskProjectionRow {
  return {
    schema: "sqlite-task-row/v1",
    taskId: row.task_id,
    title: row.title,
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.work_kind ? { workKind: row.work_kind as TaskProjectionRow["workKind"] } : {}),
    ...(row.risk_tier ? { riskTier: row.risk_tier as TaskProjectionRow["riskTier"] } : {}),
    ...(row.urgency ? { urgency: row.urgency as TaskProjectionRow["urgency"] } : {}),
    canonicalStatus: row.canonical_status as TaskProjectionRow["canonicalStatus"],
    coordinationStatus: row.coordination_status as TaskProjectionRow["coordinationStatus"],
    rawStatus: row.raw_status,
    packageDisposition: row.package_disposition as TaskProjectionRow["packageDisposition"],
    closeoutReadiness: row.closeout_readiness as TaskProjectionRow["closeoutReadiness"],
    lifecycleEngine: row.lifecycle_engine,
    freshness: row.freshness as TaskProjectionRow["freshness"],
    updatedAt: row.updated_at,
    source: row.source as TaskProjectionRow["source"],
    sourcePath: row.source_path,
    ...(row.vertical ? { vertical: row.vertical } : {}),
    ...(row.preset ? { preset: row.preset } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.module_key ? { moduleKey: row.module_key } : {}),
    ...(row.module_title ? { moduleTitle: row.module_title } : {}),
    hasLessonCandidates: row.has_lesson_candidates === 1,
  };
}
function jsonStrings(value: string | null): readonly string[] {
  if (value === null) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item))
    throw new Error("Relation truth JSON string list is invalid");
  return parsed;
}
function jsonRecords(value: string): RelationFactRow["provenance"] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        ["runtime", "sessionId", "boundAt"].some(
          (field) => typeof (item as Record<string, unknown>)[field] !== "string",
        ),
    )
  )
    throw new Error("Relation fact provenance is invalid");
  return parsed as RelationFactRow["provenance"];
}

export interface EdgeRecord {
  readonly relation_id: string;
  readonly source_ref: string;
  readonly target_ref: string;
  readonly relation_type: string;
  readonly direction: string;
  readonly strength: string;
  readonly origin: string;
  readonly state: string;
  readonly rationale: string;
  readonly owner_ref: string;
  readonly source_path: string;
  readonly record_index: number;
}
export interface CoverageRecord {
  readonly claim_ref: string;
  readonly decision_ref: string;
  readonly status: string;
  readonly fulfillment: string | null;
  readonly covering_fact_ref: string | null;
  readonly refuting_fact_refs_json: string | null;
  readonly relation_path_json: string;
}
export interface FactAnchorRecord {
  readonly fact_ref: string;
  readonly task_id: string;
  readonly fact_id: string;
  readonly source_path: string;
}
export interface FactRecord {
  readonly fact_ref: string;
  readonly task_id: string;
  readonly fact_id: string;
  readonly schema_name: string;
  readonly statement: string;
  readonly source: string;
  readonly observed_at: string;
  readonly confidence: string;
  readonly memory_class: string;
  readonly memory_tags_json: string;
  readonly provenance_json: string;
  readonly liveness: string;
}
export interface TaskRecord {
  readonly task_id: string;
  readonly title: string;
  readonly parent_task_id: string | null;
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
  readonly work_kind: string | null;
  readonly risk_tier: string | null;
  readonly urgency: string | null;
  readonly vertical: string | null;
  readonly preset: string | null;
  readonly profile: string | null;
  readonly module_key: string | null;
  readonly module_title: string | null;
  readonly has_lesson_candidates: number;
}
