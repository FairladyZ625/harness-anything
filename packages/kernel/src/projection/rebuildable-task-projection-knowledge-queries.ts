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
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { catchUpRound } from "./rebuildable-task-projection-catch-up.ts";
import { watermark } from "./rebuildable-task-projection-sql.ts";

// Fact and decision admission plus read query API.
export function knowledgeQueryApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "admitFact"
  | "readFact"
  | "searchFacts"
  | "readFactAnchors"
  | "readFactGraph"
  | "admitDecision"
  | "readDecision"
  | "readDecisions"
  | "listDecisions"
  | "listDecisionAgendaPage"
  | "readDecisionGraph"
> {
  const { eventStore, limit, projectionPath, readHead } = context;
  return {
    admitFact: (event) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit);
        if (round.watermark !== round.sourceRevision)
          throw new FactProjectionError(
            "content_not_ready",
            `Fact admission requires projection revision ${round.sourceRevision}; current watermark is ${round.watermark}.`,
          );
        assertFactAdmission(db, event);
      }),
    readFact: (taskId, factId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          fact: readFactRow(db, taskId, factId),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    searchFacts: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = searchFactRowsPage(db, filters);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          facts: page.rows,
          watermark: current,
          sourceRevision: round.sourceRevision,
          ...(page.page ? { page: page.page } : {}),
        };
      }),
    readFactAnchors: (refs) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readFactAnchorRows(db, refs),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readFactGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          ...readFactGraphRows(db),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    admitDecision: (event) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit);
        if (round.watermark !== round.sourceRevision)
          throw new FactProjectionError(
            "content_not_ready",
            `Decision admission requires projection revision ${round.sourceRevision}; current watermark is ${round.watermark}.`,
          );
        assertDecisionAdmission(db, event);
      }),
    readDecision: (decisionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decision: readDecisionRow(db, decisionId),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readDecisions: (decisionIds) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: readDecisionRows(db, decisionIds),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    listDecisions: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: listDecisionRows(db, filters),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    listDecisionAgendaPage: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = listDecisionAgendaRowsPage(db, query);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: page.rows,
          page: page.page,
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readDecisionGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          ...readDecisionGraphRows(db),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
  };
}
