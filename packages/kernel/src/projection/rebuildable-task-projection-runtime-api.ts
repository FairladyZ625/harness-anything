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
import {
  changeLease,
  effectiveLease,
  readIntervals,
  readRuntimeInstallation,
  readRuntimeInstallations,
  readRuntimeSession,
  readRuntimeSessions,
  reserve,
} from "./rebuildable-task-projection-runtime.ts";
import { queryRows, refreshStateDigestAtSourceCut, transaction } from "./rebuildable-task-projection-sql.ts";

// Runtime-state and lease-control API.
export function runtimeLeaseApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "readRuntimeInstallation"
  | "readRuntimeInstallations"
  | "readRuntimeSession"
  | "readRuntimeSessions"
  | "readRuntimeSessionsForTask"
  | "readLeaseIntervals"
  | "currentLease"
  | "currentLeaseForExecution"
  | "reserveLease"
  | "activateLease"
  | "renewLease"
  | "releaseLease"
> {
  const { eventStore, now, projectionPath, readHead } = context;
  return {
    readRuntimeInstallation: (installationId) =>
      withDatabase(projectionPath, readHead, (db) => readRuntimeInstallation(db, installationId)),
    readRuntimeInstallations: () => withDatabase(projectionPath, readHead, readRuntimeInstallations),
    readRuntimeSession: (runtimeSessionIdValue) =>
      withDatabase(projectionPath, readHead, (db) => readRuntimeSession(db, runtimeSessionIdValue)),
    readRuntimeSessions: () => withDatabase(projectionPath, readHead, readRuntimeSessions),
    readRuntimeSessionsForTask: (taskId) =>
      withDatabase(projectionPath, readHead, (db) =>
        readRuntimeSessions(db).filter((session) => session.taskBindings.some((binding) => binding.taskId === taskId)),
      ),
    readLeaseIntervals: (taskId) => withDatabase(projectionPath, readHead, (db) => readIntervals(db, taskId)),
    currentLease: (taskId, at) =>
      withDatabase(projectionPath, readHead, (db) => effectiveLease(db, taskId, at ?? now())),
    currentLeaseForExecution: (executionId, at) =>
      withDatabase(projectionPath, readHead, (db) => {
        const row = db
          .prepare("SELECT task_id FROM lease_cas WHERE json_extract(lease_json, '$.executionId') = ?")
          .get(executionId) as { readonly task_id: string } | undefined;
        return row ? effectiveLease(db, row.task_id, at ?? now()) : null;
      }),
    reserveLease: (lease, now) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const reserved = reserve(db, lease, now);
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return reserved;
        }),
      ),
    activateLease: (lease) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const active = changeLease(db, lease, "held", lease.expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return active;
        }),
      ),
    renewLease: (lease, expiresAt) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const renewed = changeLease(db, lease, "held", expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return renewed;
        }),
      ),
    releaseLease: (lease) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const released = changeLease(db, lease, "released", lease.expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return released;
        }),
      ),
  };
}
