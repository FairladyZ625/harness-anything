// @write-boundary-exemption rebuildable-projection
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { decodeRebuildableRelationRecords, rebuildableRelationRequiredColumns, type CoverageRecord, type EdgeRecord, type FactAnchorRecord, type FactRecord, type RebuildableRelationRead, type RebuildableRelationUnavailable, type TaskRecord as RelationTaskRecord } from "./rebuildable-relation-read.ts";
import type { ColdDecisionProjectionRow } from "./cold-rebuild-source.ts";
import type { FactAnchorRow, RelationCoverageRow, RelationFactRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import type {
  ProjectionMeta,
  TaskFieldExtensionProjection,
  TaskProjectionRow
} from "./types.ts";

export const projectionVersion = "entity-projection/d4-v3";
const baseTaskProjectionColumns = [
  "task_id",
  "title",
  "parent_task_id",
  "work_kind",
  "risk_tier",
  "urgency",
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
  "vertical",
  "preset",
  "profile",
  "module_key",
  "module_title",
  "has_lesson_candidates",
  "created_by_json"
] as const;

export function writeProjectionDatabase(
  projectionPath: string,
  rows: ReadonlyArray<TaskProjectionRow>,
  meta: ProjectionMeta,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection>,
  relationProjection: { readonly edges: readonly RelationGraphEdgeRow[]; readonly coverageRows: readonly RelationCoverageRow[]; readonly factAnchors: readonly FactAnchorRow[]; readonly facts: readonly RelationFactRow[]; readonly decisions: readonly ColdDecisionProjectionRow[]; readonly truthComplete: boolean }
): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  runSqlite(tempPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = DELETE`;
    yield* sql`CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    yield* sql`
      CREATE TABLE task_projection (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parent_task_id TEXT,
        canonical_status TEXT NOT NULL,
        coordination_status TEXT NOT NULL,
        raw_status TEXT NOT NULL,
        package_disposition TEXT NOT NULL,
        closeout_readiness TEXT NOT NULL,
        lifecycle_engine TEXT NOT NULL,
        freshness TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        work_kind TEXT,
        risk_tier TEXT,
        urgency TEXT,
        vertical TEXT,
        preset TEXT,
        profile TEXT,
        module_key TEXT,
        module_title TEXT,
        has_lesson_candidates INTEGER NOT NULL,
        created_by_json TEXT
      )
    `;
    const projectedTaskFieldExtensions = queryableTaskFieldExtensions(taskFieldExtensions);
    for (const extension of projectedTaskFieldExtensions) {
      yield* addTaskProjectionColumn(sql, extension.projection.column);
    }
    yield* insertMeta(sql, "version", projectionVersion);
    yield* insertMeta(sql, "sourceHash", meta.sourceHash);
    yield* insertMeta(sql, "rowsHash", meta.rowsHash);
    if (relationProjection.truthComplete) yield* insertMeta(sql, "relationTruthSource", "authored-l1/v1");
    for (const row of rows) yield* insertTaskRow(sql, row, projectedTaskFieldExtensions);
    yield* sql`CREATE INDEX task_projection_status ON task_projection (canonical_status, coordination_status)`;
    yield* sql`CREATE INDEX task_projection_parent_task_id ON task_projection (parent_task_id)`;
    yield* sql`CREATE INDEX task_projection_module_key ON task_projection (module_key)`;
    yield* writeDecisionProjection(sql, relationProjection.decisions);
    yield* writeRelationProjection(sql, relationProjection);
  }));
  renameSync(tempPath, projectionPath);
}

export function tryReadProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath, taskFieldExtensions)
    };
  } catch {
    return { ok: false };
  }
}

export function queryTaskChildrenRows(projectionPath: string, parentTaskId: string): ReadonlyArray<TaskProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection WHERE parent_task_id = ? ORDER BY task_id", [parentTaskId]);
    return records.map((record) => recordToTaskRow(record));
  }));
}

function readProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly meta: ProjectionMeta;
} {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const metaRows = yield* sql`SELECT key, value FROM projection_meta`;
    const meta = new Map(metaRows.map((row) => [String(row.key), String(row.value)]));
    const taskRecords = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection ORDER BY task_id");
    return {
      meta: {
        version: meta.get("version"),
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? ""
      },
      rows: taskRecords.map((record) => recordToTaskRow(record, taskFieldExtensions))
    };
  }));
}

export function runSqlite<A>(filename: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): A {
  return Effect.runSync(Effect.provide(effect, SqliteClient.layer({ filename })));
}

function runReadonlySqlite<A>(filename: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): A { return Effect.runSync(Effect.provide(effect, SqliteClient.layer({ filename, readonly: true, disableWAL: true }))); }
export function readRebuildableRelationProjection(projectionPath: string): RebuildableRelationRead | RebuildableRelationUnavailable { try { return runReadonlySqlite(projectionPath, Effect.gen(function* () { const sql = yield* SqlClient.SqlClient, marker = yield* sql.unsafe<{ readonly value: string }>("SELECT value FROM projection_meta WHERE key = 'relationTruthSource'"); if (marker[0]?.value !== "authored-l1/v1") throw new Error("Relation truth source is unavailable or incomplete"); for (const [table, columns] of Object.entries(rebuildableRelationRequiredColumns)) { const actual = new Set((yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`)).map(({ name }) => name)), missing = columns.filter((column) => !actual.has(column)); if (missing.length) throw new Error(`Relation truth table ${table} is unavailable or missing columns: ${missing.join(", ")}`); } return decodeRebuildableRelationRecords({ edges: yield* sql.unsafe<EdgeRecord>("SELECT * FROM relation_edges ORDER BY relation_id"), coverageRows: yield* sql.unsafe<CoverageRecord>("SELECT * FROM relation_coverage ORDER BY claim_ref"), factAnchors: yield* sql.unsafe<FactAnchorRecord>("SELECT * FROM task_fact_anchors ORDER BY fact_ref"), facts: yield* sql.unsafe<FactRecord>("SELECT * FROM task_fact_projection ORDER BY fact_ref"), taskRows: yield* sql.unsafe<RelationTaskRecord>("SELECT * FROM task_projection ORDER BY task_id") }); })); } catch (error) { consumeKnownError(error); return { ok: false, reason: error instanceof Error ? error.message : String(error) }; } }
function writeDecisionProjection(sql: SqlClient.SqlClient, rows: readonly ColdDecisionProjectionRow[]): Effect.Effect<void, unknown> { return Effect.gen(function* () { yield* sql`CREATE TABLE decision_projection (decision_id TEXT PRIMARY KEY, legacy_id TEXT, legacy_number INTEGER, state TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL, chosen_json TEXT NOT NULL, rejected_json TEXT NOT NULL, path TEXT NOT NULL, module_keys_json TEXT NOT NULL, product_line_keys_json TEXT NOT NULL, risk_tier TEXT, urgency TEXT, vertical TEXT, preset TEXT, decision_class TEXT, proposed_at TEXT, provenance_json TEXT, decided_at TEXT)`; for (const row of rows) yield* sql`INSERT INTO decision_projection VALUES (${row.decisionId}, ${row.legacyId ?? null}, ${row.legacyId ? Number(row.legacyId.slice(1)) : null}, ${row.state}, ${row.title}, ${row.question}, ${JSON.stringify(row.chosen)}, ${JSON.stringify(row.rejected)}, ${row.path}, ${JSON.stringify(row.moduleKeys)}, ${JSON.stringify(row.productLineKeys)}, ${row.riskTier ?? null}, ${row.urgency ?? null}, ${row.vertical ?? null}, ${row.preset ?? null}, ${row.decisionClass ?? null}, ${row.proposedAt ?? null}, ${row.provenance ? JSON.stringify(row.provenance) : null}, ${row.decidedAt ?? null})`; yield* sql`CREATE INDEX decision_projection_legacy_number ON decision_projection(legacy_number)`; yield* sql`CREATE INDEX decision_projection_state ON decision_projection(state)`; }); }
function writeRelationProjection(sql: SqlClient.SqlClient, input: { readonly edges: readonly RelationGraphEdgeRow[]; readonly coverageRows: readonly RelationCoverageRow[]; readonly factAnchors: readonly FactAnchorRow[]; readonly facts: readonly RelationFactRow[] }): Effect.Effect<void, unknown> { return Effect.gen(function* () { yield* sql`CREATE TABLE relation_edges (relation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL, direction TEXT NOT NULL, strength TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, rationale TEXT NOT NULL, owner_ref TEXT NOT NULL, source_path TEXT NOT NULL, record_index INTEGER NOT NULL)`; yield* sql`CREATE TABLE relation_coverage (claim_ref TEXT PRIMARY KEY, decision_ref TEXT NOT NULL, status TEXT NOT NULL, fulfillment TEXT, covering_fact_ref TEXT, refuting_fact_refs_json TEXT, relation_path_json TEXT NOT NULL)`; yield* sql`CREATE TABLE task_fact_anchors (fact_ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, fact_id TEXT NOT NULL, source_path TEXT NOT NULL)`; yield* sql`CREATE TABLE task_fact_projection (fact_ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, fact_id TEXT NOT NULL, schema_name TEXT NOT NULL, statement TEXT NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL, confidence TEXT NOT NULL, memory_class TEXT NOT NULL, memory_tags_json TEXT NOT NULL, provenance_json TEXT NOT NULL)`; for (const row of input.edges) yield* sql`INSERT INTO relation_edges VALUES (${row.relationId}, ${row.sourceRef}, ${row.targetRef}, ${row.relationType}, ${row.direction}, ${row.strength}, ${row.origin}, ${row.state}, ${row.rationale}, ${row.ownerRef}, ${row.sourcePath}, ${row.recordIndex})`; for (const row of input.coverageRows) yield* sql`INSERT INTO relation_coverage VALUES (${row.claimRef}, ${row.decisionRef}, ${row.status}, ${row.fulfillment}, ${row.coveringFactRef ?? null}, ${row.refutingFactRefs ? JSON.stringify(row.refutingFactRefs) : null}, ${JSON.stringify(row.relationPath)})`; for (const row of input.factAnchors) yield* sql`INSERT INTO task_fact_anchors VALUES (${row.factRef}, ${row.taskId}, ${row.factId}, ${row.sourcePath})`; for (const row of input.facts) yield* sql`INSERT INTO task_fact_projection VALUES (${row.ref}, ${row.taskId}, ${row.factId}, ${row.schema}, ${row.statement}, ${row.source}, ${row.observedAt}, ${row.confidence}, ${row.memoryClass}, ${JSON.stringify(row.memoryTags)}, ${JSON.stringify(row.provenance)})`; yield* sql`CREATE INDEX relation_edges_source_ref ON relation_edges(source_ref)`; yield* sql`CREATE INDEX relation_edges_target_ref ON relation_edges(target_ref)`; yield* sql`CREATE INDEX relation_coverage_decision_ref ON relation_coverage(decision_ref)`; yield* sql`CREATE INDEX task_fact_anchors_task_id ON task_fact_anchors(task_id)`; yield* sql`CREATE INDEX task_fact_projection_task_id ON task_fact_projection(task_id)`; }); }
function consumeKnownError(error: unknown): void { void error; }

function insertMeta(sql: SqlClient.SqlClient, key: string, value: string): Effect.Effect<unknown, unknown> {
  return sql`INSERT INTO projection_meta (key, value) VALUES (${key}, ${value})`;
}

function addTaskProjectionColumn(sql: SqlClient.SqlClient, column: string): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`ALTER TABLE task_projection ADD COLUMN ${quoteIdentifier(column)} TEXT`);
}

export function insertTaskRow(
  sql: SqlClient.SqlClient,
  row: TaskProjectionRow,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection>
): Effect.Effect<unknown, unknown> {
  const extensionColumns = taskFieldExtensions.map((extension) => extension.projection.column);
  const columns = [...baseTaskProjectionColumns, ...extensionColumns].map(quoteIdentifier);
  const values = [
    row.taskId,
    row.title,
    row.parentTaskId ?? null,
    row.workKind ?? null,
    row.riskTier ?? null,
    row.urgency ?? null,
    row.canonicalStatus,
    row.coordinationStatus,
    row.rawStatus,
    row.packageDisposition,
    row.closeoutReadiness,
    row.lifecycleEngine,
    row.freshness,
    row.updatedAt,
    row.source,
    row.sourcePath,
    row.vertical ?? null,
    row.preset ?? null,
    row.profile ?? null,
    row.moduleKey ?? null,
    row.moduleTitle ?? null,
    row.hasLessonCandidates === true ? 1 : 0,
    row.createdBy ? JSON.stringify(row.createdBy) : null,
    ...taskFieldExtensions.map((extension) => row.fieldExtensions?.[extension.field] ?? extension.default)
  ];
  return sql.unsafe(
    `INSERT OR REPLACE INTO task_projection (${columns.join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
    values
  );
}

interface TaskRecord {
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
}

function recordToTaskRow(
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
    ...(fieldExtensions ? { fieldExtensions } : {})
  };
}

export function queryableTaskFieldExtensions(
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): ReadonlyArray<TaskFieldExtensionProjection> {
  const seen = new Set<string>(baseTaskProjectionColumns);
  const projected: TaskFieldExtensionProjection[] = [];
  for (const extension of extensions) {
    if (!extension.projection.queryable) continue;
    if (seen.has(extension.projection.column)) continue;
    seen.add(extension.projection.column);
    projected.push(extension);
  }
  return projected;
}

function readTaskFieldExtensionRecord(
  record: TaskRecord,
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): Readonly<Record<string, string | null>> | undefined {
  const projected = queryableTaskFieldExtensions(extensions);
  if (projected.length === 0) return undefined;
  const values = Object.fromEntries(projected.map((extension) => {
    const rawValue = record[extension.projection.column];
    return [extension.field, typeof rawValue === "string" ? rawValue : null];
  }));
  return Object.values(values).some((value) => value !== null) ? values : undefined;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
