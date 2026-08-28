// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import {
  docByteLength,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  verifyDocEventChange,
  type CanonicalEventV1,
  type DocumentState,
} from "../domain/doc-sync.contract.ts";
import { isLedgerLayoutMigrationEvent } from "../domain/ledger-layout-migration-event.ts";
import { currentTaskForWrite } from "../domain/task.ts";
import {
  isAgentRuntimeEvent,
  reduceRuntimeInstallation,
  reduceRuntimeSession,
  runtimeSessionId,
} from "../domain/agent-runtime.ts";
import { isEntityEvent } from "../domain/entity-event.ts";
import { interpretEntityValue } from "../domain/entity-kind-projection.ts";
import { requireEntityStoreKindContract } from "../domain/entity-kind-registry.ts";
import { isTaskBootstrapEvent, taskBootstrapPackagePath } from "../domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { isPresetSnapshotUpgradeEvent } from "../domain/preset-snapshot-upgrade-event.ts";
import { isScheduleEvent } from "../domain/schedule-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { readSettingsFacet, repositorySettings } from "../domain/settings.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import { isCiRunObservationEvent } from "../domain/ci-run-observation-event.ts";
import { parsePeopleRosterDocument } from "../domain/people-roster.ts";
import { scheduleDefinition, validateScheduleDefinitionV1 } from "../domain/schedule.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { refreshDecisionDocumentSearch } from "./decision-event-projection.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import { projectMigration } from "./rebuildable-task-projection-migration.ts";
import { projectDecision, projectFact, projectProgress } from "./rebuildable-task-projection-write-model.ts";
import { applyTaskEvent } from "./rebuildable-task-projection-task-events.ts";
import {
  deleteEntityProjectionRow,
  projectEmbeddedCanonicalEntities,
  projectInterpretedEntityValue,
} from "./rebuildable-task-projection-entities.ts";
import {
  readRuntimeInstallation,
  readRuntimeSession,
  readSnapshot,
  refreshRuntimeSessionAssociations,
} from "./rebuildable-task-projection-runtime.ts";
import { canonicalJson, runSql } from "./rebuildable-task-projection-sql.ts";
import { deriveRelationId } from "../domain/entity-relation.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

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
  if (isEntityEvent(event)) {
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
    if (sha256Text(body) !== claim.sha256) throw new Error(`entity declaration blob ${claim.sha256} hash mismatch`);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new Error(`entity declaration blob ${claim.sha256} is not JSON`);
    }
    const contract = requireEntityStoreKindContract(event.payload.entityKind),
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
    projectInterpretedEntityValue(db, contract, entity, event.workspaceRevision, `event:${event.opId}`);
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
      if (sha256Text(body) !== claim.sha256) throw new Error(`schedule definition blob ${claim.sha256} hash mismatch`);
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
    if (sha256Text(body) !== claim.sha256) throw new Error(`settings harness.yaml blob ${claim.sha256} hash mismatch`);
    if (
      canonicalJson(repositorySettings(readSettingsFacet(body))) !==
      canonicalJson(repositorySettings(event.payload.settings))
    )
      throw new Error(`settings harness.yaml blob ${claim.sha256} does not match the event settings facet`);
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
    if (sha256Text(body) !== claim.sha256) throw new Error(`people.yaml blob ${claim.sha256} hash mismatch`);
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
    const taskId = event.type === "runtime_session_task_bound" ? event.payload.taskId : null;
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
      }
    }
    if (event.type === "runtime_session_task_bound") {
      const source = `runtime-session/${event.payload.runtimeSessionId}`,
        target = `task/${event.payload.taskId}`,
        relationId = deriveRelationId({ source, target, type: "executes", direction: "directed" }),
        row = {
          relationId,
          sourceRef: source,
          targetRef: target,
          relationType: "executes",
          direction: "directed",
          strength: "strong",
          origin: "generated",
          state: "active",
          rationale: "Authenticated runtime handoff.",
          ownerRef: source,
          sourcePath: `event:${event.opId}`,
          recordIndex: 0,
        };
      runSql(
        db,
        "INSERT OR REPLACE INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        relationId,
        source,
        target,
        "executes",
        "active",
        source,
        event.workspaceRevision,
        JSON.stringify(row),
      );
    }
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
      const previous =
          /* @gate-identity check-bypass-write-boundary/bypass-write-011 */
          db.prepare("SELECT value_json FROM document WHERE path = ?").get(change.path) as
            | { readonly value_json: string }
            | undefined,
        base = previous ? (JSON.parse(previous.value_json) as DocumentState) : null;
      if (change.candidate === null) {
        if (
          event.payload.retirementReason === undefined ||
          (base !== null && change.baseBlobSha256 !== base.blobSha256)
        )
          throw new Error(`document retirement mismatch for ${change.path}`);
        runSql(db, "DELETE FROM document WHERE path = ?", change.path);
        continue;
      }
      if (change.baseBlobSha256 !== (base?.blobSha256 ?? null)) {
        if (
          base !== null &&
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
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`document blob ${change.candidate.sha256} is not UTF-8`);
      }
      if (!verifyDocEventChange(change, base?.body ?? "", body))
        throw new Error(`document proof mismatch for ${change.path}`);
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
    const changed = {
        completionGateIds: event.payload.task.completionGateIds,
        presetSnapshotDigest: event.payload.task.presetSnapshotDigest,
      },
      historical = { ...current.task, ...changed },
      currentShape = { ...currentTaskForWrite(current.task), ...changed };
    if (
      canonicalJson(historical) !== canonicalJson(event.payload.task) &&
      canonicalJson(currentShape) !== canonicalJson(event.payload.task)
    )
      throw new Error(`preset snapshot upgrade changed immutable task fields for ${event.taskId}`);
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes)),
      contractBody = new TextDecoder("utf-8", { fatal: true }).decode(contractBytes),
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
        task: event.payload.task,
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
        task: event.payload.task,
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
