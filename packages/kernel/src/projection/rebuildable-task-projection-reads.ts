// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  type LeaseChangeReason,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../domain/task-lifecycle.contract.ts";
import {
  assertDocSyncWritePlan,
  docByteLength,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  verifyDocEventChange,
  type CanonicalEventV1,
  type DocumentState,
} from "../domain/doc-sync.contract.ts";
import type { FrozenWritePlan } from "../domain/write-chain.contract.ts";
import {
  assertMigrationImportWritePlan,
  type MigrationDocumentClaim,
  type MigrationImportEventV1,
} from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
} from "../domain/ledger-layout-migration-event.ts";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseHolder, type LeaseV1 } from "../domain/execution.ts";
import { canonicalizeContractValue, currentTaskForWrite } from "../domain/task.ts";
import { localEventFileSystem, localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import {
  isAgentRuntimeEvent,
  markRuntimeSessionUnknown,
  reduceRuntimeInstallation,
  reduceRuntimeSession,
  runtimeSessionId,
  type AgentRuntimeEventV1,
  type RuntimeInstallation,
  type RuntimeSession,
} from "../domain/agent-runtime.ts";
import { assertAgentEntityWritePlan, isAgentEntityEvent } from "../domain/agent-entity-event.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapPackagePath,
} from "../domain/task-bootstrap-event.ts";
import {
  assertTaskProgressWritePlan,
  isTaskProgressEvent,
  type TaskProgressEventV1,
} from "../domain/task-progress-event.ts";
import {
  isTaskBoundRuntimeWriter,
  resolveLiveTaskBoundRuntimeBinding,
} from "../domain/task-bound-runtime-authority.ts";
import {
  assertPresetSnapshotUpgradeWritePlan,
  isPresetSnapshotUpgradeEvent,
} from "../domain/preset-snapshot-upgrade-event.ts";
import { assertDecisionWritePlan, type DecisionEventV1 } from "../domain/decision-event.ts";
import { assertFactWritePlan, type FactEventV1 } from "../domain/fact-event.ts";
import { assertTaskLifecycleWritePlan, lifecycleDocumentPaths } from "../domain/task-lifecycle-publication.ts";
import { slugifyTaskTitle } from "../layout/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import {
  assertDecisionAdmission,
  createDecisionProjectionTables,
  listDecisionAgendaRowsPage,
  listDecisionRows,
  readDecisionDocumentState,
  readDecisionGraphRows,
  readDecisionRow,
  readDecisionRows,
  reduceDecisionEvent,
  refreshDecisionDocumentSearch,
} from "./decision-event-projection.ts";
import {
  assertFactAdmission,
  createFactProjectionTables,
  FactProjectionError,
  readFactAnchorRows,
  readFactGraphRows,
  readFactRow,
  reduceFactEvent,
  searchFactRowsPage,
} from "./fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "./relation-graph-projection.ts";
import { taskProjectionSchemaVersion } from "./projection-schema.ts";
import {
  createTaskRelationProjectionTable,
  listTaskRowsNarrow,
  readTaskDependencyClosureRows,
  readTaskRelationPage,
  readTaskRelationRows,
  readTaskRelationsByTargets,
  readTaskRuntimeBatchPage,
  readTaskStatusRows,
  refreshTaskRelationProjection,
  taskCreatedAtSql,
  type TaskProjectionListQuery,
} from "./task-query-projection.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
import type { TaskProjection } from "./task-projection-port.ts";
export type { TaskProjection } from "./task-projection-port.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import type {
  DocumentProjectionRead,
  PresetSnapshotProjectionRead,
  ProjectionRebuildReceipt,
  TaskProjectionListRead,
  TaskProjectionRead,
} from "./projection-reads.ts";
import { discardDatabase, withDatabase } from "./rebuildable-task-projection-database.ts";
import { catchUpRound } from "./rebuildable-task-projection-catch-up.ts";
import { markRuntimeSessionsUnknown, readSnapshot } from "./rebuildable-task-projection-runtime.ts";
import {
  parseEventJson,
  refreshStateDigestAtSourceCut,
  transaction,
  watermark,
} from "./rebuildable-task-projection-sql.ts";

// Cache-backed task, document, preset, and rebuild reads.
export function listProjection(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  eventStore: EventStreamPort,
  limit: number,
  now: () => string,
  query: TaskProjectionListQuery = {},
): TaskProjectionListRead {
  const existed = localRuntimeStateFileSystem.exists(projectionPath);
  return withDatabase(projectionPath, readHead, (db) => {
    const round = catchUpRound(db, eventStore, limit),
      current = watermark(db),
      at = now();
    // The unparameterized read keeps its original single statement so its result
    // stays byte-identical; only explicit query parameters take the indexed path.
    if (
      query.status === undefined &&
      query.changedAfterRevision === undefined &&
      query.updatedAfter === undefined &&
      query.updatedBefore === undefined &&
      query.limit === undefined &&
      query.cursor === undefined &&
      query.pinnedFirst !== true
    ) {
      const rows = db
        .prepare(
          `SELECT task_snapshot.task_id AS task_id, task_package.package_path AS package_path, COALESCE(task_generation.generation, 'v1') AS generation, task_snapshot.workspace_revision AS workspace_revision, ${taskCreatedAtSql("task_snapshot.task_id")} AS created_at, event_index.event_json AS event_json FROM task_snapshot LEFT JOIN task_package USING(task_id) LEFT JOIN task_generation USING(task_id) JOIN event_index ON event_index.workspace_revision = task_snapshot.workspace_revision ORDER BY task_snapshot.task_id`,
        )
        .all() as unknown as readonly {
        readonly task_id: string;
        readonly package_path: string | null;
        readonly generation: "v0" | "v1";
        readonly workspace_revision: number;
        readonly created_at: string | null;
        readonly event_json: string;
      }[];
      return {
        status: current === round.sourceRevision ? "ready" : "pending",
        rows: rows.map((row) => ({
          taskId: row.task_id,
          packagePath: row.package_path,
          generation: row.generation,
          workspaceRevision: row.workspace_revision,
          createdAt: row.created_at,
          updatedAt: parseEventJson(row.event_json).occurredAt,
          snapshot: readSnapshot(db, row.task_id, at),
        })),
        watermark: current,
        sourceRevision: round.sourceRevision,
        warnings: !existed && round.sourceRevision > 0 ? ["projection_missing"] : [],
      };
    }
    const page = listTaskRowsNarrow(db, query);
    return {
      status: current === round.sourceRevision ? "ready" : "pending",
      rows: page.rows.map((row) => ({
        taskId: row.task_id,
        packagePath: row.package_path,
        generation: row.generation,
        workspaceRevision: row.workspace_revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        snapshot: readSnapshot(db, row.task_id, at),
      })),
      watermark: current,
      sourceRevision: round.sourceRevision,
      warnings: !existed && round.sourceRevision > 0 ? ["projection_missing"] : [],
      ...(page.page ? { page: page.page } : {}),
    };
  });
}

export function readDocument(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  eventStore: EventStreamPort,
  documentPath: string,
  limit: number,
): DocumentProjectionRead {
  return withDatabase(projectionPath, readHead, (db) => {
    const round = catchUpRound(db, eventStore, limit),
      current = watermark(db),
      row = db.prepare("SELECT value_json FROM document WHERE path = ?").get(documentPath) as
        | { readonly value_json: string }
        | undefined;
    return {
      status: current === round.sourceRevision ? "ready" : "pending",
      document: row ? (JSON.parse(row.value_json) as DocumentState) : null,
      watermark: current,
      sourceRevision: round.sourceRevision,
    };
  });
}
export function readPresetSnapshot(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  eventStore: EventStreamPort,
  digest: string,
  limit: number,
): PresetSnapshotProjectionRead {
  return withDatabase(projectionPath, readHead, (db) => {
    const round = catchUpRound(db, eventStore, limit),
      current = watermark(db),
      row = db.prepare("SELECT value_json FROM preset_snapshot WHERE digest = ?").get(digest) as
        | { readonly value_json: string }
        | undefined;
    return {
      status: current === round.sourceRevision ? "ready" : "pending",
      snapshot: row ? JSON.parse(row.value_json) : null,
      watermark: current,
      sourceRevision: round.sourceRevision,
    };
  });
}

export function readProjection(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  eventStore: EventStreamPort,
  taskId: string,
  limit: number,
  now: () => string,
): TaskProjectionRead {
  const existed = localRuntimeStateFileSystem.exists(projectionPath);
  return withDatabase(projectionPath, readHead, (db) => {
    const round = catchUpRound(db, eventStore, limit);
    const current = watermark(db);
    return {
      status: current === round.sourceRevision ? "ready" : "pending",
      snapshot: readSnapshot(db, taskId, now()),
      packagePath:
        (
          db.prepare("SELECT package_path FROM task_package WHERE task_id = ?").get(taskId) as
            | { readonly package_path: string }
            | undefined
        )?.package_path ?? null,
      watermark: current,
      sourceRevision: round.sourceRevision,
      warnings: !existed && round.sourceRevision > 0 ? ["projection_missing"] : [],
      catchUp: {
        maxItems: limit,
        reducedItems: round.reducedItems,
        sqliteTransactions: round.sqliteTransactions,
      },
    };
  });
}

export function rebuildProjection(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  eventStore: EventStreamPort,
  limit: number,
): ProjectionRebuildReceipt {
  discardDatabase(projectionPath, readHead);
  let transactions = 0,
    reducedItems = 0,
    maxBatchItems = 0;
  for (;;) {
    const round = withDatabase(projectionPath, readHead, (db) => catchUpRound(db, eventStore, limit));
    transactions += round.sqliteTransactions;
    reducedItems += round.reducedItems;
    maxBatchItems = Math.max(maxBatchItems, round.accessedItems);
    if (round.watermark === round.sourceRevision) break;
  }
  const result = withDatabase(projectionPath, readHead, (db) =>
    transaction(db, () => {
      markRuntimeSessionsUnknown(db);
      const current = watermark(db),
        digest = refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
      if (digest === null) throw new Error("projection rebuild did not reach a source-complete state digest");
      return { current, digest };
    }),
  );
  transactions += 1;
  return {
    watermark: result.current,
    stateDigest: result.digest,
    metrics: { sqliteTransactions: transactions, reducedItems, maxBatchItems },
  };
}
