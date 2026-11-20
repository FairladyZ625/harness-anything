import type { PoolClient } from "pg";
import type { EntityProjectionRow, PinnedEntityProjectionRow } from "@harness-anything/kernel";
import {
  personalPinsFromNewest,
  pinRetirementEventTypes,
} from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { assertPgEventReadIndexReady, pgImportedTaskPinPredicate } from "./pg-event-read-index-migration.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";

export async function readPgPersonalPins(
  client: PoolClient,
  { scope, repoId }: PgTaskProjectionSourceOptions,
  personId: string,
  watermark: number,
): Promise<readonly PinnedEntityProjectionRow[]> {
  await assertPgEventReadIndexReady(client, scope, repoId);
  const visibility = `(tenant_id,project_id,repo_id,policy_epoch)=($1,$2,$3,$4)
     AND (cardinality($5::text[])=0 OR readers && $5::text[]) AND revision <= $7`;
  const { rows } = await client.query<{ entity_ref: string; occurred_at: string; event_type: string }>(
    `WITH actions(entity_ref, revision) AS (
       SELECT ha_read_index_json(event_json)#>>'{payload,entityRef}', revision
       FROM ha_events
       WHERE ${visibility} AND actor_person_id=$6 AND event_type IN ('entity_pinned','entity_unpinned')
       UNION ALL
       SELECT 'task/' || (ha_read_index_json(event_json)#>>'{payload,entity,task,taskId}'), revision
       FROM ha_events
       WHERE ${visibility} AND actor_person_id=$6 AND ${pgImportedTaskPinPredicate}
     ), latest_pin AS MATERIALIZED (
       SELECT entity_ref, max(revision) AS revision FROM actions GROUP BY entity_ref
     )
     SELECT pin.entity_ref, event.occurred_at, event.event_type
     FROM latest_pin pin
     JOIN ha_events event ON (event.tenant_id,event.project_id,event.repo_id,event.policy_epoch,event.revision)
       =($1,$2,$3,$4,pin.revision)
     WHERE event.event_type<>'entity_unpinned' AND NOT EXISTS (
       SELECT 1 FROM ha_event_entity_refs ref
       JOIN ha_events retired USING (tenant_id,project_id,repo_id,policy_epoch,revision)
       WHERE (ref.tenant_id,ref.project_id,ref.repo_id,ref.policy_epoch)=($1,$2,$3,$4)
         AND (cardinality($5::text[])=0 OR retired.readers && $5::text[])
         AND ref.entity_ref=pin.entity_ref AND ref.revision > pin.revision AND ref.revision <= $7
         AND (retired.event_type=ANY($8::text[]) OR (retired.event_type='task_transitioned'
           AND ha_read_index_json(retired.event_json)#>>'{payload,task,status}'='cancelled'))
     )`,
    [
      scope.tenantId,
      scope.projectId,
      repoId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      personId,
      watermark,
      pinRetirementEventTypes,
    ],
  );
  return personalPinsFromNewest(
    rows.map(({ entity_ref, occurred_at, event_type }) => ({
      entityRef: entity_ref,
      personId,
      pinnedAt: occurred_at,
      pinned: event_type !== "entity_unpinned",
    })),
    personId,
  );
}

export async function readPgEntityOrigins(
  client: PoolClient,
  { scope, repoId }: PgTaskProjectionSourceOptions,
  kind: string,
  entities: readonly EntityProjectionRow[],
): Promise<readonly EntityProjectionRow[]> {
  if (entities.length === 0) return entities;
  await assertPgEventReadIndexReady(client, scope, repoId);
  const result = await client.query<{ id: string; person_id: string | null; node_id: string | null }>(
    `SELECT requested.id, origin.actor_person_id AS person_id, origin.fleet_node_id AS node_id
     FROM unnest($7::text[]) AS requested(id)
     LEFT JOIN LATERAL (
       SELECT event.actor_person_id, event.fleet_node_id
       FROM ha_event_entity_refs ref JOIN ha_events event USING (tenant_id, project_id, repo_id, policy_epoch, revision)
       WHERE ref.tenant_id=$1 AND ref.project_id=$2 AND ref.policy_epoch=$3 AND ref.repo_id=$4
         AND (cardinality($5::text[])=0 OR event.readers && $5::text[])
         AND ref.entity_ref=$6 || '/' || requested.id
         AND event.event_type IN ('entity_upserted','entity_reference_declared','entity_content_observed','schedule_created')
       ORDER BY ref.revision LIMIT 1
     ) origin ON true`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      repoId,
      [...(scope.readers ?? [])],
      kind,
      entities.map(({ id }) => id),
    ],
  );
  const origins = new Map(result.rows.map((row) => [row.id, row]));
  return entities.map((row) => ({
    ...row,
    createdByPersonId: origins.get(row.id)?.person_id ?? null,
    originNodeId: origins.get(row.id)?.node_id ?? null,
  }));
}
