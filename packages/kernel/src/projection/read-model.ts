import {
  createRepositoryReadModelTables,
  readRepositoryReadModelRows,
  repositoryReadModelPath,
  applyRepositoryReadModelRow,
  deleteRepositoryReadModelRow,
  type RepositoryReadModelRow,
} from "./read-model-repository.ts";
import type { DatabaseSync } from "node:sqlite";
import { createDecisionProjectionTables } from "./decision-projection-schema.ts";
import { createFactProjectionTables } from "./fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "./relation-graph-projection.ts";
import { createTaskRelationProjectionTable, refreshTaskRelationProjection } from "./task-query-projection.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";

/**
 * The edge read model (dec_0C26B97C5B6CEA37101FC0A84D): the center publishes its own projection
 * rows into each replica cut as derived `.read-model/` entries — one file per logical row key, so
 * the existing delta protocol moves only changed rows — and an edge loads them into tables built
 * from the same DDL so the center's own queries run unchanged on the edge. Documents are not
 * published here: they already ride the cut as ledger content entries.
 */
export const READ_MODEL_SCHEMA_GENERATION = 5 as const;
export const READ_MODEL_META_PATH = ".read-model/meta.json";
export const TASK_READ_MODEL_PREFIX = ".read-model/tasks/";
const TASK_GENERATION_PREFIX = ".read-model/task-generation/";
const TASK_PROGRESS_PREFIX = ".read-model/task-progress/";
const ENTITY_READ_MODEL_PREFIX = ".read-model/entities/";
const LEASE_READ_MODEL_PREFIX = ".read-model/leases/";
const RELATION_READ_MODEL_PREFIX = ".read-model/relations/";
const DECISION_READ_MODEL_PREFIX = ".read-model/decisions/";
const FACT_READ_MODEL_PREFIX = ".read-model/facts/";
const PRESET_SNAPSHOT_PREFIX = ".read-model/preset-snapshots/";

/** Derived read-model entries ride replica cuts beside ledger documents but are never documents. */
export function isReadModelPath(entryPath: string): boolean {
  return entryPath.startsWith(".read-model/");
}

/** The task index tables shared by the center projection and the edge read model. */
export const TASK_INDEX_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS task_snapshot (
      task_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT,
      pinned INTEGER NOT NULL GENERATED ALWAYS AS (
        json_extract(snapshot_json, '$.task.pinned')
      ) STORED,
      package_disposition TEXT NOT NULL GENERATED ALWAYS AS (
        COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active')
      ) STORED,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS task_snapshot_status_updated ON task_snapshot(status, updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_updated_task ON task_snapshot(updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_revision_task ON task_snapshot(workspace_revision, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_parent
      ON task_snapshot(json_extract(snapshot_json, '$.task.metadata.parentTaskId'));
    CREATE TABLE IF NOT EXISTS task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);`;

export const DOCUMENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS document (
      path TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );`;
export const PRESET_SNAPSHOT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS preset_snapshot (
      digest TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );`;
export const TASK_GENERATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS task_generation (
      task_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL CHECK(generation IN ('v0','v1'))
    );`;
export const TASK_PROGRESS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS task_progress (
      workspace_revision INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      event_json TEXT NOT NULL
    );`;
export const ENTITY_PROJECTION_TABLES_SQL = `CREATE TABLE IF NOT EXISTS entity_projection (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      freshness TEXT NOT NULL,
      current_version,
      value_json TEXT NOT NULL,
      PRIMARY KEY(entity_kind, task_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS entity_projection_task
      ON entity_projection(entity_kind, task_id, workspace_revision, entity_id);`;
export const LEASE_CAS_TABLES_SQL = `CREATE TABLE IF NOT EXISTS lease_cas (
      task_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL,
      execution_id TEXT GENERATED ALWAYS AS (json_extract(lease_json, '$.executionId')) STORED
    );
    CREATE INDEX IF NOT EXISTS lease_cas_execution ON lease_cas(execution_id);`;

/** Every table an edge read model replicates; the same DDL the center projection creates. */
export function createEdgeReadModelTables(db: DatabaseSync): void {
  db.exec(
    [
      TASK_INDEX_TABLES_SQL,
      DOCUMENT_TABLE_SQL,
      PRESET_SNAPSHOT_TABLE_SQL,
      TASK_GENERATION_TABLE_SQL,
      TASK_PROGRESS_TABLE_SQL,
      ENTITY_PROJECTION_TABLES_SQL,
      LEASE_CAS_TABLES_SQL,
    ].join("\n"),
  );
  createRepositoryReadModelTables(db);
  createRelationGraphProjectionTables(db);
  createTaskRelationProjectionTable(db);
  createDecisionProjectionTables(db);
  createFactProjectionTables(db);
}

export interface TaskReadModelRow {
  readonly taskId: string;
  readonly workspaceRevision: number;
  readonly snapshotJson: string;
  readonly status: string | null;
  readonly updatedAt: string;
  readonly packagePath: string | null;
}
export interface TaskGenerationRow {
  readonly taskId: string;
  readonly generation: string;
}
export interface TaskProgressEntry {
  readonly workspaceRevision: number;
  readonly executionId: string;
  readonly eventJson: string;
}
export interface TaskProgressRow {
  readonly taskId: string;
  readonly entries: readonly TaskProgressEntry[];
}
export interface EntityReadModelRow {
  readonly entityKind: string;
  readonly entityId: string;
  readonly ownerId: string;
  readonly workspaceRevision: number;
  readonly freshness: string;
  readonly currentVersion: number | null;
  readonly valueJson: string;
}
export interface LeaseReadModelRow {
  readonly taskId: string;
  readonly leaseJson: string;
}
export interface RelationReadModelRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly state: string;
  readonly targetObservedVersion: string | number | null;
  readonly ownerRef: string;
  readonly workspaceRevision: number;
  readonly updatedAt: string;
  readonly rowJson: string;
}
export interface DecisionReadModelRow {
  readonly decisionId: string;
  readonly decision: {
    readonly state: string;
    readonly title: string;
    readonly question: string;
    readonly riskTier: string;
    readonly urgency: string;
    readonly vertical: string;
    readonly preset: string;
    readonly decisionClass: string;
    readonly appliesJson: string;
    readonly proposerJson: string;
    readonly arbiterJson: string | null;
    readonly proposedAt: string;
    readonly decidedAt: string | null;
    readonly provenanceJson: string;
    readonly workspaceRevision: number;
  } | null;
  readonly options: readonly {
    readonly kind: string;
    readonly optionId: string;
    readonly position: number;
    readonly text: string;
    readonly rationale: string | null;
    readonly workspaceRevision: number;
  }[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly position: number;
    readonly text: string;
    readonly loadBearing: number;
    readonly fulfillment: string | null;
    readonly declaredRevision: number;
    readonly fulfilledRevision: number | null;
  }[];
  readonly consents: readonly {
    readonly consentId: string;
    readonly workspaceRevision: number;
    readonly valueJson: string;
  }[];
  readonly amendments: readonly {
    readonly amendmentId: string;
    readonly workspaceRevision: number;
    readonly valueJson: string;
  }[];
  readonly pins: readonly { readonly pinId: string; readonly workspaceRevision: number; readonly valueJson: string }[];
  readonly reviewEvents: readonly {
    readonly eventId: string;
    readonly kind: string;
    readonly workspaceRevision: number;
    readonly valueJson: string;
  }[];
}
export interface FactReadModelRow {
  readonly taskId: string;
  readonly factId: string;
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: string;
  readonly memoryClass: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly rowJson: string;
}
export interface PresetSnapshotReadModelRow {
  readonly digest: string;
  readonly workspaceRevision: number;
  readonly valueJson: string;
}
/** The center's own rows, published table by table; every table describes the same revision. */
export interface EdgeReadModelRows {
  readonly repository: readonly RepositoryReadModelRow[];
  readonly tasks: readonly TaskReadModelRow[];
  readonly taskGeneration: readonly TaskGenerationRow[];
  readonly taskProgress: readonly TaskProgressRow[];
  readonly entities: readonly EntityReadModelRow[];
  readonly leases: readonly LeaseReadModelRow[];
  readonly relations: readonly RelationReadModelRow[];
  readonly decisions: readonly DecisionReadModelRow[];
  readonly facts: readonly FactReadModelRow[];
  readonly presetSnapshots: readonly PresetSnapshotReadModelRow[];
}
export interface EdgeReadModelMeta {
  readonly schemaGeneration: typeof READ_MODEL_SCHEMA_GENERATION;
  readonly sourceRevision: number;
  readonly rootThreshold: number;
}

export const EDGE_READ_AUTHORIZATION_DOMAINS = ["repository-read"] as const;
export function edgeReadAuthorizationShapeDigest(input: {
  readonly repoId: string;
  readonly owner: string | null;
}): string {
  return sha256Text(
    stableStringify({
      repoId: input.repoId,
      owner: input.owner,
      domains: EDGE_READ_AUTHORIZATION_DOMAINS,
    }),
  );
}

export function taskReadModelPath(taskId: string): string {
  return `${TASK_READ_MODEL_PREFIX}${taskId}.json`;
}

const pathSegment = (value: string, label: string): string => {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,191}$/u.test(value))
    throw new Error(`read model ${label} is not path-safe: ${value}`);
  return value;
};

export function readTaskReadModelRows(db: DatabaseSync): readonly TaskReadModelRow[] {
  return (
    db
      .prepare(
        "SELECT task_snapshot.task_id, workspace_revision, snapshot_json, status, updated_at, package_path FROM task_snapshot LEFT JOIN task_package USING(task_id) ORDER BY task_snapshot.task_id",
      )
      .all() as readonly Record<string, unknown>[]
  ).map((row) => ({
    taskId: String(row.task_id),
    workspaceRevision: Number(row.workspace_revision),
    snapshotJson: String(row.snapshot_json),
    status: row.status === null ? null : String(row.status),
    updatedAt: String(row.updated_at),
    packagePath: row.package_path === null ? null : String(row.package_path),
  }));
}

type SqlRow = Record<string, unknown>;
const all = (db: DatabaseSync, sql: string): readonly SqlRow[] => db.prepare(sql).all() as readonly SqlRow[];
const text = (row: SqlRow, key: string): string => String(row[key]);
const nullableText = (row: SqlRow, key: string): string | null => (row[key] === null ? null : String(row[key]));
const integral = (row: SqlRow, key: string): number => Number(row[key]);

/** Reads every replicated table from the center projection at one completed revision. */
export function readEdgeReadModelRows(db: DatabaseSync): EdgeReadModelRows {
  const progress = new Map<string, TaskProgressEntry[]>();
  for (const row of all(
    db,
    "SELECT task_id, workspace_revision, execution_id, event_json FROM task_progress ORDER BY task_id, workspace_revision",
  )) {
    const taskId = text(row, "task_id");
    (progress.get(taskId) ?? progress.set(taskId, []).get(taskId)!).push({
      workspaceRevision: integral(row, "workspace_revision"),
      executionId: text(row, "execution_id"),
      eventJson: text(row, "event_json"),
    });
  }
  const bundles = new Map<
    string,
    {
      decisionId: string;
      decision: DecisionReadModelRow["decision"];
      options: DecisionReadModelRow["options"][number][];
      claims: DecisionReadModelRow["claims"][number][];
      consents: DecisionReadModelRow["consents"][number][];
      amendments: DecisionReadModelRow["amendments"][number][];
      pins: DecisionReadModelRow["pins"][number][];
      reviewEvents: DecisionReadModelRow["reviewEvents"][number][];
    }
  >();
  const bundle = (decisionId: string) =>
    bundles.get(decisionId) ??
    bundles
      .set(decisionId, {
        decisionId,
        decision: null,
        options: [],
        claims: [],
        consents: [],
        amendments: [],
        pins: [],
        reviewEvents: [],
      })
      .get(decisionId)!;
  for (const row of all(db, "SELECT decision_id FROM decision ORDER BY decision_id")) bundle(text(row, "decision_id"));
  for (const row of all(
    db,
    "SELECT decision_id, state, title, question, risk_tier, urgency, vertical, preset, decision_class, applies_json, proposer_json, arbiter_json, proposed_at, decided_at, provenance_json, workspace_revision FROM decision ORDER BY decision_id",
  ))
    bundle(text(row, "decision_id")).decision = {
      state: text(row, "state"),
      title: text(row, "title"),
      question: text(row, "question"),
      riskTier: text(row, "risk_tier"),
      urgency: text(row, "urgency"),
      vertical: text(row, "vertical"),
      preset: text(row, "preset"),
      decisionClass: text(row, "decision_class"),
      appliesJson: text(row, "applies_json"),
      proposerJson: text(row, "proposer_json"),
      arbiterJson: nullableText(row, "arbiter_json"),
      proposedAt: text(row, "proposed_at"),
      decidedAt: nullableText(row, "decided_at"),
      provenanceJson: text(row, "provenance_json"),
      workspaceRevision: integral(row, "workspace_revision"),
    };
  for (const row of all(
    db,
    "SELECT decision_id, kind, option_id, position, text, rationale, workspace_revision FROM decision_option ORDER BY decision_id, kind, position, option_id",
  ))
    bundle(text(row, "decision_id")).options.push({
      kind: text(row, "kind"),
      optionId: text(row, "option_id"),
      position: integral(row, "position"),
      text: text(row, "text"),
      rationale: nullableText(row, "rationale"),
      workspaceRevision: integral(row, "workspace_revision"),
    });
  for (const row of all(
    db,
    "SELECT decision_id, claim_id, position, text, load_bearing, fulfillment, declared_revision, fulfilled_revision FROM decision_claim ORDER BY decision_id, position, claim_id",
  ))
    bundle(text(row, "decision_id")).claims.push({
      claimId: text(row, "claim_id"),
      position: integral(row, "position"),
      text: text(row, "text"),
      loadBearing: integral(row, "load_bearing"),
      fulfillment: nullableText(row, "fulfillment"),
      declaredRevision: integral(row, "declared_revision"),
      fulfilledRevision: row.fulfilled_revision === null ? null : Number(row.fulfilled_revision),
    });
  for (const row of all(
    db,
    "SELECT consent_id, decision_id, workspace_revision, value_json FROM decision_judgment_consent ORDER BY decision_id, workspace_revision",
  ))
    bundle(text(row, "decision_id")).consents.push({
      consentId: text(row, "consent_id"),
      workspaceRevision: integral(row, "workspace_revision"),
      valueJson: text(row, "value_json"),
    });
  for (const row of all(
    db,
    "SELECT amendment_id, decision_id, workspace_revision, value_json FROM decision_amendment ORDER BY decision_id, workspace_revision",
  ))
    bundle(text(row, "decision_id")).amendments.push({
      amendmentId: text(row, "amendment_id"),
      workspaceRevision: integral(row, "workspace_revision"),
      valueJson: text(row, "value_json"),
    });
  for (const row of all(
    db,
    "SELECT pin_id, decision_id, workspace_revision, value_json FROM decision_content_pin ORDER BY decision_id, workspace_revision",
  ))
    bundle(text(row, "decision_id")).pins.push({
      pinId: text(row, "pin_id"),
      workspaceRevision: integral(row, "workspace_revision"),
      valueJson: text(row, "value_json"),
    });
  for (const row of all(
    db,
    "SELECT event_id, decision_id, kind, workspace_revision, value_json FROM decision_review_event ORDER BY decision_id, workspace_revision",
  ))
    bundle(text(row, "decision_id")).reviewEvents.push({
      eventId: text(row, "event_id"),
      kind: text(row, "kind"),
      workspaceRevision: integral(row, "workspace_revision"),
      valueJson: text(row, "value_json"),
    });
  return {
    repository: readRepositoryReadModelRows(db),
    tasks: readTaskReadModelRows(db),
    taskGeneration: all(db, "SELECT task_id, generation FROM task_generation ORDER BY task_id").map((row) => ({
      taskId: text(row, "task_id"),
      generation: text(row, "generation"),
    })),
    taskProgress: [...progress].map(([taskId, entries]) => ({ taskId, entries })),
    entities: all(
      db,
      "SELECT entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json FROM entity_projection ORDER BY entity_kind, entity_id, task_id",
    ).map((row) => ({
      entityKind: text(row, "entity_kind"),
      entityId: text(row, "entity_id"),
      ownerId: text(row, "task_id"),
      workspaceRevision: integral(row, "workspace_revision"),
      freshness: text(row, "freshness"),
      currentVersion: row.current_version === null ? null : Number(row.current_version),
      valueJson: text(row, "value_json"),
    })),
    leases: all(db, "SELECT task_id, lease_json FROM lease_cas ORDER BY task_id").map((row) => ({
      taskId: text(row, "task_id"),
      leaseJson: text(row, "lease_json"),
    })),
    relations: all(
      db,
      "SELECT relation_id, source_ref, target_ref, relation_type, state, target_observed_version, owner_ref, workspace_revision, updated_at, row_json FROM relation_edge ORDER BY relation_id",
    ).map((row) => ({
      relationId: text(row, "relation_id"),
      sourceRef: text(row, "source_ref"),
      targetRef: text(row, "target_ref"),
      relationType: text(row, "relation_type"),
      state: text(row, "state"),
      targetObservedVersion:
        row.target_observed_version === null ? null : (row.target_observed_version as string | number),
      ownerRef: text(row, "owner_ref"),
      workspaceRevision: integral(row, "workspace_revision"),
      updatedAt: text(row, "updated_at"),
      rowJson: text(row, "row_json"),
    })),
    decisions: [...bundles.values()],
    facts: all(
      db,
      "SELECT task_id, fact_id, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json FROM fact ORDER BY fact_id",
    ).map((row) => ({
      taskId: text(row, "task_id"),
      factId: text(row, "fact_id"),
      statement: text(row, "statement"),
      evidenceSource: text(row, "evidence_source"),
      observedAt: text(row, "observed_at"),
      confidence: text(row, "confidence"),
      memoryClass: text(row, "memory_class"),
      opId: text(row, "op_id"),
      workspaceRevision: integral(row, "workspace_revision"),
      rowJson: text(row, "row_json"),
    })),
    presetSnapshots: all(db, "SELECT digest, workspace_revision, value_json FROM preset_snapshot ORDER BY digest").map(
      (row) => ({
        digest: text(row, "digest"),
        workspaceRevision: integral(row, "workspace_revision"),
        valueJson: text(row, "value_json"),
      }),
    ),
  };
}

export interface EdgeReadModelEntry {
  readonly path: string;
  readonly text: string;
}

/** Every file the center publishes for one read-model revision, meta first. */
export function edgeReadModelEntries(model: {
  readonly sourceRevision: number;
  readonly rootThreshold: number;
  readonly rows: EdgeReadModelRows;
}): readonly EdgeReadModelEntry[] {
  const entry = <Row>(path: string, row: Row): EdgeReadModelEntry => ({
    path,
    text: JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, ...row }),
  });
  return [
    entry(READ_MODEL_META_PATH, {
      sourceRevision: model.sourceRevision,
      rootThreshold: model.rootThreshold,
    }),
    ...model.rows.repository.map((row) => entry(repositoryReadModelPath(row), row)),
    ...model.rows.tasks.map((row) => entry(taskReadModelPath(pathSegment(row.taskId, "task id")), row)),
    ...model.rows.taskGeneration.map((row) =>
      entry(`${TASK_GENERATION_PREFIX}${pathSegment(row.taskId, "task id")}.json`, row),
    ),
    ...model.rows.taskProgress.map((row) =>
      entry(`${TASK_PROGRESS_PREFIX}${pathSegment(row.taskId, "task id")}.json`, row),
    ),
    ...model.rows.entities.map((row) =>
      entry(
        `${ENTITY_READ_MODEL_PREFIX}${pathSegment(row.entityKind, "entity kind")}/${pathSegment(row.ownerId || "_", "entity owner")}/${pathSegment(row.entityId, "entity id")}.json`,
        row,
      ),
    ),
    ...model.rows.leases.map((row) =>
      entry(`${LEASE_READ_MODEL_PREFIX}${pathSegment(row.taskId, "task id")}.json`, row),
    ),
    ...model.rows.relations.map((row) =>
      entry(`${RELATION_READ_MODEL_PREFIX}${pathSegment(row.relationId, "relation id")}.json`, row),
    ),
    ...model.rows.decisions.map((row) =>
      entry(`${DECISION_READ_MODEL_PREFIX}${pathSegment(row.decisionId, "decision id")}.json`, row),
    ),
    ...model.rows.facts.map((row) => entry(`${FACT_READ_MODEL_PREFIX}${pathSegment(row.factId, "fact id")}.json`, row)),
    ...model.rows.presetSnapshots.map((row) => {
      const digest = pathSegment(row.digest.replace(/^sha256:/u, ""), "preset digest");
      return entry(`${PRESET_SNAPSHOT_PREFIX}${digest}.json`, row);
    }),
  ];
}

export function parseEdgeReadModelMeta(text: string): EdgeReadModelMeta {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (
    value.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION ||
    !Number.isSafeInteger(value.sourceRevision) ||
    !Number.isSafeInteger(value.rootThreshold)
  )
    throw new Error("edge read model meta is incompatible");
  return value as unknown as EdgeReadModelMeta;
}

type VersionedRow = { readonly schemaGeneration: typeof READ_MODEL_SCHEMA_GENERATION } & Record<string, unknown>;
const parseEntry = (entryText: string): VersionedRow => {
  const value = JSON.parse(entryText) as Record<string, unknown>;
  if (value.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION) throw new Error("edge read model row is incompatible");
  return value as VersionedRow;
};
// Row files are written by this module's own serializer and arrive digest-verified, so loading
// narrows their JSON shapes back without re-validating each field.
const str = (value: unknown): string => value as string;
const int = (value: unknown): number => value as number;
const optText = (value: unknown): string | null => value as string | null;
const optInt = (value: unknown): number | null => value as number | null;

/** Loads one published row; a row from another schema generation is rejected, never coerced. */
export function upsertTaskReadModelRow(db: DatabaseSync, entryText: string): string {
  const row = parseEntry(entryText);
  if (typeof row.taskId !== "string") throw new Error("task read model row is incompatible");
  db.prepare(
    "INSERT OR REPLACE INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(row.taskId, int(row.workspaceRevision), str(row.snapshotJson), optText(row.status), str(row.updatedAt));
  db.prepare("DELETE FROM task_package WHERE task_id = ?").run(row.taskId);
  if (row.packagePath !== null)
    db.prepare("INSERT INTO task_package(task_id, package_path) VALUES (?, ?)").run(row.taskId, str(row.packagePath));
  return row.taskId;
}

export function deleteTaskReadModelRow(db: DatabaseSync, taskId: string): void {
  db.prepare("DELETE FROM task_snapshot WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM task_package WHERE task_id = ?").run(taskId);
}

const relationSourceTask = (db: DatabaseSync, relationId: string): string | null =>
  (
    db.prepare("SELECT source_ref FROM relation_edge WHERE relation_id = ?").get(relationId) as
      | { readonly source_ref: string }
      | undefined
  )?.source_ref.replace(/^task\//u, "") ?? null;

const refreshTaskRelationsOf = (db: DatabaseSync, taskId: string): void => {
  if (taskId) refreshTaskRelationProjection(db, taskId, null, 0, "");
};

/** Applies one published row file into the edge tables; the entry's path names its table and key. */
export function applyEdgeReadModelEntry(db: DatabaseSync, entryPath: string, entryText: string): void {
  const row = parseEntry(entryText);
  if (applyRepositoryReadModelRow(db, entryPath, row as unknown as RepositoryReadModelRow)) return;
  if (entryPath.startsWith(TASK_READ_MODEL_PREFIX)) {
    upsertTaskReadModelRow(db, entryText);
    return;
  }
  if (entryPath.startsWith(TASK_GENERATION_PREFIX)) {
    db.prepare("INSERT OR REPLACE INTO task_generation(task_id, generation) VALUES (?, ?)").run(
      str(row.taskId),
      str(row.generation),
    );
    return;
  }
  if (entryPath.startsWith(TASK_PROGRESS_PREFIX)) {
    db.prepare("DELETE FROM task_progress WHERE task_id = ?").run(str(row.taskId));
    const insert = db.prepare(
      "INSERT INTO task_progress(workspace_revision, task_id, execution_id, event_json) VALUES (?, ?, ?, ?)",
    );
    for (const entry of row.entries as readonly TaskProgressEntry[])
      insert.run(int(entry.workspaceRevision), str(row.taskId), str(entry.executionId), str(entry.eventJson));
    return;
  }
  if (entryPath.startsWith(ENTITY_READ_MODEL_PREFIX)) {
    db.prepare(
      "INSERT OR REPLACE INTO entity_projection(entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      str(row.entityKind),
      str(row.entityId),
      str(row.ownerId),
      int(row.workspaceRevision),
      str(row.freshness),
      optInt(row.currentVersion),
      str(row.valueJson),
    );
    return;
  }
  if (entryPath.startsWith(LEASE_READ_MODEL_PREFIX)) {
    db.prepare("INSERT OR REPLACE INTO lease_cas(task_id, lease_json) VALUES (?, ?)").run(
      str(row.taskId),
      str(row.leaseJson),
    );
    return;
  }
  if (entryPath.startsWith(RELATION_READ_MODEL_PREFIX)) {
    db.prepare(
      "INSERT OR REPLACE INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, target_observed_version, owner_ref, workspace_revision, updated_at, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      str(row.relationId),
      str(row.sourceRef),
      str(row.targetRef),
      str(row.relationType),
      str(row.state),
      row.targetObservedVersion as string | number | null,
      str(row.ownerRef),
      int(row.workspaceRevision),
      str(row.updatedAt),
      str(row.rowJson),
    );
    refreshTaskRelationsOf(db, String(row.sourceRef).replace(/^task\//u, ""));
    return;
  }
  if (entryPath.startsWith(DECISION_READ_MODEL_PREFIX)) {
    const decisionId = String(row.decisionId);
    db.prepare("DELETE FROM decision WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_option WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_claim WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_judgment_consent WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_amendment WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_content_pin WHERE decision_id = ?").run(decisionId);
    db.prepare("DELETE FROM decision_review_event WHERE decision_id = ?").run(decisionId);
    const decision = row.decision as DecisionReadModelRow["decision"];
    if (decision)
      db.prepare(
        "INSERT INTO decision(decision_id, state, title, question, risk_tier, urgency, vertical, preset, decision_class, applies_json, proposer_json, arbiter_json, proposed_at, decided_at, provenance_json, workspace_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        decisionId,
        decision.state,
        decision.title,
        decision.question,
        decision.riskTier,
        decision.urgency,
        decision.vertical,
        decision.preset,
        decision.decisionClass,
        decision.appliesJson,
        decision.proposerJson,
        decision.arbiterJson,
        decision.proposedAt,
        decision.decidedAt,
        decision.provenanceJson,
        decision.workspaceRevision,
      );
    const option = db.prepare(
      "INSERT INTO decision_option(decision_id, kind, option_id, position, text, rationale, workspace_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const value of row.options as DecisionReadModelRow["options"])
      option.run(
        decisionId,
        value.kind,
        value.optionId,
        value.position,
        value.text,
        value.rationale,
        value.workspaceRevision,
      );
    const claim = db.prepare(
      "INSERT INTO decision_claim(decision_id, claim_id, position, text, load_bearing, fulfillment, declared_revision, fulfilled_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const value of row.claims as DecisionReadModelRow["claims"])
      claim.run(
        decisionId,
        value.claimId,
        value.position,
        value.text,
        value.loadBearing,
        value.fulfillment,
        value.declaredRevision,
        value.fulfilledRevision,
      );
    const consent = db.prepare(
      "INSERT INTO decision_judgment_consent(consent_id, decision_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)",
    );
    for (const value of row.consents as DecisionReadModelRow["consents"])
      consent.run(value.consentId, decisionId, value.workspaceRevision, value.valueJson);
    const amendment = db.prepare(
      "INSERT INTO decision_amendment(amendment_id, decision_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)",
    );
    for (const value of row.amendments as DecisionReadModelRow["amendments"])
      amendment.run(value.amendmentId, decisionId, value.workspaceRevision, value.valueJson);
    const pin = db.prepare(
      "INSERT INTO decision_content_pin(pin_id, decision_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)",
    );
    for (const value of row.pins as DecisionReadModelRow["pins"])
      pin.run(value.pinId, decisionId, value.workspaceRevision, value.valueJson);
    const reviewEvent = db.prepare(
      "INSERT INTO decision_review_event(event_id, decision_id, kind, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const value of row.reviewEvents as DecisionReadModelRow["reviewEvents"])
      reviewEvent.run(value.eventId, decisionId, value.kind, value.workspaceRevision, value.valueJson);
    return;
  }
  if (entryPath.startsWith(FACT_READ_MODEL_PREFIX)) {
    db.prepare(
      "INSERT OR REPLACE INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      str(row.taskId),
      str(row.factId),
      `fact/${String(row.factId)}`,
      str(row.statement),
      str(row.evidenceSource),
      str(row.observedAt),
      str(row.confidence),
      str(row.memoryClass),
      str(row.opId),
      int(row.workspaceRevision),
      str(row.rowJson),
    );
    return;
  }
  if (entryPath.startsWith(PRESET_SNAPSHOT_PREFIX)) {
    db.prepare("INSERT OR REPLACE INTO preset_snapshot(digest, workspace_revision, value_json) VALUES (?, ?, ?)").run(
      str(row.digest),
      int(row.workspaceRevision),
      str(row.valueJson),
    );
    return;
  }
  throw new Error(`edge read model entry ${entryPath} names no replicated table`);
}

/** Removes the row a published path described, re-deriving anything that was folded from it. */
export function deleteEdgeReadModelEntry(db: DatabaseSync, entryPath: string): void {
  if (deleteRepositoryReadModelRow(db, entryPath)) return;
  const key = (prefix: string): string => entryPath.slice(prefix.length, -".json".length);
  if (entryPath.startsWith(TASK_READ_MODEL_PREFIX)) {
    deleteTaskReadModelRow(db, key(TASK_READ_MODEL_PREFIX));
    return;
  }
  if (entryPath.startsWith(TASK_GENERATION_PREFIX)) {
    db.prepare("DELETE FROM task_generation WHERE task_id = ?").run(key(TASK_GENERATION_PREFIX));
    return;
  }
  if (entryPath.startsWith(TASK_PROGRESS_PREFIX)) {
    db.prepare("DELETE FROM task_progress WHERE task_id = ?").run(key(TASK_PROGRESS_PREFIX));
    return;
  }
  if (entryPath.startsWith(ENTITY_READ_MODEL_PREFIX)) {
    const [entityKind, ownerId, ...rest] = key(ENTITY_READ_MODEL_PREFIX).split("/");
    db.prepare("DELETE FROM entity_projection WHERE entity_kind = ? AND task_id = ? AND entity_id = ?").run(
      entityKind,
      ownerId === "_" ? "" : ownerId,
      rest.join("/"),
    );
    return;
  }
  if (entryPath.startsWith(LEASE_READ_MODEL_PREFIX)) {
    db.prepare("DELETE FROM lease_cas WHERE task_id = ?").run(key(LEASE_READ_MODEL_PREFIX));
    return;
  }
  if (entryPath.startsWith(RELATION_READ_MODEL_PREFIX)) {
    const relationId = key(RELATION_READ_MODEL_PREFIX),
      sourceTask = relationSourceTask(db, relationId);
    db.prepare("DELETE FROM relation_edge WHERE relation_id = ?").run(relationId);
    if (sourceTask) {
      db.prepare("DELETE FROM task_relation WHERE relation_id = ?").run(relationId);
      refreshTaskRelationsOf(db, sourceTask);
    }
    return;
  }
  if (entryPath.startsWith(DECISION_READ_MODEL_PREFIX)) {
    const decisionId = key(DECISION_READ_MODEL_PREFIX);
    for (const table of [
      "decision",
      "decision_option",
      "decision_claim",
      "decision_judgment_consent",
      "decision_amendment",
      "decision_content_pin",
      "decision_review_event",
    ])
      db.prepare(`DELETE FROM ${table} WHERE decision_id = ?`).run(decisionId);
    return;
  }
  if (entryPath.startsWith(FACT_READ_MODEL_PREFIX)) {
    db.prepare("DELETE FROM fact WHERE fact_id = ?").run(key(FACT_READ_MODEL_PREFIX));
    return;
  }
  if (entryPath.startsWith(PRESET_SNAPSHOT_PREFIX)) {
    db.prepare("DELETE FROM preset_snapshot WHERE digest = ?").run(`sha256:${key(PRESET_SNAPSHOT_PREFIX)}`);
    return;
  }
  throw new Error(`edge read model entry ${entryPath} names no replicated table`);
}
