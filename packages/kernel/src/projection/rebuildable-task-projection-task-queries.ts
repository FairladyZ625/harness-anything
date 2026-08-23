// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { isTaskEvent } from "../domain/doc-sync.contract.ts";
import { isAgentRuntimeEvent, type AgentRuntimeEventV1 } from "../domain/agent-runtime.ts";
import { type TaskProgressEventV1 } from "../domain/task-progress-event.ts";
import { readDecisionGraphRows } from "./decision-event-projection.ts";
import { readFactGraphRows } from "./fact-event-projection.ts";
import {
  readTaskDependencyClosureRows,
  readTaskRelationPage,
  readTaskRelationRows,
  readTaskRelationsByTargets,
  readTaskRuntimeBatchPage,
  readTaskStatusRows,
} from "./task-query-projection.ts";
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { catchUpRound } from "./rebuildable-task-projection-catch-up.ts";
import { readDocument, readPresetSnapshot } from "./rebuildable-task-projection-reads.ts";
import { watermark, parseEventJson, queryRow, queryRows, transaction } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const TASK_COMPLETION_SQL = [
  "SELECT event_json FROM event_index WHERE task_id = ?",
  "AND json_extract(event_json, '$.schema') = 'task-event/v1'",
  "AND json_extract(event_json, '$.type') = 'task_completed'",
  "AND json_extract(event_json, '$.payload.execution.executionId') = ?",
  "ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");
const RUNTIME_DISPATCH_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.runtimeSessionId') = ?",
  "AND json_extract(event_json, '$.payload.definitionSnapshotRef') = ?",
  "ORDER BY workspace_revision LIMIT 1",
].join(" ");
const RUNTIME_DISPATCHES_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "ORDER BY workspace_revision",
].join(" ");
const RUNTIME_SESSION_EVENTS_SQL = [
  "SELECT event_json FROM event_index WHERE workspace_revision > ?",
  "AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.payload.runtimeSessionId') = ?",
  "ORDER BY workspace_revision LIMIT ?",
].join(" ");
const REPLICA_EVENTS_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE workspace_revision > ? AND workspace_revision <= ?",
  "ORDER BY workspace_revision LIMIT 64",
].join(" ");
const REPLICA_DOCUMENTS_SQL = [
  "SELECT path, json_extract(value_json, '$.blobSha256') AS blob_sha256,",
  "json_extract(value_json, '$.size') AS size,",
  "json_extract(value_json, '$.mediaType') AS media_type",
  "FROM document ORDER BY path",
].join(" ");
const TASK_FOR_DOCUMENT_SQL = [
  "SELECT task_id FROM task_package WHERE ? = package_path",
  "OR substr(?, 1, length(package_path) + 1) = package_path || '/'",
  "ORDER BY length(package_path) DESC LIMIT 1",
].join(" ");

// Task relations, task status, document, replica, and progress query API.
export function taskQueryApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "readTaskRelations"
  | "readTaskDependencyClosure"
  | "readTaskRelationsByTargets"
  | "readTaskStatuses"
  | "readTaskRuntimeBatch"
  | "readRelationQuery"
  | "readOperation"
  | "readRelationTruth"
  | "readTaskOperation"
  | "readTaskCompletion"
  | "readRuntimeDispatch"
  | "readRuntimeDispatches"
  | "readRuntimeSessionEvents"
  | "readDocument"
  | "readReplicaBasis"
  | "taskIdForDocumentPath"
  | "readPresetSnapshot"
  | "readProgress"
> {
  const { eventStore, limit, projectionPath, readHead } = context;
  return {
    readTaskRelations: () =>
      withDatabase(projectionPath, readHead, (db: DatabaseSync) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readTaskRelationRows(db),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readTaskDependencyClosure: (sourceRefs, maxDepth) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readTaskDependencyClosureRows(db, sourceRefs, maxDepth),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readTaskRelationsByTargets: (targetRefs, relationType) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readTaskRelationsByTargets(db, targetRefs, relationType),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readTaskStatuses: (taskIds) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readTaskStatusRows(db, taskIds),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readTaskRuntimeBatch: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = readTaskRuntimeBatchPage(db, query);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          ...page,
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readRelationQuery: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = readTaskRelationPage(db, query ?? {});
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: page.rows,
          watermark: current,
          sourceRevision: round.sourceRevision,
          ...(page.page ? { page: page.page } : {}),
        };
      }),
    readOperation: (opId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(opId) as
          | { readonly event_json: string }
          | undefined;
        return row === undefined ? null : { event: parseEventJson(row.event_json), watermark: watermark(db) };
      }),
    readRelationTruth: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const facts = readFactGraphRows(db),
          decisions = readDecisionGraphRows(db);
        return {
          factAnchors: facts.factAnchors,
          decisionAnchors: decisions.decisionAnchors,
          edges: [...facts.edges, ...decisions.edges],
          coverageRows: decisions.coverageRows.map((row) => ({
            ...row,
            fulfillment: row.fulfillment === "standing_policy" ? ("standing-policy" as const) : row.fulfillment,
          })),
        };
      }),
    readTaskOperation: (opId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(opId) as
          | { readonly event_json: string }
          | undefined;
        if (!row) return null;
        const event = parseEventJson(row.event_json);
        return isTaskEvent(event) ? { event, watermark: watermark(db) } : null;
      }),
    readTaskCompletion: (taskId, executionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        catchUpRound(db, eventStore, limit);
        const row = queryRows(db, TASK_COMPLETION_SQL, taskId, executionId)[0];
        if (!row) return null;
        const event = parseEventJson(String(row.event_json));
        return isTaskEvent(event) ? event : null;
      }),
    readRuntimeDispatch: (runtimeSessionIdValue, definitionSnapshotRef) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = queryRow(db, RUNTIME_DISPATCH_SQL, runtimeSessionIdValue, definitionSnapshotRef);
        if (!row) return null;
        const event = parseEventJson(String(row.event_json));
        return isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested" ? event : null;
      }),
    readRuntimeDispatches: () =>
      withDatabase(projectionPath, readHead, (db) =>
        queryRows(db, RUNTIME_DISPATCHES_SQL)
          .map((row) => parseEventJson(String(row.event_json)))
          .filter(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
              isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
          ),
      ),
    readRuntimeSessionEvents: (runtimeSessionIdValue, afterRevision, limit) =>
      withDatabase(projectionPath, readHead, (db) => {
        if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1)
          throw new Error("runtime session event page requires a non-negative revision and a positive limit");
        return queryRows(db, RUNTIME_SESSION_EVENTS_SQL, afterRevision, runtimeSessionIdValue, limit)
          .map((row) => parseEventJson(String(row.event_json)))
          .filter((event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event));
      }),
    readDocument: (documentPath) => readDocument(projectionPath, readHead, eventStore, documentPath, limit),
    readReplicaBasis: (afterRevision) => {
      if (afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
        throw new Error("replica basis revision must be a non-negative integer or null");
      const sourceRevision = eventStore.readHead()?.revision ?? 0;
      return withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const current = watermark(db),
            head =
              current === 0
                ? undefined
                : queryRows(db, "SELECT event_json FROM event_index WHERE workspace_revision = ?", current)[0],
            rows = afterRevision === null ? [] : queryRows(db, REPLICA_EVENTS_SQL, afterRevision, current),
            documents = queryRows(db, REPLICA_DOCUMENTS_SQL);
          return {
            watermark: current,
            sourceRevision,
            headEvent: head ? parseEventJson(String(head.event_json)) : null,
            events: rows.map((row) => parseEventJson(String(row.event_json))),
            documents: documents.map((row) => ({
              path: String(row.path),
              blobSha256: String(row.blob_sha256),
              size: Number(row.size),
              mediaType: String(row.media_type),
            })),
          };
        }),
      );
    },
    taskIdForDocumentPath: (documentPath) =>
      withDatabase(
        projectionPath,
        readHead,
        (db) =>
          (
            db.prepare(TASK_FOR_DOCUMENT_SQL).get(documentPath, documentPath) as
              | { readonly task_id: string }
              | undefined
          )?.task_id ?? null,
      ),
    readPresetSnapshot: (digest) => readPresetSnapshot(projectionPath, readHead, eventStore, digest, limit),
    readProgress: (taskId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          rows = queryRows(
            db,
            "SELECT event_json FROM task_progress WHERE task_id = ? ORDER BY workspace_revision",
            taskId,
          );
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: rows.map((row) => parseEventJson(String(row.event_json)) as TaskProgressEventV1),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
  };
}
