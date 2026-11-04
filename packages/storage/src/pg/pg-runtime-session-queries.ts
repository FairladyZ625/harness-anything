import type { PoolClient } from "pg";
import type { RuntimeSession, RuntimeSessionPageQuery, RuntimeSessionPageRead } from "@harness-anything/kernel";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { assertPgReadIndexReady } from "./pg-read-index-migration.ts";

export async function readPgTaskSessions(
  client: PoolClient,
  scope: PgProjectionScope,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, RuntimeSession[]>> {
  await assertPgReadIndexReady(client, scope, "runtime-session");
  const rows = await client.query<{ task_id: string; value: string }>(
    `SELECT b.task_id,p.value FROM ha_runtime_session_tasks b JOIN ha_projection_values p
      ON p.tenant_id=b.tenant_id AND p.project_id=b.project_id AND p.policy_epoch=b.policy_epoch
        AND p.model='runtime-session' AND p.owner_id='' AND p.entity_id=b.session_id
      WHERE b.tenant_id=$1 AND b.project_id=$2 AND b.policy_epoch=$3 AND b.task_id=ANY($5::text[])
        AND (cardinality($4::text[])=0 OR b.readers && $4::text[])
        AND (cardinality($4::text[])=0 OR p.readers && $4::text[])
      ORDER BY b.task_id,b.session_id`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, [...(scope.readers ?? [])], taskIds],
  );
  const sessions = new Map<string, RuntimeSession[]>();
  for (const { task_id, value } of rows.rows) {
    const group = sessions.get(task_id) ?? [];
    group.push(JSON.parse(value) as RuntimeSession);
    sessions.set(task_id, group);
  }
  return sessions;
}

export async function readPgSessionPage(
  client: PoolClient,
  scope: PgProjectionScope,
  query: RuntimeSessionPageQuery,
): Promise<RuntimeSessionPageRead> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 64)
    throw new Error("runtime session page limit must be between 1 and 64");
  await assertPgReadIndexReady(client, scope, "runtime-session");
  const parameters = [
    scope.tenantId,
    scope.projectId,
    scope.policyEpoch,
    [...(scope.readers ?? [])],
    query.afterRuntimeSessionId ?? "",
    ...(query.taskId ? [query.taskId] : []),
  ];
  const from = query.taskId
    ? `ha_runtime_session_tasks b JOIN ha_projection_values p
      ON p.tenant_id=b.tenant_id AND p.project_id=b.project_id AND p.policy_epoch=b.policy_epoch
      AND p.model='runtime-session' AND p.owner_id='' AND p.entity_id=b.session_id`
    : "ha_projection_values p";
  const predicate = query.taskId
    ? `b.tenant_id=$1 AND b.project_id=$2 AND b.policy_epoch=$3 AND b.task_id=$6 AND b.session_id > $5
      AND (cardinality($4::text[])=0 OR b.readers && $4::text[])`
    : `p.tenant_id=$1 AND p.project_id=$2 AND p.policy_epoch=$3 AND p.model='runtime-session' AND p.owner_id='' AND p.entity_id > $5`;
  const where = `${predicate} AND (cardinality($4::text[])=0 OR p.readers && $4::text[])`,
    rows = await client.query<{ value: string }>(
      `SELECT p.value FROM ${from} WHERE ${where} ORDER BY ${query.taskId ? "b.session_id" : "p.entity_id"} LIMIT $${parameters.length + 1}`,
      [...parameters, query.limit + 1],
    ),
    sessions = rows.rows.slice(0, query.limit).map(({ value }) => JSON.parse(value) as RuntimeSession),
    last = sessions.at(-1)?.runtimeSessionId;
  if (last === undefined) return { rows: sessions, nextRuntimeSessionId: null, remainingCount: 0 };
  if (query.includeRemainingCount !== true) {
    const hasMore = rows.rows.length > query.limit;
    return { rows: sessions, nextRuntimeSessionId: hasMore ? last : null, remainingCount: hasMore ? null : 0 };
  }
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${from} WHERE ${where}`,
    parameters.map((value, index) => (index === 4 ? last : value)),
  );
  const remainingCount = Number(count.rows[0]!.count);
  return { rows: sessions, nextRuntimeSessionId: remainingCount ? last : null, remainingCount };
}
