import { assertTaskProgressReferences } from "@harness-anything/kernel/internal/domain/storage-replay-policy.ts";
import { FACT_DOCUMENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { DECISION_DOCUMENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { currentTaskForWrite } from "@harness-anything/kernel/internal/domain/task.ts";
import {
  docByteLength,
  type DocumentState,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { requireEntityKindContract } from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { type TaskProgressEventV1 } from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import { type DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { type FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { type EntityDocumentEventV1 } from "@harness-anything/kernel/internal/domain/entity-document-event.ts";
import { type RelationEventV1 } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import {
  type MigrationDocumentClaim,
  type MigrationImportEventV1,
} from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import {
  decisionIdSortKey,
  decisionLegacyNumber,
  readDecisionDocumentState,
  reduceDecisionEvent,
  refreshDecisionDocumentSearch,
} from "./decision-event-projection.ts";
import { factMaterializationHeld, reduceFactEvent } from "./fact-event-projection.ts";
import { decisionMaterializationHeld, refreshMaterializationHolds } from "./decision-projection-admission.ts";
import { terminalDecisionMaterializationStates } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { projectInterpretedEntityValue } from "./rebuildable-task-projection-entities.ts";
import { readRuntimeSession, readSnapshot } from "./rebuildable-task-projection-runtime.ts";
import { applyRelationProjectionEvent } from "./relation-entity-projection.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "@harness-anything/kernel";

const DOCUMENT_BASE_SQL =
  "SELECT json_extract(value_json, '$.blobSha256') AS blob_sha256 FROM " +
  "(SELECT path,value_json FROM document UNION ALL SELECT path,value_json FROM document_history) WHERE path = ? LIMIT 1";
const UPSERT_DOCUMENT_SQL = [
  "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
].join(" ");
const ARCHIVE_DOCUMENT_SQL = [
  "INSERT INTO document_history(path, workspace_revision, value_json)",
  "SELECT path, ?, value_json FROM document WHERE path = ?",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json",
].join(" ");
function archiveDocument(db: DatabaseSync, path: string, revision: number): void {
  runSql(db, ARCHIVE_DOCUMENT_SQL, revision, path);
  runSql(db, "DELETE FROM document WHERE path = ?", path);
}
function storeHistoricalDocument(db: DatabaseSync, document: DocumentState): void {
  runSql(
    db,
    "INSERT INTO document_history(path, workspace_revision, value_json) VALUES (?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json",
    document.path,
    document.workspaceRevision,
    canonicalJson(document),
  );
  runSql(db, "DELETE FROM document WHERE path = ?", document.path);
}
function upsertActiveDocument(db: DatabaseSync, path: string, revision: number, document: DocumentState): void {
  runSql(db, "DELETE FROM document_history WHERE path = ?", path);
  runSql(db, UPSERT_DOCUMENT_SQL, path, revision, canonicalJson(document));
}

// Progress, fact, and decision materialized-write handlers.
export function projectProgress(
  db: DatabaseSync,
  event: TaskProgressEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  const taskId = event.payload.taskId,
    snapshot = readSnapshot(db, taskId),
    packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id = ?", taskId)[0]?.package_path,
    claim = event.payload.resultDocumentClaim,
    base = queryRows(db, DOCUMENT_BASE_SQL, claim.path)[0],
    bytes = readBlob(claim.sha256),
    runtimeSessionIdValue = event.payload.runtimeSessionId,
    runtime = runtimeSessionIdValue ? readRuntimeSession(db, runtimeSessionIdValue) : null;
  // Admission checks the current lease. Replay checks accepted fact references, not today's authority.
  assertTaskProgressReferences(snapshot, event, packagePath, runtime);
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
  if (event.type === "fact_archived") {
    const retirement = event.payload.factsDocumentRetirement,
      base = queryRows(db, DOCUMENT_BASE_SQL, retirement?.path ?? "")[0];
    if (
      !retirement ||
      retirement.path !== `facts/${event.factId}.md` ||
      retirement.sha256 !== (base?.blob_sha256 ?? null)
    )
      throw new Error(`archived fact document path or base mismatch for ${event.factId}`);
    reduceFactEvent(db, event);
    runSql(
      db,
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
      event.opId,
      event.workspaceRevision,
      event.taskId ?? null,
      eventJson,
    );
    if (!factMaterializationHeld(db, `fact/${event.factId}`, "archived"))
      archiveDocument(db, retirement.path, event.workspaceRevision);
    return;
  }
  const claim = event.payload.factsDocumentClaim;
  if (!claim) throw new Error(`fact document claim missing for ${event.factId}`);
  const bytes = readBlob(claim.sha256);
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
  upsertActiveDocument(db, claim.path, event.workspaceRevision, document);
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
  const supersededFactId = supersededClaim.path.match(/^facts\/(F-[0-9A-HJKMNP-TV-Z]{8})\.md$/u)?.[1];
  if (supersededFactId && factMaterializationHeld(db, `fact/${supersededFactId}`, "superseded_fact"))
    upsertActiveDocument(db, supersededClaim.path, event.workspaceRevision, supersededDocument);
  else storeHistoricalDocument(db, supersededDocument);
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
  const terminal = (terminalDecisionMaterializationStates as readonly string[]).includes(state.state),
    held = terminal && decisionMaterializationHeld(db, event.decisionId, state.state);
  if (terminal && !held) {
    storeHistoricalDocument(db, document);
  } else {
    upsertActiveDocument(db, claim.path, event.workspaceRevision, document);
    refreshDecisionDocumentSearch(db, document);
  }
  if (event.type === "decision_review_recorded")
    for (const change of event.payload.carriedDocumentClaims ?? []) {
      const carriedBase = queryRows(db, DOCUMENT_BASE_SQL, change.path)[0],
        carriedBytes = readBlob(change.candidate.sha256);
      if (!carriedBytes || carriedBytes.byteLength !== change.candidate.size)
        throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
      if (change.baseBlobSha256 !== (carriedBase?.blob_sha256 ?? null))
        throw new Error(`carried document proof mismatch for ${change.path}`);
      const carriedDocument: DocumentState = {
        path: change.path as DocumentState["path"],
        blobSha256: change.candidate.sha256,
        body: new TextDecoder("utf-8", { fatal: true }).decode(carriedBytes),
        size: docByteLength(change.candidate.size),
        mediaType: change.candidate.mediaType,
        policyId: change.policyId,
        workspaceRevision: event.workspaceRevision,
      };
      if (terminal && !held) storeHistoricalDocument(db, carriedDocument);
      else {
        upsertActiveDocument(db, change.path, event.workspaceRevision, carriedDocument);
        refreshDecisionDocumentSearch(db, carriedDocument);
      }
    }
  if (terminal && !held) archiveDecisionCarriedDocuments(db, event.decisionId, event.workspaceRevision);
}

/** Release terminal documents whose last active canonical hold changed in this projection transaction. */
export function settleTerminalMaterializationForEvent(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  const changedRefs = materializationReleaseRefs(db, event);
  if (changedRefs.length === 0) return;
  settleTerminalMaterialization(db, refreshMaterializationHolds(db, changedRefs), event.workspaceRevision);
}

function settleTerminalMaterialization(db: DatabaseSync, candidates: readonly string[], revision: number): void {
  const held = (ref: string) =>
    queryRows(db, "SELECT 1 FROM materialization_hold WHERE owner_ref=? LIMIT 1", ref).length > 0;
  for (const ref of candidates) {
    const decision = ref.match(/^decision\/([^/]+)$/u)?.[1],
      fact = ref.match(/^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u)?.[1],
      taskId = ref.match(/^task\/([^/]+)$/u)?.[1];
    if (fact) {
      const row = queryRows<{ archived: number }>(
          db,
          "SELECT json_extract(row_json,'$.archived') AS archived FROM fact WHERE fact_id=?",
          fact,
        )[0],
        terminal =
          row?.archived ||
          queryRows(
            db,
            "SELECT 1 FROM relation_edge WHERE relation_type='supersedes-fact' AND target_ref=? AND state='active' LIMIT 1",
            ref,
          ).length > 0;
      if (row) settleDocumentPrefix(db, `facts/${fact}.md`, revision, !terminal || held(ref), false);
    } else if (decision) {
      const state = queryRows<{ readonly state: string }>(
        db,
        "SELECT state FROM decision WHERE decision_id=?",
        decision,
      )[0];
      if (state)
        settleDocumentPrefix(
          db,
          `decisions/decision-${decision}/`,
          revision,
          !(terminalDecisionMaterializationStates as readonly string[]).includes(state.state) || held(ref),
        );
    } else if (taskId) {
      const task = readSnapshot(db, taskId).task,
        packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id=?", taskId)[0]?.package_path;
      if (task && packagePath) {
        settleDocumentPrefix(
          db,
          `${packagePath}/`,
          revision,
          (task.status !== "cancelled" && task.packageDisposition !== "archived") || held(ref),
        );
      }
    }
  }
}

/** Move the current document descriptors between active and historical indexes; blobs never change. */
function settleDocumentPrefix(
  db: DatabaseSync,
  prefix: string,
  revision: number,
  active: boolean,
  subtree = true,
): void {
  const source = active ? "document_history" : "document";
  for (const row of queryRows<{ readonly path: string; readonly value_json: string }>(
    db,
    active
      ? `SELECT history.path,history.value_json FROM document_history AS history
         WHERE ${subtree ? "history.path>=? AND history.path<?" : "history.path=?"}
           AND NOT EXISTS (SELECT 1 FROM document AS current WHERE current.path=history.path)`
      : `SELECT path,value_json FROM ${source} WHERE ${subtree ? "path>=? AND path<?" : "path=?"}`,
    ...(subtree ? [prefix, `${prefix.slice(0, -1)}0`] : [prefix]),
  )) {
    if (active) upsertActiveDocument(db, row.path, revision, JSON.parse(row.value_json) as DocumentState);
    else archiveDocument(db, row.path, revision);
  }
}

function archiveDecisionCarriedDocuments(db: DatabaseSync, decisionId: string, revision: number): void {
  const prefix = `decisions/decision-${decisionId}/`;
  for (const row of queryRows<{ readonly path: string }>(
    db,
    "SELECT path FROM document WHERE path GLOB ?",
    `${prefix}*`,
  ))
    archiveDocument(db, row.path, revision);
}

function materializationReleaseRefs(db: DatabaseSync, event: PersistedCanonicalEventV1): readonly string[] {
  if (event.schema === "relation-event/v1") {
    const ids = [event.relationId, ...(event.type === "relation_replaced" ? [event.payload.previousRelationId] : [])],
      refs = queryRows<{ readonly source_ref: string; readonly target_ref: string }>(
        db,
        "SELECT source_ref,target_ref FROM relation_edge WHERE relation_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      );
    return [...new Set(refs.flatMap(({ source_ref: source, target_ref: target }) => [source, target]))];
  }
  if (
    event.schema === "decision-event/v1" &&
    (event.type === "decision_relation_retired" || event.type === "decision_relation_replaced")
  ) {
    const ids = [
        event.payload.relationId,
        ...(event.type === "decision_relation_replaced" ? [event.payload.replacement.relation_id] : []),
      ],
      refs = queryRows<{ readonly source_ref: string; readonly target_ref: string }>(
        db,
        "SELECT source_ref,target_ref FROM relation_edge WHERE relation_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      );
    return [...new Set(refs.flatMap(({ source_ref: source, target_ref: target }) => [source, target]))];
  }
  if (
    event.schema === "decision-event/v1" &&
    (
      ["decision_rejected", "decision_superseded", "decision_retired", "decision_deferred"] as readonly string[]
    ).includes(event.type)
  )
    return [`decision/${event.decisionId}`];
  if (event.schema === "entity-document-event/v1")
    return event.payload.entityRefs.map((ref) => ref.replace(/^task\/([^/]+)\/.*$/u, "task/$1"));
  if (event.schema === "fact-event/v1")
    return [`fact/${event.factId}`, ...(event.payload.supersedes ? [event.payload.supersedes.factRef] : [])];
  if (event.schema === "decision-event/v1") return [`decision/${event.decisionId}`];
  if (event.schema === "task-event/v1") {
    const row = queryRows<{ readonly status: string | null; readonly disposition: string | null }>(
      db,
      "SELECT status,json_extract(snapshot_json,'$.task.packageDisposition') AS disposition FROM task_snapshot WHERE task_id=?",
      event.taskId,
    )[0];
    return row ? [`task/${event.taskId}`] : [];
  }
  if (event.schema === "doc-event/v1")
    return [
      ...new Set(
        event.payload.changes.flatMap(({ path }) => {
          const decisionId = path.match(/^decisions\/decision-([^/]+)\//u)?.[1],
            factId = path.match(/^facts\/(F-[^/]+)\.md$/u)?.[1];
          if (decisionId) return [`decision/${decisionId}`];
          if (factId) return [`fact/${factId}`];
          const row = queryRows<{ readonly task_id: string }>(
            db,
            "SELECT task_id FROM task_package WHERE package_path=?",
            path.split("/").slice(0, 2).join("/"),
          )[0];
          return row ? [`task/${row.task_id}`] : [];
        }),
      ),
    ];
  return [];
}

export function projectEntityDocumentRematerialization(
  db: DatabaseSync,
  event: EntityDocumentEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
): void {
  runSql(
    db,
    "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)",
    event.opId,
    event.workspaceRevision,
    eventJson,
  );
  for (const claim of event.payload.documentClaims) {
    const bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`rematerialized document blob ${claim.sha256} is unavailable`);
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
    if (claim.policyId === DECISION_DOCUMENT_POLICY_ID) refreshDecisionDocumentSearch(db, document);
  }
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
      (claim.policyId === DECISION_DOCUMENT_POLICY_ID &&
        !/^decisions\/decision-[^/]+\/decision\.md$/u.test(claim.path)) ||
      (claim.policyId === FACT_DOCUMENT_POLICY_ID && !/^facts\/F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u.test(claim.path))
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
    if (claim.policyId === DECISION_DOCUMENT_POLICY_ID) refreshDecisionDocumentSearch(db, document);
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
      "INSERT INTO decision(decision_id, legacy_number, decision_sort_key, state, title, question, risk_tier, urgency, vertical, preset, decision_class, applies_json, proposer_json, arbiter_json, proposed_at, decided_at, provenance_json, workspace_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      value.decisionId,
      decisionLegacyNumber(value.decisionId),
      decisionIdSortKey(value.decisionId),
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
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-write-model.sqlite-database */
    db
      .prepare("SELECT json_type(snapshot_json, '$.task') AS task_type FROM task_snapshot WHERE task_id = ?")
      .get(taskId) as { readonly task_type: string | null } | undefined;
  return row !== undefined && row.task_type !== null && row.task_type !== "null";
}

/** One projection-only upgrade: classify existing current rows, never replay event history. */
export function initializeTerminalMaterialization(db: DatabaseSync): void {
  const key = "terminal-materialization-v1";
  if (queryRows(db, "SELECT 1 FROM projection_maintenance WHERE key=?", key).length) return;
  const refs = queryRows<{ ref: string }>(
    db,
    "SELECT 'fact/'||fact_id AS ref FROM fact UNION ALL SELECT 'decision/'||decision_id FROM decision UNION ALL SELECT 'task/'||task_id FROM task_snapshot",
  ).map(({ ref }) => ref);
  const candidates = refreshMaterializationHolds(db, refs);
  const revision = Number(queryRows(db, "SELECT watermark FROM projection_meta WHERE singleton=1")[0]?.watermark ?? 0);
  settleTerminalMaterialization(db, candidates, revision);
  runSql(
    db,
    "INSERT INTO projection_maintenance(key,completed_at) VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    key,
  );
}
