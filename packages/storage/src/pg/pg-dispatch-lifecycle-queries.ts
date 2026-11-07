import type { DispatchLifecycleGroup, DispatchLifecycleQuery, DispatchLifecycleRead } from "@harness-anything/kernel";
import {
  emptyDispatchLifecycleProjection,
  readDispatchLifecycle as queryDispatchLifecycle,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { getPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { Pool } from "pg";

export interface PgDispatchLifecycleQueries {
  readonly readDispatchLifecycle: (query: DispatchLifecycleQuery) => Promise<DispatchLifecycleRead>;
}
/** Reads the projection written in the canonical event transaction. No lifecycle state is inferred in SQL. */
export function pgDispatchLifecycleQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgDispatchLifecycleQueries {
  const claims = options.scope;
  const readDispatchLifecycle: PgDispatchLifecycleQueries["readDispatchLifecycle"] = (query) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const groups = await groupsForQuery(client, claims, query),
          projection = projectionForGroups(groups),
          cut = await readCutInTransaction(client, claims, [...(claims.readers ?? [])], options.repoId),
          read = queryDispatchLifecycle(
            { ...projection, watermark: cut.watermark, sourceRevision: cut.sourceRevision },
            query,
          );
        return { ...read, status: cut.status };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  return { readDispatchLifecycle };
}
async function groupsForQuery(
  client: import("pg").PoolClient,
  scope: PostgresScopeClaims & { readonly readers?: readonly string[] },
  query: DispatchLifecycleQuery,
): Promise<readonly DispatchLifecycleGroup[]> {
  if (query.by === "active") {
    const values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, [...(scope.readers ?? [])]],
      predicates = [
        "tenant_id=$1",
        "project_id=$2",
        "policy_epoch=$3",
        "model='dispatch-lifecycle-active'",
        "(cardinality($4::text[])=0 OR readers && $4::text[])",
      ];
    if (query.instanceId !== undefined) {
      values.push(query.instanceId);
      predicates.push(`owner_id=$${values.length}`);
    }
    if (query.afterGroupId !== undefined) {
      values.push(query.afterGroupId);
      predicates.push(`entity_id>$${values.length}`);
    }
    values.push(query.limit + 1);
    const rows = await client.query<{ value: string }>(
      `SELECT value FROM ha_projection_values WHERE ${predicates.join(" AND ")}
       ORDER BY entity_id COLLATE "C" LIMIT $${values.length}`,
      values,
    );
    return rows.rows.map(({ value }) => JSON.parse(value) as DispatchLifecycleGroup);
  }
  const ids =
    query.by === "group"
      ? [query.attemptGroupId]
      : query.by === "dispatch"
        ? await Promise.all(
            query.dispatchIds.map((id) =>
              getPgProjectionValue<string>(client, scope, "dispatch-lifecycle-dispatch", id),
            ),
          )
        : [await getPgProjectionValue<string>(client, scope, "dispatch-lifecycle-session", query.runtimeSessionId)];
  const groups = await Promise.all(
    [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))].map((id) =>
      getPgProjectionValue<DispatchLifecycleGroup>(client, scope, "dispatch-lifecycle-group", id),
    ),
  );
  return groups.filter((group): group is DispatchLifecycleGroup => group !== null);
}

function projectionForGroups(groups: readonly DispatchLifecycleGroup[]) {
  const projection = emptyDispatchLifecycleProjection(),
    groupByDispatchId: Record<string, string> = {},
    groupBySessionId: Record<string, string> = {},
    activeReservationsByInstance: Record<string, string[]> = {};
  for (const group of groups) {
    for (const attempt of group.attempts) {
      groupByDispatchId[attempt.dispatchId] = group.attemptGroupId;
      groupBySessionId[attempt.runtimeSessionId] = group.attemptGroupId;
      if (attempt.capacity !== "released")
        (activeReservationsByInstance[attempt.instanceId] ??= []).push(attempt.reservationId);
    }
  }
  return {
    ...projection,
    groups: Object.fromEntries(groups.map((group) => [group.attemptGroupId, group])),
    groupByDispatchId,
    groupBySessionId,
    activeGroupIds: groups.filter(({ phase }) => phase !== "closed").map(({ attemptGroupId }) => attemptGroupId),
    activeReservationsByInstance,
  };
}
