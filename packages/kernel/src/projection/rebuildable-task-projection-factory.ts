// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  serializeCanonicalEvent,
} from "../domain/doc-sync.contract.ts";
import type { FrozenWritePlan } from "../domain/write-chain.contract.ts";
import { assertMigrationImportWritePlan } from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
} from "../domain/ledger-layout-migration-event.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { assertEntityUpsertWritePlan, isEntityEvent } from "../domain/entity-event.ts";
import { assertScheduleEventWritePlan, isScheduleEvent } from "../domain/schedule-event.ts";
import { assertSettingsEventWritePlan, isSettingsEvent } from "../domain/settings-event.ts";
import { assertPeopleEventWritePlan, isPeopleEvent } from "../domain/people-event.ts";
import { assertTaskBootstrapWritePlan, isTaskBootstrapEvent } from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import {
  assertPresetSnapshotUpgradeWritePlan,
  isPresetSnapshotUpgradeEvent,
} from "../domain/preset-snapshot-upgrade-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { TaskProjection, TaskProjectionQueries, TaskProjectionReader } from "./task-projection-port.ts";
import type { EventStreamPort, ProjectionContext } from "./rebuildable-task-projection-types.ts";
import {
  closeDatabase,
  discardDatabase,
  ProjectionIdentityMismatchError,
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
import {
  readStateDigest,
  readProjectionCut,
  refreshStateDigestAtSourceCut,
  transaction,
  watermark,
} from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

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
}): TaskProjection {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = options.catchUpLimit ?? 4096,
    now = options.now ?? (() => new Date().toISOString()),
    sourceReadHead = options.eventStore.readHead;
  let observedSourceHead = false,
    hotAppliedHead: ReturnType<EventStreamPort["readHead"]> = null;
  // `apply` is the synchronous projection of a just-published event. A headless in-memory
  // source may not expose that event through readHead, but only this live instance may retain it.
  // Once a real source head has been seen, a later null/lower head remains a history regression.
  const readHead = () => {
    const sourceHead = sourceReadHead();
    if (sourceHead !== null) {
      observedSourceHead = true;
      return sourceHead;
    }
    return observedSourceHead ? null : hotAppliedHead;
  };
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
    throw new Error("task projection catch-up limit must be between 1 and 4096");
  if (localRuntimeStateFileSystem.exists(projectionPath)) {
    try {
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          if (markRuntimeSessionsUnknown(db) > 0) refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
        }),
      );
    } catch (error) {
      if (!(error instanceof ProjectionIdentityMismatchError)) throw error;
      if (readHead() === null) discardDatabase(projectionPath, readHead);
      else consumeKnownError(error);
    }
  }
  const closeProjection = () => {
    hotAppliedHead = null;
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
    apply: (event, plan) => {
      if (isDocEvent(event)) assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">);
      if (isEntityEvent(event)) assertEntityUpsertWritePlan(event, plan as FrozenWritePlan<"EntityUpsert">);
      if (isScheduleEvent(event)) assertScheduleEventWritePlan(event, plan);
      if (isSettingsEvent(event)) assertSettingsEventWritePlan(event, plan);
      if (isPeopleEvent(event)) assertPeopleEventWritePlan(event, plan);
      if (
        isTaskEvent(event) &&
        ((event.payload.documentClaims?.length ?? 0) > 0 || (event.payload.carriedDocumentClaims?.length ?? 0) > 0)
      )
        assertTaskLifecycleWritePlan(event, plan);
      if (isTaskBootstrapEvent(event)) assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">);
      if (isPresetSnapshotUpgradeEvent(event))
        assertPresetSnapshotUpgradeWritePlan(event, plan as FrozenWritePlan<"PresetSnapshotUpgrade">);
      if (isTaskProgressEvent(event)) assertTaskProgressWritePlan(event, plan);
      if (isFactEvent(event)) assertFactWritePlan(event, plan);
      if (isDecisionEvent(event)) assertDecisionWritePlan(event, plan);
      if (isMigrationImportEvent(event)) assertMigrationImportWritePlan(event, plan);
      if (isLedgerLayoutMigrationEvent(event)) assertLedgerLayoutMigrationWritePlan(event, plan);
      const receipt = withDatabase(projectionPath, readHead, (db) =>
        reduceBatch(db, [event], limit, options.eventStore.readContentBlob, readHead()?.revision ?? 0),
      );
      if (!observedSourceHead)
        hotAppliedHead = {
          revision: event.workspaceRevision,
          eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}`,
        };
      return receipt;
    },
    rebuild: () => {
      hotAppliedHead = null;
      closeDatabase(projectionPath, readHead);
      return rebuildProjection(projectionPath, readHead, options.eventStore, limit);
    },
    catchUp: () => {
      let sqliteTransactions = 0,
        reducedItems = 0,
        maxBatchItems = 0;
      for (;;) {
        const round = withDatabase(projectionPath, readHead, (db) => catchUpRound(db, options.eventStore, limit));
        sqliteTransactions += round.sqliteTransactions;
        reducedItems += round.reducedItems;
        maxBatchItems = Math.max(maxBatchItems, round.accessedItems);
        if (round.watermark !== round.sourceRevision) continue;
        const settled = withDatabase(projectionPath, readHead, (db) =>
          transaction(db, () => ({
            watermark: watermark(db),
            stateDigest: refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0),
          })),
        );
        if (settled.stateDigest === null) throw new Error("projection catch-up did not reach the source cut");
        return {
          watermark: settled.watermark,
          stateDigest: settled.stateDigest,
          metrics: { sqliteTransactions: sqliteTransactions + 1, reducedItems, maxBatchItems },
        };
      }
    },
    readStateDigest: () => withDatabase(projectionPath, readHead, readStateDigest),
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
      readStateDigest: () => withDatabase(projectionPath, readHead, readStateDigest),
      readCut: () => withDatabase(projectionPath, readHead, (db) => readProjectionCut(db, readHead)),
      read: (taskId) => readProjection(projectionPath, readHead, unavailableSource, taskId, 4096, now),
      list: (query) => listProjection(projectionPath, readHead, unavailableSource, 4096, now, query),
      ...entityQueryApi(context),
      readTaskIndex: taskQueries.readTaskIndex,
      readWorkspaceSummary: taskQueries.readWorkspaceSummary,
      readTaskRelations: taskQueries.readTaskRelations,
      readTaskDependencyClosure: taskQueries.readTaskDependencyClosure,
      readTaskRelationsByTargets: taskQueries.readTaskRelationsByTargets,
      readTaskStatuses: taskQueries.readTaskStatuses,
      readTaskRuntimeBatch: taskQueries.readTaskRuntimeBatch,
      readRelationQuery: taskQueries.readRelationQuery,
      readOperation: taskQueries.readOperation,
      readRelationTruth: taskQueries.readRelationTruth,
      readEntityVersionWitness: taskQueries.readEntityVersionWitness,
      readTaskOperation: taskQueries.readTaskOperation,
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
              "SELECT meta.schema_version, meta.watermark, event.event_json",
              "FROM projection_meta AS meta",
              "LEFT JOIN event_index AS event ON event.workspace_revision = meta.watermark",
              "WHERE meta.singleton = 1",
            ].join(" "),
          )
          .get() as
          | { readonly schema_version: number; readonly watermark: number; readonly event_json: string | null }
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
        const watermark = Number(row.watermark),
          eventJson = row.event_json ?? undefined;
        if (watermark > 0 && eventJson === undefined)
          throw new Error(`projection completed cut ${watermark} has no canonical event`);
        publishedHead =
          eventJson === undefined
            ? null
            : {
                revision: watermark,
                // event_index stores serializePersistedCanonicalEvent(event).trimEnd();
                // restore its one canonical newline without reparsing/canonicalizing on every read.
                eventDigest: `sha256:${sha256Text(`${eventJson}\n`)}`,
              };
        try {
          return read(queries);
        } finally {
          publishedHead = null;
        }
      }),
    close: () => undefined,
  };
}
