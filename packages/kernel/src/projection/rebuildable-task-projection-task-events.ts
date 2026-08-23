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
import { readSnapshot, replayClaim, replayRelease, replayRenew } from "./rebuildable-task-projection-runtime.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

const UPSERT_TASK_SNAPSHOT_SQL = [
  "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at)",
  "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET",
  "workspace_revision=excluded.workspace_revision, snapshot_json=excluded.snapshot_json,",
  "status=excluded.status, updated_at=excluded.updated_at",
].join(" ");
const UPSERT_DOCUMENT_SQL = [
  "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");

// Lifecycle task-event reduction, document claims, and materialized task rows.
export function applyTaskEvent(
  db: DatabaseSync,
  event: TaskEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const snapshot = reduceTaskEvent(readSnapshot(db, event.taskId), event);
  runSql(
    db,
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
    event.opId,
    event.workspaceRevision,
    event.taskId,
    eventJson,
  );
  runSql(
    db,
    UPSERT_TASK_SNAPSHOT_SQL,
    event.taskId,
    event.workspaceRevision,
    canonicalJson(snapshot),
    snapshot.task?.status ?? null,
    event.occurredAt,
  );
  if (event.type === "task_created") {
    runSql(
      db,
      "INSERT OR IGNORE INTO task_package(task_id, package_path) VALUES (?, ?)",
      event.taskId,
      `tasks/${event.taskId}-${slugifyTaskTitle(event.payload.task.title)}`,
    );
    runSql(db, "INSERT OR IGNORE INTO task_generation VALUES (?, 'v1')", event.taskId);
  }
  const packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id = ?", event.taskId)[0]
    ?.package_path;
  refreshTaskRelationProjection(
    db,
    event.taskId,
    snapshot.task,
    event.workspaceRevision,
    event.occurredAt,
    packagePath === undefined ? null : String(packagePath),
  );
  // Replay used to re-render each lifecycle document and require today's renderer to reproduce
  // the bytes committed when the event was written. That is not a data invariant; it is a claim
  // that the renderer has never changed. `renderIndex` did change (#1472, #1533, #1562), and the
  // assertion sat dormant until #1599 bumped the projection schema and forced a cold rebuild --
  // at which point replay threw on a document from three days earlier and latched every workspace
  // command in the repository, including the rebuild command that exists to repair it.
  //
  // The blob is already content-addressed by the claim's own sha256 and checked for availability
  // and size below, so nothing verifiable is lost. What is lost is a delayed brick on every future
  // renderer change.
  const lifecycleClaims = event.payload.documentClaims ?? [];
  if (lifecycleClaims.length) {
    if (
      !packagePath ||
      canonicalJson(lifecycleClaims.map((claim) => claim.path)) !==
        canonicalJson(lifecycleDocumentPaths(event, String(packagePath)))
    )
      throw new Error(`lifecycle document paths mismatch for ${event.taskId}`);
    for (const claim of lifecycleClaims) {
      const bytes = readBlob(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size)
        throw new Error(`lifecycle document blob ${claim.sha256} is unavailable`);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const document: DocumentState = {
        path: claim.path as DocumentState["path"],
        blobSha256: claim.sha256,
        body,
        size: docByteLength(claim.size),
        mediaType: claim.mediaType,
        policyId: claim.policyId,
        workspaceRevision: event.workspaceRevision,
      };
      runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    }
  }
  // Class-A task commands carry replaceable prose on the same canonical event
  // as the lifecycle transition. Replaying this event after a process crash
  // therefore restores both the task snapshot and its carried documents.
  for (const change of event.payload.carriedDocumentClaims ?? []) {
    const previous = queryRows(db, "SELECT value_json FROM document WHERE path = ?", change.path)[0],
      base = previous ? (JSON.parse(String(previous.value_json)) as DocumentState) : null,
      bytes = readBlob(change.candidate.sha256);
    if (!bytes || bytes.byteLength !== change.candidate.size)
      throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`carried document blob ${change.candidate.sha256} is not UTF-8`);
    }
    if (change.baseBlobSha256 !== (base?.blobSha256 ?? null) || !verifyDocEventChange(change, base?.body ?? "", body))
      throw new Error(`carried document proof mismatch for ${change.path}`);
    const document: DocumentState = {
      path: change.path as DocumentState["path"],
      blobSha256: change.candidate.sha256,
      body,
      size: docByteLength(change.candidate.size),
      mediaType: change.candidate.mediaType,
      policyId: change.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(db, UPSERT_DOCUMENT_SQL, change.path, event.workspaceRevision, canonicalJson(document));
    refreshDecisionDocumentSearch(db, document);
  }
  if ("execution" in event.payload)
    runSql(
      db,
      "INSERT OR REPLACE INTO execution(execution_id, task_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)",
      event.payload.execution.executionId,
      event.taskId,
      event.workspaceRevision,
      canonicalJson(event.payload.execution),
    );
  if (event.type === "review_recorded")
    runSql(
      db,
      "INSERT INTO review(review_id, task_id, execution_id, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)",
      event.payload.review.reviewId,
      event.taskId,
      event.payload.review.executionId,
      event.workspaceRevision,
      canonicalJson(event.payload.review),
    );
  const edge =
    event.type === "execution_submitted"
      ? event.payload.edge
      : event.type === "review_recorded"
        ? event.payload.edge
        : undefined;
  if (edge !== undefined)
    runSql(
      db,
      "INSERT INTO edge(task_id, edge_id, iteration, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)",
      event.taskId,
      edge.edgeId,
      edge.iteration,
      event.workspaceRevision,
      canonicalJson(edge),
    );
  if (event.type === "execution_started") replayClaim(db, event);
  if (event.type === "lease_renewed") replayRenew(db, event);
  if (event.type === "execution_submitted" || event.type === "lease_released")
    replayRelease(db, event.taskId, event.payload.execution.executionId, event.workspaceRevision);
}
