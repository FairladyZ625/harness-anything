import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import {
  runtimeExecutionLinkForEvent,
  runtimeTaskExecutionRelation,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  entityKindContracts,
  type EntityKindContract,
} from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { interpretEmbeddedEntityProjections } from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import {
  relationFreshnessAnchorForType,
  relationOwnerRef,
  type EntityRelationRecord,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { TaskEventV1 } from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
import {
  assertRelationRecord,
  embeddedRelationEventsForReplay,
  reduceRelationEntity,
  relationRecord,
  type RelationEntity,
  type RelationEventV1,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import type { MigrationImportEventV1 } from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import type { VersionedRelationProjectionRow } from "@harness-anything/kernel";
export type { VersionedRelationProjectionRow } from "@harness-anything/kernel";
import { canonicalJson, projectionTables, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";
import { readEntityVersionWitness } from "./entity-freshness-projection.ts";
import { isRelationFreshness, relationFreshnessColumns } from "./relation-freshness-columns.ts";
import {
  type EntityVersion,
  type EntityVersionWitness,
  type RelationFreshness,
} from "@harness-anything/kernel/internal/domain/entity-freshness.ts";

export const RELATION_PROJECTION_VERSION = "relation-projection/v1" as const;

/**
 * Which kinds can interpret each event schema, in registry order, so replay visits only the contracts
 * that declare the schema instead of every kind. Contracts without a canonical projection cannot
 * produce embedded projections and are absent by construction.
 */
const embeddedProjectionContractsBySchema = new Map<string, readonly (typeof entityKindContracts)[number][]>(
  [
    ...new Set(
      entityKindContracts.flatMap((contract) =>
        contract.stateStores.flatMap((store: EntityKindContract["stateStores"][number]) =>
          store.projection && store.medium.kind === "canonical-event" && store.medium.schema
            ? [{ schema: store.medium.schema }]
            : [],
        ),
      ),
    ),
  ].map((source) => [
    source.schema,
    entityKindContracts.filter((contract) =>
      contract.stateStores.some(
        (store: EntityKindContract["stateStores"][number]) =>
          store.projection && store.medium.kind === "canonical-event" && store.medium.schema === source.schema,
      ),
    ),
  ]),
);

export function applyRelationProjectionEvent(
  db: DatabaseSync,
  event: RelationEventV1 | MigrationImportEventV1,
): VersionedRelationProjectionRow {
  const migration = event.schema === "migration-import-event/v1" ? event.payload.entity : null;
  if (migration !== null && migration.kind !== "relation") throw new Error("Relation projection received another kind");
  const relationId =
      migration?.kind === "relation" ? migration.relation.relation_id : (event as RelationEventV1).relationId,
    current = readRelationProjectionRow(db, relationId),
    projectedEvent = relationEventWithTargetWitness(db, event),
    entity = reduceRelationEntity(current?.entity ?? null, projectedEvent),
    row = relationProjectionRow(db, entity, `event:${event.opId}`);
  runSql(
    db,
    [
      "INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, " +
        "state, target_observed_version, owner_ref, workspace_revision, updated_at, row_json, freshness, current_target_version)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(relation_id) DO UPDATE SET source_ref=excluded.source_ref, target_ref=excluded.target_ref,",
      "relation_type=excluded.relation_type, state=excluded.state,",
      "target_observed_version=excluded.target_observed_version, owner_ref=excluded.owner_ref,",
      "workspace_revision=excluded.workspace_revision, updated_at=excluded.updated_at,",
      "row_json=excluded.row_json, freshness=excluded.freshness, current_target_version=excluded.current_target_version",
      "WHERE relation_edge.workspace_revision < excluded.workspace_revision",
    ].join(" "),
    row.relationId,
    row.sourceRef,
    row.targetRef,
    row.relationType,
    row.state,
    row.targetObservedVersion,
    row.ownerRef,
    row.workspaceRevision,
    entity.updatedAt,
    canonicalJson(row),
    row.freshness,
    row.currentTargetVersion,
  );
  const taskId = row.sourceRef.match(/^task\/([^/]+)$/u)?.[1];
  if (taskId && projectionTables(db).has("task_relation"))
    refreshTaskRelationProjection(db, taskId, null, row.workspaceRevision, entity.updatedAt);
  return row;
}

function relationEventWithTargetWitness(
  db: DatabaseSync,
  event: RelationEventV1 | MigrationImportEventV1,
): RelationEventV1 | MigrationImportEventV1 {
  if (event.schema === "migration-import-event/v1" && event.payload.entity.kind === "relation") {
    const relation = event.payload.entity.relation,
      currentVersion = readEntityVersionWitness(db, relation.target).currentVersion;
    if (currentVersion === null && /^person\/[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(relation.target))
      return {
        ...event,
        payload: {
          ...event.payload,
          entity: { ...event.payload.entity, relation: { ...relation, targetObservedVersion: null } },
        },
      } as MigrationImportEventV1;
    return currentVersion === null
      ? event
      : ({
          ...event,
          payload: {
            ...event.payload,
            entity: {
              ...event.payload.entity,
              relation: { ...event.payload.entity.relation, targetObservedVersion: currentVersion },
            },
          },
        } as MigrationImportEventV1);
  }
  if (event.schema !== "relation-event/v1") return event;
  if (event.type !== "relation_created" && event.type !== "relation_replaced") return event;
  if (event.payload.relation.targetObservedVersion !== null) return event;
  const currentVersion = readEntityVersionWitness(db, event.payload.relation.target).currentVersion;
  if (currentVersion === null) return event;
  if (event.type === "relation_created")
    return {
      ...event,
      payload: {
        ...event.payload,
        relation: { ...event.payload.relation, targetObservedVersion: currentVersion },
      },
    };
  return {
    ...event,
    payload: {
      ...event.payload,
      relation: { ...event.payload.relation, targetObservedVersion: currentVersion },
    },
  };
}

export function applyEmbeddedRelationProjectionEvents(
  db: DatabaseSync,
  event: AgentRuntimeEventV1 | DecisionEventV1 | FactEventV1 | TaskEventV1,
): void {
  if (event.schema !== "agent-runtime-event/v1")
    for (const relationEvent of embeddedRelationEventsForReplay(event)) applyRelationProjectionEvent(db, relationEvent);
  for (const record of derivedRelationRecordsForReplay(event)) projectDerivedRelation(db, event, record);
}

export function derivedRelationRecordsForReplay(event: PersistedCanonicalEventV1): readonly EntityRelationRecord[] {
  const records: EntityRelationRecord[] = [];
  if (event.schema === "agent-runtime-event/v1") {
    const binding = runtimeExecutionLinkForEvent(event);
    if (binding) records.push(runtimeTaskExecutionRelation(binding.runtimeSessionId, binding.taskId));
  }
  // Hoisted from interpretEmbeddedEntityProjections: it raised this for every declaring contract
  // regardless of schema match, so replay keeps rejecting a malformed payload outright.
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload))
    throw new Error(`${event.schema}/${event.type} payload must be an object`);
  for (const contract of embeddedProjectionContractsBySchema.get(event.schema) ?? [])
    for (const projection of interpretEmbeddedEntityProjections(contract, event))
      for (const relation of projection.relations) {
        const record = {
          relation_id: relation.relationId,
          source: relation.sourceRef,
          target: relation.targetRef,
          type: relation.relationType,
          direction: relation.direction,
          strength: relation.strength,
          origin: relation.origin,
          state: relation.state,
          rationale: relation.rationale,
        } as EntityRelationRecord;
        records.push(record);
      }
  return records;
}

function projectDerivedRelation(
  db: DatabaseSync,
  event: AgentRuntimeEventV1 | DecisionEventV1 | FactEventV1 | TaskEventV1,
  record: EntityRelationRecord,
): void {
  assertRelationRecord(record);
  const current = readRelationProjectionRow(db, record.relation_id);
  if (current === null)
    applyRelationProjectionEvent(db, {
      schema: "relation-event/v1",
      eventId: event.eventId,
      workspaceRevision: event.workspaceRevision,
      opId: event.opId,
      relationId: record.relation_id,
      type: "relation_created",
      actor: event.actor,
      source: event.source,
      occurredAt: event.occurredAt,
      payload: {
        relation: {
          relation_id: record.relation_id,
          source: record.source,
          target: record.target,
          type: record.type,
          direction: record.direction,
          origin: record.origin,
          state: record.state,
          rationale: record.rationale,
          targetObservedVersion: readEntityVersionWitness(db, record.target).currentVersion,
        },
      },
    });
  else {
    const { targetObservedVersion: _targetObservedVersion, ...projected } = relationRecord(current.entity);
    if (canonicalJson(projected) !== canonicalJson(record))
      throw new Error(`Embedded relation ${record.relation_id} changed identity`);
  }
}

const storedRelationColumns = "row_json, freshness, current_target_version";

export function readRelationProjectionRow(db: DatabaseSync, relationId: string): VersionedRelationProjectionRow | null {
  return (
    storedRelationProjectionRows(
      queryRows<StoredRelationEdge>(
        db,
        `SELECT ${storedRelationColumns} FROM relation_edge WHERE relation_id=?`,
        relationId,
      ),
    )[0] ?? null
  );
}

export function readRelationProjectionRows(
  db: DatabaseSync,
  targetRef?: string,
): readonly VersionedRelationProjectionRow[] {
  return storedRelationProjectionRows(
    targetRef === undefined
      ? queryRows<StoredRelationEdge>(db, `SELECT ${storedRelationColumns} FROM relation_edge ORDER BY relation_id`)
      : queryRows<StoredRelationEdge>(
          db,
          `SELECT ${storedRelationColumns} FROM relation_edge WHERE target_ref = ? ORDER BY relation_id`,
          targetRef,
        ),
  );
}

/** Relation rows targeting one entity or any of its anchors (`<ref>/<anchor>`), through the target index. */
export function readRelationProjectionRowsTargetingEntity(
  db: DatabaseSync,
  entityRef: string,
): readonly VersionedRelationProjectionRow[] {
  return storedRelationProjectionRows(
    queryRows<StoredRelationEdge>(
      db,
      `SELECT ${storedRelationColumns} FROM relation_edge WHERE target_ref = ? OR (target_ref >= ? AND target_ref < ?) ORDER BY relation_id`,
      entityRef,
      `${entityRef}/`,
      `${entityRef}0`,
    ),
  );
}

export function readRelationProjectionRowsForTargets(
  db: DatabaseSync,
  targetRefs: readonly string[],
  filter: { readonly relationType?: string; readonly sourcePrefix?: string } = {},
): readonly VersionedRelationProjectionRow[] {
  if (targetRefs.length === 0) return [];
  return storedRelationProjectionRows(
    queryRows<StoredRelationEdge>(
      db,
      [
        `SELECT ${storedRelationColumns} FROM relation_edge`,
        // A declared relation type rides relation_edge_type_target's leading column; without it
        // a task snapshot would walk every runtime-session executes edge that targets the task.
        ...(filter.relationType === undefined ? [] : ["INDEXED BY relation_edge_type_target"]),
        "WHERE target_ref IN (SELECT value FROM json_each(?))",
        ...(filter.relationType === undefined ? [] : ["AND relation_type = ?"]),
        // Task snapshots carry decision lineage only (lineageOrphan reads decision/ -> task
        // derives edges). Generated per-session executes edges must not make one task snapshot
        // linear in the sessions it ever ran.
        ...(filter.sourcePrefix === undefined ? [] : ["AND source_ref LIKE ? || '%'"]),
        "ORDER BY target_ref, relation_id",
      ].join(" "),
      JSON.stringify(targetRefs),
      ...(filter.relationType === undefined ? [] : [filter.relationType]),
      ...(filter.sourcePrefix === undefined ? [] : [filter.sourcePrefix]),
    ),
  );
}

export type StoredRelationEdge = {
  readonly row_json: string;
  readonly freshness: string | null;
  readonly current_target_version: EntityVersion | null;
};

/**
 * Projection rows for selected relation_edge rows with the freshness stored at their last write
 * cut (dec_E34C4284B48AFAF152D7BF1980). Reads never derive endpoint witnesses.
 */
export function storedRelationProjectionRows(
  selected: readonly StoredRelationEdge[],
): readonly VersionedRelationProjectionRow[] {
  return selected.flatMap((stored) => {
    const row = JSON.parse(stored.row_json) as Partial<VersionedRelationProjectionRow>;
    if (row.schema !== RELATION_PROJECTION_VERSION || row.entity?.kind !== "relation") return [];
    if (!isRelationFreshness(stored.freshness)) throw new Error(`relation ${row.entity.id} has no stored freshness`);
    return [
      relationProjectionRowFromColumns(row.entity as RelationEntity, String(row.sourcePath), {
        freshness: stored.freshness,
        currentTargetVersion: stored.current_target_version,
      }),
    ];
  });
}

export function relationProjectionRow(
  db: DatabaseSync,
  entity: RelationEntity,
  sourcePath: string,
  targetWitness?: EntityVersionWitness,
  sourceWitness?: EntityVersionWitness,
): VersionedRelationProjectionRow {
  return relationProjectionRowFromWitnesses(
    entity,
    sourcePath,
    targetWitness ?? readEntityVersionWitness(db, entity.target),
    relationFreshnessAnchorForType(entity.type) === "source"
      ? (sourceWitness ?? readEntityVersionWitness(db, entity.source))
      : undefined,
  );
}

/** Write-cut interpretation: the stored columns computed from global witnesses. */
function relationProjectionRowFromWitnesses(
  entity: RelationEntity,
  sourcePath: string,
  projectedTarget: EntityVersionWitness,
  sourceWitness?: EntityVersionWitness,
): VersionedRelationProjectionRow {
  return relationProjectionRowFromColumns(
    entity,
    sourcePath,
    relationFreshnessColumns(entity, projectedTarget, sourceWitness),
  );
}

/** One relation row shape shared by the native SQLite and PostgreSQL readers. */
export function relationProjectionRowFromColumns(
  entity: RelationEntity,
  sourcePath: string,
  columns: { readonly freshness: RelationFreshness; readonly currentTargetVersion: EntityVersion | null },
): VersionedRelationProjectionRow {
  return Object.freeze({
    schema: RELATION_PROJECTION_VERSION,
    entity,
    workspaceRevision: entity.revision,
    relationId: entity.id,
    sourceRef: entity.source,
    targetRef: entity.target,
    relationType: entity.type,
    direction: entity.direction,
    strength: entity.strength,
    origin: entity.origin,
    state: entity.state,
    targetObservedVersion: entity.targetObservedVersion,
    currentTargetVersion: columns.currentTargetVersion,
    freshness: columns.freshness,
    rationale: entity.rationale,
    ownerRef: relationOwnerRef(entity.source),
    sourcePath,
    recordIndex: 0,
  });
}
