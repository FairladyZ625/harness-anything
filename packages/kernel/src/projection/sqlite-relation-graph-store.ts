import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { TaskFactProjectionRow } from "./fact-projection.ts";
import type { FactAnchorRow, RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import type { ProjectionWarning } from "./types.ts";

export interface ProjectionGraphRows {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly factRows: ReadonlyArray<TaskFactProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface RelationGraphReuseSeed {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly factRefs: ReadonlySet<string>;
}

export function createRelationGraphTables(sql: SqlClient.SqlClient): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    yield* sql`
      CREATE TABLE relation_edges (
        relation_id TEXT PRIMARY KEY,
        source_ref TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        direction TEXT NOT NULL,
        strength TEXT NOT NULL,
        origin TEXT NOT NULL,
        state TEXT NOT NULL,
        rationale TEXT NOT NULL,
        owner_ref TEXT NOT NULL,
        source_path TEXT NOT NULL,
        record_index INTEGER NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE relation_coverage (
        claim_ref TEXT PRIMARY KEY,
        decision_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        fulfillment TEXT NOT NULL,
        covering_fact_ref TEXT,
        refuting_fact_refs_json TEXT,
        relation_path_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE task_fact_anchors (
        fact_ref TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        source_path TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE task_fact_projection (
        fact_ref TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        statement TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        confidence TEXT NOT NULL,
        memory_class TEXT NOT NULL,
        memory_tags_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE relation_projection_warnings (
        warning_index INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        repair_hint TEXT
      )
    `;
  });
}

export function createRelationGraphIndexes(sql: SqlClient.SqlClient): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    yield* sql`CREATE INDEX relation_edges_source_ref ON relation_edges (source_ref)`;
    yield* sql`CREATE INDEX relation_edges_target_ref ON relation_edges (target_ref)`;
    yield* sql`CREATE INDEX relation_coverage_decision_ref ON relation_coverage (decision_ref)`;
    yield* sql`CREATE INDEX task_fact_anchors_task_id ON task_fact_anchors (task_id)`;
    yield* sql`CREATE INDEX task_fact_projection_task_id ON task_fact_projection (task_id)`;
  });
}

export function readRelationGraphRowsFromStore(
  sql: SqlClient.SqlClient
): Effect.Effect<ProjectionGraphRows, unknown> {
  return Effect.gen(function* () {
    const edgeRecords = yield* sql<Record<string, unknown>>`
      SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin,
             state, rationale, owner_ref, source_path, record_index
      FROM relation_edges
      ORDER BY source_ref, target_ref, relation_id
    `;
    const coverageRecords = yield* sql<Record<string, unknown>>`
      SELECT claim_ref, decision_ref, status, fulfillment, covering_fact_ref, refuting_fact_refs_json, relation_path_json
      FROM relation_coverage
      ORDER BY claim_ref
    `;
    const factAnchorRecords = yield* sql<Record<string, unknown>>`
      SELECT fact_ref, task_id, fact_id, source_path
      FROM task_fact_anchors
      ORDER BY fact_ref
    `;
    const factRecords = yield* sql<Record<string, unknown>>`
      SELECT fact_ref, task_id, fact_id, schema_name, statement, source, observed_at,
             confidence, memory_class, memory_tags_json, provenance_json
      FROM task_fact_projection
      ORDER BY fact_ref
    `;
    const warningRecords = yield* sql<Record<string, unknown>>`
      SELECT warning_index, code, source, severity, message, repair_hint
      FROM relation_projection_warnings
      ORDER BY warning_index
    `;
    return {
      relationEdges: edgeRecords.map(recordToRelationEdge),
      coverageRows: coverageRecords.map(recordToCoverageRow),
      factAnchors: factAnchorRecords.map(recordToFactAnchor),
      factRows: factRecords.map(recordToTaskFact),
      warnings: warningRecords.map(recordToProjectionWarning)
    };
  });
}

export function readRelationGraphReuseSeedFromStore(
  sql: SqlClient.SqlClient
): Effect.Effect<RelationGraphReuseSeed, unknown> {
  return Effect.gen(function* () {
    const edgeRecords = yield* sql<Record<string, unknown>>`
      SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin,
             state, rationale, owner_ref, source_path, record_index
      FROM relation_edges
      ORDER BY source_ref, target_ref, relation_id
    `;
    const factRecords = yield* sql<{ readonly fact_ref: unknown }>`
      SELECT fact_ref FROM task_fact_projection
      UNION
      SELECT source_ref AS fact_ref FROM relation_edges WHERE source_ref LIKE 'fact/%'
      UNION
      SELECT target_ref AS fact_ref FROM relation_edges WHERE target_ref LIKE 'fact/%'
      ORDER BY fact_ref
    `;
    return {
      relationEdges: edgeRecords.map(recordToRelationEdge),
      factRefs: new Set(factRecords.map((record) => String(record.fact_ref).slice("fact/".length)))
    };
  });
}

export function insertRelationEdges(
  sql: SqlClient.SqlClient,
  edges: ReadonlyArray<RelationGraphEdgeRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const batch of chunks(edges, 500)) yield* sql.unsafe(`
    INSERT OR REPLACE INTO relation_edges (
      relation_id, source_ref, target_ref, relation_type, direction, strength, origin,
      state, rationale, owner_ref, source_path, record_index
    ) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, batch.flatMap((edge) => [
      edge.relationId, edge.sourceRef, edge.targetRef, edge.relationType, edge.direction,
      edge.strength, edge.origin, edge.state, edge.rationale, edge.ownerRef, edge.sourcePath, edge.recordIndex
    ]));
  });
}

export function insertCoverageRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<RelationCoverageRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const batch of chunks(rows, 500)) yield* sql.unsafe(`
    INSERT OR REPLACE INTO relation_coverage (
      claim_ref, decision_ref, status, fulfillment, covering_fact_ref, refuting_fact_refs_json, relation_path_json
    ) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, batch.flatMap((row) => [
      row.claimRef,
      row.decisionRef,
      row.status,
      row.fulfillment,
      row.coveringFactRef ?? null,
      row.refutingFactRefs ? JSON.stringify(row.refutingFactRefs) : null,
      JSON.stringify(row.relationPath)
    ]));
  });
}

export function insertFactAnchors(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<FactAnchorRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const batch of chunks(rows, 500)) yield* sql.unsafe(`
    INSERT OR REPLACE INTO task_fact_anchors (fact_ref, task_id, fact_id, source_path)
    VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}
  `, batch.flatMap((row) => [row.factRef, row.taskId, row.factId, row.sourcePath]));
  });
}

export function insertTaskFactRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<TaskFactProjectionRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const batch of chunks(rows, 500)) yield* sql.unsafe(`
    INSERT OR REPLACE INTO task_fact_projection (
      fact_ref, task_id, fact_id, schema_name, statement, source, observed_at,
      confidence, memory_class, memory_tags_json, provenance_json
    ) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, batch.flatMap((row) => [
      row.ref,
      row.taskId,
      row.factId,
      row.schema,
      row.statement,
      row.source,
      row.observedAt,
      row.confidence,
      row.memoryClass,
      JSON.stringify(row.memoryTags),
      JSON.stringify(row.provenance)
    ]));
  });
}

export function insertRelationProjectionWarning(
  sql: SqlClient.SqlClient,
  index: number,
  row: ProjectionWarning
): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO relation_projection_warnings (
      warning_index, code, source, severity, message, repair_hint
    ) VALUES (
      ${index}, ${row.code}, ${row.source}, ${row.severity}, ${row.message}, ${row.repairHint ?? null}
    )
  `;
}

function recordToRelationEdge(record: Readonly<Record<string, unknown>>): RelationGraphEdgeRow {
  return {
    relationId: String(record.relation_id),
    sourceRef: String(record.source_ref),
    targetRef: String(record.target_ref),
    relationType: String(record.relation_type) as RelationGraphEdgeRow["relationType"],
    direction: String(record.direction) as RelationGraphEdgeRow["direction"],
    strength: String(record.strength) as RelationGraphEdgeRow["strength"],
    origin: String(record.origin) as RelationGraphEdgeRow["origin"],
    state: String(record.state) as RelationGraphEdgeRow["state"],
    rationale: String(record.rationale),
    ownerRef: String(record.owner_ref),
    sourcePath: String(record.source_path),
    recordIndex: Number(record.record_index)
  };
}

function recordToCoverageRow(record: Readonly<Record<string, unknown>>): RelationCoverageRow {
  const rawFulfillment = record.fulfillment == null ? "evidenced" : String(record.fulfillment);
  const fulfillment: RelationCoverageRow["fulfillment"] =
    rawFulfillment === "delivered" || rawFulfillment === "standing-policy" || rawFulfillment === "evidenced"
      ? rawFulfillment
      : "evidenced";
  return {
    decisionRef: String(record.decision_ref),
    claimRef: String(record.claim_ref),
    status: String(record.status) as RelationCoverageRow["status"],
    fulfillment,
    ...(record.covering_fact_ref === null ? {} : { coveringFactRef: String(record.covering_fact_ref) }),
    ...(record.refuting_fact_refs_json === null
      ? {}
      : { refutingFactRefs: JSON.parse(String(record.refuting_fact_refs_json)) as ReadonlyArray<string> }),
    relationPath: JSON.parse(String(record.relation_path_json)) as ReadonlyArray<string>
  };
}

function recordToFactAnchor(record: Readonly<Record<string, unknown>>): FactAnchorRow {
  return {
    factRef: String(record.fact_ref),
    taskId: String(record.task_id),
    factId: String(record.fact_id),
    sourcePath: String(record.source_path)
  };
}

function recordToTaskFact(record: Readonly<Record<string, unknown>>): TaskFactProjectionRow {
  return {
    schema: String(record.schema_name) as TaskFactProjectionRow["schema"],
    ref: String(record.fact_ref),
    taskId: String(record.task_id),
    factId: String(record.fact_id),
    statement: String(record.statement),
    source: String(record.source),
    observedAt: String(record.observed_at),
    confidence: String(record.confidence) as TaskFactProjectionRow["confidence"],
    memoryClass: String(record.memory_class) as TaskFactProjectionRow["memoryClass"],
    memoryTags: JSON.parse(String(record.memory_tags_json)) as TaskFactProjectionRow["memoryTags"],
    provenance: JSON.parse(String(record.provenance_json)) as TaskFactProjectionRow["provenance"]
  };
}

function recordToProjectionWarning(record: Readonly<Record<string, unknown>>): ProjectionWarning {
  return {
    code: String(record.code) as ProjectionWarning["code"],
    source: String(record.source) as ProjectionWarning["source"],
    severity: String(record.severity) as ProjectionWarning["severity"],
    message: String(record.message),
    ...(record.repair_hint === null ? {} : { repairHint: String(record.repair_hint) })
  };
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}
