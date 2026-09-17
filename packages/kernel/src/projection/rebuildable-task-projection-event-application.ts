// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot, reduceTaskEvent, type TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { OPAQUE_TEXTUAL_POLICY_ID, RAW_ARTIFACT_POLICY_ID } from "../domain/artifact-text-classification.ts";
import {
  docByteLength,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isRelationEvent,
  normalizePersistedCanonicalEvent,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
  type DocumentState,
} from "../domain/doc-sync.contract.ts";
import { isEntityDocumentEvent } from "../domain/entity-document-event.ts";
import { isLedgerLayoutMigrationEvent } from "../domain/ledger-layout-migration-event.ts";
import { currentTaskForWrite } from "../domain/task.ts";
import {
  isAgentRuntimeEvent,
  reduceRuntimeInstallation,
  reduceRuntimeSession,
  runtimeExecutionLinkForEvent,
  runtimeSessionId,
} from "../domain/agent-runtime.ts";
import { contractForDeclarationEvent, isEntityDeclarationEvent, isEntityEvent } from "../domain/entity-event.ts";
import { interpretEntityValue } from "../domain/entity-kind-projection.ts";
import { isTaskBootstrapEvent, taskBootstrapPackagePath } from "../domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { isPresetSnapshotUpgradeEvent } from "../domain/preset-snapshot-upgrade-event.ts";
import { isScheduleEvent } from "../domain/schedule-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { isVerticalDeclarationEvent } from "../domain/vertical-declaration.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import { isCiRunObservationEvent } from "../domain/ci-run-observation-event.ts";
import { parsePeopleRosterDocument } from "../domain/people-roster.ts";
import { scheduleDefinition, validateScheduleDefinitionV1 } from "../domain/schedule.ts";
import { lifecycleDocumentPaths } from "../domain/task-lifecycle-publication.ts";
import { slugifyTaskTitle } from "../layout/index.ts";
import { refreshDecisionDocumentSearch } from "./decision-event-projection.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import type { EventContentPrefetch, EventStreamPort } from "./rebuildable-task-projection-types.ts";
import type { ProjectionApplyReceipt } from "./projection-reads.ts";
import {
  projectDecision,
  projectEntityDocumentRematerialization,
  projectFact,
  projectMigration,
  projectProgress,
  projectRelationDocuments,
} from "./rebuildable-task-projection-write-model.ts";
import {
  deleteEntityProjectionRow,
  markEntityProjectionMissing,
  projectEmbeddedCanonicalEntities,
  projectInterpretedEntityValue,
  projectRuntimeSessionCanonicalEntity,
} from "./rebuildable-task-projection-entities.ts";
import {
  readRuntimeInstallation,
  readRuntimeSession,
  readSnapshot,
  refreshRuntimeSessionAssociations,
  replayClaim,
  replayRelease,
  replayRenew,
} from "./rebuildable-task-projection-runtime.ts";
import {
  canonicalJson,
  prepareQuery,
  queryRows,
  runSql,
  transaction,
  watermark,
} from "./rebuildable-task-projection-sql.ts";
import { applyEmbeddedRelationProjectionEvents, applyRelationProjectionEvent } from "./relation-entity-projection.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const DOCUMENT_BASE_SQL = [
  "SELECT json_extract(value_json, '$.blobSha256') AS blobSha256,",
  "json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS mediaType,",
  "json_extract(value_json, '$.policyId') AS policyId FROM document WHERE path = ?",
].join(" ");
const UPSERT_DOCUMENT_SQL = [
  "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");
const UPSERT_RUNTIME_INSTALLATION_SQL = [
  "INSERT INTO runtime_installation(installation_id, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(installation_id) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");
const UPSERT_RUNTIME_SESSION_SQL = [
  "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(runtime_session_id) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");
const UPSERT_TASK_SNAPSHOT_SQL = [
  "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at)",
  "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET",
  "workspace_revision=excluded.workspace_revision, snapshot_json=excluded.snapshot_json,",
  "status=excluded.status, updated_at=excluded.updated_at",
].join(" ");
const INSERT_TASK_SNAPSHOT_SQL = [
  "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at)",
  "VALUES (?, ?, ?, ?, ?)",
].join(" ");
const UPSERT_PRESET_SNAPSHOT_SQL = [
  "INSERT INTO preset_snapshot(digest, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(digest) DO UPDATE SET value_json=excluded.value_json",
  "WHERE preset_snapshot.value_json=excluded.value_json",
].join(" ");

// Canonical-event dispatcher for non-task domains and task-event handoff.
export function applyEvent(
  db: DatabaseSync,
  event: CanonicalEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  if (isCiRunObservationEvent(event)) {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    return;
  }
  if (event.schema === "ci-run-observation/v2") {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    return;
  }
  if (isLedgerLayoutMigrationEvent(event)) {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    return;
  }
  if (isMigrationImportEvent(event)) {
    projectMigration(db, event, eventJson, readBlob);
    return;
  }
  if (isEntityDocumentEvent(event)) {
    projectEntityDocumentRematerialization(db, event, eventJson, readBlob);
    return;
  }
  if (isRelationEvent(event)) {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    applyRelationProjectionEvent(db, event);
    projectRelationDocuments(db, event, readBlob);
    return;
  }
  if (isEntityEvent(event)) {
    if (!isEntityDeclarationEvent(event)) {
      runSql(
        db,
        "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
        event.opId,
        event.workspaceRevision,
        eventJson,
      );
      if (event.type === "entity_deleted") {
        for (const retirement of event.payload.ownedContent.retirements)
          runSql(db, "DELETE FROM document WHERE path = ?", retirement.path);
        deleteEntityProjectionRow(db, event.payload.entityKind, event.payload.entityId);
      } else markEntityProjectionMissing(db, event.payload.entityKind, event.payload.entityId, event.workspaceRevision);
      return;
    }
    const claim = event.payload.declarationDocumentClaim,
      bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`entity declaration blob ${claim.sha256} is unavailable`);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`entity declaration blob ${claim.sha256} is not UTF-8`);
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new Error(`entity declaration blob ${claim.sha256} is not JSON`);
    }
    const contract = contractForDeclarationEvent(event),
      entity = interpretEntityValue(contract, value),
      contractErrors = contract.entityStore.validate?.(entity.value) ?? [];
    if (contractErrors.length) throw new Error(contractErrors.join("; "));
    if (entity.id !== event.payload.entityId)
      throw new Error(`entity declaration blob ${claim.sha256} identity mismatch`);
    const document: DocumentState = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      body,
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    projectInterpretedEntityValue(
      db,
      contract,
      entity,
      event.workspaceRevision,
      `event:${event.opId}`,
      "current",
      event.type === "entity_content_observed" || event.type === "entity_updated"
        ? event.payload.observedContentVersion
        : event.workspaceRevision,
    );
    return;
  }
  if (isScheduleEvent(event)) {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    if ("declarationDocumentClaim" in event.payload) {
      const claim = event.payload.declarationDocumentClaim,
        bytes = readBlob(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size)
        throw new Error(`schedule definition blob ${claim.sha256} is unavailable`);
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`schedule definition blob ${claim.sha256} is not UTF-8`);
      }
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw new Error(`schedule definition blob ${claim.sha256} is not JSON`);
      }
      if (
        validateScheduleDefinitionV1(value).length > 0 ||
        canonicalJson(value) !== canonicalJson(scheduleDefinition(event.payload.schedule))
      )
        throw new Error(`schedule definition blob ${claim.sha256} does not match the event definition facet`);
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
    if ("declarationDocumentRetirement" in event.payload) {
      runSql(db, "DELETE FROM document WHERE path = ?", event.payload.declarationDocumentRetirement.path);
      deleteEntityProjectionRow(db, "schedule", event.entity.id);
      return;
    }
    projectEmbeddedCanonicalEntities(db, event);
    return;
  }
  if (isSettingsEvent(event)) {
    const claim = event.payload.harnessDocumentClaim,
      bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`settings harness.yaml blob ${claim.sha256} is unavailable`);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`settings harness.yaml blob ${claim.sha256} is not UTF-8`);
    }
    const document: DocumentState = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      body,
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    projectEmbeddedCanonicalEntities(db, event);
    return;
  }
  if (isVerticalDeclarationEvent(event)) {
    const claim = event.payload.declarationDocumentClaim,
      bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`vertical declaration blob ${claim.sha256} is unavailable`);
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
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    return;
  }
  if (isPeopleEvent(event)) {
    const claim = event.payload.peopleDocumentClaim,
      bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size) throw new Error(`people.yaml blob ${claim.sha256} is unavailable`);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`people.yaml blob ${claim.sha256} is not UTF-8`);
    }
    if (canonicalJson(parsePeopleRosterDocument(body)) !== canonicalJson(event.payload.roster))
      throw new Error(`people.yaml blob ${claim.sha256} does not match the event roster snapshot`);
    const document: DocumentState = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      body,
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    return;
  }
  if (isFactEvent(event)) {
    projectFact(db, event, eventJson, readBlob);
    return;
  }
  if (isDecisionEvent(event)) {
    projectDecision(db, event, eventJson, readBlob);
    return;
  }
  if (isAgentRuntimeEvent(event)) {
    const taskId = runtimeExecutionLinkForEvent(event)?.taskId ?? null;
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
      event.opId,
      event.workspaceRevision,
      taskId,
      eventJson,
    );
    const installation = reduceRuntimeInstallation(
      event.type === "runtime_installation_observed" ? readRuntimeInstallation(db, event.payload.installationId) : null,
      event,
    );
    if (installation !== null)
      runSql(
        db,
        UPSERT_RUNTIME_INSTALLATION_SQL,
        installation.installationId,
        event.workspaceRevision,
        canonicalJson(installation),
      );
    const sessionId = runtimeSessionId(event);
    if (sessionId !== null) {
      const session = reduceRuntimeSession(readRuntimeSession(db, sessionId), event);
      if (session !== null) {
        runSql(
          db,
          UPSERT_RUNTIME_SESSION_SQL,
          session.runtimeSessionId,
          event.workspaceRevision,
          canonicalJson(session),
        );
        refreshRuntimeSessionAssociations(db, session);
        projectRuntimeSessionCanonicalEntity(db, session, event.workspaceRevision, `event:${event.opId}`);
      }
    }
    applyEmbeddedRelationProjectionEvents(db, event);
    return;
  }
  if (isDocEvent(event)) {
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
      event.opId,
      event.workspaceRevision,
      eventJson,
    );
    for (const change of event.payload.changes) {
      const base = prepareQuery(db, DOCUMENT_BASE_SQL, (sql) =>
        /* @gate-identity check-bypass-write-boundary/bypass-write-011 */ db.prepare(sql),
      ).get(change.path) as Pick<DocumentState, "blobSha256" | "size" | "mediaType" | "policyId"> | undefined;
      if (change.candidate === null) {
        if (
          event.payload.retirementReason === undefined ||
          (base !== undefined && change.baseBlobSha256 !== base.blobSha256)
        )
          throw new Error(`document retirement mismatch for ${change.path}`);
        runSql(db, "DELETE FROM document WHERE path = ?", change.path);
        continue;
      }
      if (change.baseBlobSha256 !== (base?.blobSha256 ?? null)) {
        if (
          base !== undefined &&
          change.candidate.sha256 === base.blobSha256 &&
          change.candidate.size === base.size &&
          change.candidate.mediaType === base.mediaType &&
          change.policyId === base.policyId
        )
          continue;
        throw new Error(`document base mismatch for ${change.path}`);
      }
      const bytes = readBlob(change.candidate.sha256);
      if (!bytes || bytes.byteLength !== change.candidate.size)
        throw new Error(`document blob ${change.candidate.sha256} is unavailable`);
      // A raw artifact has no text body to project. Its identity is the claim digest, which is checked
      // above against the stored bytes, so reading it back means reading the content object, not this row.
      let body = "";
      if (change.policyId !== RAW_ARTIFACT_POLICY_ID)
        try {
          body = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: change.policyId === OPAQUE_TEXTUAL_POLICY_ID,
          }).decode(bytes);
        } catch {
          throw new Error(`document blob ${change.candidate.sha256} is not UTF-8`);
        }
      const document: DocumentState = {
        path: change.path,
        blobSha256: change.candidate.sha256,
        body,
        size: change.candidate.size,
        mediaType: change.candidate.mediaType,
        policyId: change.policyId,
        workspaceRevision: event.workspaceRevision,
      };
      runSql(db, UPSERT_DOCUMENT_SQL, change.path, event.workspaceRevision, canonicalJson(document));
      refreshDecisionDocumentSearch(db, document);
    }
    return;
  }
  if (isTaskProgressEvent(event)) {
    projectProgress(db, event, eventJson, readBlob);
    return;
  }
  if (isPresetSnapshotUpgradeEvent(event)) {
    const current = readSnapshot(db, event.taskId),
      snapshotBytes = readBlob(event.payload.presetSnapshotClaim.sha256),
      contractBytes = readBlob(event.payload.taskContractClaim.sha256);
    if (
      !current.task ||
      current.task.presetSnapshotDigest !== event.payload.previousDigest ||
      !snapshotBytes ||
      snapshotBytes.byteLength !== event.payload.presetSnapshotClaim.size ||
      !contractBytes ||
      contractBytes.byteLength !== event.payload.taskContractClaim.size
    )
      throw new Error(`preset snapshot upgrade basis mismatch for ${event.taskId}`);
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes)),
      changedPreset = current.task.metadata?.presetId !== snapshot.identity.id,
      changed = {
        completionGateIds: snapshot.profile.completionGateIds,
        presetSnapshotDigest: snapshot.digest,
        ...(changedPreset && current.task.metadata
          ? {
              metadata: {
                ...currentTaskForWrite(current.task).metadata,
                presetId: snapshot.identity.id,
                profileId: snapshot.profile.id,
              },
              iteration: current.task.iteration + 1,
            }
          : {}),
      },
      currentShape = { ...currentTaskForWrite(current.task), ...changed };
    if (canonicalJson(currentShape) !== canonicalJson(currentTaskForWrite(event.payload.task)))
      throw new Error(`preset snapshot upgrade changed immutable task fields for ${event.taskId}`);
    const contractBody = new TextDecoder("utf-8", { fatal: true }).decode(contractBytes),
      contract = event.payload.taskContractClaim,
      document: DocumentState = {
        path: contract.path as DocumentState["path"],
        blobSha256: contract.sha256,
        body: contractBody,
        size: contract.size as DocumentState["size"],
        mediaType: contract.mediaType,
        policyId: contract.policyId,
        workspaceRevision: event.workspaceRevision,
      };
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
      canonicalJson({
        ...current,
        revision: event.workspaceRevision,
        task: currentTaskForWrite(event.payload.task),
      }),
      event.payload.task.status,
      event.occurredAt,
    );
    refreshTaskRelationProjection(db, event.taskId, event.payload.task, event.workspaceRevision, event.occurredAt);
    runSql(
      db,
      UPSERT_PRESET_SNAPSHOT_SQL,
      event.payload.presetSnapshotClaim.digest,
      event.workspaceRevision,
      canonicalJson(snapshot),
    );
    runSql(db, UPSERT_DOCUMENT_SQL, contract.path, event.workspaceRevision, canonicalJson(document));
    return;
  }
  if (isTaskBootstrapEvent(event)) {
    const snapshotBytes = readBlob(event.payload.presetSnapshotClaim.sha256);
    if (!snapshotBytes || snapshotBytes.byteLength !== event.payload.presetSnapshotClaim.size)
      throw new Error(`preset snapshot blob ${event.payload.presetSnapshotClaim.sha256} is unavailable`);
    const snapshotBody = new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes),
      snapshot = JSON.parse(snapshotBody);
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
      INSERT_TASK_SNAPSHOT_SQL,
      event.taskId,
      event.workspaceRevision,
      canonicalJson({
        ...emptyTaskLifecycleSnapshot(event.workspaceRevision),
        task: currentTaskForWrite(event.payload.task),
      }),
      event.payload.task.status,
      event.occurredAt,
    );
    const bootstrapPackagePath = taskBootstrapPackagePath(event);
    runSql(db, "INSERT INTO task_package(task_id, package_path) VALUES (?, ?)", event.taskId, bootstrapPackagePath);
    refreshTaskRelationProjection(
      db,
      event.taskId,
      event.payload.task,
      event.workspaceRevision,
      event.occurredAt,
      bootstrapPackagePath,
    );
    runSql(db, "INSERT OR IGNORE INTO task_generation VALUES (?, 'v1')", event.taskId);
    if (
      Number(
        runSql(
          db,
          UPSERT_PRESET_SNAPSHOT_SQL,
          event.payload.presetSnapshotClaim.digest,
          event.workspaceRevision,
          canonicalJson(snapshot),
        ),
      ) === 0
    )
      throw new Error(`preset snapshot digest ${event.payload.presetSnapshotClaim.digest} names different bytes`);
    for (const claim of event.payload.initialDocumentClaims) {
      const bytes = readBlob(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size) throw new Error(`document blob ${claim.sha256} is unavailable`);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        document: DocumentState = {
          path: claim.path as DocumentState["path"],
          blobSha256: claim.sha256,
          body,
          size: claim.size as DocumentState["size"],
          mediaType: claim.mediaType,
          policyId: claim.policyId,
          workspaceRevision: event.workspaceRevision,
        };
      runSql(
        db,
        "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
        claim.path,
        event.workspaceRevision,
        canonicalJson(document),
      );
    }
    return;
  }
  applyTaskEvent(db, event, eventJson, readBlob);
}

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
    canonicalJson({
      ...snapshot,
      task: snapshot.task === null ? null : currentTaskForWrite(snapshot.task),
      executions: [],
      reviews: [],
    }),
    snapshot.task?.status ?? null,
    event.occurredAt,
  );
  applyEmbeddedRelationProjectionEvents(db, event);
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
    if (change.baseBlobSha256 !== (base?.blobSha256 ?? null))
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
  projectEmbeddedCanonicalEntities(db, event);
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
  if (
    (event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined) ||
    event.type === "lease_released"
  )
    replayRelease(db, event.taskId, event.payload.execution.executionId, event.workspaceRevision);
}

// Incremental source scanning, deferred-event staging, and batch replay.
const batchContentPrefetchers = new WeakMap<EventStreamPort, EventContentPrefetch>();
const SCAN_STATE_SQL = "SELECT scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1",
  NEXT_DEFERRED_EVENT_SQL = [
    "SELECT event_json FROM event_source WHERE workspace_revision = ?",
    "OR (? = 1 AND workspace_revision > ?) ORDER BY workspace_revision LIMIT 1",
  ].join(" ");
export function reduceBatch(
  db: DatabaseSync,
  events: readonly CanonicalEventV1[],
  limit: number,
  readBlob: EventStreamPort["readContentBlob"],
  head: ReturnType<EventStreamPort["readHead"]>,
): ProjectionApplyReceipt {
  return transaction(db, () => {
    for (const event of events) stageEvent(db, event);
    const reducedItems = drainDeferred(db, limit, readBlob, true);
    const state = prepareQuery(db, SCAN_STATE_SQL, (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-001 */ db.prepare(sql),
    ).get() as { readonly scan_cursor: string | null; readonly scanned_revision: number };
    const last = events.at(-1);
    if (
      last !== undefined &&
      state.scan_cursor === null &&
      state.scanned_revision === last.workspaceRevision - events.length &&
      watermark(db) >= last.workspaceRevision
    ) {
      runSql(
        db,
        "UPDATE projection_meta SET scanned_revision = ?, head_digest = ? WHERE singleton = 1",
        last.workspaceRevision,
        head?.eventDigest ?? null,
      );
    }
    return { metrics: { sqliteTransactions: 1, reducedItems } };
  });
}

export function catchUpRound(
  db: DatabaseSync,
  eventStore: EventStreamPort,
  limit: number,
): {
  readonly sourceRevision: number;
  readonly watermark: number;
  readonly reducedItems: number;
  readonly accessedItems: number;
  readonly sqliteTransactions: 0 | 1;
} {
  const head = eventStore.readHead();
  const sourceRevision = head?.revision ?? 0;
  const state = prepareQuery(db, SCAN_STATE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-002 */ db.prepare(sql),
  ).get() as { readonly scan_cursor: string | null; readonly scanned_revision: number };
  const shouldScan = state.scan_cursor !== null || state.scanned_revision < sourceRevision;
  const batch = shouldScan ? eventStore.readBatch(state.scan_cursor, limit) : null;
  if (batch?.prefetchContent !== undefined) batchContentPrefetchers.set(eventStore, batch.prefetchContent);
  const hasDeferred =
    prepareQuery(db, "SELECT 1 AS present FROM event_source WHERE workspace_revision > ? LIMIT 1", (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-003 */ db.prepare(sql),
    ).get(watermark(db)) !== undefined;
  if (batch === null && !hasDeferred)
    return {
      sourceRevision,
      watermark: watermark(db),
      reducedItems: 0,
      accessedItems: 0,
      sqliteTransactions: 0,
    };
  // A complete source scan proves that an absent revision is a permanent hole in this
  // ledger. Before that point, keep strict continuity so a later batch can still supply it.
  const allowRevisionGaps = batch === null || batch.done;
  const replayEvents = readyDeferredEvents(db, batch?.events ?? [], limit, allowRevisionGaps);
  let prefetch = batch?.prefetchContent ?? batchContentPrefetchers.get(eventStore);
  if (prefetch === undefined && hasDeferred) {
    prefetch = eventStore.readBatch(null, 1).prefetchContent;
    if (prefetch !== undefined) batchContentPrefetchers.set(eventStore, prefetch);
  }
  if (replayEvents.length > 0 && prefetch === undefined)
    throw new Error("event stream must provide a verified batch content prefetch");
  const prefetchedContent = replayEvents.length ? prefetch!(replayEvents) : new Map<string, Uint8Array | null>();
  const reducedItems = transaction(db, () => {
    if (batch !== null) {
      for (const event of batch.events) stageEvent(db, event);
      if (batch.done)
        runSql(
          db,
          "UPDATE projection_meta SET scan_cursor = NULL, scanned_revision = ?, head_digest = ? WHERE singleton = 1",
          batch.sourceRevision,
          head?.eventDigest ?? null,
        );
      else runSql(db, "UPDATE projection_meta SET scan_cursor = ? WHERE singleton = 1", batch.cursor);
    }
    return drainDeferred(db, limit, (sha256) => prefetchedContent.get(sha256) ?? null, allowRevisionGaps);
  });
  return {
    sourceRevision,
    watermark: watermark(db),
    reducedItems,
    accessedItems: batch?.accessedItems ?? 0,
    sqliteTransactions: 1,
  };
}

function readyDeferredEvents(
  db: DatabaseSync,
  batch: readonly CanonicalEventV1[],
  limit: number,
  allowRevisionGaps: boolean,
): readonly CanonicalEventV1[] {
  const current = watermark(db),
    candidates = new Map<number, CanonicalEventV1>();
  for (const row of queryRows(
    db,
    [
      "SELECT workspace_revision, event_json FROM event_source",
      "WHERE workspace_revision > ? AND workspace_revision <= ?",
      "ORDER BY workspace_revision",
    ].join(" "),
    current,
    current + limit,
  ))
    candidates.set(Number(row.workspace_revision), JSON.parse(String(row.event_json)) as CanonicalEventV1);
  for (const event of batch)
    if (event.workspaceRevision <= current + limit) candidates.set(event.workspaceRevision, event);
  const ready: CanonicalEventV1[] = [];
  for (let revision = current + 1; revision <= current + limit; revision += 1) {
    const event = candidates.get(revision);
    if (event === undefined) {
      if (!allowRevisionGaps) break;
      continue;
    }
    ready.push(event);
  }
  return ready;
}

function stageEvent(db: DatabaseSync, event: CanonicalEventV1): void {
  const eventJson = serializePersistedCanonicalEvent(event).trimEnd();
  const applied = prepareQuery(db, "SELECT event_json FROM event_index WHERE op_id = ?", (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-004 */ db.prepare(sql),
  ).get(event.opId) as { readonly event_json: string } | undefined;
  if (applied !== undefined) {
    if (applied.event_json !== eventJson) throw new Error(`projection opId ${event.opId} names different bytes`);
    return;
  }
  const staged = prepareQuery(
    db,
    "SELECT event_json FROM event_source WHERE op_id = ? OR workspace_revision = ?",
    (sql) => /* @gate-identity check-bypass-write-boundary/bypass-write-005 */ db.prepare(sql),
  ).get(event.opId, event.workspaceRevision) as { readonly event_json: string } | undefined;
  if (staged !== undefined) {
    if (staged.event_json !== eventJson)
      throw new Error(`projection revision or opId ${event.opId} names different bytes`);
    return;
  }
  runSql(
    db,
    "INSERT INTO event_source(workspace_revision, op_id, event_json) VALUES (?, ?, ?)",
    event.workspaceRevision,
    event.opId,
    eventJson,
  );
}

function drainDeferred(
  db: DatabaseSync,
  limit: number,
  readBlob: EventStreamPort["readContentBlob"],
  allowRevisionGaps = false,
): number {
  let next = watermark(db),
    reduced = 0;
  while (reduced < limit) {
    const row = prepareQuery(db, NEXT_DEFERRED_EVENT_SQL, (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-006 */ db.prepare(sql),
    ).get(next + 1, allowRevisionGaps ? 1 : 0, next) as { readonly event_json: string } | undefined;
    if (row === undefined) break;
    const event = JSON.parse(row.event_json) as CanonicalEventV1;
    applyEvent(db, normalizePersistedCanonicalEvent(event), row.event_json, readBlob);
    runSql(db, "DELETE FROM event_source WHERE workspace_revision = ?", event.workspaceRevision);
    next = event.workspaceRevision;
    reduced += 1;
  }
  runSql(db, "UPDATE projection_meta SET watermark = ? WHERE singleton = 1", next);
  return reduced;
}
