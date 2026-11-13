import type { PoolClient } from "pg";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
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
import { canonicalJson, hashCanonicalJsonTextFieldChunksAsync } from "../projection/rebuildable-task-projection-sql.ts";
import { decodePageCursor, encodePageCursor, checkedPageLimit } from "../projection/task-query-projection.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction, readEventRowsInTransaction } from "./pg-event-queries.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import { pgProjectionStoredRows } from "./pg-projection-stored-rows.ts";
import { PG_PROJECTION_AUDIT_TABLES } from "./pg-projection-schema.ts";
import { readPgTaskSessions } from "./pg-runtime-session-queries.ts";
import { assertPgTaskParentIndexReady } from "./pg-task-parent-index.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgAggregateQueries = AsyncQueries<"readWorkspaceSummary" | "readTaskRuntimeBatch" | "readStateDigest">;
const stateDigestChunkBytes = 1024 * 1024;
const stateDigestChunkCharacters = stateDigestChunkBytes / 4;

export function pgAggregateQueries(options: PgTaskProjectionSourceOptions): PgAggregateQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  return {
    readWorkspaceSummary: () =>
      read(async (client) => {
        await assertPgTaskParentIndexReady(client, scope);
        const tasks = await client.query<{
            task_id: string;
            status: string | null;
            updated_at: Date;
          }>(
            `SELECT task_id,task_status AS status,updated_at
         FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND task_package_disposition='active'
           AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY task_id`,
            parameters,
          ),
          taskById = new Map(
            tasks.rows.map(({ task_id, status }) => [task_id, { taskId: task_id, status: status ?? "unknown" }]),
          ),
          sources = new Set(
            tasks.rows
              .filter(({ status }) => status === "planned" || status === "active")
              .map(({ task_id }) => task_id),
          ),
          relations = new Map<string, Awaited<ReturnType<typeof readRelationsInTransaction>>[number]>();
        // Only planned/active current packages can change census status. Expand each visible
        // dependency component once, including done/archived endpoints. Incoming entries and
        // relation-id order matter to blockingOf's DFS even when those entries are archived.
        // Never fabricate a missing/hidden endpoint for the domain judgment.
        for (const taskId of sources) {
          if (!taskById.has(taskId)) {
            const target = await client.query<{ status: string | null }>(
              `SELECT task_status AS status FROM ha_task_snapshots
               WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$5
                 AND (cardinality($4::text[])=0 OR readers && $4::text[])`,
              [...parameters, taskId],
            );
            if (!target.rows[0]) continue;
            taskById.set(taskId, { taskId, status: target.rows[0].status ?? "unknown" });
          }
          for (const [relationType, endpoint] of [
            ["depends-on", "source"],
            ["depends-on", "target"],
            ["awaits", "source"],
          ] as const) {
            const edges = await readRelationsInTransaction(client, scope, readers, {
              [endpoint]: `task/${taskId}`,
              relationType,
              state: "active",
            });
            for (const edge of edges) {
              relations.set(edge.relationId, edge);
              if (relationType === "depends-on")
                for (const ref of [edge.sourceRef, edge.targetRef]) {
                  const id = /^task\/([^/]+)$/u.exec(ref)?.[1];
                  if (id) sources.add(id);
                }
            }
          }
        }
        const orderedRelations = [...relations.values()].sort((left, right) =>
            left.relationId < right.relationId ? -1 : left.relationId > right.relationId ? 1 : 0,
          ),
          states = new Map(
            blockingOf([...taskById.values()], orderedRelations).map(({ taskId, state }) => [taskId, state]),
          ),
          counts = emptyWorkspaceTaskCounts();
        let lastChangedAt: string | null = null;
        for (const row of tasks.rows) {
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
          sessions = query.includeSessions === false ? new Map() : await readPgTaskSessions(client, scope, taskIds);
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          taskIds,
          rows: tasks.rows.map(({ task_id, title, package_path }) => ({
            taskId: task_id,
            title,
            packagePath: package_path,
            sessions: (sessions.get(task_id) ?? []).map(publicRuntimeSession),
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
        for (const table of PG_PROJECTION_AUDIT_TABLES.filter((name) => name !== "ha_projection_meta")) {
          digest = sha256Text(`${digest}\n${table}`);
          if (table === "ha_projection_values") {
            digest = await digestPgProjectionValues(client, scope, readers, digest);
            continue;
          }
          const stored = pgProjectionStoredRows(table);
          const result = await client.query<{ row_value: Record<string, unknown> }>(
            `SELECT (${stored.row}) - ARRAY['tenant_id','project_id','policy_epoch','readers'] AS row_value FROM ${stored.from}
           WHERE projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3 AND (cardinality($4::text[])=0 OR projection.readers && $4::text[]) ORDER BY ${table === "ha_entity_declaration_heads" ? "entity_kind,entity_id" : `((${stored.row}) - ARRAY['tenant_id','project_id','policy_epoch','readers'])::text`}`,
            parameters,
          );
          for (const { row_value } of result.rows) {
            // Current declarations retain JSON text for NUL/surrogate compatibility. Previous
            // writers' object key order must not turn an equivalent rebuild into a new state.
            const value =
              table === "ha_entity_declaration_heads"
                ? { ...row_value, state: JSON.parse(String(row_value.state)) }
                : row_value;
            digest = sha256Text(`${digest}\n${canonicalJson(value)}`);
          }
        }
        for (const row of await readEventRowsInTransaction(client, scope, readers, repoId, "true"))
          digest = sha256Text(`${digest}\n${row.event_json}`);
        return `sha256:${digest}` as ReturnType<TaskProjectionQueries["readStateDigest"]>;
      }),
  };
}

async function digestPgProjectionValues(
  client: PoolClient,
  scope: PgTaskProjectionSourceOptions["scope"],
  readers: readonly string[],
  previousDigest: string,
): Promise<string> {
  const rowWithoutScope = "to_jsonb(projection) - ARRAY['tenant_id','project_id','policy_epoch','readers']",
    rowWithoutScopeAndValue = `${rowWithoutScope} - 'value'`,
    result = await client.query<{
      row_value: Record<string, unknown>;
      value_part: string | null;
      value_bytes: number;
      value_characters: number | null;
      model: string;
      owner_id: string;
      entity_id: string;
    }>(
      `SELECT ${rowWithoutScopeAndValue} AS row_value,
         CASE WHEN octet_length(projection.value) <= $5 THEN projection.value END AS value_part,
         octet_length(projection.value) AS value_bytes,
         CASE WHEN octet_length(projection.value) > $5 THEN char_length(projection.value) END AS value_characters,
         projection.model, projection.owner_id, projection.entity_id
       FROM ha_projection_values projection
       WHERE projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3
         AND (cardinality($4::text[])=0 OR projection.readers && $4::text[])
       ORDER BY (${rowWithoutScope})::text`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, readers, stateDigestChunkBytes],
    );
  let digest = previousDigest;
  for (const row of result.rows) {
    async function* readValueChunks(): AsyncIterable<Uint8Array> {
      if (row.value_bytes <= stateDigestChunkBytes) {
        yield Buffer.from(row.value_part ?? "", "utf8");
        return;
      }
      for (let offset = 0; offset < (row.value_characters ?? 0); offset += stateDigestChunkCharacters) {
        const chunk = await client.query<{ value_chunk: string }>(
          `SELECT substring(value FROM $8::integer FOR $9::integer) AS value_chunk
           FROM ha_projection_values
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
             AND (cardinality($4::text[])=0 OR readers && $4::text[])
             AND model=$5 AND owner_id=$6 AND entity_id=$7`,
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            readers,
            row.model,
            row.owner_id,
            row.entity_id,
            offset + 1,
            stateDigestChunkCharacters,
          ],
        );
        const valueChunk = chunk.rows[0]?.value_chunk;
        if (valueChunk === undefined)
          throw new Error(`projection value ${row.model}/${row.entity_id} disappeared during state digest`);
        yield Buffer.from(valueChunk, "utf8");
      }
    }
    digest = await hashCanonicalJsonTextFieldChunksAsync(
      digest,
      { ...row.row_value, value: "" },
      "value",
      readValueChunks(),
    );
  }
  return digest;
}
