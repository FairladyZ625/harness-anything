import { assertFactAdmissionAtCut } from "@harness-anything/kernel/internal/domain/fact-admission.ts";
import type { DatabaseSync } from "node:sqlite";
import { factRef, type FactDomainType, type FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import type {
  FactAnchorRow,
  FactDomainTypeRow,
  FactProjectionRow,
  FactRelationEdgeRow,
  FactSearchFilters,
  FactSearchPage,
} from "@harness-anything/kernel";
export type {
  FactAnchorRow,
  FactDomainTypeRow,
  FactProjectionRow,
  FactRelationEdgeRow,
  FactSearchFilters,
  FactSearchPage,
} from "@harness-anything/kernel";
import { factInvalidated, factLiveness } from "@harness-anything/kernel/internal/domain/fact-liveness.ts";
import { ftsQuery } from "./fts-query.ts";
import { applyEmbeddedRelationProjectionEvents } from "./relation-entity-projection.ts";
import { prepareQuery, queryRows, type ProjectionSqlRow } from "./rebuildable-task-projection-sql.ts";

export function createFactProjectionTables(db: DatabaseSync): void {
  /* @gate-identity state-store/task.source.storage.src.projection.fact-event-projection.sqlite-database */ db.exec(`
    /* @gate-identity state-store/task.projection.fact */ CREATE TABLE IF NOT EXISTS fact (
      task_id TEXT, fact_id TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
      statement TEXT NOT NULL, evidence_source TEXT NOT NULL,
      observed_at TEXT NOT NULL, confidence TEXT NOT NULL, memory_class TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE, workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL,
      PRIMARY KEY(fact_id));
    /* @gate-identity state-store/task.projection.fact_fts */ CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(fact_id UNINDEXED, statement, evidence_source,
      tokenize='unicode61 remove_diacritics 2');
    /* @gate-identity state-store/task.projection.fact_domain_type */ CREATE TABLE IF NOT EXISTS fact_domain_type (
      domain_type TEXT PRIMARY KEY, registered_by_fact_id TEXT NOT NULL UNIQUE,
      workspace_revision INTEGER NOT NULL);
    /* @gate-identity state-store/task.projection.fact_reclassification */ CREATE TABLE IF NOT EXISTS fact_reclassification (
      op_id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, domain_types_json TEXT NOT NULL,
      rationale TEXT NOT NULL, workspace_revision INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS fact_task_page ON fact(task_id, observed_at DESC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_observed_page ON fact(observed_at DESC, task_id ASC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_confidence_page ON fact(confidence, observed_at DESC, task_id ASC, fact_id ASC);
    CREATE INDEX IF NOT EXISTS fact_memory_class_page ON fact(memory_class, observed_at DESC, task_id ASC, fact_id ASC);
  `);
}

export function readFactAdmissionState(db: DatabaseSync, event: FactEventV1) {
  const record = prepareQuery(db, "SELECT row_json FROM fact WHERE fact_id = ?").get(event.factId) as
      | { readonly row_json: string }
      | undefined,
    ref = event.payload.supersedes?.factRef,
    target = ref
      ? (prepareQuery(db, "SELECT ref FROM fact WHERE ref = ?").get(ref) as { readonly ref: string } | undefined)
      : undefined;
  return {
    row: record ? (JSON.parse(record.row_json) as FactProjectionRow) : null,
    domainTypes: listFactDomainTypeRows(db),
    supersededTarget: target ?? null,
    relations: target ? livenessRelations(db, [target.ref]) : [],
  };
}

export function reduceFactEvent(db: DatabaseSync, event: FactEventV1): void {
  const admission = readFactAdmissionState(db, event);
  assertFactAdmissionAtCut(admission, event);
  if (event.type === "fact_archived" || event.type === "fact_unarchived") {
    const row = admission.row!;
    prepareQuery(db, "UPDATE fact SET workspace_revision = ?, row_json = ? WHERE fact_id = ?").run(
      event.workspaceRevision,
      JSON.stringify({
        ...row,
        archived: event.type === "fact_archived",
        workspaceRevision: event.workspaceRevision,
      }),
      event.factId,
    );
    return;
  }
  if (event.type === "fact_reclassified") {
    const row = admission.row!;
    prepareQuery(db, "UPDATE fact SET workspace_revision = ?, row_json = ? WHERE fact_id = ?").run(
      event.workspaceRevision,
      JSON.stringify({ ...row, domainTypes: event.payload.domainTypes, workspaceRevision: event.workspaceRevision }),
      event.factId,
    );
    prepareQuery(
      db,
      "INSERT INTO fact_reclassification" +
        "(op_id, fact_id, domain_types_json, rationale, workspace_revision) VALUES (?, ?, ?, ?, ?)",
    ).run(
      event.opId,
      event.factId,
      JSON.stringify(event.payload.domainTypes ?? []),
      event.payload.reclassificationRationale!,
      event.workspaceRevision,
    );
    return;
  }
  const ref = factRef(event.factId);
  const row: Omit<FactProjectionRow, "state" | "invalidated"> = {
    schema: "fact-row/v1",
    ref,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    factId: event.factId,
    statement: event.payload.statement,
    evidenceSource: event.payload.evidenceSource,
    observedAt: event.payload.observedAt,
    ...(event.payload.observedCommit !== undefined ? { observedCommit: event.payload.observedCommit } : {}),
    confidence: event.payload.confidence,
    ...(event.payload.domainTypes ? { domainTypes: event.payload.domainTypes } : {}),
    memoryClass: event.payload.memoryClass,
    memoryTags: event.payload.memoryTags,
    provenance: event.payload.provenance,
    actor: event.actor,
    source: event.source,
    occurredAt: event.occurredAt,
    workspaceRevision: event.workspaceRevision,
    archived: false,
  };
  prepareQuery(
    db,
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
  if (event.payload.registersDomainType)
    prepareQuery(
      db,
      "INSERT INTO fact_domain_type(domain_type, registered_by_fact_id, workspace_revision) VALUES (?, ?, ?)",
    ).run(event.payload.registersDomainType, event.factId, event.workspaceRevision);
  prepareQuery(db, "INSERT INTO fact_fts(fact_id, statement, evidence_source) VALUES (?, ?, ?)").run(
    event.factId,
    row.statement,
    row.evidenceSource,
  );
  applyEmbeddedRelationProjectionEvents(db, event);
}

const factRowSelect = "SELECT row_json FROM fact";
interface FactRecord extends ProjectionSqlRow {
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
  const select =
    "SELECT relation_edge.target_ref AS targetRef, relation_edge.relation_type AS relationType, relation_edge.state";
  if (targetRefs === undefined)
    return queryRows<{
      readonly targetRef: string;
      readonly relationType: string;
      readonly state: string;
    }>(
      db,
      select + " FROM relation_edge WHERE state = 'active' AND relation_type = 'supersedes-fact' ORDER BY relation_id",
    );
  return queryRows<{
    readonly targetRef: string;
    readonly relationType: string;
    readonly state: string;
  }>(
    db,
    "WITH requested_targets AS (SELECT value AS target_ref FROM json_each(?)) " +
      select +
      " FROM requested_targets CROSS JOIN relation_edge INDEXED BY relation_edge_target " +
      "WHERE relation_edge.target_ref = requested_targets.target_ref AND state = 'active' " +
      "AND relation_type = 'supersedes-fact' ORDER BY relation_id",
    JSON.stringify(targetRefs),
  );
}
function decodeFactRows(db: DatabaseSync, records: readonly FactRecord[]): readonly FactProjectionRow[] {
  const raw = records.map((record) => JSON.parse(record.row_json) as Omit<FactProjectionRow, "state" | "invalidated">),
    relations = livenessRelations(
      db,
      raw.map((row) => row.ref),
    );
  return raw.map((row) => {
    const state = factLiveness(row, relations);
    return { ...row, state, invalidated: factInvalidated(state), archived: row.archived === true };
  });
}
function listFactRows(db: DatabaseSync, where: string, values: readonly string[]): readonly FactProjectionRow[] {
  return decodeFactRows(
    db,
    queryRows<FactRecord>(db, `${factRowSelect}${where} ORDER BY observed_at DESC, fact_id`, ...values),
  );
}
export function readFactRow(db: DatabaseSync, factId: string): FactProjectionRow | null {
  const record = prepareQuery(db, `${factRowSelect} WHERE fact_id = ?`).get(factId) as FactRecord | undefined;
  return record ? (decodeFactRows(db, [record])[0] ?? null) : null;
}

export function listFactDomainTypeRows(db: DatabaseSync): readonly FactDomainTypeRow[] {
  return queryRows<{
    readonly domainType: FactDomainType;
    readonly registeredByFactId: string;
    readonly workspaceRevision: number;
  }>(
    db,
    "SELECT domain_type AS domainType, registered_by_fact_id AS registeredByFactId," +
      " workspace_revision AS workspaceRevision FROM fact_domain_type ORDER BY domain_type",
  ).map((row) => ({ ...row }));
}

/** Paged variant of the Fact search: the unparameterized filters keep returning every match;
 * an explicit limit/cursor pages over the same (observed_at DESC, task_id, fact_id) order. */
export function searchFactRowsPage(
  db: DatabaseSync,
  filters: FactSearchFilters,
): { readonly rows: readonly FactProjectionRow[]; readonly page?: FactSearchPage } {
  const where: string[] = [],
    values: Array<string> = [];
  if (filters.query?.trim()) {
    where.push("fact.rowid IN (SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?)");
    values.push(ftsQuery(filters.query));
  }
  if (filters.taskId) {
    where.push("fact.task_id = ?");
    values.push(filters.taskId);
  }
  if (filters.refs !== undefined) {
    where.push("fact.ref IN (SELECT value FROM json_each(?))");
    values.push(JSON.stringify(filters.refs));
  }
  if (filters.confidence) {
    where.push("fact.confidence = ?");
    values.push(filters.confidence);
  }
  if (filters.domainType) {
    where.push("EXISTS (SELECT 1 FROM json_each(fact.row_json, '$.domainTypes') WHERE value = ?)");
    values.push(filters.domainType);
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
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "",
    limitSql = pageLimit === null ? "" : " LIMIT ?",
    sql = `${factRowSelect}${whereSql} ORDER BY observed_at DESC, fact_id${limitSql}`;
  if (pageLimit !== null) values.push(String(pageLimit + 1));
  const records = queryRows<FactRecord>(db, sql, ...values);
  const visible = pageLimit === null ? records : records.slice(0, pageLimit),
    rows = decodeFactRows(db, visible);
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
  const edges = queryRows<{ readonly row_json: string }>(
    db,
    "SELECT row_json FROM relation_edge" +
      " WHERE owner_ref LIKE 'fact/%' OR target_ref LIKE 'fact/%' ORDER BY relation_id",
  ).map((row) => JSON.parse(row.row_json) as FactRelationEdgeRow);
  const factAnchors = readFactAnchorRows(db);
  return { edges, factAnchors, facts: listFactRows(db, "", []) };
}

export function readFactAnchorRows(db: DatabaseSync, refs?: readonly string[]): readonly FactAnchorRow[] {
  if (refs !== undefined && refs.length === 0) return [];
  const where = refs === undefined ? "" : " WHERE ref IN (SELECT value FROM json_each(?))";
  const rows = queryRows<{
    readonly ref: string;
    readonly task_id: string | null;
    readonly fact_id: string;
    readonly op_id: string;
  }>(
    db,
    `SELECT ref, task_id, fact_id, op_id FROM fact${where} ORDER BY ref`,
    ...(refs === undefined ? [] : [JSON.stringify(refs)]),
  ).map((row) => ({
    factRef: row.ref,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    factId: row.fact_id,
    sourcePath: `event:${row.op_id}`,
  }));
  return rows;
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
