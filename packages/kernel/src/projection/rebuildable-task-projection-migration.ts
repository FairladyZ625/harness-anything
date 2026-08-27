// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import { docByteLength, type DocumentState } from "../domain/doc-sync.contract.ts";
import { requireEntityKindContract } from "../domain/entity-kind-registry.ts";
import { type MigrationDocumentClaim, type MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { refreshDecisionDocumentSearch } from "./decision-event-projection.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import { deriveRelationId } from "../domain/entity-relation.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { projectInterpretedEntityValue } from "./rebuildable-task-projection-entities.ts";
import { readSnapshot } from "./rebuildable-task-projection-runtime.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

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
const UPSERT_DOCUMENT_SQL = [
  "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
  "ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision,",
  "value_json=excluded.value_json",
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
        task: entity.task,
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
    if (value.taskId) {
      const produces = {
        source: `task/${value.taskId}`,
        target: ref,
        type: "produces" as const,
        direction: "directed" as const,
      };
      runSql(
        db,
        "INSERT OR IGNORE INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        deriveRelationId(produces),
        produces.source,
        produces.target,
        produces.type,
        "active",
        produces.source,
        event.workspaceRevision,
        JSON.stringify({
          relationId: deriveRelationId(produces),
          sourceRef: produces.source,
          targetRef: produces.target,
          relationType: produces.type,
          direction: produces.direction,
          strength: "strong",
          origin: "generated",
          state: "active",
          rationale: "Migrated fact owner.",
          ownerRef: produces.source,
          sourcePath: `event:${event.opId}`,
          recordIndex: 1,
        }),
      );
    }
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
    if (!readSnapshot(db, entity.taskId).task)
      throw new Error(`migration task document owner is missing for ${entity.taskId}`);
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "repo-document") {
    storeMigrationDocument(db, event, entity.documentClaim, readBlob);
    return;
  }
  if (entity.kind === "relation") {
    const value = entity.relation,
      edge = {
        relationId: value.relation_id,
        sourceRef: value.source,
        targetRef: value.target,
        relationType: value.type,
        direction: value.direction,
        strength: value.strength,
        origin: value.origin,
        state: value.state,
        rationale: value.rationale,
        ownerRef: entity.ownerRef,
        sourcePath: `event:${event.opId}`,
        recordIndex: 0,
      };
    runSql(
      db,
      "INSERT OR IGNORE INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      edge.relationId,
      edge.sourceRef,
      edge.targetRef,
      edge.relationType,
      edge.state,
      edge.ownerRef,
      event.workspaceRevision,
      JSON.stringify(edge),
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
  if (sha256Text(body) !== claim.sha256) throw new Error(`migration document blob ${claim.sha256} hash mismatch`);
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
