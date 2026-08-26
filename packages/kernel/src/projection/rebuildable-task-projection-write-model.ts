// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import { docByteLength, verifyDocEventChange, type DocumentState } from "../domain/doc-sync.contract.ts";
import { type TaskProgressEventV1 } from "../domain/task-progress-event.ts";
import { isTaskBoundRuntimeWriter, resolveTaskBoundRuntimeBinding } from "../domain/task-bound-runtime-authority.ts";
import { type DecisionEventV1 } from "../domain/decision-event.ts";
import { type FactEventV1 } from "../domain/fact-event.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import {
  readDecisionDocumentState,
  reduceDecisionEvent,
  refreshDecisionDocumentSearch,
} from "./decision-event-projection.ts";
import { reduceFactEvent } from "./fact-event-projection.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { readRuntimeSession, readSnapshot, storedLease } from "./rebuildable-task-projection-runtime.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const UPSERT_DOCUMENT_SQL = [
  "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");

// Progress, fact, and decision materialized-write handlers.
export function projectProgress(
  db: DatabaseSync,
  event: TaskProgressEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const taskId = event.payload.taskId,
    snapshot = readSnapshot(db, taskId),
    lease = storedLease(db, taskId),
    packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id = ?", taskId)[0]?.package_path,
    claim = event.payload.resultDocumentClaim,
    previous = queryRows(db, "SELECT value_json FROM document WHERE path = ?", claim.path)[0],
    base = previous ? (JSON.parse(String(previous.value_json)) as DocumentState) : null,
    bytes = readBlob(claim.sha256),
    runtimeSessionIdValue = event.payload.runtimeSessionId,
    runtime = runtimeSessionIdValue ? readRuntimeSession(db, runtimeSessionIdValue) : null;
  const runtimeBinding =
      runtime === null ? null : resolveTaskBoundRuntimeBinding(runtime, taskId, event.payload.executionId),
    directHolder =
      lease !== null &&
      runtimeSessionIdValue === undefined &&
      canonicalJson(lease.actor) === canonicalJson(event.actor) &&
      canonicalJson(lease.source) === canonicalJson(event.source),
    runtimeWorker =
      lease !== null &&
      runtimeSessionIdValue !== undefined &&
      runtimeBinding !== null &&
      isTaskBoundRuntimeWriter(lease, event.actor, event.source, runtimeBinding);
  if (
    snapshot.task?.status !== "active" ||
    !packagePath ||
    claim.path !== `${packagePath}/progress.md` ||
    lease?.phase !== "held" ||
    lease.executionId !== event.payload.executionId ||
    (!directHolder && !runtimeWorker)
  )
    throw new Error(`progress event lease mismatch for task ${taskId}`);
  if (event.payload.baseDocumentSha256 !== (base?.blobSha256 ?? null) || !bytes || bytes.byteLength !== claim.size)
    throw new Error(`progress document base or blob mismatch for task ${taskId}`);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (sha256Text(body) !== claim.sha256) throw new Error(`progress append proof mismatch for task ${taskId}`);
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
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
    event.opId,
    event.workspaceRevision,
    taskId,
    eventJson,
  );
  runSql(
    db,
    "INSERT INTO task_progress(workspace_revision, task_id, execution_id, event_json) VALUES (?, ?, ?, ?)",
    event.workspaceRevision,
    taskId,
    event.payload.executionId,
    eventJson,
  );
  runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
  for (const change of event.payload.carriedDocumentClaims ?? []) {
    const previous = queryRows(db, "SELECT value_json FROM document WHERE path = ?", change.path)[0],
      carriedBase = previous ? (JSON.parse(String(previous.value_json)) as DocumentState) : null,
      carriedBytes = readBlob(change.candidate.sha256);
    if (!carriedBytes || carriedBytes.byteLength !== change.candidate.size)
      throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
    let carriedBody: string;
    try {
      carriedBody = new TextDecoder("utf-8", { fatal: true }).decode(carriedBytes);
    } catch {
      throw new Error(`carried document blob ${change.candidate.sha256} is not UTF-8`);
    }
    if (
      change.baseBlobSha256 !== (carriedBase?.blobSha256 ?? null) ||
      !verifyDocEventChange(change, carriedBase?.body ?? "", carriedBody)
    )
      throw new Error(`carried document proof mismatch for ${change.path}`);
    const carriedDocument: DocumentState = {
      path: change.path as DocumentState["path"],
      blobSha256: change.candidate.sha256,
      body: carriedBody,
      size: docByteLength(change.candidate.size),
      mediaType: change.candidate.mediaType,
      policyId: change.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(db, UPSERT_DOCUMENT_SQL, change.path, event.workspaceRevision, canonicalJson(carriedDocument));
    refreshDecisionDocumentSearch(db, carriedDocument);
  }
}

export function projectFact(
  db: DatabaseSync,
  event: FactEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id = ?", event.taskId)[0]
      ?.package_path,
    claim = event.payload.factsDocumentClaim,
    bytes = readBlob(claim.sha256);
  if ((packagePath && claim.path !== `${packagePath}/facts.md`) || !bytes || bytes.byteLength !== claim.size)
    throw new Error(`fact document path or blob mismatch for task ${event.taskId}`);
  reduceFactEvent(db, event);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (sha256Text(body) !== claim.sha256) throw new Error(`fact document projection mismatch for task ${event.taskId}`);
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
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
    event.opId,
    event.workspaceRevision,
    event.taskId,
    eventJson,
  );
  runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
}

export function projectDecision(
  db: DatabaseSync,
  event: DecisionEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const claim = event.payload.decisionDocumentClaim,
    previousRow = queryRows(db, "SELECT value_json FROM document WHERE path = ?", claim.path)[0],
    previous = previousRow ? (JSON.parse(String(previousRow.value_json)) as DocumentState) : null,
    bytes = readBlob(claim.sha256);
  if (
    claim.path !== `decisions/decision-${event.decisionId}/decision.md` ||
    event.payload.baseDocumentSha256 !== (previous?.blobSha256 ?? null) ||
    !bytes ||
    bytes.byteLength !== claim.size
  )
    throw new Error(`decision document path, base, or blob mismatch for ${event.decisionId}`);
  reduceDecisionEvent(db, event);
  const state = readDecisionDocumentState(db, event.decisionId);
  if (!state) throw new Error(`decision projection missing for ${event.decisionId}`);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (sha256Text(body) !== claim.sha256)
    throw new Error(`decision document projection mismatch for ${event.decisionId}`);
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
  refreshDecisionDocumentSearch(db, document);
}
