import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { projectionCatchUpLimit } from "./catch-up-limit.ts";
import { createSqlTaskQueryReader } from "../pg/sql-task-query-reader.ts";
import { makePgTaskProjection } from "../pg/pg-task-projection.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  isFrozenWritePlan,
  sameWriteTargets,
  type FrozenWritePlan,
} from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { assertMigrationImportWritePlan } from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
} from "@harness-anything/kernel/internal/domain/ledger-layout-migration-event.ts";
import {
  assertEventShapeMigrationWritePlan,
  isEventShapeMigrationEvent,
} from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { assertEntityUpsertWritePlan, isEntityEvent } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import {
  assertScheduleEventWritePlan,
  isScheduleEvent,
} from "@harness-anything/kernel/internal/domain/schedule-event.ts";
import {
  assertSettingsEventWritePlan,
  isSettingsEvent,
} from "@harness-anything/kernel/internal/domain/settings-event.ts";
import {
  isVerticalDeclarationEvent,
  verticalDeclarationWritePlan,
} from "@harness-anything/kernel/internal/domain/vertical-declaration.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
} from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import {
  assertTaskProgressWritePlan,
  isTaskProgressEvent,
} from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import {
  assertPresetSnapshotUpgradeWritePlan,
  isPresetSnapshotUpgradeEvent,
} from "@harness-anything/kernel/internal/domain/preset-snapshot-upgrade-event.ts";
import { assertDecisionWritePlan } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { assertFactWritePlan } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { assertTaskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type {
  TaskProjection,
  TaskProjectionPort,
  TaskProjectionQueries,
  TaskProjectionReader,
  TaskProjectionReaderPort,
} from "@harness-anything/kernel";
import type {
  EventStreamPort,
  ProjectionContext,
  TaskProjectionCatchUpProgress,
} from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import type { LedgerEventStorePort } from "@harness-anything/kernel";
import {
  closeDatabase,
  closeQueryOnlyReader,
  discardDatabase,
  ProjectionIdentityMismatchError,
  ProjectionSchemaMismatchError,
  withDatabase,
  withQueryOnlyDatabaseSession,
} from "./rebuildable-task-projection-database.ts";
import { taskProjectionSchemaVersion } from "./projection-schema.ts";
import { reduceBatch } from "./rebuildable-task-projection-event-application.ts";
import { requiresEventShapeReplay } from "./event-shape-replay.ts";
import {
  catchUpProjectionRound,
  listProjection,
  readProjection,
  rebuildProjection,
} from "./rebuildable-task-projection-reads.ts";
import { knowledgeQueryApi } from "./rebuildable-task-projection-knowledge-queries.ts";
import { entityQueryApi } from "./rebuildable-task-projection-entity-api.ts";
import { runtimeLeaseApi } from "./rebuildable-task-projection-runtime-api.ts";
import { taskQueryApi } from "./rebuildable-task-projection-task-queries.ts";
import { readStateDigest, readProjectionCut, watermark } from "./rebuildable-task-projection-sql.ts";
import {
  resolveStorageBackend,
  unsupportedStorageBackendError,
  type PostgresStorageBackendConfig,
  type PGliteStorageBackendConfig,
  type SqliteStorageBackendConfig,
  type StorageBackendOptions,
} from "../storage-backend.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type {
  TaskProjection,
  TaskProjectionPort,
  TaskProjectionQueries,
  TaskProjectionReaderPort,
} from "@harness-anything/kernel";

export type { TaskProjectionCatchUpProgress } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";

interface CommonTaskProjectionFactoryOptions {
  readonly rootDir: string;
  readonly projectionPath?: string;
  readonly catchUpLimit?: number;
  readonly now?: () => string;
  readonly onValidationProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
  readonly onProgress?: (progress: TaskProjectionCatchUpProgress) => void;
}
export interface SqliteTaskProjectionFactoryOptions extends CommonTaskProjectionFactoryOptions {
  readonly storage?: SqliteStorageBackendConfig;
  readonly eventStore: EventStreamPort;
}
export interface CanonicalTaskProjectionFactoryOptions extends CommonTaskProjectionFactoryOptions {
  readonly storage?: SqliteStorageBackendConfig | PostgresStorageBackendConfig | PGliteStorageBackendConfig;
  readonly eventStore: LedgerEventStorePort;
}
export type TaskProjectionFactoryOptions = SqliteTaskProjectionFactoryOptions | CanonicalTaskProjectionFactoryOptions;
export interface PostgresTaskProjectionFactoryOptions
  extends Omit<TaskProjectionFactoryOptions, "eventStore" | "storage"> {
  readonly storage: PostgresStorageBackendConfig;
  readonly eventStore: LedgerEventStorePort;
}
export interface PGliteTaskProjectionFactoryOptions extends Omit<PostgresTaskProjectionFactoryOptions, "storage"> {
  readonly storage: PGliteStorageBackendConfig;
}
function requireSqliteBackend<Options extends StorageBackendOptions>(
  options: Options,
): asserts options is Options & { readonly storage?: SqliteStorageBackendConfig } {
  const backend = resolveStorageBackend(options);
  if (backend.backend !== "sqlite") throw unsupportedStorageBackendError(backend.backend);
}

// Public projection construction and local source-head handling.
// The cache location is never a literal: it is whatever layout.localRoot says, so a repository that
// renamed its local root keeps the default `.harness` directory free of projection state.
export function defaultLifecycleTaskProjectionPath(rootDir: string): string {
  return resolveHarnessLayout(rootDir).taskProjectionPath;
}
export function makeTaskProjection(options: PostgresTaskProjectionFactoryOptions): TaskProjectionPort;
export function makeTaskProjection(options: PGliteTaskProjectionFactoryOptions): TaskProjectionPort;
export function makeTaskProjection(options: TaskProjectionFactoryOptions): TaskProjection;
export function makeTaskProjection(
  options: TaskProjectionFactoryOptions | PostgresTaskProjectionFactoryOptions | PGliteTaskProjectionFactoryOptions,
): TaskProjection;
export function makeTaskProjection(
  options: TaskProjectionFactoryOptions | PostgresTaskProjectionFactoryOptions | PGliteTaskProjectionFactoryOptions,
): TaskProjection | TaskProjectionPort {
  if (options.storage?.backend === "postgres" || options.storage?.backend === "pglite")
    return makePgTaskProjection(options as PostgresTaskProjectionFactoryOptions | PGliteTaskProjectionFactoryOptions);
  requireSqliteBackend(options);
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = projectionCatchUpLimit(options.catchUpLimit),
    now = options.now ?? (() => new Date().toISOString()),
    onProgress = options.onProgress ?? (() => undefined),
    readHead = options.eventStore.readHead;
  if (localRuntimeStateFileSystem.exists(projectionPath)) {
    try {
      withDatabase(projectionPath, readHead, () => undefined, options.onValidationProgress);
    } catch (error) {
      if (error instanceof ProjectionSchemaMismatchError && error.observed < taskProjectionSchemaVersion) {
        consumeKnownError(error);
        discardDatabase(projectionPath, options.eventStore, "schema_mismatch", options.onValidationProgress);
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
    apply: (event, plan) => {
      if (isDocEvent(event)) assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">);
      if (isEntityEvent(event)) assertEntityUpsertWritePlan(event, plan as FrozenWritePlan<"EntityUpsert">);
      if (isScheduleEvent(event)) assertScheduleEventWritePlan(event, plan);
      if (isSettingsEvent(event)) assertSettingsEventWritePlan(event, plan);
      if (isVerticalDeclarationEvent(event)) {
        const expected = verticalDeclarationWritePlan(event);
        if (
          plan === undefined ||
          !isFrozenWritePlan(plan) ||
          plan.commandType !== expected.commandType ||
          !sameWriteTargets(plan.targets, expected.targets)
        )
          throw new Error("vertical declaration write plan does not match the event");
      }
      const ownsDocuments =
        isTaskEvent(event) &&
        ((event.payload.documentClaims?.length ?? 0) > 0 || (event.payload.carriedDocumentClaims?.length ?? 0) > 0);
      if (ownsDocuments) assertTaskLifecycleWritePlan(event, plan);
      if (isTaskBootstrapEvent(event)) assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">);
      if (isPresetSnapshotUpgradeEvent(event))
        assertPresetSnapshotUpgradeWritePlan(event, plan as FrozenWritePlan<"PresetSnapshotUpgrade">);
      if (isTaskProgressEvent(event)) assertTaskProgressWritePlan(event, plan);
      if (isFactEvent(event)) assertFactWritePlan(event, plan);
      if (isDecisionEvent(event)) assertDecisionWritePlan(event, plan);
      if (isMigrationImportEvent(event)) assertMigrationImportWritePlan(event, plan);
      if (isLedgerLayoutMigrationEvent(event)) assertLedgerLayoutMigrationWritePlan(event, plan);
      if (isEventShapeMigrationEvent(event)) assertEventShapeMigrationWritePlan(event, plan);
      if (
        isEventShapeMigrationEvent(event) &&
        withDatabase(projectionPath, readHead, (db) => requiresEventShapeReplay([event], watermark(db)))
      )
        rebuildProjection(projectionPath, readHead, options.eventStore, limit, onProgress);
      // As with schema repair at open, prerequisite replay is separate from this apply receipt.
      return withDatabase(projectionPath, readHead, (db) =>
        reduceBatch(db, [event], limit, options.eventStore.readContentBlob, options.eventStore.readHead()),
      );
    },
    rebuild: () => {
      closeDatabase(projectionPath, readHead);
      return rebuildProjection(projectionPath, readHead, options.eventStore, limit, onProgress);
    },
    catchUp: () => {
      let initialWatermark = withDatabase(projectionPath, readHead, watermark, options.onValidationProgress);
      let storeTransactions = 0,
        reducedItems = 0,
        maxBatchItems = 0,
        reportedWatermark = initialWatermark;
      for (;;) {
        const round = catchUpProjectionRound(projectionPath, options.eventStore, limit, options.onValidationProgress);
        if (round.restarted) initialWatermark = reportedWatermark = 0;
        storeTransactions += round.storeTransactions;
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
        return { watermark: round.watermark, metrics: { storeTransactions, reducedItems, maxBatchItems } };
      }
    },
    catchUpAsync: async () => {
      let initialWatermark = withDatabase(projectionPath, readHead, watermark, options.onValidationProgress);
      let storeTransactions = 0,
        reducedItems = 0,
        maxBatchItems = 0,
        reportedWatermark = initialWatermark;
      for (;;) {
        const round = catchUpProjectionRound(projectionPath, options.eventStore, limit, options.onValidationProgress);
        if (round.restarted) initialWatermark = reportedWatermark = 0;
        storeTransactions += round.storeTransactions;
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
        if (round.watermark === round.sourceRevision)
          return { watermark: round.watermark, metrics: { storeTransactions, reducedItems, maxBatchItems } };
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    readStateDigest: () =>
      withDatabase(projectionPath, readHead, (db) => readStateDigest(db, readHead()?.revision ?? 0)),
    readCut: () => withDatabase(projectionPath, readHead, (db) => readProjectionCut(db, readHead)),
    read: (taskId, presentationStatus) =>
      readProjection(projectionPath, readHead, options.eventStore, taskId, limit, now, presentationStatus),
    list: (query) => listProjection(projectionPath, readHead, options.eventStore, limit, now, query),
    ...entityQueryApi(context),
    ...taskQueryApi(context),
    ...knowledgeQueryApi(context),
    ...runtimeLeaseApi(context),
  };
}

export interface TaskProjectionReaderFactoryOptions {
  readonly storage?: SqliteStorageBackendConfig;
  readonly rootDir: string;
  readonly projectionPath?: string;
  readonly now?: () => string;
}
export interface PostgresTaskProjectionReaderFactoryOptions
  extends Omit<TaskProjectionReaderFactoryOptions, "rootDir" | "storage"> {
  readonly storage: PostgresStorageBackendConfig;
  readonly rootDir?: string;
  readonly repoId: string;
}
export interface PGliteTaskProjectionReaderFactoryOptions
  extends Omit<PostgresTaskProjectionReaderFactoryOptions, "storage"> {
  readonly storage: PGliteStorageBackendConfig;
}
type SqlTaskProjectionReaderFactoryOptions = Omit<PostgresTaskProjectionReaderFactoryOptions, "storage"> & {
  readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
};
export function makeTaskProjectionReader(options: PostgresTaskProjectionReaderFactoryOptions): TaskProjectionReaderPort;
export function makeTaskProjectionReader(options: PGliteTaskProjectionReaderFactoryOptions): TaskProjectionReaderPort;

export function makeTaskProjectionReader(options: SqlTaskProjectionReaderFactoryOptions): TaskProjectionReaderPort;
export function makeTaskProjectionReader(options: TaskProjectionReaderFactoryOptions): TaskProjectionReader;
export function makeTaskProjectionReader(
  options: TaskProjectionReaderFactoryOptions | SqlTaskProjectionReaderFactoryOptions,
): TaskProjectionReader | TaskProjectionReaderPort {
  if (options.storage?.backend === "postgres" || options.storage?.backend === "pglite") {
    const repoId = "repoId" in options ? options.repoId : undefined;
    if (!repoId) throw new TypeError("PostgreSQL projection reader requires a repository id");
    return createSqlTaskQueryReader({
      storage: options.storage,
      repoId,
      requireRuntimeRole: true,
      ...(options.projectionPath === undefined ? {} : { path: options.projectionPath }),
      now: options.now,
    });
  }
  requireSqliteBackend(options);
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir ?? ""),
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
      limit: storageReadPolicy.defaultValue.pageSizes.progress,
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
      read: (taskId, presentationStatus) =>
        readProjection(projectionPath, readHead, unavailableSource, taskId, 4096, now, presentationStatus),
      readForTaskContractMigration: taskQueries.readForTaskContractMigration,
      readTaskIdsForTaskContractMigration: taskQueries.readTaskIdsForTaskContractMigration,
      list: (query) => listProjection(projectionPath, readHead, unavailableSource, 4096, now, query),
      ...entityQueryApi(context),
      readTaskIndex: taskQueries.readTaskIndex,
      readTaskChildCounts: taskQueries.readTaskChildCounts,
      readWorkspaceSummary: taskQueries.readWorkspaceSummary,
      readTaskRelations: taskQueries.readTaskRelations,
      readTaskRelationNeighborhood: taskQueries.readTaskRelationNeighborhood,
      readTaskDependencyClosure: taskQueries.readTaskDependencyClosure,
      readTaskRelationsByTargets: taskQueries.readTaskRelationsByTargets,
      readTaskRelationsBySources: taskQueries.readTaskRelationsBySources,
      readTaskStatuses: taskQueries.readTaskStatuses,
      readTaskExists: taskQueries.readTaskExists,
      readTaskEventExists: taskQueries.readTaskEventExists,
      readTaskByIdempotencyKey: taskQueries.readTaskByIdempotencyKey,
      readTaskRuntimeBatch: taskQueries.readTaskRuntimeBatch,
      readRelationQuery: taskQueries.readRelationQuery,
      readRelationCycleAudit: taskQueries.readRelationCycleAudit,
      readOperation: taskQueries.readOperation,
      readRelationEdge: taskQueries.readRelationEdge,
      readEntityVersionWitness: taskQueries.readEntityVersionWitness,
      listPinnedEntities: taskQueries.listPinnedEntities,
      readTaskOperation: taskQueries.readTaskOperation,
      readTaskSubmissionOperation: taskQueries.readTaskSubmissionOperation,
      readTaskCompletion: taskQueries.readTaskCompletion,
      readRuntimeDispatch: taskQueries.readRuntimeDispatch,
      readRuntimeDispatchById: taskQueries.readRuntimeDispatchById,
      readRuntimeDispatchByDispatchKey: taskQueries.readRuntimeDispatchByDispatchKey,
      readRuntimeDispatchByResumeSource: taskQueries.readRuntimeDispatchByResumeSource,
      readRuntimeDispatchesBySession: taskQueries.readRuntimeDispatchesBySession,
      readRuntimeDispatchEventsBySession: taskQueries.readRuntimeDispatchEventsBySession,
      readRuntimeDispatchesByTaskIds: taskQueries.readRuntimeDispatchesByTaskIds,
      readLatestRuntimeDispatchesByTaskIds: taskQueries.readLatestRuntimeDispatchesByTaskIds,
      readLatestRuntimeDispatchBySession: taskQueries.readLatestRuntimeDispatchBySession,
      readRuntimeDispatchByDispatchIdPrefix: taskQueries.readRuntimeDispatchByDispatchIdPrefix,
      countRuntimeDispatchesByAgent: taskQueries.countRuntimeDispatchesByAgent,
      readRuntimeDispatchesByTaskExecution: taskQueries.readRuntimeDispatchesByTaskExecution,
      readRuntimeDispatchesByAttemptGroup: taskQueries.readRuntimeDispatchesByAttemptGroup,
      readRuntimeDispatchesByDecision: taskQueries.readRuntimeDispatchesByDecision,
      readRuntimeDispatchPage: taskQueries.readRuntimeDispatchPage,
      readRuntimeDispatchesByMember: taskQueries.readRuntimeDispatchesByMember,
      readRuntimeSessionEvents: taskQueries.readRuntimeSessionEvents,
      readRuntimeSessionEventsByType: taskQueries.readRuntimeSessionEventsByType,
      readCanonicalEvents: taskQueries.readCanonicalEvents,
      readScheduleEvents: taskQueries.readScheduleEvents,
      readReckoningEvents: taskQueries.readReckoningEvents,
      readScheduleOutputEvents: taskQueries.readScheduleOutputEvents,
      readArtifactEntityState: taskQueries.readArtifactEntityState,
      readEventList: taskQueries.readEventList,
      readEventSummaries: taskQueries.readEventSummaries,
      readEventWitness: taskQueries.readEventWitness,
      readDocuments: taskQueries.readDocuments,
      readArtifactTimelinePage: taskQueries.readArtifactTimelinePage,
      readSettingsEvent: taskQueries.readSettingsEvent,
      readDocument: taskQueries.readDocument,
      readDocumentMetadata: taskQueries.readDocumentMetadata,
      readReplicaBasis: taskQueries.readReplicaBasis,
      taskIdForDocumentPath: taskQueries.taskIdForDocumentPath,
      readPresetSnapshot: taskQueries.readPresetSnapshot,
      readProgress: taskQueries.readProgress,
      readDispatchLifecycle: taskQueries.readDispatchLifecycle,
      readFact: knowledgeQueries.readFact,
      searchFacts: knowledgeQueries.searchFacts,
      listFactDomainTypes: knowledgeQueries.listFactDomainTypes,
      readFactAnchors: knowledgeQueries.readFactAnchors,
      readFactGraph: knowledgeQueries.readFactGraph,
      readDecision: knowledgeQueries.readDecision,
      readDecisionDocumentState: knowledgeQueries.readDecisionDocumentState,
      readDecisions: knowledgeQueries.readDecisions,
      listDecisions: knowledgeQueries.listDecisions,
      listDecisionAgendaPage: knowledgeQueries.listDecisionAgendaPage,
      readDecisionGraph: knowledgeQueries.readDecisionGraph,
      readDecisionIncomingRelations: knowledgeQueries.readDecisionIncomingRelations,
      readDecisionCoverage: knowledgeQueries.readDecisionCoverage,
      readLeaseIntervals: runtimeQueries.readLeaseIntervals,
      readLatestLeaseIntervalForExecution: runtimeQueries.readLatestLeaseIntervalForExecution,
      readLatestLeaseInterval: runtimeQueries.readLatestLeaseInterval,
      currentLease: runtimeQueries.currentLease,
      currentLeaseForExecution: runtimeQueries.currentLeaseForExecution,
      readRuntimeInstallation: runtimeQueries.readRuntimeInstallation,
      readRuntimeInstallations: runtimeQueries.readRuntimeInstallations,
      readRuntimeSession: runtimeQueries.readRuntimeSession,
      readRuntimeSessions: runtimeQueries.readRuntimeSessions,
      readRuntimeSessionsForTask: runtimeQueries.readRuntimeSessionsForTask,
      readRuntimeSessionPage: runtimeQueries.readRuntimeSessionPage,
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
    close: () => closeQueryOnlyReader(projectionPath),
  };
}
