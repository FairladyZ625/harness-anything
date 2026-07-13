import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { FactAnchorRow, RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { unresolvedEntityAttribution } from "./entity-attribution-projection.ts";
import {
  recordToDecisionRow,
  recordToTaskRow,
  type DecisionRecord,
  type TaskRecord
} from "./sqlite-projection-records.ts";
import type {
  DecisionProjectionQueryFilters,
  DecisionProjectionRow,
  ProjectionMeta,
  TaskFieldExtensionProjection,
  TaskProjectionQueryFilters,
  TaskProjectionRow
} from "./types.ts";

export const projectionVersion = "entity-projection/d4-v11";
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
  "attribution_json"
] as const;

export interface ProjectionGraphRows {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
}

export function writeProjectionDatabase(
  projectionPath: string,
  rows: ReadonlyArray<TaskProjectionRow>,
  decisionRows: ReadonlyArray<DecisionProjectionRow>,
  meta: ProjectionMeta,
  graphRows: ProjectionGraphRows = { relationEdges: [], coverageRows: [], factAnchors: [] },
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = [],
  materializeSupplemental?: (sql: SqlClient.SqlClient) => Effect.Effect<void, unknown>
): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  const writeEffect = Effect.gen(function* () {
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
        attribution_json TEXT NOT NULL
      )
    `;
    const projectedTaskFieldExtensions = queryableTaskFieldExtensions(taskFieldExtensions);
    for (const extension of projectedTaskFieldExtensions) {
      yield* addTaskProjectionColumn(sql, extension.projection.column);
    }
    yield* sql`
      CREATE TABLE decision_projection (
        decision_id TEXT PRIMARY KEY,
        legacy_id TEXT,
        legacy_number INTEGER,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        chosen_json TEXT NOT NULL,
        rejected_json TEXT NOT NULL,
        path TEXT NOT NULL,
        module_keys_json TEXT NOT NULL,
        product_line_keys_json TEXT NOT NULL,
        risk_tier TEXT,
        urgency TEXT,
        vertical TEXT,
        preset TEXT,
        decision_class TEXT,
        proposed_at TEXT,
        provenance_json TEXT,
        decided_at TEXT,
        attribution_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE relation_edges (
        relation_id TEXT PRIMARY KEY,
        source_ref TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        row_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE relation_coverage (
        claim_ref TEXT PRIMARY KEY,
        decision_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        covering_fact_ref TEXT,
        row_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE task_fact_anchors (
        fact_ref TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        row_json TEXT NOT NULL
      )
    `;
    yield* insertMeta(sql, "version", projectionVersion);
    yield* insertMeta(sql, "sourceHash", meta.sourceHash);
    yield* insertMeta(sql, "rowsHash", meta.rowsHash);
    yield* insertMeta(sql, "decisionRowsHash", meta.decisionRowsHash ?? "");
    yield* insertMeta(sql, "declaredRowsHash", meta.declaredRowsHash ?? "");
    yield* insertMeta(sql, "declaredManifestHash", meta.declaredManifestHash ?? "");
    yield* insertMeta(sql, "attributionRowsHash", meta.attributionRowsHash ?? "");
    yield* insertMeta(sql, "attributionSourceHash", meta.attributionSourceHash ?? "");
    yield* insertMeta(sql, "taskSourceHash", meta.taskSourceHash ?? "");
    yield* insertMeta(sql, "sourceCacheHash", meta.sourceCacheHash ?? "");
    yield* insertMeta(sql, "legacyPersonIdsHash", meta.legacyPersonIdsHash ?? "");
    for (const row of rows) yield* insertTaskRow(sql, row, projectedTaskFieldExtensions);
    for (const row of decisionRows) yield* insertDecisionRow(sql, row);
    for (const edge of graphRows.relationEdges) yield* insertRelationEdge(sql, edge);
    for (const row of graphRows.coverageRows) yield* insertCoverageRow(sql, row);
    for (const row of graphRows.factAnchors) yield* insertFactAnchor(sql, row);
    yield* sql`CREATE INDEX task_projection_status ON task_projection (canonical_status, coordination_status)`;
    yield* sql`CREATE INDEX task_projection_parent_task_id ON task_projection (parent_task_id)`;
    yield* sql`CREATE INDEX task_projection_module_key ON task_projection (module_key)`;
    yield* sql`CREATE INDEX decision_projection_legacy_number ON decision_projection (legacy_number)`;
    yield* sql`CREATE INDEX decision_projection_state ON decision_projection (state)`;
    yield* sql`CREATE INDEX relation_edges_source_ref ON relation_edges (source_ref)`;
    yield* sql`CREATE INDEX relation_edges_target_ref ON relation_edges (target_ref)`;
    yield* sql`CREATE INDEX relation_coverage_decision_ref ON relation_coverage (decision_ref)`;
    yield* sql`CREATE INDEX task_fact_anchors_task_id ON task_fact_anchors (task_id)`;
    if (materializeSupplemental) yield* materializeSupplemental(sql);
    const attributionRowsHash = yield* hashAttributionProjectionState(sql);
    yield* sql`UPDATE projection_meta SET value = ${attributionRowsHash} WHERE key = 'attributionRowsHash'`;
  });
  try {
    runSqlite(tempPath, writeEffect);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  renameSync(tempPath, projectionPath);
}

export function tryReadProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly decisionRows: ReadonlyArray<DecisionProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath, taskFieldExtensions)
    };
  } catch {
    return { ok: false };
  }
}

export function queryTaskProjectionRows(
  projectionPath: string,
  filters: TaskProjectionQueryFilters,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): ReadonlyArray<TaskProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const where = taskWhereClause(filters);
    const records = yield* sql.unsafe<TaskRecord>(`SELECT * FROM task_projection ${where.sql} ORDER BY task_id`, where.params);
    return records.map((record) => recordToTaskRow(record, taskFieldExtensions));
  }));
}

export function queryDecisionProjectionRows(projectionPath: string, filters: DecisionProjectionQueryFilters): ReadonlyArray<DecisionProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const where = decisionWhereClause(filters);
    const records = yield* sql.unsafe<DecisionRecord>(`SELECT * FROM decision_projection ${where.sql} ORDER BY COALESCE(legacy_number, 1000000000), decision_id`, where.params);
    return records.map(recordToDecisionRow);
  }));
}

export function queryTaskChildrenRows(projectionPath: string, parentTaskId: string): ReadonlyArray<TaskProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection WHERE parent_task_id = ? ORDER BY task_id", [parentTaskId]);
    return records.map((record) => recordToTaskRow(record));
  }));
}

export function queryTaskSubtreeRows(projectionPath: string, rootTaskId: string): ReadonlyArray<TaskProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql.unsafe<TaskRecord>(`
      WITH RECURSIVE subtree(task_id) AS (
        SELECT task_id FROM task_projection WHERE task_id = ?
        UNION
        SELECT child.task_id
        FROM task_projection child
        JOIN subtree parent ON child.parent_task_id = parent.task_id
      )
      SELECT task_projection.*
      FROM task_projection
      JOIN subtree ON task_projection.task_id = subtree.task_id
      ORDER BY task_projection.task_id
    `, [rootTaskId]);
    return records.map((record) => recordToTaskRow(record));
  }));
}

export function readRelationGraphRows(projectionPath: string): ProjectionGraphRows {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const edgeRecords = yield* sql`SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id`;
    const coverageRecords = yield* sql`SELECT row_json FROM relation_coverage ORDER BY claim_ref`;
    const factAnchorRecords = yield* sql`SELECT row_json FROM task_fact_anchors ORDER BY fact_ref`;
    return {
      relationEdges: edgeRecords.map((record) => JSON.parse(String(record.row_json)) as RelationGraphEdgeRow),
      coverageRows: coverageRecords.map((record) => JSON.parse(String(record.row_json)) as RelationCoverageRow),
      factAnchors: factAnchorRecords.map((record) => JSON.parse(String(record.row_json)) as FactAnchorRow)
    };
  }));
}

function readProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly decisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly meta: ProjectionMeta;
} {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const metaRows = yield* sql`SELECT key, value FROM projection_meta`;
    const meta = new Map(metaRows.map((row) => [String(row.key), String(row.value)]));
    const taskRecords = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection ORDER BY task_id");
    const decisionRecords = yield* sql.unsafe<DecisionRecord>("SELECT * FROM decision_projection ORDER BY COALESCE(legacy_number, 1000000000), decision_id");
    return {
      meta: {
        version: meta.get("version"),
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? "",
        decisionRowsHash: meta.get("decisionRowsHash") ?? "",
        declaredRowsHash: meta.get("declaredRowsHash") ?? "",
        declaredManifestHash: meta.get("declaredManifestHash") ?? "",
        attributionRowsHash: meta.get("attributionRowsHash") ?? "",
        attributionSourceHash: meta.get("attributionSourceHash") ?? "",
        taskSourceHash: meta.get("taskSourceHash") ?? "",
        sourceCacheHash: meta.get("sourceCacheHash") ?? "",
        legacyPersonIdsHash: meta.get("legacyPersonIdsHash") ?? ""
      },
      rows: taskRecords.map((record) => recordToTaskRow(record, taskFieldExtensions)),
      decisionRows: decisionRecords.map(recordToDecisionRow)
    };
  }));
}

export function runSqlite<A>(filename: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): A {
  return Effect.runSync(Effect.provide(effect, SqliteClient.layer({ filename })));
}

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
    JSON.stringify(row.attribution ?? unresolvedEntityAttribution()),
    ...taskFieldExtensions.map((extension) => row.fieldExtensions?.[extension.field] ?? extension.default)
  ];
  const assignments = [...baseTaskProjectionColumns, ...extensionColumns]
    .filter((column) => column !== "task_id" && column !== "attribution_json")
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`);
  return sql.unsafe(
    `INSERT INTO task_projection (${columns.join(", ")}) VALUES (${values.map(() => "?").join(", ")}) ON CONFLICT (task_id) DO UPDATE SET ${assignments.join(", ")}`,
    values
  );
}

export function insertDecisionRow(sql: SqlClient.SqlClient, row: DecisionProjectionRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT INTO decision_projection (
      decision_id, legacy_id, legacy_number, state, title, question, chosen_json,
      rejected_json, path, module_keys_json, product_line_keys_json, risk_tier, urgency,
      vertical, preset, decision_class, proposed_at, provenance_json, decided_at, attribution_json
    ) VALUES (
      ${row.decisionId}, ${row.legacyId ?? null}, ${row.legacyId ? legacyNumberFromLabel(row.legacyId) ?? null : null},
      ${row.state}, ${row.title}, ${row.question}, ${JSON.stringify(row.chosen)}, ${JSON.stringify(row.rejected)},
      ${row.path}, ${JSON.stringify(row.moduleKeys)}, ${JSON.stringify(row.productLineKeys)}, ${row.riskTier ?? null}, ${row.urgency ?? null},
      ${row.vertical ?? null}, ${row.preset ?? null}, ${row.decisionClass ?? null}, ${row.proposedAt ?? null},
      ${row.provenance ? JSON.stringify(row.provenance) : null}, ${row.decidedAt ?? null},
      ${JSON.stringify(row.attribution ?? unresolvedEntityAttribution())}
    ) ON CONFLICT (decision_id) DO UPDATE SET
      legacy_id = excluded.legacy_id,
      legacy_number = excluded.legacy_number,
      state = excluded.state,
      title = excluded.title,
      question = excluded.question,
      chosen_json = excluded.chosen_json,
      rejected_json = excluded.rejected_json,
      path = excluded.path,
      module_keys_json = excluded.module_keys_json,
      product_line_keys_json = excluded.product_line_keys_json,
      risk_tier = excluded.risk_tier,
      urgency = excluded.urgency,
      vertical = excluded.vertical,
      preset = excluded.preset,
      decision_class = excluded.decision_class,
      proposed_at = excluded.proposed_at,
      provenance_json = excluded.provenance_json,
      decided_at = excluded.decided_at
  `;
}

export function readAttributionProjectionStateHash(projectionPath: string): string {
  return runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, hashAttributionProjectionState));
}

export function hashAttributionProjectionState(sql: SqlClient.SqlClient): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const tableRecords = yield* sql<{ readonly name: unknown }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    const tableNames = tableRecords.map((record) => String(record.name));
    const entities: Array<{
      readonly table: string;
      readonly rows: ReadonlyArray<{ readonly id: string; readonly attribution: string }>;
    }> = [];
    for (const table of tableNames) {
      const columns = yield* sql.unsafe<{ readonly name: unknown; readonly pk: unknown }>(`PRAGMA table_info(${quoteIdentifier(table)})`);
      if (!columns.some((column) => String(column.name) === "attribution_json")) continue;
      const primaryKey = columns.find((column) => Number(column.pk) > 0);
      if (!primaryKey) throw new Error(`attributed projection table ${table} has no primary key`);
      const idColumn = String(primaryKey.name);
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT ${quoteIdentifier(idColumn)} AS entity_id, attribution_json FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(idColumn)}`
      );
      entities.push({
        table,
        rows: records.map((record) => ({ id: String(record.entity_id), attribution: String(record.attribution_json) }))
      });
    }
    const events = tableNames.includes("attribution_events")
      ? (yield* sql<Record<string, unknown>>`
          SELECT event_id, op_id, subject_ref, operation, principal_person_id,
                 executor_agent_id, occurred_at, recorded_at, source_json
          FROM attribution_events
          ORDER BY occurred_at, event_id
        `).map((record) => ({
          eventId: String(record.event_id),
          opId: String(record.op_id),
          subjectRef: String(record.subject_ref),
          operation: String(record.operation),
          principalPersonId: String(record.principal_person_id),
          executorAgentId: record.executor_agent_id === null ? null : String(record.executor_agent_id),
          occurredAt: String(record.occurred_at),
          recordedAt: String(record.recorded_at),
          source: String(record.source_json)
        }))
      : [];
    return stablePayloadHash({ schema: "projection-attribution-state/v1", entities, events });
  });
}

export function insertRelationEdge(sql: SqlClient.SqlClient, edge: RelationGraphEdgeRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO relation_edges (relation_id, source_ref, target_ref, relation_type, direction, state, row_json)
    VALUES (${edge.relationId}, ${edge.sourceRef}, ${edge.targetRef}, ${edge.relationType}, ${edge.direction}, ${edge.state}, ${JSON.stringify(edge)})
  `;
}

export function insertCoverageRow(sql: SqlClient.SqlClient, row: RelationCoverageRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO relation_coverage (claim_ref, decision_ref, status, covering_fact_ref, row_json)
    VALUES (${row.claimRef}, ${row.decisionRef}, ${row.status}, ${row.coveringFactRef ?? null}, ${JSON.stringify(row)})
  `;
}

export function insertFactAnchor(sql: SqlClient.SqlClient, row: FactAnchorRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO task_fact_anchors (fact_ref, task_id, fact_id, source_path, row_json)
    VALUES (${row.factRef}, ${row.taskId}, ${row.factId}, ${row.sourcePath}, ${JSON.stringify(row)})
  `;
}

function taskWhereClause(filters: TaskProjectionQueryFilters): { readonly sql: string; readonly params: ReadonlyArray<unknown> } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!filters.includeArchived) clauses.push("package_disposition = 'active'");
  if (filters.state) addTaskStateFilter(clauses, params, filters.state);
  if (filters.moduleKey) addClause(clauses, params, "module_key = ?", filters.moduleKey);
  if (filters.queue) addTaskQueueFilter(clauses, params, filters.queue);
  if (filters.preset) addClause(clauses, params, "preset = ?", filters.preset);
  if (filters.workKind) addClause(clauses, params, "work_kind = ?", filters.workKind);
  if (filters.riskTier) addClause(clauses, params, "risk_tier = ?", filters.riskTier);
  if (filters.urgency) addClause(clauses, params, "urgency = ?", filters.urgency);
  if (filters.review) addTaskReviewFilter(clauses, params, filters.review);
  if (filters.lesson) clauses.push(filters.lesson === "present" ? "has_lesson_candidates = 1" : "has_lesson_candidates = 0");
  if (filters.missingMaterials) clauses.push("closeout_readiness = 'missing'");
  if (filters.search) {
    const needle = `%${filters.search.toLocaleLowerCase()}%`;
    clauses.push("(lower(task_id) LIKE ? OR lower(title) LIKE ? OR lower(source_path) LIKE ? OR lower(COALESCE(preset, '')) LIKE ? OR lower(COALESCE(module_key, '')) LIKE ? OR lower(COALESCE(module_title, '')) LIKE ? OR lower(COALESCE(attribution_json, '')) LIKE ?)");
    params.push(needle, needle, needle, needle, needle, needle, needle);
  }
  for (const extensionFilter of filters.fieldExtensions ?? []) {
    addClause(clauses, params, `${quoteIdentifier(extensionFilter.column)} = ?`, extensionFilter.value);
  }
  return where(clauses, params);
}

function decisionWhereClause(filters: DecisionProjectionQueryFilters): { readonly sql: string; readonly params: ReadonlyArray<unknown> } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.legacyId) addClause(clauses, params, "legacy_id = ?", filters.legacyId);
  if (filters.legacyRange) {
    clauses.push("legacy_number BETWEEN ? AND ?");
    params.push(filters.legacyRange.start, filters.legacyRange.end);
  }
  if (filters.state) addClause(clauses, params, "state = ?", filters.state);
  if (filters.moduleKey) addJsonArrayContains(clauses, params, "module_keys_json", filters.moduleKey);
  if (filters.productLine) addJsonArrayContains(clauses, params, "product_line_keys_json", filters.productLine);
  if (filters.search) {
    const needle = `%${filters.search.toLocaleLowerCase()}%`;
    clauses.push("(lower(decision_id) LIKE ? OR lower(COALESCE(legacy_id, '')) LIKE ? OR lower(title) LIKE ? OR lower(question) LIKE ? OR lower(chosen_json) LIKE ? OR lower(rejected_json) LIKE ?)");
    params.push(needle, needle, needle, needle, needle, needle);
  }
  return where(clauses, params);
}

function addTaskStateFilter(clauses: string[], params: unknown[], state: string): void {
  const normalized = normalizeTaskFilter(state);
  clauses.push("(canonical_status = ? OR coordination_status = ?)");
  params.push(normalized, normalized);
}

function addTaskQueueFilter(clauses: string[], params: unknown[], queue: string): void {
  const normalized = normalizeTaskFilter(queue);
  clauses.push("(coordination_status = ? OR package_disposition = ?)");
  params.push(normalized, normalized);
}

function addTaskReviewFilter(clauses: string[], params: unknown[], review: string): void {
  const normalized = normalizeTaskFilter(review);
  clauses.push("(closeout_readiness = ? OR canonical_status = ? OR coordination_status = ?)");
  params.push(normalized, normalized, normalized);
}

function addClause(clauses: string[], params: unknown[], clause: string, value: unknown): void {
  clauses.push(clause);
  params.push(value);
}

function addJsonArrayContains(clauses: string[], params: unknown[], column: string, value: string): void {
  clauses.push(`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`);
  params.push(value);
}

function where(clauses: ReadonlyArray<string>, params: ReadonlyArray<unknown>): { readonly sql: string; readonly params: ReadonlyArray<unknown> } {
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function normalizeTaskFilter(value: string): string {
  if (value === "review") return "in_review";
  if (value === "done") return "terminal";
  return value;
}

function legacyNumberFromLabel(value: string): number | undefined {
  const match = /^E?(\d+)$/iu.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
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

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
