import { readVersionedRelationsInTransaction } from "./pg-relation-queries.ts";
import { putPgProjectionValue } from "./pg-projection-values.ts";
import { derivedRelationRecordsForReplay } from "../projection/relation-entity-projection.ts";
import { materializePgQueryModels } from "./pg-query-model-materialize.ts";
import type { PoolClient } from "pg";
import {
  emptyTaskLifecycleSnapshot,
  initializeTaskLifecycleSnapshot,
  reduceTaskEvent,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import {
  isTaskEvent,
  isMigrationImportEvent,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { isFactEvent, type FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { isDecisionEvent, type DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  embeddedRelationEventsForReplay,
  isRelationEvent,
  reduceRelationEntity,
  type RelationEntity,
  type RelationEventV1,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import {
  reduceDecisionDocument,
  type DecisionDocumentState,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  PG_PROJECTION_SCHEMA_VERSION,
  PG_PROJECTION_TABLES,
  assertPgProjectionSchemaVersion,
} from "./pg-projection-schema.ts";
import { slugifyTaskTitle } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  isTaskBootstrapEvent,
  taskBootstrapPackagePath,
} from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import { isEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { isEntityEvent, isEntityDeclarationEvent } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import {
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
} from "@harness-anything/kernel/internal/domain/agent-squad-schema.ts";

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
  /** Durable ledger head observed by A2 for this commit cut. */
  readonly sourceHeadRevision?: number;
  /** Canonical content objects are read by A2 and supplied to replay; declarations are never trusted from event metadata. */
  readonly readContentBlob?: (sha256: string) => Uint8Array | null | Promise<Uint8Array | null>;
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
  readonly sourceHeadRevision?: number;
  readonly stateDigest?: `sha256:${string}`;
  readonly readContentBlob?: (sha256: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /** Restore each event's authorization metadata from the replay source when the scope contains several reader sets. */
  readonly readEventReaders?: (event: PersistedCanonicalEventV1) => readonly string[];
}

/** Materialize one canonical event in the caller's existing transaction; schema setup is a migration concern. */
export async function materializePgProjectionEvent(
  client: PoolClient,
  scope: PgProjectionScope,
  input: PgProjectionEventInput,
): Promise<PgProjectionMaterializationReceipt> {
  await admitProjectionGeneration(client, scope);
  return materializeProjectionEvent(client, scope, input);
}

async function admitProjectionGeneration(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  const result = await client.query<{ schema_version: number }>(
    "SELECT schema_version FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  assertPgProjectionSchemaVersion(result.rows[0]?.schema_version);
}

async function materializeProjectionEvent(
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
  } else if (isTaskBootstrapEvent(event)) {
    taskId = event.taskId;
    snapshot = await storeTaskBootstrap(client, scope, event, tables);
  } else if (isMigrationImportEvent(event)) {
    ({ taskId, snapshot } = await storeMigrationImport(client, scope, event, tables));
  } else if (isEntityPinEvent(event)) {
    await storeEntityPin(client, scope, event, tables);
  } else if (isEntityEvent(event)) {
    await storeEntityEvent(client, scope, event, tables, input.readContentBlob);
  }
  await storeEmbeddedRelations(client, scope, event, tables);
  await materializePgQueryModels(client, scope, input, snapshot);
  tables.add("ha_projection_values");
  await updateProjectionMeta(client, scope, revision, input.sourceHeadRevision ?? input.sourceRevision ?? revision);
  return { revision, taskId, snapshot, tables: [...tables].sort() };
}

/** A2's append hook calls this with the committed batch while still inside the ledger transaction. */
export async function materializePgProjectionEvents(
  client: PoolClient,
  scope: PgProjectionScope,
  input: { readonly revision: number; readonly events: readonly PersistedCanonicalEventV1[] },
): Promise<void> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    throw new TypeError("projection source head must be a non-negative safe integer");
  const last = input.events.at(-1);
  if (last && last.workspaceRevision !== input.revision)
    throw new Error("projection event batch does not end at its declared ledger head");
  const readContentBlob = async (sha256: string): Promise<Uint8Array | null> => {
    const result = await client.query<{ readonly body: Buffer }>(
      `SELECT body FROM ha_content_blobs
       WHERE tenant_id = $1 AND project_id = $2 AND sha256 = $3`,
      [scope.tenantId, scope.projectId, sha256],
    );
    const body = result.rows[0]?.body;
    return body === undefined ? null : Uint8Array.from(body);
  };
  await admitProjectionGeneration(client, scope);
  for (const event of input.events)
    await materializeProjectionEvent(client, scope, {
      event,
      sourceRevision: event.workspaceRevision,
      sourceHeadRevision: input.revision,
      readContentBlob,
    });
}

/** Rebuild the projection from an ordered canonical event stream. Existing projection rows are discarded. */
export async function rebuildPgProjection(
  client: PoolClient,
  scope: PgProjectionScope,
  input: PgProjectionRebuildInput,
): Promise<PgProjectionMaterializationReceipt> {
  const scopeValues = [scope.tenantId, scope.projectId, scope.policyEpoch];
  for (const table of PG_PROJECTION_TABLES)
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
    receipt = await materializeProjectionEvent(
      client,
      input.readEventReaders ? { ...scope, readers: input.readEventReaders(event) } : scope,
      {
        event,
        sourceHeadRevision: input.sourceHeadRevision ?? input.sourceRevision,
        readContentBlob: input.readContentBlob,
      },
    );
  const sourceHeadRevision = input.sourceHeadRevision ?? input.sourceRevision ?? receipt.revision,
    snapshots = await client.query<{ readonly snapshot: TaskLifecycleSnapshot }>(
      `SELECT snapshot FROM ha_task_snapshots
       WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 ORDER BY task_id`,
      scopeValues,
    ),
    stateDigest = input.stateDigest ?? projectionStateDigest(snapshots.rows.map(({ snapshot }) => snapshot));
  await updateProjectionMeta(client, scope, receipt.revision, sourceHeadRevision);
  await client.query(
    `UPDATE ha_projection_meta SET state_digest = $1, source_revision = $2, schema_version = $3
     WHERE tenant_id = $4 AND project_id = $5 AND policy_epoch = $6 AND projection_name = 'task/v1'`,
    [stateDigest, sourceHeadRevision, PG_PROJECTION_SCHEMA_VERSION, scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return receipt;
}

async function reduceAndStoreTaskSnapshot(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "task-event/v1" }>,
  tables: Set<string>,
): Promise<TaskLifecycleSnapshot> {
  const existing = await client.query<{
    readonly snapshot: TaskLifecycleSnapshot;
    readonly raw_lease: TaskLifecycleSnapshot["lease"];
  }>(
    `SELECT snapshot, raw_lease FROM ha_task_snapshots
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, event.taskId],
  );
  const previous = existing.rows[0]?.snapshot ?? emptyTaskLifecycleSnapshot(0),
    snapshot = reduceTaskEvent(previous, event);
  // The domain snapshot clears released leases; the raw query projection retains their CAS version.
  let rawLease = existing.rows[0]?.raw_lease ?? null;
  if (event.type === "execution_started") rawLease = { ...event.payload.lease, phase: "held" };
  else if (event.type === "lease_renewed") rawLease = event.payload.lease;
  else if (
    ((event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined) ||
      event.type === "lease_released" ||
      event.type === "task_completion_generation_retired") &&
    rawLease !== null &&
    rawLease.executionId === event.payload.execution.executionId
  )
    rawLease = { ...rawLease, phase: "released", version: rawLease.version + 1 };

  await client.query(
    `INSERT INTO ha_task_snapshots
       (tenant_id, project_id, policy_epoch, readers, task_id, workspace_revision, snapshot, raw_lease,
        package_path, generation, created_at, completed_at, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, $11::jsonb, $8, 'v1',
             COALESCE((SELECT created_at FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$5), $9::timestamptz),
       COALESCE((SELECT completed_at FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$5), CASE WHEN $10::text = 'task_completed' THEN $9::timestamptz END),
             $9::timestamptz)
     ON CONFLICT (tenant_id, project_id, policy_epoch, task_id) DO UPDATE SET
       policy_epoch = excluded.policy_epoch,
       readers = excluded.readers,
       workspace_revision = excluded.workspace_revision,
       snapshot = excluded.snapshot,
       raw_lease = excluded.raw_lease,
       package_path = COALESCE(excluded.package_path, ha_task_snapshots.package_path),
       generation = excluded.generation,
       created_at = COALESCE(ha_task_snapshots.created_at, excluded.created_at),
       completed_at = COALESCE(ha_task_snapshots.completed_at, excluded.completed_at),
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
      event.type === "task_created" ? `tasks/${event.taskId}-${slugifyTaskTitle(event.payload.task.title)}` : null,
      event.occurredAt,
      event.type,
      JSON.stringify(rawLease),
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
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, $8::timestamptz)
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
      event.occurredAt,
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
  const previous = current.rows[0]?.value ?? null,
    reduced = reduceDecisionDocument(previous, event),
    value: DecisionDocumentState = {
      ...reduced,
      ...("judgmentConsent" in event.payload && event.payload.judgmentConsent
        ? { judgmentConsents: [...(previous?.judgmentConsents ?? []), event.payload.judgmentConsent] }
        : {}),
      ...("contentPin" in event.payload && event.payload.contentPin
        ? { contentPins: [...(previous?.contentPins ?? []), event.payload.contentPin] }
        : {}),
      ...("amendment" in event.payload && event.payload.amendment
        ? { amendments: [...(previous?.amendments ?? []), event.payload.amendment] }
        : {}),
    };
  await client.query(
    `INSERT INTO ha_decisions
       (tenant_id, project_id, policy_epoch, readers, decision_id, workspace_revision, value, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, $8::timestamptz)
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
      event.occurredAt,
    ],
  );
  tables.add("ha_decisions");
}

async function storeRelation(
  client: PoolClient,
  scope: PgProjectionScope,
  originalEvent: RelationEventV1 | Extract<PersistedCanonicalEventV1, { readonly schema: "migration-import-event/v1" }>,
  tables: Set<string>,
): Promise<void> {
  const event = await relationEventWithTargetWitness(client, scope, originalEvent),
    relationId =
      event.schema === "migration-import-event/v1"
        ? event.payload.entity.kind === "relation"
          ? event.payload.entity.relation.relation_id
          : null
        : event.relationId;
  if (relationId === null) throw new Error("Relation projection received another migration entity kind");
  const previous = await client.query<{ readonly value: Record<string, unknown> }>(
    `SELECT value FROM ha_relations WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND relation_id = $4`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, relationId],
  );
  const current = (previous.rows[0]?.value ?? null) as unknown as RelationEntity | null;
  const relation = reduceRelationEntity(current, event);
  const workspaceRevision = event.workspaceRevision;
  const value = {
    ...relation,
    sourcePath: `event:${event.opId}`,
    recordIndex: 0,
  };
  await client.query(
    `INSERT INTO ha_relations
       (tenant_id, project_id, policy_epoch, readers, relation_id, source_ref, target_ref, relation_type, relation_state,
        workspace_revision, value, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
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
      relationId,
      relation.source,
      relation.target,
      relation.type,
      relation.state,
      workspaceRevision,
      JSON.stringify(value),
      event.occurredAt,
    ],
  );
  const projected = (
    await readVersionedRelationsInTransaction(client, scope, [...(scope.readers ?? [])], { relationId })
  )[0]!;
  await putPgProjectionValue(client, scope, "relation-write", relationId, "", workspaceRevision, projected);
  tables.add("ha_relations");
}

async function storeTaskBootstrap(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "task-bootstrap-event/v1" }>,
  tables: Set<string>,
): Promise<TaskLifecycleSnapshot> {
  const snapshot = initializeTaskLifecycleSnapshot(event);
  const packagePath = taskBootstrapPackagePath(event);
  await client.query(
    `INSERT INTO ha_task_snapshots
       (tenant_id, project_id, policy_epoch, readers, task_id, workspace_revision, snapshot,
        package_path, generation, created_at, completed_at, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, $8, 'v1', $9::timestamptz,
             NULL, $9::timestamptz)
     ON CONFLICT (tenant_id, project_id, policy_epoch, task_id) DO UPDATE SET
       workspace_revision = excluded.workspace_revision, snapshot = excluded.snapshot,
       package_path = excluded.package_path, generation = excluded.generation,
       created_at = COALESCE(ha_task_snapshots.created_at, excluded.created_at),
       completed_at = COALESCE(ha_task_snapshots.completed_at, excluded.completed_at),
       updated_at = excluded.updated_at
     WHERE ha_task_snapshots.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      event.taskId,
      event.workspaceRevision,
      JSON.stringify(snapshot),
      packagePath,
      event.occurredAt,
    ],
  );
  tables.add("ha_task_snapshots");
  return snapshot;
}

async function storeMigrationImport(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "migration-import-event/v1" }>,
  tables: Set<string>,
): Promise<{ readonly taskId: string | null; readonly snapshot: TaskLifecycleSnapshot | null }> {
  const entity = event.payload.entity;
  if (entity.kind === "task") {
    const snapshot = initializeTaskLifecycleSnapshot(event);
    await client.query(
      `INSERT INTO ha_task_snapshots
         (tenant_id, project_id, policy_epoch, readers, task_id, workspace_revision, snapshot,
          package_path, generation, created_at, completed_at, updated_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7::jsonb,$8,'v0',$9::timestamptz,
               NULL,$10::timestamptz)
       ON CONFLICT (tenant_id, project_id, policy_epoch, task_id) DO UPDATE SET
         workspace_revision=excluded.workspace_revision,snapshot=excluded.snapshot,
         package_path=excluded.package_path,generation='v0',updated_at=excluded.updated_at
       WHERE ha_task_snapshots.workspace_revision < excluded.workspace_revision`,
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        [...(scope.readers ?? [])],
        entity.task.taskId,
        event.workspaceRevision,
        JSON.stringify(snapshot),
        entity.packagePath,
        migrationCreatedAt(event),
        event.occurredAt,
      ],
    );
    tables.add("ha_task_snapshots");
    return { taskId: entity.task.taskId, snapshot };
  }
  if (entity.kind === "fact") {
    const value = {
      schema: "fact-row/v1",
      ref: `fact/${entity.fact.factId}`,
      ...entity.fact,
      actor: event.actor,
      source: event.source,
      occurredAt: event.occurredAt,
      workspaceRevision: event.workspaceRevision,
      state: "standing",
      invalidated: false,
      archived: false,
    };
    await client.query(
      `INSERT INTO ha_facts (tenant_id,project_id,policy_epoch,readers,fact_id,workspace_revision,value,updated_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7::jsonb,$8::timestamptz)
       ON CONFLICT (tenant_id,project_id,policy_epoch,fact_id) DO UPDATE SET workspace_revision=excluded.workspace_revision,value=excluded.value,updated_at=excluded.updated_at
       WHERE ha_facts.workspace_revision < excluded.workspace_revision`,
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        [...(scope.readers ?? [])],
        entity.fact.factId,
        event.workspaceRevision,
        JSON.stringify(value),
        migrationCreatedAt(event),
      ],
    );
    tables.add("ha_facts");
    return { taskId: entity.fact.taskId ?? null, snapshot: null };
  }
  if (entity.kind === "decision") {
    await client.query(
      `INSERT INTO ha_decisions (tenant_id,project_id,policy_epoch,readers,decision_id,workspace_revision,value,updated_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7::jsonb,$8::timestamptz)
       ON CONFLICT (tenant_id,project_id,policy_epoch,decision_id) DO UPDATE SET workspace_revision=excluded.workspace_revision,value=excluded.value,updated_at=excluded.updated_at
       WHERE ha_decisions.workspace_revision < excluded.workspace_revision`,
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        [...(scope.readers ?? [])],
        entity.decision.decisionId,
        event.workspaceRevision,
        JSON.stringify(entity.decision),
        migrationCreatedAt(event),
      ],
    );
    tables.add("ha_decisions");
    return { taskId: null, snapshot: null };
  }
  if (entity.kind === "relation") {
    await storeRelation(client, scope, event, tables);
    return { taskId: null, snapshot: null };
  }
  return { taskId: null, snapshot: null };
}

async function storeEntityPin(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "entity-pin-event/v1" }>,
  tables: Set<string>,
): Promise<void> {
  const match = /^task\/(.+)$/u.exec(event.payload.entityRef);
  if (!match) return;
  await client.query(
    `UPDATE ha_task_snapshots
       SET snapshot = jsonb_set(snapshot, '{task,pinned}', to_jsonb($1::boolean), true)
     WHERE tenant_id=$2 AND project_id=$3 AND policy_epoch=$4 AND task_id=$5`,
    [event.type === "entity_pinned", scope.tenantId, scope.projectId, scope.policyEpoch, match[1]],
  );
  tables.add("ha_task_snapshots");
}

async function storeEntityEvent(
  client: PoolClient,
  scope: PgProjectionScope,
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "entity-event/v1" | "agent-entity-event/v1" }>,
  tables: Set<string>,
  readContentBlob?: (sha256: string) => Uint8Array | null | Promise<Uint8Array | null>,
): Promise<void> {
  const payload = event.payload as unknown as Record<string, unknown>;
  const kind = String(payload.entityKind ?? "");
  const id = String(payload.entityId ?? "");
  if ((event.type as string) === "entity_deleted") {
    if (kind !== "agent" && kind !== "squad") return;
    await client.query(
      `DELETE FROM ${kind === "agent" ? "ha_agents" : "ha_squads"} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${kind === "agent" ? "agent_id" : "squad_id"}=$4`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, id],
    );
    tables.add(kind === "agent" ? "ha_agents" : "ha_squads");
    return;
  }
  if ((event.type as string) === "agent_retired") {
    await client.query(
      `UPDATE ha_agents SET declaration = declaration || $1::jsonb, workspace_revision=$2, updated_at=$3::timestamptz WHERE tenant_id=$4 AND project_id=$5 AND policy_epoch=$6 AND agent_id=$7`,
      [
        JSON.stringify({
          lifecycleState: "retired",
          retirement: {
            retiredAt: payload.retiredAt,
            reason: payload.reason,
            ...(payload.successor === undefined ? {} : { successor: payload.successor }),
          },
        }),
        event.workspaceRevision,
        event.occurredAt,
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        id,
      ],
    );
    tables.add("ha_agents");
    return;
  }
  if (kind !== "agent" && kind !== "squad") return;
  let raw: unknown;
  let documentPath: string | null = null;
  let documentSha256: string | null = null;
  if (isEntityDeclarationEvent(event) && event.type === "entity_reference_declared") {
    raw = event.payload.descriptor;
  } else if (isEntityDeclarationEvent(event)) {
    const claim = event.payload.declarationDocumentClaim,
      bytes = await readContentBlob?.(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size)
      throw new Error(`entity declaration blob ${claim.sha256} is unavailable`);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`entity declaration blob ${claim.sha256} is not UTF-8`);
    }
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error(`entity declaration blob ${claim.sha256} is not JSON`);
    }
    documentPath = claim.path;
    documentSha256 = claim.sha256;
  } else return;
  const declaration = kind === "agent" ? parseAgentDeclarationV1(raw) : parseSquadDeclarationV1(raw);
  const table = kind === "agent" ? "ha_agents" : "ha_squads";
  const idColumn = kind === "agent" ? "agent_id" : "squad_id";
  await client.query(
    `INSERT INTO ${table} (tenant_id,project_id,policy_epoch,readers,${idColumn},workspace_revision,declaration_revision,declaration,document_path,document_sha256,updated_at) VALUES ($1,$2,$3,$4::text[],$5,$6,$6,$7::jsonb,$8,$9,$10::timestamptz) ON CONFLICT (tenant_id,project_id,policy_epoch,${idColumn}) DO UPDATE SET readers=excluded.readers,workspace_revision=excluded.workspace_revision,declaration_revision=excluded.declaration_revision,declaration=excluded.declaration,document_path=excluded.document_path,document_sha256=excluded.document_sha256,updated_at=excluded.updated_at WHERE ${table}.workspace_revision < excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      id,
      event.workspaceRevision,
      JSON.stringify(declaration),
      documentPath,
      documentSha256,
      event.occurredAt,
    ],
  );
  tables.add(table);
}

async function storeEmbeddedRelations(
  client: PoolClient,
  scope: PgProjectionScope,
  event: PersistedCanonicalEventV1,
  tables: Set<string>,
): Promise<void> {
  const executionSourceVersions: { readonly relationId: string; readonly workspaceRevision: number }[] = [];
  for (const record of derivedRelationRecordsForReplay(event)) {
    const relationId = record.relation_id;
    const previous = await client.query<{ readonly value: Record<string, unknown> }>(
      `SELECT value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_id=$4`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, relationId],
    );
    if (previous.rows[0]) {
      const value = previous.rows[0].value;
      if (
        value.source !== record.source ||
        value.target !== record.target ||
        value.type !== record.type ||
        value.direction !== record.direction ||
        value.origin !== record.origin ||
        value.state !== record.state ||
        value.rationale !== record.rationale
      )
        throw new Error(`Embedded relation ${relationId} changed identity`);
    } else {
      const { strength: _strength, ...relation } = record;
      const derived: RelationEventV1 = {
        schema: "relation-event/v1",
        eventId: event.eventId,
        workspaceRevision: event.workspaceRevision,
        opId: event.opId,
        relationId,
        type: "relation_created",
        actor: event.actor,
        source: event.source,
        occurredAt: event.occurredAt,
        payload: {
          relation: { ...relation, targetObservedVersion: await relationTargetVersion(client, scope, record.target) },
        },
      };
      await storeRelation(client, scope, derived, tables);
    }
    if (record.source.startsWith("execution/"))
      executionSourceVersions.push({ relationId, workspaceRevision: event.workspaceRevision });
  }
  for (const { relationId, workspaceRevision } of executionSourceVersions)
    await recordExecutionRelationSourceVersion(client, scope, relationId, workspaceRevision);
}

async function recordExecutionRelationSourceVersion(
  client: PoolClient,
  scope: PgProjectionScope,
  relationId: string,
  workspaceRevision: number,
): Promise<void> {
  await client.query(
    `UPDATE ha_relations
     SET value=jsonb_set(value, '{sourceObservedVersion}',
       to_jsonb(GREATEST(COALESCE((value->>'sourceObservedVersion')::bigint, 0), $1::bigint)), true)
     WHERE tenant_id=$2 AND project_id=$3 AND policy_epoch=$4 AND relation_id=$5`,
    [workspaceRevision, scope.tenantId, scope.projectId, scope.policyEpoch, relationId],
  );
}

async function relationEventWithTargetWitness(
  client: PoolClient,
  scope: PgProjectionScope,
  event: RelationEventV1 | Extract<PersistedCanonicalEventV1, { readonly schema: "migration-import-event/v1" }>,
): Promise<typeof event> {
  if (event.schema === "migration-import-event/v1") {
    if (event.payload.entity.kind !== "relation") return event;
    const relation = event.payload.entity.relation as typeof event.payload.entity.relation & {
      readonly targetObservedVersion?: number | string | null;
    };
    if (relation.targetObservedVersion != null) return event;
    const witnessed = await relationTargetVersion(client, scope, relation.target);
    if (witnessed === null) return event;
    return {
      ...event,
      payload: {
        ...event.payload,
        entity: { ...event.payload.entity, relation: { ...relation, targetObservedVersion: witnessed } },
      },
    } as unknown as typeof event;
  }
  if (event.type !== "relation_created" && event.type !== "relation_replaced") return event;
  const relation = event.payload.relation;
  if (relation.targetObservedVersion !== null) return event;
  const slash = relation.target.indexOf("/"),
    kind = slash > 0 ? relation.target.slice(0, slash) : "",
    id = slash > 0 ? relation.target.slice(slash + 1) : "";
  const table =
    kind === "task"
      ? "ha_task_snapshots"
      : kind === "decision"
        ? "ha_decisions"
        : kind === "fact"
          ? "ha_facts"
          : kind === "agent"
            ? "ha_agents"
            : kind === "squad"
              ? "ha_squads"
              : null;
  const idColumn =
    kind === "task"
      ? "task_id"
      : kind === "decision"
        ? "decision_id"
        : kind === "fact"
          ? "fact_id"
          : kind === "agent"
            ? "agent_id"
            : kind === "squad"
              ? "squad_id"
              : null;
  if (!table || !idColumn) return event;
  const currentVersion = await relationTargetVersion(client, scope, relation.target, table, idColumn, id);
  if (currentVersion === null) return event;
  return {
    ...event,
    payload: { ...event.payload, relation: { ...event.payload.relation, targetObservedVersion: currentVersion } },
  } as unknown as typeof event;
}

async function relationTargetVersion(
  client: PoolClient,
  scope: PgProjectionScope,
  target: string,
  knownTable?: string,
  knownIdColumn?: string,
  knownId?: string,
): Promise<number | null> {
  const slash = target.indexOf("/"),
    kind = slash > 0 ? target.slice(0, slash) : "",
    id = slash > 0 ? target.slice(slash + 1) : "",
    readers = [...(scope.readers ?? [])];
  if (kind === "execution") {
    const result = await client.query<{ source_version: string }>(
      `SELECT value->>'sourceObservedVersion' AS source_version FROM ha_relations
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND source_ref=$4 AND relation_type='executes'
         AND value ? 'sourceObservedVersion'
         AND (cardinality($5::text[])=0 OR readers && $5::text[])
       ORDER BY (value->>'sourceObservedVersion')::bigint DESC LIMIT 1`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, target, readers],
    );
    return result.rows[0] ? Number(result.rows[0].source_version) : null;
  }
  const table =
      knownTable ??
      (kind === "task"
        ? "ha_task_snapshots"
        : kind === "decision"
          ? "ha_decisions"
          : kind === "fact"
            ? "ha_facts"
            : kind === "agent"
              ? "ha_agents"
              : kind === "squad"
                ? "ha_squads"
                : null),
    idColumn =
      knownIdColumn ??
      (kind === "task"
        ? "task_id"
        : kind === "decision"
          ? "decision_id"
          : kind === "fact"
            ? "fact_id"
            : kind === "agent"
              ? "agent_id"
              : kind === "squad"
                ? "squad_id"
                : null);
  if (!table || !idColumn) return null;
  const result = await client.query<{ workspace_revision: string }>(
    `SELECT workspace_revision::text FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${idColumn}=$4 AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, knownId ?? id, readers],
  );
  return result.rows[0] ? Number(result.rows[0].workspace_revision) : null;
}

function migrationCreatedAt(
  event: Extract<PersistedCanonicalEventV1, { readonly schema: "migration-import-event/v1" }>,
): string {
  const createdAt = (event.payload as unknown as Record<string, unknown>).createdAt;
  return typeof createdAt === "string" ? createdAt : event.occurredAt;
}

async function updateProjectionMeta(
  client: PoolClient,
  scope: PgProjectionScope,
  watermark: number,
  sourceRevision: number,
): Promise<void> {
  if (!Number.isSafeInteger(watermark) || watermark < 0 || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0)
    throw new TypeError("projection revisions must be non-negative safe integers");
  if (watermark > sourceRevision)
    throw new Error(`projection watermark ${watermark} exceeds ledger head ${sourceRevision}`);
  await client.query(
    `INSERT INTO ha_projection_meta
       (tenant_id, project_id, policy_epoch, projection_name, schema_version, watermark, source_revision, state_digest, updated_at)
     VALUES ($1, $2, $3, 'task/v1', $4, $5, $6, NULL, clock_timestamp())
     ON CONFLICT (tenant_id, project_id, policy_epoch, projection_name) DO UPDATE SET
       policy_epoch = excluded.policy_epoch, schema_version = excluded.schema_version,
       readers = '{}',
       watermark = GREATEST(ha_projection_meta.watermark, excluded.watermark),
       source_revision = GREATEST(ha_projection_meta.source_revision, excluded.source_revision),
       updated_at = excluded.updated_at`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION, watermark, sourceRevision],
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
