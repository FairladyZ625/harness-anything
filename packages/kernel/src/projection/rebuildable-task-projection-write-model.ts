// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import { currentTaskForWrite } from "../domain/task.ts";
import { docByteLength, type DocumentState } from "../domain/doc-sync.contract.ts";
import { requireEntityKindContract } from "../domain/entity-kind-registry.ts";
import { type TaskProgressEventV1 } from "../domain/task-progress-event.ts";
import { isTaskBoundRuntimeWriter, resolveTaskBoundRuntimeBinding } from "../domain/task-bound-runtime-authority.ts";
import { isSamePerson } from "../domain/actor-domain-services.ts";
import { type DecisionEventV1 } from "../domain/decision-event.ts";
import { type FactEventV1 } from "../domain/fact-event.ts";
import { type RelationEventV1 } from "../domain/relation-event.ts";
import { type MigrationDocumentClaim, type MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import {
  readDecisionDocumentState,
  reduceDecisionEvent,
  refreshDecisionDocumentSearch,
} from "./decision-event-projection.ts";
import { reduceFactEvent } from "./fact-event-projection.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { projectInterpretedEntityValue } from "./rebuildable-task-projection-entities.ts";
import { readRuntimeSession, readSnapshot, storedLease } from "./rebuildable-task-projection-runtime.ts";
import { applyRelationProjectionEvent } from "./relation-entity-projection.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const DOCUMENT_BASE_SQL = "SELECT json_extract(value_json, '$.blobSha256') AS blob_sha256 FROM document WHERE path = ?";
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
    base = queryRows(db, DOCUMENT_BASE_SQL, claim.path)[0],
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
      isTaskBoundRuntimeWriter(lease, event.actor, event.source, runtimeBinding),
    // Owner backfill entries bypass the held-lease requirement but still bind the creator and a
    // non-held lease, mirroring compileTaskProgress so replay reaches the same verdict.
    ownerBackfill =
      event.payload.backfilled === true &&
      snapshot.task !== null &&
      isSamePerson(snapshot.task.createdBy, event.actor) &&
      (lease === null || lease.phase === "released" || lease.phase === "orphaned");
  if (
    snapshot.task === null ||
    !packagePath ||
    claim.path !== `${packagePath}/progress.md` ||
    (!ownerBackfill &&
      (snapshot.task.status !== "active" ||
        lease?.phase !== "held" ||
        lease.executionId !== event.payload.executionId ||
        (!directHolder && !runtimeWorker)))
  )
    throw new Error(`progress event lease mismatch for task ${taskId}`);
  if (event.payload.baseDocumentSha256 !== (base?.blob_sha256 ?? null) || !bytes || bytes.byteLength !== claim.size)
    throw new Error(`progress document base or blob mismatch for task ${taskId}`);
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
    const carriedBase = queryRows(db, DOCUMENT_BASE_SQL, change.path)[0],
      carriedBytes = readBlob(change.candidate.sha256);
    if (!carriedBytes || carriedBytes.byteLength !== change.candidate.size)
      throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
    let carriedBody: string;
    try {
      carriedBody = new TextDecoder("utf-8", { fatal: true }).decode(carriedBytes);
    } catch {
      throw new Error(`carried document blob ${change.candidate.sha256} is not UTF-8`);
    }
    if (change.baseBlobSha256 !== (carriedBase?.blob_sha256 ?? null))
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
  const claim = event.payload.factsDocumentClaim,
    bytes = readBlob(claim.sha256);
  if (claim.path !== `facts/${event.factId}.md` || !bytes || bytes.byteLength !== claim.size)
    throw new Error(`fact document path or blob mismatch for ${event.factId}`);
  reduceFactEvent(db, event);
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
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
    event.opId,
    event.workspaceRevision,
    event.taskId ?? null,
    eventJson,
  );
  runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
  const supersededClaim = event.payload.supersededFactsDocumentClaim;
  if (!supersededClaim) return;
  const supersededBytes = readBlob(supersededClaim.sha256);
  if (!supersededBytes || supersededBytes.byteLength !== supersededClaim.size)
    throw new Error(`superseded fact document blob ${supersededClaim.sha256} is unavailable`);
  const supersededDocument: DocumentState = {
    path: supersededClaim.path as DocumentState["path"],
    blobSha256: supersededClaim.sha256,
    body: new TextDecoder("utf-8", { fatal: true }).decode(supersededBytes),
    size: docByteLength(supersededClaim.size),
    mediaType: supersededClaim.mediaType,
    policyId: supersededClaim.policyId,
    workspaceRevision: event.workspaceRevision,
  };
  runSql(db, UPSERT_DOCUMENT_SQL, supersededClaim.path, event.workspaceRevision, canonicalJson(supersededDocument));
}

export function projectDecision(
  db: DatabaseSync,
  event: DecisionEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const claim = event.payload.decisionDocumentClaim,
    previous = queryRows(db, DOCUMENT_BASE_SQL, claim.path)[0],
    bytes = readBlob(claim.sha256);
  if (
    claim.path !== `decisions/decision-${event.decisionId}/decision.md` ||
    event.payload.baseDocumentSha256 !== (previous?.blob_sha256 ?? null) ||
    !bytes ||
    bytes.byteLength !== claim.size
  )
    throw new Error(`decision document path, base, or blob mismatch for ${event.decisionId}`);
  reduceDecisionEvent(db, event);
  const state = readDecisionDocumentState(db, event.decisionId);
  if (!state) throw new Error(`decision projection missing for ${event.decisionId}`);
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
  refreshDecisionDocumentSearch(db, document);
}

export function projectRelationDocuments(
  db: DatabaseSync,
  event: RelationEventV1,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  for (const claim of event.payload.documentClaims ?? []) {
    const bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`relation document blob ${claim.sha256} is unavailable`);
    if (
      (claim.policyId === "markdown-body-replaceable/v1" &&
        !/^decisions\/decision-[^/]+\/decision\.md$/u.test(claim.path)) ||
      (claim.policyId === "typed-machine-writer/v1" && !/^facts\/F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u.test(claim.path))
    )
      throw new Error(`relation document path ${claim.path} does not match its policy`);
    const document: DocumentState = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    runSql(db, UPSERT_DOCUMENT_SQL, claim.path, event.workspaceRevision, canonicalJson(document));
    if (claim.policyId === "markdown-body-replaceable/v1") refreshDecisionDocumentSearch(db, document);
  }
}

const INSERT_TASK_SNAPSHOT_SQL = [
  "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at)",
  "VALUES (?, ?, ?, ?, ?)",
].join(" ");
const INSERT_FACT_SQL = [
  "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at,",
  "confidence, memory_class, op_id, workspace_revision, row_json)",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
].join(" ");
const UPSERT_TASK_SNAPSHOT_SQL = [
  "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at)",
  "VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET",
  "workspace_revision=excluded.workspace_revision, snapshot_json=excluded.snapshot_json,",
  "status=excluded.status, updated_at=excluded.updated_at",
].join(" ");
// Legacy migration-import replay and its document materialization.
export function projectMigration(
  db: DatabaseSync,
  event: MigrationImportEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const entity = event.payload.entity,
    taskId =
      entity.kind === "task"
        ? entity.task.taskId
        : entity.kind === "fact"
          ? (entity.fact.taskId ?? null)
          : entity.kind === "execution"
            ? entity.execution.taskId
            : entity.kind === "task-document"
              ? entity.taskId
              : null;
  runSql(
    db,
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
    event.opId,
    event.workspaceRevision,
    taskId,
    eventJson,
  );
  if (entity.kind === "task") {
    runSql(
      db,
      INSERT_TASK_SNAPSHOT_SQL,
      entity.task.taskId,
      event.workspaceRevision,
      canonicalJson({
        ...emptyTaskLifecycleSnapshot(event.workspaceRevision),
        task: currentTaskForWrite(entity.task),
      }),
      entity.task.status,
      event.occurredAt,
    );
    runSql(db, "INSERT INTO task_package VALUES (?, ?)", entity.task.taskId, entity.packagePath);
    runSql(db, "INSERT INTO task_generation VALUES (?, 'v0')", entity.task.taskId);
    refreshTaskRelationProjection(
      db,
      entity.task.taskId,
      entity.task,
      event.workspaceRevision,
      event.occurredAt,
      entity.packagePath,
    );
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "decision") {
    const value = entity.decision,
      revision = event.workspaceRevision;
    runSql(
      db,
      "INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      value.decisionId,
      value.state,
      value.title,
      value.question,
      value.riskTier,
      value.urgency,
      value.vertical,
      value.preset,
      value.decisionClass,
      JSON.stringify(value.appliesTo),
      JSON.stringify(value.proposer),
      value.arbiter === null ? null : JSON.stringify(value.arbiter),
      value.proposedAt,
      value.decidedAt,
      JSON.stringify(value.provenance ?? []),
      revision,
    );
    for (const [position, row] of value.chosen.entries())
      runSql(
        db,
        "INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)",
        value.decisionId,
        "chosen",
        row.id,
        position,
        row.text,
        row.rationale ?? null,
        revision,
      );
    for (const [position, row] of value.rejected.entries())
      runSql(
        db,
        "INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)",
        value.decisionId,
        "rejected",
        row.id,
        position,
        row.text,
        row.whyNot,
        revision,
      );
    for (const [position, row] of value.claims.entries())
      runSql(
        db,
        "INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        value.decisionId,
        row.id,
        position,
        row.text,
        row.loadBearing ? 1 : 0,
        row.fulfillment,
        revision,
        row.fulfillment ? revision : null,
      );
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    refreshDecisionDocumentSearch(db, migrationDocument(db, entity.documentClaim.path)!);
    return;
  }
  if (entity.kind === "fact") {
    const value = entity.fact,
      ref = `fact/${value.factId}`,
      row = {
        schema: "fact-row/v1",
        ref,
        ...value,
        actor: event.actor,
        source: event.source,
        occurredAt: event.occurredAt,
        workspaceRevision: event.workspaceRevision,
      };
    runSql(
      db,
      INSERT_FACT_SQL,
      value.taskId ?? null,
      value.factId,
      ref,
      value.statement,
      value.evidenceSource,
      value.observedAt,
      value.confidence,
      value.memoryClass,
      event.opId,
      event.workspaceRevision,
      JSON.stringify(row),
    );
    runSql(db, "INSERT INTO fact_fts VALUES (?, ?, ?)", value.factId, value.statement, value.evidenceSource);
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "execution") {
    const value = entity.execution,
      snapshot = readSnapshot(db, value.taskId);
    if (!snapshot.task || snapshot.executions.some(({ executionId }) => executionId === value.executionId))
      throw new Error(`migration execution owner or identity mismatch for ${value.executionId}`);
    const next = {
      ...snapshot,
      revision: event.workspaceRevision,
      executions: [...snapshot.executions, value],
    };
    runSql(
      db,
      UPSERT_TASK_SNAPSHOT_SQL,
      value.taskId,
      event.workspaceRevision,
      canonicalJson({ ...next, executions: [], reviews: [] }),
      next.task?.status ?? null,
      event.occurredAt,
    );
    refreshTaskRelationProjection(db, value.taskId, next.task, event.workspaceRevision, event.occurredAt);
    const contract = requireEntityKindContract(entity.kind);
    projectInterpretedEntityValue(
      db,
      contract,
      { kind: contract.kind, id: value.executionId, value: { ...value } },
      event.workspaceRevision,
      `event:${event.opId}`,
    );
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "task-document") {
    if (!hasTaskSnapshot(db, entity.taskId))
      throw new Error(`migration task document owner is missing for ${entity.taskId}`);
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "repo-document") {
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "relation") {
    applyRelationProjectionEvent(db, event);
    return;
  }
  if (entity.kind === "archived-entity") {
    runSql(
      db,
      [
        "INSERT INTO archived_entity(entity_kind, entity_id, workspace_revision, row_json)",
        "VALUES (?, ?, ?, ?) ON CONFLICT(entity_kind, entity_id) DO UPDATE SET",
        "workspace_revision=excluded.workspace_revision, row_json=excluded.row_json",
        "WHERE archived_entity.workspace_revision <= excluded.workspace_revision",
      ].join(" "),
      entity.entityKind,
      entity.entityId,
      event.workspaceRevision,
      canonicalJson(entity),
    );
    return;
  }
  storeMigrationDocument(db, event, entity.documentClaim, readBlob);
}
export function storeMigrationDocument(
  db: DatabaseSync,
  event: MigrationImportEventV1,
  claim: MigrationDocumentClaim,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const bytes = readBlob(claim.sha256);
  if (!bytes || bytes.byteLength !== claim.size)
    throw new Error(`migration document blob ${claim.sha256} is unavailable`);
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
export function migrationDocument(db: DatabaseSync, path: string): DocumentState | null {
  const row = queryRows(db, "SELECT value_json FROM document WHERE path=?", path)[0];
  return row ? (JSON.parse(String(row.value_json)) as DocumentState) : null;
}

function hasTaskSnapshot(db: DatabaseSync, taskId: string): boolean {
  const row =
    /* @gate-identity check-bypass-write-boundary/bypass-write-098 */
    db
      .prepare("SELECT json_type(snapshot_json, '$.task') AS task_type FROM task_snapshot WHERE task_id = ?")
      .get(taskId) as { readonly task_type: string | null } | undefined;
  return row !== undefined && row.task_type !== null && row.task_type !== "null";
}
