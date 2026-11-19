import type { PoolClient } from "pg";
import type { EntityProjectionRow, PinnedEntityProjectionRow } from "@harness-anything/kernel";
import {
  personalPinsFromNewest,
  pinRetirementEventTypes,
  type EntityPinEventV1,
} from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { assertPgEventReadIndexReady } from "./pg-event-read-index-migration.ts";
import { readEventRowsInTransaction } from "./pg-event-queries.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";

export async function readPgPersonalPins(
  client: PoolClient,
  { scope, repoId }: PgTaskProjectionSourceOptions,
  personId: string,
  watermark: number,
): Promise<readonly PinnedEntityProjectionRow[]> {
  const rows = await readEventRowsInTransaction(
    client,
    scope,
    [...(scope.readers ?? [])],
    repoId,
    `event_type IN ('entity_pinned','entity_unpinned') AND actor_person_id=$6 AND revision <= $7
      AND NOT EXISTS (
        SELECT 1 FROM ha_event_entity_refs ref
        JOIN ha_events retirement USING (tenant_id, project_id, repo_id, policy_epoch, revision)
        WHERE (ref.tenant_id,ref.project_id,ref.repo_id,ref.policy_epoch)=($1,$2,$3,$4)
          AND ref.entity_ref=ha_read_index_json(ha_events.event_json)#>>'{payload,entityRef}'
          AND ref.revision > ha_events.revision AND ref.revision <= $7
          AND retirement.event_type=ANY($8::text[])
          AND (cardinality($5::text[])=0 OR retirement.readers && $5::text[])
      )`,
    [personId, watermark, pinRetirementEventTypes],
    "DESC",
  );
  return personalPinsFromNewest(
    rows.map(({ event_json }) => {
      const event = JSON.parse(event_json) as EntityPinEventV1;
      return {
        entityRef: event.payload.entityRef,
        personId: event.actor.principal.personId ?? null,
        pinnedAt: event.occurredAt,
        pinned: event.type === "entity_pinned",
      };
    }),
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
         AND event.event_type IN ('entity_upserted','entity_reference_declared','schedule_created')
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
