import type { DatabaseSync } from "node:sqlite";
import {
  deriveRelationId,
  type RelationType,
  type RelationOrigin,
  type RelationState,
} from "../domain/entity-relation.ts";
import { factRef, type FactEventV1, type FactMemoryClass, type FactConfidence } from "../domain/fact-event.ts";
import type { ActorIdentity, WriteSource } from "../domain/write-chain.contract.ts";
import type { FactAnchorRow } from "./relation-graph-projection.ts";
import { factLiveness } from "../domain/fact-liveness.ts";
import { ftsQuery } from "./fts-query.ts";

export interface FactProjectionRow {
  readonly schema: "fact-row/v1";
  readonly ref: string;
  readonly taskId?: string;
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
  readonly state: "standing" | "superseded_fact";
}
export interface FactRelationEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: RelationType;
  readonly direction: "directed";
  readonly strength: "strong";
  readonly origin: RelationOrigin;
  readonly state: RelationState;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}
export interface FactSearchFilters {
  readonly query?: string;
  readonly taskId?: string;
  readonly refs?: readonly string[];
  readonly confidence?: FactConfidence;
  readonly memoryClass?: FactMemoryClass;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface FactSearchPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}
export class FactProjectionError extends Error {
  readonly code:
    | "content_not_ready"
    | "invalid_transition"
    | "entity_not_found"
    | "anchor_not_found"
    | "relation_invalid";
  constructor(code: FactProjectionError["code"], message: string) {
    super(message);
    this.name = "FactProjectionError";
    this.code = code;
  }
}

export function createFactProjectionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact (task_id TEXT, fact_id TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, statement TEXT NOT NULL, evidence_source TEXT NOT NULL,
      observed_at TEXT NOT NULL, confidence TEXT NOT NULL, memory_class TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL,
      PRIMARY KEY(fact_id));
    CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(fact_id UNINDEXED, statement, evidence_source,
      tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX IF NOT EXISTS fact_task_page ON fact(task_id, observed_at DESC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_observed_page ON fact(observed_at DESC, task_id ASC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_confidence_page ON fact(confidence, observed_at DESC, task_id ASC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_memory_class_page ON fact(memory_class, observed_at DESC, task_id ASC, fact_id ASC);
  `);
}

export function assertFactAdmission(db: DatabaseSync, event: FactEventV1): void {
  const ownRef = factRef(event.factId);
  if (db.prepare("SELECT 1 FROM fact WHERE fact_id = ?").get(event.factId))
    throw new FactProjectionError("invalid_transition", `Fact ${ownRef} already exists.`);
  const supersedes = event.payload.supersedes;
  if (!supersedes) return;
  const target = db.prepare("SELECT ref FROM fact WHERE ref = ?").get(supersedes.factRef) as
    | { readonly ref: string }
    | undefined;
  if (!target)
    throw new FactProjectionError("entity_not_found", `Superseded endpoint ${supersedes.factRef} does not exist.`);
  if (factLiveness(target, livenessRelations(db, [target.ref])) === "superseded_fact")
    throw new FactProjectionError(
      "relation_invalid",
      `Superseded endpoint ${supersedes.factRef} is already superseded.`,
    );
}

export function reduceFactEvent(db: DatabaseSync, event: FactEventV1): void {
  assertFactAdmission(db, event);
  const ref = factRef(event.factId),
    sourcePath = `event:${event.opId}`;
  const row: Omit<FactProjectionRow, "state"> = {
    schema: "fact-row/v1",
    ref,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    factId: event.factId,
    statement: event.payload.statement,
    evidenceSource: event.payload.evidenceSource,
    observedAt: event.payload.observedAt,
    confidence: event.payload.confidence,
    memoryClass: event.payload.memoryClass,
    memoryTags: event.payload.memoryTags,
    provenance: event.payload.provenance,
    actor: event.actor,
    source: event.source,
    occurredAt: event.occurredAt,
    workspaceRevision: event.workspaceRevision,
  };
  db.prepare(
    "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    event.taskId ?? null,
    event.factId,
    ref,
    row.statement,
    row.evidenceSource,
    row.observedAt,
    row.confidence,
    row.memoryClass,
    event.opId,
    event.workspaceRevision,
    JSON.stringify(row),
  );
  db.prepare("INSERT INTO fact_fts(fact_id, statement, evidence_source) VALUES (?, ?, ?)").run(
    event.factId,
    row.statement,
    row.evidenceSource,
  );
  if (event.payload.supersedes) {
    const identity = {
      source: ref,
      target: event.payload.supersedes.factRef,
      type: "supersedes-fact" as const,
      direction: "directed" as const,
    };
    const edge: FactRelationEdgeRow = {
      relationId: deriveRelationId(identity),
      sourceRef: identity.source,
      targetRef: identity.target,
      relationType: identity.type,
      direction: identity.direction,
      strength: "strong",
      origin: "declared",
      state: "active",
      rationale: event.payload.supersedes.rationale,
      ownerRef: ref,
      sourcePath,
      recordIndex: 0,
    };
    db.prepare(
      "INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      edge.relationId,
      edge.sourceRef,
      edge.targetRef,
      edge.relationType,
      edge.state,
      edge.ownerRef,
      event.workspaceRevision,
      JSON.stringify(edge),
    );
  }
  if (event.taskId) {
    const identity = {
        source: `task/${event.taskId}`,
        target: ref,
        type: "produces" as const,
        direction: "directed" as const,
      },
      edge = {
        relationId: deriveRelationId(identity),
        sourceRef: identity.source,
        targetRef: identity.target,
        relationType: identity.type,
        direction: identity.direction,
        strength: "strong" as const,
        origin: "generated" as const,
        state: "active" as const,
        rationale: "Fact recorded with an explicit task owner.",
        ownerRef: identity.source,
        sourcePath,
        recordIndex: 1,
      };
    db.prepare(
      "INSERT OR IGNORE INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      edge.relationId,
      edge.sourceRef,
      edge.targetRef,
      edge.relationType,
      edge.state,
      edge.ownerRef,
      event.workspaceRevision,
      JSON.stringify(edge),
    );
  }
}

const factRowSelect = "SELECT row_json FROM fact";
interface FactRecord {
  readonly row_json: string;
}
// Liveness only ever consults the incoming supersedes-fact edges of the facts being
// decoded, so the fetch is narrowed to those targets (indexed by relation_edge_target)
// instead of scanning the whole edge table per read.
function livenessRelations(
  db: DatabaseSync,
  targetRefs?: readonly string[],
): readonly { readonly targetRef: string; readonly relationType: string; readonly state: string }[] {
  if (targetRefs !== undefined && targetRefs.length === 0) return [];
  const scoped = targetRefs !== undefined && targetRefs.length <= 900;
  const where = scoped ? ` WHERE target_ref IN (${targetRefs.map(() => "?").join(",")})` : "";
  return db
    .prepare(
      `SELECT target_ref AS targetRef, relation_type AS relationType, state FROM relation_edge${where} ORDER BY relation_id`,
    )
    .all(...(scoped ? targetRefs : [])) as unknown as readonly {
    readonly targetRef: string;
    readonly relationType: string;
    readonly state: string;
  }[];
}
function decodeFactRows(db: DatabaseSync, records: readonly FactRecord[]): readonly FactProjectionRow[] {
  const raw = records.map((record) => JSON.parse(record.row_json) as Omit<FactProjectionRow, "state">),
    relations = livenessRelations(
      db,
      raw.map((row) => row.ref),
    );
  return raw.map((row) => ({ ...row, state: factLiveness(row, relations) }));
}
function listFactRows(db: DatabaseSync, where: string, values: readonly string[]): readonly FactProjectionRow[] {
  return decodeFactRows(
    db,
    db
      .prepare(`${factRowSelect}${where} ORDER BY observed_at DESC, fact_id`)
      .all(...values) as unknown as readonly FactRecord[],
  );
}
export function readFactRow(db: DatabaseSync, factId: string): FactProjectionRow | null {
  const record = db.prepare(`${factRowSelect} WHERE fact_id = ?`).get(factId) as FactRecord | undefined;
  return record ? (decodeFactRows(db, [record])[0] ?? null) : null;
}

export function searchFactRows(db: DatabaseSync, filters: FactSearchFilters): readonly FactProjectionRow[] {
  return searchFactRowsPage(db, { ...filters, limit: undefined, cursor: undefined }).rows;
}

/** Paged variant of the Fact search: the unparameterized filters keep returning every match;
 * an explicit limit/cursor pages over the same (observed_at DESC, task_id, fact_id) order. */
export function searchFactRowsPage(
  db: DatabaseSync,
  filters: FactSearchFilters,
): { readonly rows: readonly FactProjectionRow[]; readonly page?: FactSearchPage } {
  const where: string[] = [],
    values: Array<string> = [];
  // A ref list above SQLite's parameter budget filters in memory after the decode instead of in SQL.
  const memoryRefs = filters.refs !== undefined && filters.refs.length > 900 ? new Set(filters.refs) : null;
  if (filters.query?.trim()) {
    where.push("fact.rowid IN (SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?)");
    values.push(ftsQuery(filters.query));
  }
  if (filters.taskId) {
    where.push("fact.task_id = ?");
    values.push(filters.taskId);
  }
  if (filters.refs !== undefined && memoryRefs === null) {
    if (filters.refs.length === 0) where.push("0");
    else {
      where.push(`fact.ref IN (${filters.refs.map(() => "?").join(",")})`);
      values.push(...filters.refs);
    }
  }
  if (filters.confidence) {
    where.push("fact.confidence = ?");
    values.push(filters.confidence);
  }
  if (filters.memoryClass) {
    where.push("fact.memory_class = ?");
    values.push(filters.memoryClass);
  }
  if (filters.observedAfter) {
    where.push("fact.observed_at >= ?");
    values.push(filters.observedAfter);
  }
  if (filters.observedBefore) {
    where.push("fact.observed_at <= ?");
    values.push(filters.observedBefore);
  }
  const paged = filters.limit !== undefined || filters.cursor !== undefined;
  if (filters.cursor !== undefined) {
    const cursor = decodeFactCursor(filters.cursor);
    where.push("(fact.observed_at < ? OR fact.observed_at = ? AND fact.fact_id > ?)");
    values.push(cursor[0]!, cursor[0]!, cursor[1]!);
  }
  const pageLimit = filters.limit === undefined ? (paged ? 100 : null) : checkedFactPageLimit(filters.limit);
  const sql = `${factRowSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at DESC, fact_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(String(pageLimit + 1));
  const records = db.prepare(sql).all(...values) as unknown as readonly FactRecord[];
  const visible = pageLimit === null ? records : records.slice(0, pageLimit),
    decoded = decodeFactRows(db, visible);
  const rows = memoryRefs === null ? decoded : decoded.filter((row) => memoryRefs.has(row.ref));
  if (pageLimit === null) return { rows };
  const hasMore = records.length > pageLimit,
    last = rows.at(-1);
  return {
    rows,
    page: {
      limit: pageLimit,
      cursor: filters.cursor ?? null,
      nextCursor: hasMore && last ? encodeFactCursor([last.observedAt, last.factId]) : null,
    },
  };
}

export function readFactGraphRows(db: DatabaseSync): {
  readonly edges: readonly FactRelationEdgeRow[];
  readonly factAnchors: readonly FactAnchorRow[];
  readonly facts: readonly FactProjectionRow[];
} {
  const edges = (
    db
      .prepare(
        "SELECT row_json FROM relation_edge WHERE owner_ref LIKE 'fact/%' OR target_ref LIKE 'fact/%' ORDER BY relation_id",
      )
      .all() as unknown as readonly { readonly row_json: string }[]
  ).map((row) => JSON.parse(row.row_json) as FactRelationEdgeRow);
  const factAnchors = readFactAnchorRows(db);
  return { edges, factAnchors, facts: listFactRows(db, "", []) };
}

export function readFactAnchorRows(db: DatabaseSync, refs?: readonly string[]): readonly FactAnchorRow[] {
  if (refs !== undefined && refs.length === 0) return [];
  const scoped = refs !== undefined && refs.length <= 900;
  const where = scoped ? ` WHERE ref IN (${refs.map(() => "?").join(",")})` : "";
  const memoryRefs = refs !== undefined && !scoped ? new Set(refs) : null;
  const rows = (
    db
      .prepare(`SELECT ref, task_id, fact_id, op_id FROM fact${where} ORDER BY ref`)
      .all(...(scoped ? refs : [])) as unknown as readonly {
      readonly ref: string;
      readonly task_id: string | null;
      readonly fact_id: string;
      readonly op_id: string;
    }[]
  ).map((row) => ({
    factRef: row.ref,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    factId: row.fact_id,
    sourcePath: `event:${row.op_id}`,
  }));
  return memoryRefs === null ? rows : rows.filter((row) => memoryRefs.has(row.factRef));
}
function checkedFactPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500)
    throw new Error("fact query page limit must be an integer between 1 and 500");
  return value;
}
function encodeFactCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}
function decodeFactCursor(value: string): readonly [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("fact query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("fact query cursor is invalid");
  return [parsed[0] as string, parsed[1] as string];
}
