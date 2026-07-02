import { mkdirSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import type { ProjectionMeta, TaskProjectionRow } from "./types.ts";

const projectionVersion = "entity-projection/v1";

export interface ProjectionGraphRows {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
}

export function writeProjectionDatabase(
  projectionPath: string,
  rows: ReadonlyArray<TaskProjectionRow>,
  meta: ProjectionMeta,
  graphRows: ProjectionGraphRows = { relationEdges: [], coverageRows: [] }
): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  const db = new DatabaseSync(tempPath);
  try {
    db.exec([
      "PRAGMA journal_mode = DELETE",
      "CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      [
        "CREATE TABLE task_projection (",
        "  task_id TEXT PRIMARY KEY,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n"),
      [
        "CREATE TABLE relation_edges (",
        "  relation_id TEXT PRIMARY KEY,",
        "  source_ref TEXT NOT NULL,",
        "  target_ref TEXT NOT NULL,",
        "  relation_type TEXT NOT NULL,",
        "  direction TEXT NOT NULL,",
        "  state TEXT NOT NULL,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n"),
      [
        "CREATE TABLE relation_coverage (",
        "  claim_ref TEXT PRIMARY KEY,",
        "  decision_ref TEXT NOT NULL,",
        "  status TEXT NOT NULL,",
        "  covering_fact_ref TEXT,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n")
    ].join(";\n"));
    const insertMeta = db.prepare("INSERT INTO projection_meta (key, value) VALUES (?, ?)");
    insertMeta.run("version", projectionVersion);
    insertMeta.run("sourceHash", meta.sourceHash);
    insertMeta.run("rowsHash", meta.rowsHash);
    const insertRow = db.prepare("INSERT OR REPLACE INTO task_projection (task_id, row_json) VALUES (?, ?)");
    for (const row of rows) {
      insertRow.run(row.taskId, JSON.stringify(row));
    }
    const insertEdge = db.prepare([
      "INSERT OR REPLACE INTO relation_edges",
      "(relation_id, source_ref, target_ref, relation_type, direction, state, row_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" "));
    for (const edge of graphRows.relationEdges) {
      insertEdge.run(edge.relationId, edge.sourceRef, edge.targetRef, edge.relationType, edge.direction, edge.state, JSON.stringify(edge));
    }
    const insertCoverage = db.prepare([
      "INSERT OR REPLACE INTO relation_coverage",
      "(claim_ref, decision_ref, status, covering_fact_ref, row_json)",
      "VALUES (?, ?, ?, ?, ?)"
    ].join(" "));
    for (const row of graphRows.coverageRows) {
      insertCoverage.run(row.claimRef, row.decisionRef, row.status, row.coveringFactRef ?? null, JSON.stringify(row));
    }
    db.exec([
      "CREATE INDEX relation_edges_source_ref ON relation_edges (source_ref)",
      "CREATE INDEX relation_edges_target_ref ON relation_edges (target_ref)",
      "CREATE INDEX relation_coverage_decision_ref ON relation_coverage (decision_ref)"
    ].join(";\n"));
  } finally {
    db.close();
  }
  renameSync(tempPath, projectionPath);
}

function readProjectionDatabase(projectionPath: string): { readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const metaRows = db.prepare("SELECT key, value FROM projection_meta").all() as unknown as ReadonlyArray<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const rowRecords = db.prepare("SELECT row_json FROM task_projection ORDER BY task_id").all() as unknown as ReadonlyArray<{ row_json: string }>;
    return {
      meta: {
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? ""
      },
      rows: rowRecords.map((record) => JSON.parse(record.row_json) as TaskProjectionRow)
    };
  } finally {
    db.close();
  }
}

export function tryReadProjectionDatabase(
  projectionPath: string
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath)
    };
  } catch {
    return { ok: false };
  }
}

export function readRelationGraphRows(projectionPath: string): ProjectionGraphRows {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const edgeRecords = db.prepare("SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id").all() as unknown as ReadonlyArray<{ row_json: string }>;
    const coverageRecords = db.prepare("SELECT row_json FROM relation_coverage ORDER BY claim_ref").all() as unknown as ReadonlyArray<{ row_json: string }>;
    return {
      relationEdges: edgeRecords.map((record) => JSON.parse(record.row_json) as RelationGraphEdgeRow),
      coverageRows: coverageRecords.map((record) => JSON.parse(record.row_json) as RelationCoverageRow)
    };
  } finally {
    db.close();
  }
}
