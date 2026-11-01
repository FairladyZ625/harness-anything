import type { PoolClient } from "pg";
import type { RuntimeSession, TaskProjectionQueries } from "@harness-anything/kernel";
import type { DecisionState } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { isDomainStatus } from "@harness-anything/kernel/internal/domain/lifecycle-status.ts";
import { blockingOf } from "@harness-anything/kernel/internal/domain/task-blocking.ts";
import {
  emptyWorkspaceTaskCounts,
  summarizeWorkspaceCensus,
  workspaceTaskStatus,
} from "@harness-anything/kernel/internal/domain/workspace-summary.ts";
import { publicRuntimeSession } from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import { decodePageCursor, encodePageCursor, checkedPageLimit } from "../projection/task-query-projection.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction, readEventRowsInTransaction } from "./pg-event-queries.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import { PG_PROJECTION_TABLES } from "./pg-projection-schema.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgAggregateQueries = AsyncQueries<"readWorkspaceSummary" | "readTaskRuntimeBatch" | "readStateDigest">;
export function pgAggregateQueries(options: PgTaskProjectionSourceOptions): PgAggregateQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  return {
    readWorkspaceSummary: () =>
      read(async (client) => {
        const tasks = await client.query<{
            task_id: string;
            status: string | null;
            disposition: string;
            updated_at: Date;
          }>(
            `SELECT task_id,snapshot#>>'{task,status}' AS status, COALESCE(snapshot#>>'{task,packageDisposition}','active') AS disposition, updated_at
         FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY task_id`,
            parameters,
          ),
          relations = (await readRelationsInTransaction(client, scope, readers, {})).filter(
            ({ relationType }) => relationType === "depends-on" || relationType === "awaits",
          ),
          states = new Map(
            blockingOf(
              tasks.rows.map(({ task_id, status }) => ({ taskId: task_id, status: status ?? "unknown" })),
              relations,
            ).map(({ taskId, state }) => [taskId, state]),
          ),
          counts = emptyWorkspaceTaskCounts();
        let lastChangedAt: string | null = null;
        for (const row of tasks.rows)
          if (row.disposition === "active") {
            const at = row.updated_at.toISOString();
            if (lastChangedAt === null || at > lastChangedAt) lastChangedAt = at;
            counts[
              row.status !== null && isDomainStatus(row.status)
                ? workspaceTaskStatus({ status: row.status, blockingState: states.get(row.task_id) ?? "unknown" })
                : "unknown"
            ] += 1;
          }
        const decisions = await client.query<{ decision_id: string; state: DecisionState }>(
          `SELECT decision_id,value->>'state' AS state FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY decision_id`,
          parameters,
        );
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          summary: summarizeWorkspaceCensus(
            counts,
            decisions.rows.map(({ decision_id, state }) => ({ decisionId: decision_id, state })),
            lastChangedAt,
          ),
        };
      }),
    readTaskRuntimeBatch: (query) =>
      read(async (client) => {
        if (
          !Array.isArray(query.taskIds) ||
          query.taskIds.length === 0 ||
          query.taskIds.length > 500 ||
          query.taskIds.some((id) => typeof id !== "string" || id.length === 0) ||
          new Set(query.taskIds).size !== query.taskIds.length
        )
          throw new Error("task runtime batch requires 1..500 unique task ids");
        const limit = query.limit === undefined ? 500 : checkedPageLimit(query.limit),
          after = query.cursor === undefined ? null : decodePageCursor(query.cursor, 1)[0]!,
          remaining = [...query.taskIds].sort().filter((id) => after === null || id > after),
          taskIds = remaining.slice(0, limit),
          last = taskIds.at(-1),
          tasks = await client.query<{ task_id: string; title: string; package_path: string | null }>(
            `SELECT task_id,snapshot#>>'{task,title}' AS title,package_path FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND task_id=ANY($5::text[]) ORDER BY task_id`,
            [...parameters, taskIds],
          ),
          sessions = await client.query<{ task_id: string; value: RuntimeSession }>(
            `SELECT binding->>'taskId' AS task_id, projection.value FROM ha_projection_values projection CROSS JOIN LATERAL jsonb_array_elements(projection.value->'taskBindings') AS binding
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session' AND (cardinality($4::text[])=0 OR readers && $4::text[])
           AND binding->>'taskId'=ANY($5::text[]) ORDER BY binding->>'taskId',entity_id,binding->>'boundAt',binding->>'executionId'`,
            [...parameters, taskIds],
          );
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          taskIds,
          rows: tasks.rows.map(({ task_id, title, package_path }) => ({
            taskId: task_id,
            title,
            packagePath: package_path,
            sessions: sessions.rows
              .filter((row) => row.task_id === task_id)
              .map(({ value }) => publicRuntimeSession(value)),
          })),
          page: {
            limit,
            cursor: query.cursor ?? null,
            nextCursor: remaining.length > limit && last ? encodePageCursor([last]) : null,
          },
        };
      }),
    // Like SQLite's digest, this is an opaque fingerprint of this backend's complete stored
    // read models, not a portable hash of only the canonical task snapshots.
    readStateDigest: () =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId);
        if (cut.status !== "ready") return null;
        let digest = sha256Text("pg-task-projection-state/v1");
        for (const table of PG_PROJECTION_TABLES.filter((name) => name !== "ha_projection_meta")) {
          digest = sha256Text(`${digest}\n${table}`);
          const result = await client.query<{ row_value: Record<string, unknown> }>(
            `SELECT to_jsonb(projection) - ARRAY['tenant_id','project_id','policy_epoch','readers'] AS row_value FROM ${table} projection
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY (to_jsonb(projection) - ARRAY['tenant_id','project_id','policy_epoch','readers'])::text`,
            parameters,
          );
          for (const { row_value } of result.rows)
            digest = sha256Text(`${digest}\n${canonicalJson(row_value as never)}`);
        }
        for (const row of await readEventRowsInTransaction(client, scope, readers, repoId, "true"))
          digest = sha256Text(`${digest}\n${row.event_json}`);
        return `sha256:${digest}` as ReturnType<TaskProjectionQueries["readStateDigest"]>;
      }),
  };
}
