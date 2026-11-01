import type { TaskProjectionQueries, TaskLifecycleSnapshot } from "@harness-anything/kernel";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgTaskProjectionSourceOptions, PgTaskProjectionSource } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgTaskIndexQueries = AsyncQueries<
  | "readTaskIndex"
  | "readTaskChildCounts"
  | "readTaskStatuses"
  | "readTaskExists"
  | "readTaskByIdempotencyKey"
  | "readForTaskContractMigration"
  | "readTaskIdsForTaskContractMigration"
>;

export function pgTaskIndexQueries(
  options: PgTaskProjectionSourceOptions,
  source: Pick<PgTaskProjectionSource, "read" | "list">,
): PgTaskIndexQueries {
  const { scope } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const rows = async (client: PoolClient, predicate = "true", values: readonly unknown[] = []) =>
    (
      await client.query<{ task_id: string; snapshot: TaskLifecycleSnapshot; package_path: string | null }>(
        `SELECT task_id,snapshot,package_path FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2
       AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND ${predicate} ORDER BY task_id`,
        [...parameters, ...values],
      )
    ).rows;
  return {
    readForTaskContractMigration: source.read,
    readTaskIdsForTaskContractMigration: () =>
      read(async (client) => (await rows(client)).map(({ task_id }) => task_id)),
    readTaskExists: (id) => read(async (client) => (await rows(client, "task_id=$5", [id])).length > 0),
    readTaskByIdempotencyKey: (key) =>
      read(async (client) => {
        const row = (await rows(client, "snapshot#>>'{task,metadata,idempotencyKey}'=$5", [key]))[0];
        return row?.snapshot.task
          ? { taskId: row.task_id, status: row.snapshot.task.status, packagePath: row.package_path }
          : null;
      }),
    readTaskStatuses: (ids) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, options.repoId)),
        rows: (
          await rows(client, ids === undefined ? "true" : "task_id=ANY($5::text[])", ids === undefined ? [] : [ids])
        ).map(({ task_id, snapshot }) => ({ taskId: task_id, status: snapshot.task?.status ?? null })),
      })),
    readTaskChildCounts: (ids) =>
      read(async (client) => {
        const result = await client.query<{ parent_id: string; count: string }>(
          `SELECT snapshot#>>'{task,metadata,parentTaskId}' AS parent_id,count(*)::text FROM ha_task_snapshots
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[])
         AND COALESCE(snapshot#>>'{task,packageDisposition}','active')='active'
         AND snapshot#>>'{task,metadata,parentTaskId}'=ANY($5::text[]) GROUP BY snapshot#>>'{task,metadata,parentTaskId}'`,
          [...parameters, ids],
        );
        return Object.fromEntries(result.rows.map(({ parent_id, count }) => [parent_id, Number(count)]));
      }),
    readTaskIndex: async (query = {}) => {
      const result = await source.list(query);
      return {
        ...result,
        schema: "task-index-projection/v1",
        page: result.page ?? null,
        rows: result.rows.flatMap((row) => {
          const task = row.snapshot.task;
          return task
            ? [
                {
                  taskId: row.taskId,
                  supersededBy: task.supersededBy ?? null,
                  title: task.title,
                  status: task.status,
                  pinned: task.pinned,
                  parentTaskId: task.metadata?.parentTaskId ?? null,
                  workKind: task.metadata?.workKind ?? null,
                  riskTier: task.metadata?.riskTier ?? null,
                  urgency: task.metadata?.urgency ?? null,
                  taskClass: task.taskClass,
                  packageDisposition: task.packageDisposition ?? "active",
                  packagePath: row.packagePath,
                  updatedAt: row.updatedAt,
                },
              ]
            : [];
        }),
      } satisfies ReturnType<TaskProjectionQueries["readTaskIndex"]>;
    },
  };
}
