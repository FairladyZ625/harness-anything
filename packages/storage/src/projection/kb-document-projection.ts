// Shared KB document read model (dec_D75C5F36D3E0C4D2346D4B3961 CH1/CH2): the kernel bundle
// reducer folded over accepted `kb-document-event/v1` events. Derived state only: any cache built
// before these tables existed, or by another model version, is refolded from event rows on open.
import type { DatabaseSync } from "node:sqlite";
import {
  KB_DOCUMENT_MODEL_VERSION,
  isKbDocumentEvent,
  kbDocumentCursor,
  kbDocumentEventTypes,
  kbDocumentNextCursor,
  kbDocumentPageLimit,
  matchesKbDocumentListFilter,
  reduceKbDocumentEvent,
  type KbDocumentEventV1,
  type KbDocumentQuery,
  type KbDocumentRead,
  type KbDocumentRecord,
} from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import { hydrateEventsByRevisions, type BatchEventsByRevisionsReader } from "./rebuildable-task-projection-sql.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const KB_DOCUMENT_TABLES = ["kb_document", "kb_document_cursor"] as const;
const CATCH_UP_BATCH = 512;
const kbEventTypeSql = kbDocumentEventTypes.map((type) => `'${type}'`).join(",");

export const KB_DOCUMENT_TABLES_SQL = `
    /* @gate-identity state-store/task.projection.kb_document */ CREATE TABLE IF NOT EXISTS kb_document (
      doc_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      domain TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workspace_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_document_status_domain
      ON kb_document(status, domain, doc_id);
    CREATE INDEX IF NOT EXISTS kb_document_domain
      ON kb_document(domain, doc_id);
    /* @gate-identity state-store/task.projection.kb_document_cursor */ CREATE TABLE IF NOT EXISTS kb_document_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL,
      model_version INTEGER NOT NULL
    );`;

/** Fold one accepted canonical KB event; runs inside the SQLite projection event transaction. */
export function projectKbDocumentEvent(
  db: DatabaseSync,
  event: { readonly schema: string; readonly type: string },
): void {
  if (!isKbDocumentEvent(event)) return;
  const input = event as KbDocumentEventV1,
    existing = readExistingKbRow(db, input.payload.docId),
    next = reduceKbDocumentEvent(existing, input);
  writeKbRow(db, next);
  runSql(
    db,
    `INSERT INTO kb_document_cursor(singleton, revision, model_version) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    input.workspaceRevision,
    KB_DOCUMENT_MODEL_VERSION,
  );
}

/** Refold KB document events this cache holds but has not folded: O(unfolded KB events). */
export function catchUpKbDocuments(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
  readEventsByRevisions?: BatchEventsByRevisionsReader,
): void {
  ensureKbDocumentModel(db);
  let applied = 0,
    total = 0;
  for (;;) {
    const after = kbFoldedThrough(db),
      revisions = queryRows<{ readonly workspace_revision: number }>(
        db,
        `SELECT s.workspace_revision FROM event_summary s
         WHERE s.event_type IN (${kbEventTypeSql}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${CATCH_UP_BATCH}`,
        after,
      ).map(({ workspace_revision }) => Number(workspace_revision));
    if (revisions.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows<{ count: number }>(
          db,
          `SELECT count(*) AS count FROM event_summary WHERE event_type IN (${kbEventTypeSql}) AND workspace_revision > ?`,
          after,
        )[0]!.count,
      );
    const hydrated = hydrateEventsByRevisions(revisions, readEventsByRevisions);
    transaction(db, () => {
      for (const revision of revisions) projectKbDocumentEvent(db, hydrated.get(revision)! as KbDocumentEventV1);
    });
    applied += revisions.length;
    onProgress?.({ applied, total });
  }
}

function kbModelVersion(db: DatabaseSync): number | undefined | null {
  const cursorColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(kb_document_cursor)").map(
      ({ name }) => name,
    ),
    docColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(kb_document)").map(({ name }) => name);
  if (!cursorColumns.includes("model_version") || !docColumns.includes("doc_id") || !docColumns.includes("record_json"))
    return null;
  return queryRows<{ model_version: number }>(db, "SELECT model_version FROM kb_document_cursor WHERE singleton = 1")[0]
    ?.model_version;
}

/** KB state of another model version is discarded and refolded from the event rows. */
export function ensureKbDocumentModel(db: DatabaseSync): void {
  const version = kbModelVersion(db);
  if (version === null || (version !== undefined && version !== KB_DOCUMENT_MODEL_VERSION)) {
    for (const table of KB_DOCUMENT_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of KB_DOCUMENT_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
}

function kbDocumentModelCurrent(db: DatabaseSync): boolean {
  const version = kbModelVersion(db);
  return version === undefined || version === KB_DOCUMENT_MODEL_VERSION;
}

function kbFoldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM kb_document_cursor WHERE singleton = 1")[0]?.revision ??
      0,
  );
}

function readExistingKbRow(db: DatabaseSync, docId: string): KbDocumentRecord | null {
  const row = queryRows<{ record_json: string }>(db, "SELECT record_json FROM kb_document WHERE doc_id = ?", docId)[0];
  return row ? (JSON.parse(row.record_json) as KbDocumentRecord) : null;
}

function writeKbRow(db: DatabaseSync, record: KbDocumentRecord): void {
  runSql(
    db,
    `INSERT INTO kb_document(doc_id, status, domain, revision, workspace_revision, updated_at, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       status = excluded.status,
       domain = excluded.domain,
       revision = excluded.revision,
       workspace_revision = excluded.workspace_revision,
       updated_at = excluded.updated_at,
       record_json = excluded.record_json`,
    record.docId,
    record.manifest.status,
    record.manifest.domain,
    record.revision,
    record.workspaceRevision,
    record.updatedAt,
    JSON.stringify(record),
  );
}

/** Point read (`id`) or ordered, bounded catalog list (`list`). */
export function readKbDocumentRows(
  db: DatabaseSync,
  query: KbDocumentQuery,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): KbDocumentRead {
  if (!kbDocumentModelCurrent(db)) return { status: "pending", ...cut };
  if (query.by === "id") {
    const row = queryRows<{ record_json: string }>(
      db,
      "SELECT record_json FROM kb_document WHERE doc_id = ?",
      query.docId,
    )[0];
    return {
      status: "ready",
      ...cut,
      records: row ? [JSON.parse(row.record_json) as KbDocumentRecord] : [],
      nextCursor: null,
    };
  }
  const limit = kbDocumentPageLimit(query.limit);
  let afterKey = kbDocumentCursor(query.cursor);
  const matched: KbDocumentRecord[] = [];
  const batchSize = Math.max(limit + 1, 64);
  for (;;) {
    const predicates = ["doc_id > ?"];
    const parameters: (string | number)[] = [afterKey];
    if (query.includeArchived !== true) {
      predicates.push("status = 'active'");
    }
    if (query.domain !== undefined) {
      predicates.push("domain = ?");
      parameters.push(query.domain);
    }
    const rows = queryRows<{ doc_id: string; record_json: string }>(
      db,
      `SELECT doc_id, record_json FROM kb_document
       WHERE ${predicates.join(" AND ")}
       ORDER BY doc_id ASC LIMIT ?`,
      ...parameters,
      batchSize,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      afterKey = row.doc_id;
      const record = JSON.parse(row.record_json) as KbDocumentRecord;
      if (matchesKbDocumentListFilter(record, query)) {
        matched.push(record);
        if (matched.length > limit) break;
      }
    }
    if (matched.length > limit || rows.length < batchSize) break;
  }
  return {
    status: "ready",
    ...cut,
    records: matched.slice(0, limit),
    nextCursor: kbDocumentNextCursor(matched, limit),
  };
}
