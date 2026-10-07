import { readTaskDocumentOwner } from "./task-document-owner-query.ts";
import { listPinnedEntityRows } from "./rebuildable-task-projection-entities.ts";
// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { isTaskEvent } from "../domain/doc-sync.contract.ts";
import { repositoryEventQueries, readDocumentRows } from "./repository-event-queries.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import {
  readTaskDependencyClosureRows,
  readTaskRelationNeighborhoodRows,
  readTaskRelationNeighborhoodWindow,
  readTaskChildCounts,
  readTaskIndexRows,
  readTaskProgressRows,
  readTaskRelationPage,
  readTaskRelationRows,
  readTaskRelationsBySources,
  readTaskRelationsByTargets,
  readTaskRuntimeBatchPage,
  readTaskStatusRows,
  readTaskExists,
  readTaskByIdempotencyKey,
} from "./task-query-projection.ts";
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { readEdgeReadModelRows } from "./read-model.ts";
import { catchUpRound } from "./rebuildable-task-projection-event-application.ts";
import { readDocument, readPresetSnapshot } from "./rebuildable-task-projection-reads.ts";
import {
  prepareQuery,
  readProjectionCut,
  watermark,
  queryTransaction,
  queryRows,
} from "./rebuildable-task-projection-sql.ts";
import { readWorkspaceSummaryRows } from "./workspace-summary-projection.ts";
import { readRelationProjectionRow } from "./relation-entity-projection.ts";
import { readEntityVersionWitness } from "./entity-freshness-projection.ts";
export type {
  ProjectionPage,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
} from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const TASK_SUBMISSION_OPERATION_SQL = [
  "SELECT op_id FROM event_index WHERE task_id = ?",
  "AND json_extract(event_json, '$.schema') = 'task-event/v1'",
  "AND json_extract(event_json, '$.type') = 'execution_submitted'",
  "AND json_extract(event_json, '$.payload.execution.executionId') = ?",
  "ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");
const TASK_COMPLETION_SQL = [
  "SELECT event_json FROM event_index WHERE task_id = ?",
  "AND json_extract(event_json, '$.schema') = 'task-event/v1'",
  "AND json_extract(event_json, '$.type') = 'task_completed'",
  "AND json_extract(event_json, '$.payload.execution.executionId') = ?",
  "ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");
const CANONICAL_EVENTS_SQL = [
  "SELECT event_json FROM event_index WHERE workspace_revision > ?",
  "ORDER BY workspace_revision LIMIT ?",
].join(" ");
const REPLICA_EVENTS_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE workspace_revision > ? AND workspace_revision <= ?",
  "ORDER BY workspace_revision LIMIT 64",
].join(" ");
const EVENT_BY_OP_SQL = "SELECT event_json FROM event_index WHERE op_id = ?";

// Task relations, task status, document, replica, and progress query API.
export function taskQueryApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "readTaskRelations"
  | "readTaskRelationNeighborhood"
  | "readTaskIndex"
  | "readTaskChildCounts"
  | "readEdgeReadModel"
  | "readWorkspaceSummary"
  | "readTaskDependencyClosure"
  | "readTaskRelationsByTargets"
  | "readTaskRelationsBySources"
  | "readTaskStatuses"
  | "readTaskExists"
  | "readTaskByIdempotencyKey"
  | "readTaskRuntimeBatch"
  | "readRelationQuery"
  | "readOperation"
  | "readRelationEdge"
  | "readEntityVersionWitness"
  | "listPinnedEntities"
  | "readTaskOperation"
  | "readTaskSubmissionOperation"
  | "readTaskCompletion"
  | "readRuntimeDispatch"
  | "readRuntimeDispatches"
  | "readRuntimeDispatchById"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesBySession"
  | "readRuntimeDispatchesByTaskExecution"
  | "readRuntimeDispatchesByAttemptGroup"
  | "readRuntimeDispatchesByDecision"
  | "readRuntimeDispatchPage"
  | "readRuntimeSessionEvents"
  | "readCanonicalEvents"
  | "readScheduleEvents"
  | "readScheduleOutputEvents"
  | "readReckoningEvents"
  | "readCiRunObservations"
  | "readSettingsEvent"
  | "readArtifactEntityState"
  | "readEventList"
  | "readEventSummaries"
  | "readEventWitness"
  | "readDocuments"
  | "readDocument"
  | "readReplicaBasis"
  | "taskIdForDocumentPath"
  | "readPresetSnapshot"
  | "readProgress"
> {
  const { eventStore, limit, projectionPath, readHead } = context;
  return {
    ...repositoryEventQueries((read) =>
      withDatabase(projectionPath, readHead, (db) => read(db, readProjectionCut(db, readHead))),
    ),
    readTaskIndex: (query = {}) => {
      const existed = localRuntimeStateFileSystem.exists(projectionPath);
      return withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          schema: "task-index-projection/v1" as const,
          status: cut.status,
          ...readTaskIndexRows(db, query),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: !existed && cut.sourceRevision > 0 ? (["projection_missing"] as const) : [],
        };
      });
    },
    readEdgeReadModel: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return { status: cut.status, sourceRevision: cut.sourceRevision, rows: readEdgeReadModelRows(db) };
      }),
    readTaskChildCounts: (parentTaskIds) =>
      withDatabase(projectionPath, readHead, (db) => readTaskChildCounts(db, parentTaskIds)),
    readWorkspaceSummary: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          summary: readWorkspaceSummaryRows(db),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskRelations: () =>
      withDatabase(projectionPath, readHead, (db: DatabaseSync) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskRelationRows(db),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskRelationNeighborhood: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead),
          rows =
            query.allowTruncation === true
              ? readTaskRelationNeighborhoodWindow(db, query)
              : { rows: readTaskRelationNeighborhoodRows(db, query), truncated: false };
        return {
          status: cut.status,
          rows: rows.rows,
          truncated: rows.truncated,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskDependencyClosure: (sourceRefs, maxDepth) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskDependencyClosureRows(db, sourceRefs, maxDepth),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskRelationsByTargets: (targetRefs, relationType) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskRelationsByTargets(db, targetRefs, relationType),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskRelationsBySources: (sourceRefs, relationType) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskRelationsBySources(db, sourceRefs, relationType),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskStatuses: (taskIds) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskStatusRows(db, taskIds),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readTaskExists: (taskId) => withDatabase(projectionPath, readHead, (db) => readTaskExists(db, taskId)),
    readTaskByIdempotencyKey: (idempotencyKey) =>
      withDatabase(projectionPath, readHead, (db) => readTaskByIdempotencyKey(db, idempotencyKey)),
    readTaskRuntimeBatch: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead),
          page = readTaskRuntimeBatchPage(db, query);
        return {
          status: cut.status,
          ...page,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readRelationQuery: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead),
          page = readTaskRelationPage(db, query ?? {});
        return {
          status: cut.status,
          rows: page.rows,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          ...(page.page ? { page: page.page } : {}),
        };
      }),
    readOperation: (opId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = prepareQuery(db, EVENT_BY_OP_SQL, (sql) =>
          /* @gate-identity check-bypass-write-boundary/bypass-write-037 */ db.prepare(sql),
        ).get(opId) as { readonly event_json: string } | undefined;
        return row === undefined ? null : { event: JSON.parse(row.event_json), watermark: watermark(db) };
      }),
    readRelationEdge: (relationId) =>
      withDatabase(projectionPath, readHead, (db) => readRelationProjectionRow(db, relationId)),
    readEntityVersionWitness: (entityRef) =>
      withDatabase(projectionPath, readHead, (db) => readEntityVersionWitness(db, entityRef)),
    listPinnedEntities: () => withDatabase(projectionPath, readHead, listPinnedEntityRows),
    readTaskOperation: (opId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = prepareQuery(db, EVENT_BY_OP_SQL, (sql) =>
          /* @gate-identity check-bypass-write-boundary/bypass-write-038 */ db.prepare(sql),
        ).get(opId) as { readonly event_json: string } | undefined;
        if (!row) return null;
        const event = JSON.parse(row.event_json);
        return isTaskEvent(event) ? { event, watermark: watermark(db) } : null;
      }),
    readTaskSubmissionOperation: (taskId, executionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = queryRows(db, TASK_SUBMISSION_OPERATION_SQL, taskId, executionId)[0];
        return row ? String(row.op_id) : null;
      }),
    readTaskCompletion: (taskId, executionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        // Completion lookup is write-recovery admission, not a serving read: it must observe a
        // published completion before a retry can append a duplicate.
        catchUpRound(db, eventStore, limit);
        const row = queryRows(db, TASK_COMPLETION_SQL, taskId, executionId)[0];
        if (!row) return null;
        const event = JSON.parse(String(row.event_json));
        return isTaskEvent(event) ? event : null;
      }),
    readCanonicalEvents: (afterRevision, pageLimit) =>
      withDatabase(projectionPath, readHead, (db) => {
        if (
          !Number.isSafeInteger(afterRevision) ||
          afterRevision < 0 ||
          !Number.isSafeInteger(pageLimit) ||
          pageLimit < 1 ||
          pageLimit > 500
        )
          throw new Error("canonical event page requires a non-negative revision and a limit from 1 to 500");
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          events: queryRows(db, CANONICAL_EVENTS_SQL, afterRevision, pageLimit).map((row) =>
            JSON.parse(String(row.event_json)),
          ),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readDocument: (documentPath) => readDocument(projectionPath, readHead, eventStore, documentPath, limit),
    readReplicaBasis: (afterRevision) => {
      if (afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
        throw new Error("replica basis revision must be a non-negative integer or null");
      const sourceRevision = eventStore.readHead()?.revision ?? 0;
      return withDatabase(projectionPath, readHead, (db) =>
        queryTransaction(db, () => {
          const current = watermark(db),
            head =
              current === 0
                ? undefined
                : queryRows(db, "SELECT event_json FROM event_index WHERE workspace_revision = ?", current)[0],
            rows = afterRevision === null ? [] : queryRows(db, REPLICA_EVENTS_SQL, afterRevision, current),
            documents = readDocumentRows(db, "");
          return {
            watermark: current,
            sourceRevision,
            headEvent: head ? JSON.parse(String(head.event_json)) : null,
            events: rows.map((row) => JSON.parse(String(row.event_json))),
            documents,
          };
        }),
      );
    },
    taskIdForDocumentPath: (documentPath) =>
      withDatabase(projectionPath, readHead, (db) =>
        readTaskDocumentOwner(documentPath, (sql) =>
          prepareQuery(db, sql, (sql) =>
            /* @gate-identity check-bypass-write-boundary/bypass-write-039 */ db.prepare(sql),
          ),
        ),
      ),
    readPresetSnapshot: (digest) => readPresetSnapshot(projectionPath, readHead, eventStore, digest, limit),
    readProgress: (taskId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readTaskProgressRows(db, taskId),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
  };
}
