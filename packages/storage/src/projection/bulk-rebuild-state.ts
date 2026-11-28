import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  EVENT_INDEX_INSERT_SQL,
  eventIndexInsertParams,
  extractEventIndexRow,
} from "./rebuildable-task-projection-sql.ts";
import { prepareQuery, queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

export interface DocumentBaseMetadata {
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: string;
}

export interface FleetNodeTaskEntry {
  readonly nodeId: string;
  readonly taskId: string;
  revision: number;
  personId: string | null;
  updatedAt: string;
}

export interface BulkRebuildContext {
  readonly documentBase: Map<string, { active?: DocumentBaseMetadata; history?: DocumentBaseMetadata }>;
  readonly sessionExecutionNode: Map<string, string>;
  readonly sessionLaunchNode: Map<string, string>;
  readonly fleetNodeTasks: Map<string, FleetNodeTaskEntry>;
  readonly entityRefRevisions: Map<string, number[]>;
  readonly dispatchRows: Array<{ readonly opId: string; readonly runtimeSessionId: string | null }>;
}

const bulkRebuildContexts = new WeakMap<DatabaseSync, BulkRebuildContext | undefined>();

const DOCUMENT_BASE_ACTIVE_SQL = [
  "SELECT json_extract(value_json, '$.blobSha256') AS blobSha256,",
  "json_extract(value_json, '$.size') AS size,",
  "json_extract(value_json, '$.mediaType') AS mediaType,",
  "json_extract(value_json, '$.policyId') AS policyId",
  "FROM document INDEXED BY document_metadata WHERE path = ?",
].join(" ");

const DOCUMENT_BASE_HISTORY_SQL = [
  "SELECT json_extract(value_json, '$.blobSha256') AS blobSha256,",
  "json_extract(value_json, '$.size') AS size,",
  "json_extract(value_json, '$.mediaType') AS mediaType,",
  "json_extract(value_json, '$.policyId') AS policyId",
  "FROM document_history INDEXED BY document_history_metadata WHERE path = ?",
].join(" ");

export function beginBulkRebuild(db: DatabaseSync): BulkRebuildContext {
  const ctx: BulkRebuildContext = {
    documentBase: new Map(),
    sessionExecutionNode: new Map(),
    sessionLaunchNode: new Map(),
    fleetNodeTasks: new Map(),
    entityRefRevisions: new Map(),
    dispatchRows: [],
  };
  bulkRebuildContexts.set(db, ctx);
  return ctx;
}

export function bulkRebuildContext(db: DatabaseSync): BulkRebuildContext | undefined {
  return bulkRebuildContexts.get(db);
}

export function endBulkRebuild(db: DatabaseSync): void {
  bulkRebuildContexts.set(db, undefined);
}

function toMetadata(doc: DocumentBaseMetadata): DocumentBaseMetadata {
  return {
    blobSha256: doc.blobSha256,
    size: doc.size,
    mediaType: doc.mediaType,
    policyId: doc.policyId,
  };
}

export function recordDocumentUpsert(db: DatabaseSync, documentPath: string, document: DocumentBaseMetadata): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined) return;
  const entry = ctx.documentBase.get(documentPath);
  if (entry === undefined) ctx.documentBase.set(documentPath, { active: toMetadata(document) });
  else entry.active = toMetadata(document);
}

export function recordDocumentHistoryUpsert(
  db: DatabaseSync,
  documentPath: string,
  document: DocumentBaseMetadata,
): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined) return;
  const entry = ctx.documentBase.get(documentPath);
  if (entry === undefined) ctx.documentBase.set(documentPath, { history: toMetadata(document) });
  else entry.history = toMetadata(document);
}

export function recordDocumentDelete(db: DatabaseSync, documentPath: string): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined) return;
  const entry = ctx.documentBase.get(documentPath);
  if (entry === undefined) return;
  entry.active = undefined;
}

export function recordDocumentHistoryDelete(db: DatabaseSync, documentPath: string): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined) return;
  const entry = ctx.documentBase.get(documentPath);
  if (entry === undefined) return;
  entry.history = undefined;
}

export function recordDocumentArchive(db: DatabaseSync, documentPath: string): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined) return;
  const entry = ctx.documentBase.get(documentPath);
  if (entry === undefined) return;
  if (entry.active !== undefined) {
    entry.history = entry.active;
    entry.active = undefined;
  }
}

export function recordRuntimeSessionExecutionNode(
  db: DatabaseSync,
  runtimeSessionId: string,
  executionNodeId: string,
): void {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx === undefined || executionNodeId === "") return;
  ctx.sessionExecutionNode.set(runtimeSessionId, executionNodeId);
}

/**
 * Look up document scalar metadata without scanning multi-MB value_json overflow chains.
 * During cold rebuild, answers in O(1) from the rebuild connection's in-memory map.
 * On steady-state incremental writes, probes document and document_history via their
 * covering metadata indexes.
 */
export function readDocumentBaseMetadata(db: DatabaseSync, documentPath: string): DocumentBaseMetadata | undefined {
  const ctx = bulkRebuildContexts.get(db);
  if (ctx !== undefined) {
    const entry = ctx.documentBase.get(documentPath);
    return entry?.active ?? entry?.history;
  }
  const active = prepareQuery(db, DOCUMENT_BASE_ACTIVE_SQL).get(documentPath) as DocumentBaseMetadata | undefined;
  if (active !== undefined) return active;
  return prepareQuery(db, DOCUMENT_BASE_HISTORY_SQL).get(documentPath) as DocumentBaseMetadata | undefined;
}

export function insertEventIndexRow(
  db: DatabaseSync,
  opId: string,
  workspaceRevision: number,
  taskId: string | null,
  eventJson: string,
  event?: PersistedCanonicalEventV1,
): void {
  const ctx = bulkRebuildContexts.get(db);
  const row = extractEventIndexRow({
    opId,
    workspaceRevision,
    taskId,
    eventJson,
    parsedEvent: event as unknown as Readonly<Record<string, unknown>> | undefined,
    runtimeSessionPresent: ctx === undefined ? null : 0,
  });
  if (ctx !== undefined && row.event_schema === "agent-runtime-event/v1") {
    if (row.event_type === "runtime_session_started" && row.runtime_session_id !== null && row.source_node_id !== null)
      ctx.sessionLaunchNode.set(row.runtime_session_id, row.source_node_id);
    else if (row.event_type === "runtime_dispatch_requested")
      ctx.dispatchRows.push({ opId, runtimeSessionId: row.runtime_session_id });
  }
  runSql(db, EVENT_INDEX_INSERT_SQL, ...eventIndexInsertParams(row));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Flush sorted entity-ref rows, fleet node task summaries, and dispatch session presence in one transaction. */
export function flushBulkRebuildDerivedTables(db: DatabaseSync, ctx: BulkRebuildContext): void {
  transaction(db, () => {
    if (ctx.entityRefRevisions.size > 0) {
      const sql = "INSERT INTO event_summary_entity_ref(workspace_revision, entity_ref) VALUES (?, ?)";
      const sortedRefs = [...ctx.entityRefRevisions.keys()].sort(compareCodeUnits);
      for (const ref of sortedRefs) {
        const revisions = ctx.entityRefRevisions.get(ref)!;
        for (const revision of revisions) runSql(db, sql, revision, ref);
      }
      ctx.entityRefRevisions.clear();
    }
    if (ctx.fleetNodeTasks.size > 0) {
      const sql =
        "INSERT INTO fleet_node_task(node_id, task_id, revision, person_id, updated_at) VALUES (?, ?, ?, ?, ?)";
      const sortedFleet = [...ctx.fleetNodeTasks.values()].sort(
        (left, right) => compareCodeUnits(left.nodeId, right.nodeId) || compareCodeUnits(left.taskId, right.taskId),
      );
      for (const row of sortedFleet) runSql(db, sql, row.nodeId, row.taskId, row.revision, row.personId, row.updatedAt);
      ctx.fleetNodeTasks.clear();
    }
    if (ctx.dispatchRows.length > 0) {
      const sessions = new Set(
        queryRows<{ readonly runtime_session_id: string }>(db, "SELECT runtime_session_id FROM runtime_session").map(
          ({ runtime_session_id }) => runtime_session_id,
        ),
      );
      const sql = "UPDATE event_index SET runtime_session_present = 1 WHERE op_id = ?";
      for (const { opId, runtimeSessionId } of ctx.dispatchRows)
        if (runtimeSessionId !== null && sessions.has(runtimeSessionId)) runSql(db, sql, opId);
      ctx.dispatchRows.length = 0;
    }
  });
}
