import type { PoolClient } from "pg";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { isTaskEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { isFactEvent, type FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { isDecisionEvent, type DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  embeddedRelationEventsForReplay,
  isRelationEvent,
  reduceRelationEntity,
  type RelationEntity,
  type RelationEventV1,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  reduceDecisionDocument,
  type DecisionDocumentState,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "./pg-projection-schema.ts";

export interface PgProjectionScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyEpoch: number;
  readonly readers?: readonly string[];
}

export interface PgProjectionEventInput {
  readonly event: PersistedCanonicalEventV1;
  /** A2 can provide the canonical revision when the event envelope is read from a ledger row. */
  readonly sourceRevision?: number;
}

export interface PgProjectionMaterializationReceipt {
  readonly revision: number;
  readonly taskId: string | null;
  readonly snapshot: TaskLifecycleSnapshot | null;
  readonly tables: readonly string[];
}

export interface PgProjectionRebuildInput {
  readonly events: readonly PersistedCanonicalEventV1[];
  readonly sourceRevision?: number;
  readonly stateDigest?: `sha256:${string}`;
}

/** Materialize one canonical event in the caller's existing transaction; schema setup is a migration concern. */
export async function materializePgProjectionEvent(
  client: PoolClient,
  scope: PgProjectionScope,
  input: PgProjectionEventInput,
): Promise<PgProjectionMaterializationReceipt> {
  const event = input.event,
    revision = input.sourceRevision ?? event.workspaceRevision,
    tables = new Set<string>();
  let snapshot: TaskLifecycleSnapshot | null = null,
    taskId: string | null = null;
  if (isTaskEvent(event)) {
    taskId = event.taskId;
    snapshot = await reduceAndStoreTaskSnapshot(client, scope, event, tables);
    for (const relationEvent of embeddedRelationEventsForReplay(event)) {
      await storeRelation(client, scope, relationEvent, tables);
    }
  } else if (isFactEvent(event)) {
    await storeFact(client, scope, event, tables);
    for (const relationEvent of embeddedRelationEventsForReplay(event)) {
      await storeRelation(client, scope, relationEvent, tables);
    }
  } else if (isDecisionEvent(event)) {
    await storeDecision(client, scope, event, tables);
    for (const relationEvent of embeddedRelationEventsForReplay(event)) {
      await storeRelation(client, scope, relationEvent, tables);
    }
  } else if (isRelationEvent(event)) {
    await storeRelation(client, scope, event, tables);
  }
  await updateProjectionMeta(client, scope, revision, input.sourceRevision ?? revision);
  return { revision, taskId, snapshot, tables: [...tables].sort() };
}

/** Rebuild the projection from an ordered canonical event stream. Existing projection rows are discarded. */
export async function rebuildPgProjection(
  client: PoolClient,
  scope: PgProjectionScope,
  input: PgProjectionRebuildInput,
): Promise<PgProjectionMaterializationReceipt> {
  const scopeValues = [scope.tenantId, scope.projectId, scope.policyEpoch];
  for (const table of ["ha_task_snapshots", "ha_decisions", "ha_facts", "ha_relations", "ha_projection_meta"])
    await client.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3`,
      scopeValues,
    );
  let receipt: PgProjectionMaterializationReceipt = {
    revision: 0,
    taskId: null,
    snapshot: null,
    tables: [],
  };
  for (const event of [...input.events].sort((left, right) => left.workspaceRevision - right.workspaceRevision))
    receipt = await materializePgProjectionEvent(client, scope, { event });
  if (input.stateDigest !== undefined)
    await client.query(
      `UPDATE ha_projection_meta SET state_digest = $1, source_revision = $2, schema_version = $3
       WHERE tenant_id = $4 AND project_id = $5 AND policy_epoch = $6 AND projection_name = 'task/v1'`,
      [
        input.stateDigest,
        input.sourceRevision ?? receipt.revision,
        PG_PROJECTION_SCHEMA_VERSION,
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
      ],
    );
  return receipt;
}

async function reduceAndStoreTaskSnapshot(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "task-event/v1" }>,
  tables: Set<string>,
): Promise<TaskLifecycleSnapshot> {
  const existing = await client.query<{ readonly snapshot: TaskLifecycleSnapshot }>(
    `SELECT snapshot FROM ha_task_snapshots
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, event.taskId],
  );
  const previous = existing.rows[0]?.snapshot ?? emptyTaskLifecycleSnapshot(0),
    snapshot = reduceTaskEvent(previous, event);
  await client.query(
    `INSERT INTO ha_task_snapshots
       (tenant_id, project_id, policy_epoch, readers, task_id, workspace_revision, snapshot, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, task_id) DO UPDATE SET
       policy_epoch = excluded.policy_epoch,
       readers = excluded.readers,
       workspace_revision = excluded.workspace_revision,
       snapshot = excluded.snapshot,
       updated_at = excluded.updated_at
     WHERE ha_task_snapshots.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      event.taskId,
      snapshot.revision,
      JSON.stringify(snapshot),
    ],
  );
  tables.add("ha_task_snapshots");
  return snapshot;
}

async function storeFact(
  client: PoolClient,
  scope: PgProjectionScope,
  event: FactEventV1,
  tables: Set<string>,
): Promise<void> {
  const current = await client.query<{ readonly value: Record<string, unknown> }>(
    `SELECT value FROM ha_facts WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND fact_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, event.factId],
  );
  if (current.rows.length === 0 && event.type !== "fact_recorded")
    throw new Error(`Cannot ${event.type} missing fact ${event.factId}.`);
  const prior = current.rows[0]?.value ?? {};
  const value =
    event.type === "fact_archived" || event.type === "fact_unarchived"
      ? { ...prior, archived: event.type === "fact_archived", workspaceRevision: event.workspaceRevision }
      : event.type === "fact_reclassified"
        ? { ...prior, domainTypes: event.payload.domainTypes, workspaceRevision: event.workspaceRevision }
        : {
            schema: "fact-row/v1",
            ref: `fact/${event.factId}`,
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            factId: event.factId,
            statement: event.payload.statement,
            evidenceSource: event.payload.evidenceSource,
            observedAt: event.payload.observedAt,
            ...(event.payload.observedCommit === undefined ? {} : { observedCommit: event.payload.observedCommit }),
            confidence: event.payload.confidence,
            ...(event.payload.domainTypes === undefined ? {} : { domainTypes: event.payload.domainTypes }),
            memoryClass: event.payload.memoryClass,
            memoryTags: event.payload.memoryTags,
            provenance: event.payload.provenance,
            actor: event.actor,
            source: event.source,
            occurredAt: event.occurredAt,
            workspaceRevision: event.workspaceRevision,
            state: "standing",
            invalidated: false,
            archived: false,
          };
  await client.query(
    `INSERT INTO ha_facts
       (tenant_id, project_id, policy_epoch, readers, fact_id, workspace_revision, value, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, fact_id) DO UPDATE SET
       policy_epoch = excluded.policy_epoch, readers = excluded.readers, workspace_revision = excluded.workspace_revision,
       value = excluded.value, updated_at = excluded.updated_at
     WHERE ha_facts.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      event.factId,
      event.workspaceRevision,
      JSON.stringify(value),
    ],
  );
  tables.add("ha_facts");
}

async function storeDecision(
  client: PoolClient,
  scope: PgProjectionScope,
  event: DecisionEventV1,
  tables: Set<string>,
): Promise<void> {
  const decisionId = event.decisionId;
  const current = await client.query<{ readonly value: DecisionDocumentState }>(
    `SELECT value FROM ha_decisions
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND decision_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, decisionId],
  );
  const value = reduceDecisionDocument(current.rows[0]?.value ?? null, event);
  await client.query(
    `INSERT INTO ha_decisions
       (tenant_id, project_id, policy_epoch, readers, decision_id, workspace_revision, value, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, decision_id) DO UPDATE SET
       policy_epoch = excluded.policy_epoch, readers = excluded.readers, workspace_revision = excluded.workspace_revision,
       value = excluded.value, updated_at = excluded.updated_at
     WHERE ha_decisions.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      decisionId,
      event.workspaceRevision,
      JSON.stringify(value),
    ],
  );
  tables.add("ha_decisions");
}

async function storeRelation(
  client: PoolClient,
  scope: PgProjectionScope,
  event: RelationEventV1,
  tables: Set<string>,
): Promise<void> {
  const previous = await client.query<{ readonly value: Record<string, unknown> }>(
    `SELECT value FROM ha_relations WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND relation_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, event.relationId],
  );
  const current = (previous.rows[0]?.value ?? null) as unknown as RelationEntity | null;
  const relation = reduceRelationEntity(current, event);
  const value = {
    ...relation,
    sourcePath: `event:${event.opId}`,
    recordIndex: 0,
  };
  await client.query(
    `INSERT INTO ha_relations
       (tenant_id, project_id, policy_epoch, readers, relation_id, source_ref, target_ref, relation_type, relation_state,
        workspace_revision, value, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::jsonb, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, relation_id) DO UPDATE SET
       policy_epoch = excluded.policy_epoch, readers = excluded.readers, source_ref = excluded.source_ref, target_ref = excluded.target_ref,
       relation_type = excluded.relation_type, relation_state = excluded.relation_state,
       workspace_revision = excluded.workspace_revision, value = excluded.value, updated_at = excluded.updated_at
     WHERE ha_relations.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      event.relationId,
      relation.source,
      relation.target,
      relation.type,
      relation.state,
      event.workspaceRevision,
      JSON.stringify(value),
    ],
  );
  tables.add("ha_relations");
}

async function updateProjectionMeta(
  client: PoolClient,
  scope: PgProjectionScope,
  watermark: number,
  sourceRevision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ha_projection_meta
       (tenant_id, project_id, policy_epoch, readers, projection_name, schema_version, watermark, source_revision, state_digest, updated_at)
     VALUES ($1, $2, $3, $4::text[], 'task/v1', $5, $6, $7, NULL, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, projection_name) DO UPDATE SET
       policy_epoch = excluded.policy_epoch, readers = excluded.readers, schema_version = excluded.schema_version,
       watermark = GREATEST(ha_projection_meta.watermark, excluded.watermark),
       source_revision = GREATEST(ha_projection_meta.source_revision, excluded.source_revision),
       updated_at = excluded.updated_at`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      PG_PROJECTION_SCHEMA_VERSION,
      watermark,
      sourceRevision,
    ],
  );
}

export function projectionStateDigest(snapshots: readonly TaskLifecycleSnapshot[]): `sha256:${string}` {
  const ordered = [...snapshots].sort((left, right) => {
    const leftId = left.task?.taskId ?? "";
    const rightId = right.task?.taskId ?? "";
    return leftId.localeCompare(rightId);
  });
  return `sha256:${sha256Text(JSON.stringify(ordered))}`;
}
