import { assertPgTaskParentIndexReady } from "./pg-task-parent-index.ts";
import type { TaskProjectionQueries, TaskLifecycleSnapshot, TaskIndexProjectionRow } from "@harness-anything/kernel";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgTaskProjectionSourceOptions, PgTaskProjectionSource } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";
import { checkedPageLimit } from "./pg-query-page.ts";

export type PgTaskIndexQueries = AsyncQueries<
  | "readTaskIndex"
  | "readTaskChildCounts"
  | "readTaskStatuses"
  | "readTaskExists"
  | "readTaskByIdempotencyKey"
  | "readForTaskContractMigration"
  | "readTaskIdsForTaskContractMigration"
>;

/** Presentation status is derived from the indexed task scalars and parent key.  Keeping the
 * recursive member walk parameterized makes the planner use the parent index for each frontier
 * instead of flattening a repository-wide join. */
export const presentationStatusSql = (readersParameter: number) => `CASE
  WHEN task_status IN ('done','cancelled') THEN task_status
  WHEN task_class = 'work' OR (parent_task_id IS NULL AND EXISTS (
    SELECT 1 FROM ha_task_snapshots child WHERE child.tenant_id=ha_task_snapshots.tenant_id
      AND child.project_id=ha_task_snapshots.project_id AND child.policy_epoch=ha_task_snapshots.policy_epoch
      AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[])
      AND child.parent_task_id=ha_task_snapshots.task_id
  )) THEN COALESCE((WITH RECURSIVE members(task_id,status) AS (
    SELECT child.task_id, child.task_status FROM ha_task_snapshots child
      WHERE child.tenant_id=ha_task_snapshots.tenant_id AND child.project_id=ha_task_snapshots.project_id
        AND child.policy_epoch=ha_task_snapshots.policy_epoch
        AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[])
        AND child.parent_task_id=ha_task_snapshots.task_id AND child.task_id<>ha_task_snapshots.task_id
    UNION SELECT child.task_id, child.task_status FROM members parent CROSS JOIN LATERAL (
      SELECT child.task_id, child.task_status FROM ha_task_snapshots child
       WHERE child.tenant_id=ha_task_snapshots.tenant_id AND child.project_id=ha_task_snapshots.project_id
         AND child.policy_epoch=ha_task_snapshots.policy_epoch
         AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[])
         AND child.parent_task_id=parent.task_id AND child.task_id<>ha_task_snapshots.task_id OFFSET 0
    ) child
  ) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE status NOT IN ('done','cancelled')) THEN
      CASE WHEN EXISTS (SELECT 1 FROM members) THEN CASE WHEN EXISTS (SELECT 1 FROM members WHERE status='done') THEN 'done' ELSE 'cancelled' END END
    WHEN task_status='planned' AND EXISTS (SELECT 1 FROM members WHERE status NOT IN ('planned','cancelled')) THEN 'active' END), task_status)
  ELSE task_status END`;

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
        if (ids.length === 0) return {};
        await assertPgTaskParentIndexReady(client, scope);
        const result = await client.query<{ parent_id: string; count: string }>(
          `SELECT parent_task_id AS parent_id,count(*)::text FROM ha_task_snapshots
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[])
         AND task_package_disposition='active'
         AND parent_task_id=ANY($5::text[]) GROUP BY parent_task_id`,
          [...parameters, ids],
        );
        return Object.fromEntries(result.rows.map(({ parent_id, count }) => [parent_id, Number(count)]));
      }),
    readTaskIndex: (query = {}) =>
      read(async (client) => {
        await assertPgTaskParentIndexReady(client, scope);
        const cut = await readCutInTransaction(client, scope, readers, options.repoId),
          values: unknown[] = [...parameters],
          where = [
            "tenant_id=$1",
            "project_id=$2",
            "policy_epoch=$3",
            "(cardinality($4::text[])=0 OR readers && $4::text[])",
          ],
          presentation = query.presentationStatus ? presentationStatusSql(4) : "task_status";
        let withClause = "";
        if (query.scopeRootTaskId !== undefined) {
          values.push(query.scopeRootTaskId);
          const root = `$${values.length}`,
            visible =
              "tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[])";
          withClause = `WITH RECURSIVE descendants(task_id) AS (
            SELECT task_id FROM ha_task_snapshots WHERE ${visible} AND task_id=${root}
            UNION SELECT child.task_id FROM descendants parent CROSS JOIN LATERAL (
              SELECT task_id FROM ha_task_snapshots WHERE ${visible} AND parent_task_id=parent.task_id OFFSET 0
            ) child
          ), ancestors(task_id,parent_id) AS (
            SELECT task_id,parent_task_id FROM ha_task_snapshots WHERE ${visible} AND task_id=${root}
            UNION SELECT parent.task_id,parent.parent_task_id FROM ancestors child CROSS JOIN LATERAL (
              SELECT task_id,parent_task_id FROM ha_task_snapshots WHERE ${visible} AND task_id=child.parent_id OFFSET 0
            ) parent
          )`;
          where.push(`task_id IN (SELECT task_id FROM descendants UNION SELECT task_id FROM ancestors)`);
        }
        if (query.status !== undefined) {
          values.push(query.status);
          where.push(`${presentation}=$${values.length}`);
        }
        if (query.search !== undefined) {
          const search = query.search.replace(/[\\%_]/gu, "\\$&");
          values.push(`${search}%`, `%${search}%`);
          where.push(
            `(task_id ILIKE $${values.length - 1} ESCAPE '\\' OR task_title ILIKE $${values.length} ESCAPE '\\')`,
          );
        }
        if (query.taskIds !== undefined) {
          values.push(query.taskIds);
          where.push(`task_id=ANY($${values.length}::text[])`);
        }
        if (query.changedAfterRevision !== undefined) {
          values.push(query.changedAfterRevision);
          where.push(`workspace_revision>$${values.length}`);
        }
        if (query.updatedAfter !== undefined) {
          values.push(query.updatedAfter);
          where.push(`updated_at>=$${values.length}::timestamptz`);
        }
        if (query.updatedBefore !== undefined) {
          values.push(query.updatedBefore);
          where.push(`updated_at<=$${values.length}::timestamptz`);
        }
        if (query.parentTaskId !== undefined) {
          if (query.parentTaskId === null) where.push("parent_task_id IS NULL");
          else {
            values.push(query.parentTaskId);
            where.push(`parent_task_id=$${values.length}`);
          }
        }
        for (const [column, value] of [
          ["task_work_kind", query.workKind],
          ["task_risk_tier", query.riskTier],
          ["task_urgency", query.urgency],
          ["task_slug", query.slug],
        ] as const)
          if (value !== undefined) {
            values.push(value);
            where.push(`${column}=$${values.length}`);
          }
        if (query.openOnly === true) where.push("task_status NOT IN ('done','cancelled')");
        if (query.leaseOnly === true) where.push("task_lease_phase IS NOT NULL AND task_lease_phase <> 'released'");
        if (query.activePackagesOnly === true) where.push("task_package_disposition='active'");
        if (query.workRootsOnly === true)
          where.push(`(task_class='work' OR (parent_task_id IS NULL AND EXISTS (
            SELECT 1 FROM ha_task_snapshots child WHERE child.tenant_id=ha_task_snapshots.tenant_id
              AND child.project_id=ha_task_snapshots.project_id AND child.policy_epoch=ha_task_snapshots.policy_epoch
              AND (cardinality($4::text[])=0 OR child.readers && $4::text[]) AND child.parent_task_id=ha_task_snapshots.task_id
          )))`);
        // The task index has always been task-id ordered.  `pinnedFirst` belongs to the
        // snapshot list contract and is intentionally ignored here so callers can share
        // paging options without changing index order or cursor shape.
        if (query.cursor !== undefined) {
          const cursor = decodeTaskIndexCursor(query.cursor, 1);
          values.push(cursor[0]);
          where.push(`task_id>$${values.length}`);
        }
        const paged = query.limit !== undefined || query.cursor !== undefined,
          limit = paged ? checkedPageLimit(query.limit ?? 100) : null;
        if (limit !== null) values.push(limit + 1);
        const result = await client.query<{
          task_id: string;
          task_title: string | null;
          task_status: string | null;
          task_pinned: boolean | null;
          parent_task_id: string | null;
          task_work_kind: string | null;
          task_risk_tier: string | null;
          task_urgency: string | null;
          task_class: string | null;
          task_superseded_by: string | null;
          task_package_disposition: string | null;
          package_path: string | null;
          updated_at: string;
          presentation_status: string | null;
        }>(
          `${withClause} SELECT task_id,task_title,task_status,task_pinned,parent_task_id,task_work_kind,task_risk_tier,
             task_urgency,task_class,task_superseded_by,task_package_disposition,package_path,updated_at::text,
             ${presentation} AS presentation_status FROM ha_task_snapshots
             WHERE ${where.join(" AND ")} ORDER BY task_id
             ${limit === null ? "" : `LIMIT $${values.length}`}`,
          values,
        );
        const visible = limit === null ? result.rows : result.rows.slice(0, limit),
          rows = visible.flatMap((row) => indexRow(row));
        return {
          ...cut,
          schema: "task-index-projection/v1" as const,
          page:
            limit === null
              ? null
              : {
                  limit,
                  cursor: query.cursor ?? null,
                  nextCursor:
                    result.rows.length > limit && rows.at(-1) ? encodeTaskIndexCursor([rows.at(-1)!.taskId]) : null,
                },
          warnings: [],
          rows,
        } satisfies ReturnType<TaskProjectionQueries["readTaskIndex"]>;
      }),
  };
}

function indexRow(row: {
  readonly task_id: string;
  readonly task_title: string | null;
  readonly task_status: string | null;
  readonly task_pinned: boolean | null;
  readonly parent_task_id: string | null;
  readonly task_work_kind: string | null;
  readonly task_risk_tier: string | null;
  readonly task_urgency: string | null;
  readonly task_class: string | null;
  readonly task_superseded_by: string | null;
  readonly task_package_disposition: string | null;
  readonly package_path: string | null;
  readonly updated_at: string;
  readonly presentation_status: string | null;
}): ReturnType<TaskProjectionQueries["readTaskIndex"]>["rows"] {
  if (
    row.task_status === null ||
    row.task_title === null ||
    row.task_class === null ||
    row.presentation_status === null
  )
    return [];
  return [
    {
      taskId: row.task_id,
      supersededBy: row.task_superseded_by,
      title: row.task_title,
      status: row.presentation_status as TaskIndexProjectionRow["status"],
      pinned: row.task_pinned === true,
      parentTaskId: row.parent_task_id,
      workKind: row.task_work_kind as TaskIndexProjectionRow["workKind"],
      riskTier: row.task_risk_tier as TaskIndexProjectionRow["riskTier"],
      urgency: row.task_urgency as TaskIndexProjectionRow["urgency"],
      taskClass: row.task_class as TaskIndexProjectionRow["taskClass"],
      packageDisposition: (row.task_package_disposition ?? "active") as TaskIndexProjectionRow["packageDisposition"],
      packagePath: row.package_path,
      updatedAt: new Date(row.updated_at).toISOString(),
    },
  ];
}

function encodeTaskIndexCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeTaskIndexCursor(value: string, expected: number): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expected ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("query cursor is invalid");
  return parsed;
}
