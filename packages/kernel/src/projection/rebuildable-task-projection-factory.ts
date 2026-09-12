// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import type { TaskProjection, TaskProjectionQueries, TaskProjectionReader } from "./task-projection-port.ts";
import type { EventStreamPort, ProjectionContext } from "./rebuildable-task-projection-types.ts";
import {
  closeDatabase,
  discardDatabase,
  ProjectionIdentityMismatchError,
  ProjectionSchemaMismatchError,
  withDatabase,
  withQueryOnlyDatabaseSession,
} from "./rebuildable-task-projection-database.ts";
import { taskProjectionSchemaVersion } from "./projection-schema.ts";
import { catchUpRound, reduceBatch } from "./rebuildable-task-projection-catch-up.ts";
import { listProjection, readProjection, rebuildProjection } from "./rebuildable-task-projection-reads.ts";
import { knowledgeQueryApi } from "./rebuildable-task-projection-knowledge-queries.ts";
import { entityQueryApi } from "./rebuildable-task-projection-entity-api.ts";
import { runtimeLeaseApi } from "./rebuildable-task-projection-runtime-api.ts";
import { taskQueryApi } from "./rebuildable-task-projection-task-queries.ts";
import { markRuntimeSessionsUnknown } from "./rebuildable-task-projection-runtime.ts";
import { readStateDigest, readProjectionCut, transaction, watermark } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

export interface TaskProjectionCatchUpProgress {
  readonly applied: number;
  readonly total?: number;
  readonly watermark: number;
}

// Public projection construction and local source-head handling.
export function defaultLifecycleTaskProjectionPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".harness/cache/task.sqlite");
}
export function makeTaskProjection(options: {
  readonly rootDir: string;
  readonly eventStore: EventStreamPort;
  readonly projectionPath?: string;
  readonly catchUpLimit?: number;
  readonly now?: () => string;
  readonly onProgress?: (progress: TaskProjectionCatchUpProgress) => void;
}): TaskProjection {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = options.catchUpLimit ?? 4096,
    now = options.now ?? (() => new Date().toISOString()),
    onProgress = options.onProgress ?? (() => undefined),
    readHead = options.eventStore.readHead;
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
    throw new Error("task projection catch-up limit must be between 1 and 4096");
  if (localRuntimeStateFileSystem.exists(projectionPath)) {
    try {
      withDatabase(projectionPath, readHead, (db) => transaction(db, () => markRuntimeSessionsUnknown(db)));
    } catch (error) {
      if (error instanceof ProjectionSchemaMismatchError && error.observed < taskProjectionSchemaVersion) {
        consumeKnownError(error);
        discardDatabase(projectionPath, options.eventStore);
      } else if (error instanceof ProjectionIdentityMismatchError) consumeKnownError(error);
      else throw error;
    }
  }
  const closeProjection = () => {
    closeDatabase(projectionPath, readHead);
  };
  const context: ProjectionContext = {
    projectionPath,
    readHead,
    eventStore: options.eventStore,
    limit,
    now,
  };
  return {
    path: projectionPath,
    close: closeProjection,
    apply: (event) => {
      return withDatabase(projectionPath, readHead, (db) =>
        reduceBatch(db, [event], limit, options.eventStore.readContentBlob, options.eventStore.readHead()),
      );
    },
    rebuild: () => {
      closeDatabase(projectionPath, readHead);
      return rebuildProjection(projectionPath, readHead, options.eventStore, limit);
    },
    catchUp: () => {
      const initialWatermark = withDatabase(projectionPath, readHead, watermark);
      let sqliteTransactions = 0,
        reducedItems = 0,
        maxBatchItems = 0,
        reportedWatermark = initialWatermark;
      for (;;) {
        const round = withDatabase(projectionPath, readHead, (db) => catchUpRound(db, options.eventStore, limit));
        sqliteTransactions += round.sqliteTransactions;
        reducedItems += round.reducedItems;
        maxBatchItems = Math.max(maxBatchItems, round.accessedItems);
        const total = Math.max(0, round.sourceRevision - initialWatermark);
        if (round.watermark > reportedWatermark) {
          onProgress({
            applied: Math.min(total, Math.max(0, round.watermark - initialWatermark)),
            total,
            watermark: round.watermark,
          });
          reportedWatermark = round.watermark;
        }
        if (round.watermark !== round.sourceRevision) continue;
        return { watermark: round.watermark, metrics: { sqliteTransactions, reducedItems, maxBatchItems } };
      }
    },
    readStateDigest: () =>
      withDatabase(projectionPath, readHead, (db) => readStateDigest(db, readHead()?.revision ?? 0)),
    readCut: () => withDatabase(projectionPath, readHead, (db) => readProjectionCut(db, readHead)),
    read: (taskId) => readProjection(projectionPath, readHead, options.eventStore, taskId, limit, now),
    list: (query) => listProjection(projectionPath, readHead, options.eventStore, limit, now, query),
    ...entityQueryApi(context),
    ...taskQueryApi(context),
    ...knowledgeQueryApi(context),
    ...runtimeLeaseApi(context),
  };
}

export function makeTaskProjectionReader(options: {
  readonly rootDir: string;
  readonly projectionPath?: string;
  readonly now?: () => string;
}): TaskProjectionReader {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir),
    now = options.now ?? (() => new Date().toISOString());
  let publishedHead: ReturnType<EventStreamPort["readHead"]> = null;
  const readHead = () => publishedHead,
    unavailableSource: EventStreamPort = {
      readHead,
      readBatch: () => {
        throw new Error("query-only projection reader cannot catch up from the canonical event source");
      },
      readContentBlob: () => null,
    },
    context: ProjectionContext = {
      projectionPath,
      readHead,
      eventStore: unavailableSource,
      limit: 4096,
      now,
    },
    taskQueries = taskQueryApi(context),
    knowledgeQueries = knowledgeQueryApi(context),
    runtimeQueries = runtimeLeaseApi(context),
    queries: TaskProjectionQueries = {
      path: projectionPath,
      readStateDigest: () =>
        withDatabase(projectionPath, readHead, (db) => readStateDigest(db, readHead()?.revision ?? 0)),
      readCut: () => withDatabase(projectionPath, readHead, (db) => readProjectionCut(db, readHead)),
      read: (taskId) => readProjection(projectionPath, readHead, unavailableSource, taskId, 4096, now),
      list: (query) => listProjection(projectionPath, readHead, unavailableSource, 4096, now, query),
      ...entityQueryApi(context),
      readTaskIndex: taskQueries.readTaskIndex,
      readTaskChildCounts: taskQueries.readTaskChildCounts,
      readWorkspaceSummary: taskQueries.readWorkspaceSummary,
      readTaskRelations: taskQueries.readTaskRelations,
      readTaskRelationNeighborhood: taskQueries.readTaskRelationNeighborhood,
      readTaskDependencyClosure: taskQueries.readTaskDependencyClosure,
      readTaskRelationsByTargets: taskQueries.readTaskRelationsByTargets,
      readTaskStatuses: taskQueries.readTaskStatuses,
      readTaskExists: taskQueries.readTaskExists,
      readTaskByIdempotencyKey: taskQueries.readTaskByIdempotencyKey,
      readTaskRuntimeBatch: taskQueries.readTaskRuntimeBatch,
      readRelationQuery: taskQueries.readRelationQuery,
      readOperation: taskQueries.readOperation,
      readRelationEdge: taskQueries.readRelationEdge,
      readEntityVersionWitness: taskQueries.readEntityVersionWitness,
      readTaskOperation: taskQueries.readTaskOperation,
      readTaskSubmissionOperation: taskQueries.readTaskSubmissionOperation,
      readTaskCompletion: taskQueries.readTaskCompletion,
      readRuntimeDispatch: taskQueries.readRuntimeDispatch,
      readRuntimeDispatches: taskQueries.readRuntimeDispatches,
      readRuntimeSessionEvents: taskQueries.readRuntimeSessionEvents,
      readCanonicalEvents: taskQueries.readCanonicalEvents,
      readCiRunObservations: taskQueries.readCiRunObservations,
      readDocument: taskQueries.readDocument,
      readReplicaBasis: taskQueries.readReplicaBasis,
      taskIdForDocumentPath: taskQueries.taskIdForDocumentPath,
      readPresetSnapshot: taskQueries.readPresetSnapshot,
      readProgress: taskQueries.readProgress,
      readFact: knowledgeQueries.readFact,
      searchFacts: knowledgeQueries.searchFacts,
      listFactDomainTypes: knowledgeQueries.listFactDomainTypes,
      readFactAnchors: knowledgeQueries.readFactAnchors,
      readFactGraph: knowledgeQueries.readFactGraph,
      readDecision: knowledgeQueries.readDecision,
      readDecisions: knowledgeQueries.readDecisions,
      listDecisions: knowledgeQueries.listDecisions,
      listDecisionAgendaPage: knowledgeQueries.listDecisionAgendaPage,
      readDecisionGraph: knowledgeQueries.readDecisionGraph,
      readDecisionCoverage: knowledgeQueries.readDecisionCoverage,
      readLeaseIntervals: runtimeQueries.readLeaseIntervals,
      currentLease: runtimeQueries.currentLease,
      currentLeaseForExecution: runtimeQueries.currentLeaseForExecution,
      readRuntimeInstallation: runtimeQueries.readRuntimeInstallation,
      readRuntimeInstallations: runtimeQueries.readRuntimeInstallations,
      readRuntimeSession: runtimeQueries.readRuntimeSession,
      readRuntimeSessions: runtimeQueries.readRuntimeSessions,
      readRuntimeSessionsForTask: runtimeQueries.readRuntimeSessionsForTask,
      readRuntimeSessionPage: runtimeQueries.readRuntimeSessionPage,
      squadRunProjectionReady: runtimeQueries.squadRunProjectionReady,
      readSquadRun: runtimeQueries.readSquadRun,
      readSquadRuns: runtimeQueries.readSquadRuns,
    };
  return {
    path: projectionPath,
    withSession: (read) =>
      withQueryOnlyDatabaseSession(projectionPath, readHead, (db) => {
        const row = db
          .prepare(
            [
              "SELECT meta.schema_version, meta.watermark, event.workspace_revision AS head_event_revision",
              "FROM projection_meta AS meta",
              "LEFT JOIN event_index AS event ON event.workspace_revision = meta.watermark",
              "WHERE meta.singleton = 1",
            ].join(" "),
          )
          .get() as
          | { readonly schema_version: number; readonly watermark: number; readonly head_event_revision: number | null }
          | undefined;
        const observedSchema = row?.schema_version ?? null;
        if (observedSchema !== taskProjectionSchemaVersion)
          throw Object.assign(
            new Error(
              [
                `kernel projection schema ${observedSchema ?? "missing"}`,
                `does not match supported schema ${taskProjectionSchemaVersion};`,
                "writer recovery must publish a compatible generation",
              ].join(" "),
            ),
            { code: "kernel_schema_mismatch" },
          );
        if (row === undefined) throw new Error("projection metadata is unavailable");
        const watermark = Number(row.watermark);
        if (watermark > 0 && row.head_event_revision === null)
          throw new Error(`projection completed cut ${watermark} has no canonical event`);
        publishedHead = watermark > 0 ? { revision: watermark } : null;
        try {
          return read(queries);
        } finally {
          publishedHead = null;
        }
      }),
    close: () => undefined,
  };
}
