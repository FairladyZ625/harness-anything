import type { DossierSynthesisEventV1 } from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import { assertTaskProgressReferences } from "@harness-anything/kernel/internal/domain/storage-replay-policy.ts";
import { FACT_DOCUMENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  DECISION_DOCUMENT_POLICY_ID,
  decisionDocumentProse,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { currentTaskForWrite } from "@harness-anything/kernel/internal/domain/task.ts";
import {
  docByteLength,
  isFactEvent,
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
import {
  canonicalJson,
  decisionDocumentPattern,
  hydrateEventsByRevisions,
  queryRows,
  runSql,
  serializeProjectedDocument,
  type BatchEventsByRevisionsReader,
  type ProjectedDocumentMetadata,
} from "./rebuildable-task-projection-sql.ts";
import { projectInterpretedEntityValue } from "./rebuildable-task-projection-entities.ts";
import { readRuntimeSession, readSnapshot } from "./rebuildable-task-projection-runtime.ts";
import { applyRelationProjectionEvent } from "./relation-entity-projection.ts";
import {
  archivedFactDocumentPreimage,
  canonicalDocumentClaims,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import {
  insertEventIndexRow,
  readDocumentBaseMetadata,
  recordDocumentArchive,
  recordDocumentDelete,
  recordDocumentHistoryDelete,
  recordDocumentHistoryUpsert,
  recordDocumentUpsert,
} from "./bulk-rebuild-state.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "@harness-anything/kernel";

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
function blobByteLength(
  sha256: string,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
): number | null {
  return readBlobSize ? readBlobSize(sha256) : (readBlob(sha256)?.byteLength ?? null);
}

function upsertDocument(db: DatabaseSync, path: string, revision: number, document: ProjectedDocumentMetadata): void {
  runSql(db, UPSERT_DOCUMENT_SQL, path, revision, serializeProjectedDocument(document));
  recordDocumentUpsert(db, path, document);
}
function archiveDocument(db: DatabaseSync, path: string, revision: number): void {
  runSql(db, ARCHIVE_DOCUMENT_SQL, revision, path);
  runSql(db, "DELETE FROM document WHERE path = ?", path);
  recordDocumentArchive(db, path);
}
function storeHistoricalDocument(db: DatabaseSync, document: ProjectedDocumentMetadata): void {
  runSql(
    db,
    "INSERT INTO document_history(path, workspace_revision, value_json) VALUES (?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json",
    document.path,
    document.workspaceRevision,
    serializeProjectedDocument(document),
  );
  runSql(db, "DELETE FROM document WHERE path = ?", document.path);
  recordDocumentHistoryUpsert(db, document.path, document);
  recordDocumentDelete(db, document.path);
}
function upsertActiveDocument(
  db: DatabaseSync,
  path: string,
  revision: number,
  document: ProjectedDocumentMetadata,
): void {
  runSql(db, "DELETE FROM document_history WHERE path = ?", path);
  recordDocumentHistoryDelete(db, path);
  upsertDocument(db, path, revision, document);
}

// Progress, fact, and decision materialized-write handlers.
export function projectProgress(
  db: DatabaseSync,
  event: TaskProgressEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
): void {
  const taskId = event.payload.taskId,
    snapshot = readSnapshot(db, taskId),
    packagePath = queryRows(db, "SELECT package_path FROM task_package WHERE task_id = ?", taskId)[0]?.package_path,
    claim = event.payload.resultDocumentClaim,
    base = readDocumentBaseMetadata(db, claim.path),
    resultSize = blobByteLength(claim.sha256, readBlob, readBlobSize),
    runtimeSessionIdValue = event.payload.runtimeSessionId,
    runtime = runtimeSessionIdValue ? readRuntimeSession(db, runtimeSessionIdValue) : null;
  // Admission checks the current lease. Replay checks accepted fact references, not today's authority.
  assertTaskProgressReferences(snapshot, event, packagePath, runtime);
  if (event.payload.baseDocumentSha256 !== (base?.blobSha256 ?? null) || resultSize !== claim.size)
    throw new Error(`progress document base or blob mismatch for task ${taskId}`);
  const document: ProjectedDocumentMetadata = {
    path: claim.path as DocumentState["path"],
    blobSha256: claim.sha256,
    size: docByteLength(claim.size),
    mediaType: claim.mediaType,
    policyId: claim.policyId,
    workspaceRevision: event.workspaceRevision,
  };
  insertEventIndexRow(db, event.opId, event.workspaceRevision, taskId, eventJson, event);
  runSql(
    db,
    "INSERT INTO task_progress(workspace_revision, task_id, execution_id, event_json) VALUES (?, ?, ?, ?)",
    event.workspaceRevision,
    taskId,
    event.payload.executionId,
    eventJson,
  );
  upsertDocument(db, claim.path, event.workspaceRevision, document);
  for (const change of event.payload.carriedDocumentClaims ?? []) {
    const carriedBase = readDocumentBaseMetadata(db, change.path),
      needsSearchBody = change.policyId === DECISION_DOCUMENT_POLICY_ID || decisionDocumentPattern.test(change.path);
    let carriedBody: string | undefined;
    if (needsSearchBody) {
      const carriedBytes = readBlob(change.candidate.sha256);
      if (!carriedBytes || carriedBytes.byteLength !== change.candidate.size)
        throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
      try {
        carriedBody = new TextDecoder("utf-8", { fatal: true }).decode(carriedBytes);
      } catch {
        throw new Error(`carried document blob ${change.candidate.sha256} is not UTF-8`);
      }
    } else {
      const carriedSize = blobByteLength(change.candidate.sha256, readBlob, readBlobSize);
      if (carriedSize !== change.candidate.size)
        throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
    }
    if (change.baseBlobSha256 !== (carriedBase?.blobSha256 ?? null))
      throw new Error(`carried document proof mismatch for ${change.path}`);
    const carriedDocument: ProjectedDocumentMetadata = {
      path: change.path as DocumentState["path"],
      blobSha256: change.candidate.sha256,
      size: docByteLength(change.candidate.size),
      mediaType: change.candidate.mediaType,
      policyId: change.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    upsertDocument(db, change.path, event.workspaceRevision, carriedDocument);
    if (needsSearchBody) refreshDecisionDocumentSearch(db, { path: change.path, body: carriedBody });
  }
}

export function projectFact(
  db: DatabaseSync,
  event: FactEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
): void {
  if (event.type === "fact_archived") {
    const retirement = event.payload.factsDocumentRetirement,
      base = readDocumentBaseMetadata(db, retirement?.path ?? "");
    if (
      !retirement ||
      retirement.path !== `facts/${event.factId}.md` ||
      retirement.sha256 !== (base?.blobSha256 ?? null)
    )
      throw new Error(`archived fact document path or base mismatch for ${event.factId}`);
    reduceFactEvent(db, event);
    insertEventIndexRow(db, event.opId, event.workspaceRevision, event.taskId ?? null, eventJson, event);
    if (!factMaterializationHeld(db, `fact/${event.factId}`, "archived"))
      archiveDocument(db, retirement.path, event.workspaceRevision);
    return;
  }
  const claim = event.payload.factsDocumentClaim;
  if (!claim) throw new Error(`fact document claim missing for ${event.factId}`);
  const factSize = blobByteLength(claim.sha256, readBlob, readBlobSize);
  if (claim.path !== `facts/${event.factId}.md` || factSize !== claim.size)
    throw new Error(`fact document path or blob mismatch for ${event.factId}`);
  reduceFactEvent(db, event);
  const document: ProjectedDocumentMetadata = {
    path: claim.path as DocumentState["path"],
    blobSha256: claim.sha256,
    size: docByteLength(claim.size),
    mediaType: claim.mediaType,
    policyId: claim.policyId,
    workspaceRevision: event.workspaceRevision,
  };
  insertEventIndexRow(db, event.opId, event.workspaceRevision, event.taskId ?? null, eventJson, event);
  upsertActiveDocument(db, claim.path, event.workspaceRevision, document);
  const supersededClaim = event.payload.supersededFactsDocumentClaim;
  if (!supersededClaim) return;
  const supersededSize = blobByteLength(supersededClaim.sha256, readBlob, readBlobSize);
  if (supersededSize !== supersededClaim.size)
    throw new Error(`superseded fact document blob ${supersededClaim.sha256} is unavailable`);
  const supersededDocument: ProjectedDocumentMetadata = {
    path: supersededClaim.path as DocumentState["path"],
    blobSha256: supersededClaim.sha256,
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
  readBlobSize?: EventStreamPort["readContentBlobSize"],
  readDecisionBlob?: EventStreamPort["readContentBlob"],
  precomputedDecisionProse?: Map<string, string>,
): void {
  const claim = event.payload.decisionDocumentClaim,
    previous = readDocumentBaseMetadata(db, claim.path),
    bytes = readBlob(claim.sha256);
  if (
    claim.path !== `decisions/decision-${event.decisionId}/decision.md` ||
    event.payload.baseDocumentSha256 !== (previous?.blobSha256 ?? null) ||
    !bytes ||
    bytes.byteLength !== claim.size
  )
    throw new Error(`decision document path, base, or blob mismatch for ${event.decisionId}`);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const prose = decisionDocumentProse(body);
  precomputedDecisionProse?.set(event.decisionId, prose);
  reduceDecisionEvent(db, event, readDecisionBlob ?? readBlob, prose);
  const state = readDecisionDocumentState(db, event.decisionId);
  if (!state) throw new Error(`decision projection missing for ${event.decisionId}`);
  const document: ProjectedDocumentMetadata = {
    path: claim.path as DocumentState["path"],
    blobSha256: claim.sha256,
    size: docByteLength(claim.size),
    mediaType: claim.mediaType,
    policyId: claim.policyId,
    workspaceRevision: event.workspaceRevision,
  };
  insertEventIndexRow(db, event.opId, event.workspaceRevision, null, eventJson, event);
  const terminal = (terminalDecisionMaterializationStates as readonly string[]).includes(state.state),
    held = terminal && decisionMaterializationHeld(db, event.decisionId, state.state);
  if (terminal && !held) {
    storeHistoricalDocument(db, document);
  } else {
    upsertActiveDocument(db, claim.path, event.workspaceRevision, document);
    refreshDecisionDocumentSearch(db, { path: claim.path, body });
  }
  if (event.type === "decision_review_recorded")
    for (const change of event.payload.carriedDocumentClaims ?? []) {
      const carriedBase = readDocumentBaseMetadata(db, change.path),
        needsSearchBody = change.policyId === DECISION_DOCUMENT_POLICY_ID || decisionDocumentPattern.test(change.path);
      let carriedBody: string | undefined;
      if (needsSearchBody) {
        const carriedBytes = readBlob(change.candidate.sha256);
        if (!carriedBytes || carriedBytes.byteLength !== change.candidate.size)
          throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
        carriedBody = new TextDecoder("utf-8", { fatal: true }).decode(carriedBytes);
      } else {
        const carriedSize = blobByteLength(change.candidate.sha256, readBlob, readBlobSize);
        if (carriedSize !== change.candidate.size)
          throw new Error(`carried document blob ${change.candidate.sha256} is unavailable`);
      }
      if (change.baseBlobSha256 !== (carriedBase?.blobSha256 ?? null))
        throw new Error(`carried document proof mismatch for ${change.path}`);
      const carriedDocument: ProjectedDocumentMetadata = {
        path: change.path as DocumentState["path"],
        blobSha256: change.candidate.sha256,
        size: docByteLength(change.candidate.size),
        mediaType: change.candidate.mediaType,
        policyId: change.policyId,
        workspaceRevision: event.workspaceRevision,
      };
      if (terminal && !held) storeHistoricalDocument(db, carriedDocument);
      else {
        upsertActiveDocument(db, change.path, event.workspaceRevision, carriedDocument);
        if (needsSearchBody) refreshDecisionDocumentSearch(db, { path: change.path, body: carriedBody });
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
      if (row) settleDocumentPrefix(db, `facts/${fact}.md`, revision, !terminal || held(ref), false, !!terminal);
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
          true,
          (terminalDecisionMaterializationStates as readonly string[]).includes(state.state),
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
          true,
          ["done", "cancelled"].includes(task.status) || task.packageDisposition === "archived",
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
  refreshActive = false,
): void {
  if (active && refreshActive)
    runSql(
      db,
      `UPDATE document SET workspace_revision=? WHERE ${subtree ? "path>=? AND path<?" : "path=?"} AND workspace_revision<?`,
      revision,
      ...(subtree ? [prefix, `${prefix.slice(0, -1)}0`] : [prefix]),
      revision,
    );
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
  event: EntityDocumentEventV1 | DossierSynthesisEventV1,
  eventJson: string,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
): void {
  insertEventIndexRow(db, event.opId, event.workspaceRevision, null, eventJson, event);
  for (const claim of event.payload.documentClaims) {
    const needsSearchBody = claim.policyId === DECISION_DOCUMENT_POLICY_ID || decisionDocumentPattern.test(claim.path);
    let body: string | undefined;
    if (needsSearchBody) {
      const bytes = readBlob(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size)
        throw new Error(`rematerialized document blob ${claim.sha256} is unavailable`);
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      const size = blobByteLength(claim.sha256, readBlob, readBlobSize);
      if (size !== claim.size) throw new Error(`rematerialized document blob ${claim.sha256} is unavailable`);
    }
    const document: ProjectedDocumentMetadata = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    upsertDocument(db, claim.path, event.workspaceRevision, document);
    if (needsSearchBody) refreshDecisionDocumentSearch(db, { path: claim.path, body });
  }
}
export function projectRelationDocuments(
  db: DatabaseSync,
  event: RelationEventV1,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
): void {
  for (const claim of event.payload.documentClaims ?? []) {
    const needsSearchBody = claim.policyId === DECISION_DOCUMENT_POLICY_ID || decisionDocumentPattern.test(claim.path);
    let body: string | undefined;
    if (needsSearchBody) {
      const bytes = readBlob(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size)
        throw new Error(`relation document blob ${claim.sha256} is unavailable`);
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      const size = blobByteLength(claim.sha256, readBlob, readBlobSize);
      if (size !== claim.size) throw new Error(`relation document blob ${claim.sha256} is unavailable`);
    }
    if (
      (claim.policyId === DECISION_DOCUMENT_POLICY_ID &&
        !/^decisions\/decision-[^/]+\/decision\.md$/u.test(claim.path)) ||
      (claim.policyId === FACT_DOCUMENT_POLICY_ID && !/^facts\/F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u.test(claim.path))
    )
      throw new Error(`relation document path ${claim.path} does not match its policy`);
    const document: ProjectedDocumentMetadata = {
      path: claim.path as DocumentState["path"],
      blobSha256: claim.sha256,
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision: event.workspaceRevision,
    };
    upsertDocument(db, claim.path, event.workspaceRevision, document);
    if (needsSearchBody) refreshDecisionDocumentSearch(db, { path: claim.path, body });
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
  readBlobSize?: EventStreamPort["readContentBlobSize"],
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
  insertEventIndexRow(db, event.opId, event.workspaceRevision, taskId, eventJson, event);
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
    storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
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
    const decisionBody = storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize, true);
    refreshDecisionDocumentSearch(db, { path: entity.documentClaim.path, body: decisionBody });
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
    storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
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
    storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
    return;
  }
  if (entity.kind === "task-document") {
    if (!hasTaskSnapshot(db, entity.taskId))
      throw new Error(`migration task document owner is missing for ${entity.taskId}`);
    storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
    return;
  }
  if (entity.kind === "repo-document") {
    storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
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
  storeMigrationDocument(db, event, entity.documentClaim, readBlob, readBlobSize);
}
export function storeMigrationDocument(
  db: DatabaseSync,
  event: MigrationImportEventV1,
  claim: MigrationDocumentClaim,
  readBlob: EventStreamPort["readContentBlob"],
  readBlobSize?: EventStreamPort["readContentBlobSize"],
  decodeBody = false,
): string | undefined {
  let body: string | undefined;
  if (decodeBody) {
    const bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`migration document blob ${claim.sha256} is unavailable`);
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else {
    const size = blobByteLength(claim.sha256, readBlob, readBlobSize);
    if (size !== claim.size) throw new Error(`migration document blob ${claim.sha256} is unavailable`);
  }
  const document: ProjectedDocumentMetadata = {
    path: claim.path as DocumentState["path"],
    blobSha256: claim.sha256,
    size: docByteLength(claim.size),
    mediaType: claim.mediaType,
    policyId: claim.policyId,
    workspaceRevision: event.workspaceRevision,
  };
  upsertDocument(db, claim.path, event.workspaceRevision, document);
  return body;
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

/** Upgrade derived membership and recover archived descriptors without replaying event reducers. */
export function initializeTerminalMaterialization(
  db: DatabaseSync,
  readBlob?: EventStreamPort["readContentBlob"],
  readEventsByRevisions?: BatchEventsByRevisionsReader,
): void {
  const key = "terminal-materialization-v2";
  if (!queryRows(db, "SELECT 1 FROM projection_maintenance WHERE key=?", key).length) {
    const refs = queryRows<{ ref: string }>(
      db,
      "SELECT 'fact/'||fact_id AS ref FROM fact UNION ALL SELECT 'decision/'||decision_id FROM decision UNION ALL SELECT 'task/'||task_id FROM task_snapshot",
    ).map(({ ref }) => ref);
    const candidates = refreshMaterializationHolds(db, refs);
    const revision = Number(
      queryRows(db, "SELECT watermark FROM projection_meta WHERE singleton=1")[0]?.watermark ?? 0,
    );
    settleTerminalMaterialization(db, candidates, revision);
    runSql(
      db,
      "INSERT INTO projection_maintenance(key,completed_at) VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      key,
    );
  }
  const historyKey = "terminal-materialization-history-v1";
  if (queryRows(db, "SELECT 1 FROM projection_maintenance WHERE key=?", historyKey).length) return;
  const missing = queryRows<{ fact_id: string; workspace_revision: number }>(
    db,
    `SELECT fact_id,workspace_revision FROM fact WHERE json_extract(row_json,'$.archived')=1
      AND NOT EXISTS (SELECT 1 FROM document WHERE path='facts/'||fact.fact_id||'.md')
      AND NOT EXISTS (SELECT 1 FROM document_history WHERE path='facts/'||fact.fact_id||'.md')`,
  );
  const pending = new Map<string, { events: readonly PersistedCanonicalEventV1[]; resolved: boolean }>();
  if (!readBlob && missing.length) return;
  const restore = (factId: string, preimage: NonNullable<ReturnType<typeof archivedFactDocumentPreimage>>) => {
    const bytes = readBlob?.(preimage.document.blobSha256);
    if (!bytes || bytes.byteLength !== preimage.document.size)
      throw new Error(`projection document blob ${preimage.document.blobSha256} is unavailable`);
    upsertActiveDocument(db, preimage.document.path, preimage.retiredAt, preimage.document);
    if (!factMaterializationHeld(db, `fact/${factId}`, "archived"))
      archiveDocument(db, preimage.document.path, preimage.retiredAt);
  };
  for (const row of missing) {
    const revisions = queryRows<{ readonly workspace_revision: number }>(
      db,
      `SELECT r.workspace_revision FROM event_summary_entity_ref AS r
          WHERE r.entity_ref=? AND r.workspace_revision<=? ORDER BY r.workspace_revision DESC`,
      `fact/${row.fact_id}`,
      row.workspace_revision,
    ).map(({ workspace_revision }) => Number(workspace_revision));
    const hydrated = hydrateEventsByRevisions(revisions, readEventsByRevisions);
    const events = revisions.map((rev) => hydrated.get(rev)! as PersistedCanonicalEventV1);
    pending.set(`facts/${row.fact_id}.md`, {
      events: events.filter((event) => event.type === "fact_archived"),
      resolved: false,
    });
  }
  // Legacy imports and generic document writes have no Fact entity ref. Resolve these only
  // once during upgrade, in revision order, without replaying reducers or buffering history.
  let remaining = pending.size;
  if (remaining) {
    let beforeRevision = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const revisions = queryRows<{ readonly workspace_revision: number }>(
        db,
        "SELECT workspace_revision FROM event_index WHERE workspace_revision < ? ORDER BY workspace_revision DESC LIMIT 256",
        beforeRevision,
      ).map(({ workspace_revision }) => Number(workspace_revision));
      if (revisions.length === 0) break;
      const hydrated = hydrateEventsByRevisions(revisions, readEventsByRevisions);
      for (const rev of revisions) {
        const event = hydrated.get(rev)! as PersistedCanonicalEventV1;
        for (const claim of [
          ...canonicalDocumentClaims(event),
          ...(isFactEvent(event) && event.payload.supersededFactsDocumentClaim
            ? [event.payload.supersededFactsDocumentClaim]
            : []),
        ]) {
          const target = pending.get(claim.path);
          if (!target || target.resolved) continue;
          const factId = claim.path.slice(6, -3),
            preimage = archivedFactDocumentPreimage([...target.events, event], factId);
          if (preimage) {
            restore(factId, preimage);
            target.resolved = true;
            remaining--;
          }
        }
        if (!remaining) break;
      }
      if (!remaining) break;
      beforeRevision = revisions.at(-1)!;
    }
  }
  if (remaining)
    throw new Error(
      `archived Fact document descriptors unavailable: ${[...pending]
        .filter(([, target]) => !target.resolved)
        .map(([path]) => path)
        .join(", ")}`,
    );
  runSql(
    db,
    "INSERT INTO projection_maintenance(key,completed_at) VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    historyKey,
  );
}
