import type { DatabaseSync } from "node:sqlite";
import { deriveRelationId } from "../domain/entity-relation.ts";
import { factRef, type FactEventV1, type FactMemoryClass, type FactConfidence } from "../domain/fact-event.ts";
import type { ActorIdentity, WriteSource } from "../domain/write-chain.contract.ts";
import type { FactAnchorRow } from "./relation-graph-projection.ts";

export interface FactProjectionRow {
  readonly schema: "fact-row/v1";
  readonly ref: string;
  readonly taskId: string;
  readonly factId: string;
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: FactEventV1["payload"]["memoryTags"];
  readonly provenance: FactEventV1["payload"]["provenance"];
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly state: "live" | "retired";
}
export interface FactRelationEdgeRow {
  readonly relationId: string; readonly sourceRef: string; readonly targetRef: string; readonly relationType: "supersedes-fact";
  readonly direction: "directed"; readonly strength: "strong"; readonly origin: "declared"; readonly state: "active";
  readonly rationale: string; readonly ownerRef: string; readonly sourcePath: string; readonly recordIndex: 0;
}
export interface FactSearchFilters { readonly query?: string; readonly taskId?: string; readonly confidence?: FactConfidence; readonly memoryClass?: FactMemoryClass }
export class FactProjectionError extends Error { readonly code: "content_not_ready" | "invalid_transition" | "entity_not_found" | "relation_invalid";
  constructor(code: FactProjectionError["code"], message: string) { super(message); this.name = "FactProjectionError"; this.code = code; } }

export function createFactProjectionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact (task_id TEXT NOT NULL, fact_id TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, statement TEXT NOT NULL, evidence_source TEXT NOT NULL,
      observed_at TEXT NOT NULL, confidence TEXT NOT NULL, memory_class TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL,
      PRIMARY KEY(task_id, fact_id));
    CREATE TABLE IF NOT EXISTS relation_edge (relation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL,
      state TEXT NOT NULL, owner_ref TEXT NOT NULL, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(task_id UNINDEXED, fact_id UNINDEXED, statement, evidence_source,
      tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX IF NOT EXISTS fact_filter ON fact(task_id, confidence, memory_class, observed_at);
    CREATE INDEX IF NOT EXISTS relation_edge_source ON relation_edge(source_ref, state);
    CREATE INDEX IF NOT EXISTS relation_edge_target ON relation_edge(target_ref, state);
  `);
}

export function assertFactAdmission(db: DatabaseSync, event: FactEventV1): void {
  const ownRef = factRef(event.taskId, event.factId);
  if (db.prepare("SELECT 1 FROM fact WHERE task_id = ? AND fact_id = ?").get(event.taskId, event.factId))
    throw new FactProjectionError("invalid_transition", `Fact ${ownRef} already exists.`);
  const supersedes = event.payload.supersedes;
  if (!supersedes) return;
  const target = db.prepare("SELECT 1 FROM fact WHERE ref = ?").get(supersedes.factRef);
  if (!target) throw new FactProjectionError("entity_not_found", `Superseded endpoint ${supersedes.factRef} does not exist.`);
  if (db.prepare("SELECT 1 FROM relation_edge WHERE target_ref = ? AND relation_type = 'supersedes-fact' AND state = 'active'").get(supersedes.factRef))
    throw new FactProjectionError("relation_invalid", `Superseded endpoint ${supersedes.factRef} is already retired.`);
}

export function reduceFactEvent(db: DatabaseSync, event: FactEventV1): void {
  assertFactAdmission(db, event);
  const ref = factRef(event.taskId, event.factId), sourcePath = `event:${event.opId}`;
  const row: Omit<FactProjectionRow, "state"> = { schema: "fact-row/v1", ref, taskId: event.taskId, factId: event.factId,
    statement: event.payload.statement, evidenceSource: event.payload.evidenceSource, observedAt: event.payload.observedAt,
    confidence: event.payload.confidence, memoryClass: event.payload.memoryClass, memoryTags: event.payload.memoryTags,
    provenance: event.payload.provenance, actor: event.actor, source: event.source, occurredAt: event.occurredAt,
    workspaceRevision: event.workspaceRevision };
  db.prepare("INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.taskId, event.factId, ref, row.statement, row.evidenceSource, row.observedAt, row.confidence, row.memoryClass, event.opId, event.workspaceRevision, JSON.stringify(row));
  db.prepare("INSERT INTO fact_fts(task_id, fact_id, statement, evidence_source) VALUES (?, ?, ?, ?)").run(event.taskId, event.factId, row.statement, row.evidenceSource);
  if (event.payload.supersedes) {
    const identity = { source: ref, target: event.payload.supersedes.factRef, type: "supersedes-fact" as const, direction: "directed" as const };
    const edge: FactRelationEdgeRow = { relationId: deriveRelationId(identity), sourceRef: identity.source, targetRef: identity.target,
      relationType: identity.type, direction: identity.direction, strength: "strong", origin: "declared", state: "active",
      rationale: event.payload.supersedes.rationale, ownerRef: ref, sourcePath, recordIndex: 0 };
    db.prepare("INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(edge.relationId, edge.sourceRef, edge.targetRef, edge.relationType, edge.state, edge.ownerRef, event.workspaceRevision, JSON.stringify(edge));
  }
}

export function readFactRow(db: DatabaseSync, taskId: string, factId: string): FactProjectionRow | null {
  const record = db.prepare("SELECT row_json, EXISTS(SELECT 1 FROM relation_edge WHERE target_ref = fact.ref AND relation_type = 'supersedes-fact' AND state = 'active') AS retired FROM fact WHERE task_id = ? AND fact_id = ?")
    .get(taskId, factId) as { readonly row_json: string; readonly retired: number } | undefined;
  return record ? { ...(JSON.parse(record.row_json) as Omit<FactProjectionRow, "state">), state: record.retired ? "retired" : "live" } : null;
}

export function searchFactRows(db: DatabaseSync, filters: FactSearchFilters): readonly FactProjectionRow[] {
  const where: string[] = [], values: Array<string> = [];
  if (filters.query?.trim()) { where.push("fact.rowid IN (SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?)"); values.push(ftsQuery(filters.query)); }
  if (filters.taskId) { where.push("fact.task_id = ?"); values.push(filters.taskId); }
  if (filters.confidence) { where.push("fact.confidence = ?"); values.push(filters.confidence); }
  if (filters.memoryClass) { where.push("fact.memory_class = ?"); values.push(filters.memoryClass); }
  const sql = `SELECT task_id, fact_id FROM fact${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at DESC, task_id, fact_id LIMIT 100`;
  return (db.prepare(sql).all(...values) as unknown as readonly { readonly task_id: string; readonly fact_id: string }[])
    .map((record) => readFactRow(db, record.task_id, record.fact_id)!);
}

export function readFactGraphRows(db: DatabaseSync): { readonly edges: readonly FactRelationEdgeRow[]; readonly factAnchors: readonly FactAnchorRow[]; readonly facts: readonly FactProjectionRow[] } {
  const edges = (db.prepare("SELECT row_json FROM relation_edge WHERE owner_ref LIKE 'fact/%' ORDER BY relation_id").all() as unknown as readonly { readonly row_json: string }[])
    .map((row) => JSON.parse(row.row_json) as FactRelationEdgeRow);
  const factAnchors = readFactAnchorRows(db);
  const facts = (db.prepare("SELECT task_id, fact_id FROM fact ORDER BY observed_at DESC, task_id, fact_id").all() as unknown as readonly { readonly task_id: string; readonly fact_id: string }[])
    .map((row) => readFactRow(db, row.task_id, row.fact_id)!);
  return { edges, factAnchors, facts };
}

export function readFactAnchorRows(db: DatabaseSync): readonly FactAnchorRow[] { return (db.prepare("SELECT ref, task_id, fact_id, op_id FROM fact ORDER BY ref").all() as unknown as readonly { readonly ref: string; readonly task_id: string; readonly fact_id: string; readonly op_id: string }[]).map((row) => ({ factRef: row.ref, taskId: row.task_id, factId: row.fact_id, sourcePath: `event:${row.op_id}` })); }
function ftsQuery(value: string): string { return `"${value.trim().replaceAll('"', '""')}"`; }
