import type { Pool } from "pg";
import type {
  TaskProjectionListQuery,
  TaskProjectionListRead,
  TaskProjectionRead,
  TaskRelationProjectionRead,
} from "@harness-anything/kernel";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import type {
  FactProjectionRow,
  TaskRelationProjectionRow,
} from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import { factInvalidated, factLiveness } from "@harness-anything/kernel/internal/domain/fact-liveness.ts";
import { relationOwnerRef } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";

export interface PgTaskProjectionSourceOptions {
  readonly pool: Pool;
  readonly scope: PgProjectionScope;
  readonly path?: string;
  readonly maxItems?: number;
  readonly ownsPool?: boolean;
}

export interface PgProjectionCut {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
}

/**
 * Async PG read source. The public synchronous `TaskProjectionQueries` port is bridged by the RepoWriter worker;
 * this object owns only SQL and transaction boundaries and is safe to call from that bridge.
 */
export interface PgTaskProjectionSource {
  readonly path: string;
  readonly readCut: () => Promise<PgProjectionCut>;
  readonly read: (taskId: string) => Promise<TaskProjectionRead>;
  readonly list: (query?: TaskProjectionListQuery) => Promise<TaskProjectionListRead>;
  readonly readSnapshot: (taskId: string) => Promise<TaskLifecycleSnapshot | null>;
  readonly readDecision: (decisionId: string) => Promise<Record<string, unknown> | null>;
  readonly readFacts: (query?: {
    readonly limit?: number;
    readonly refs?: readonly string[];
  }) => Promise<readonly FactProjectionRow[]>;
  readonly readRelations: (query?: {
    readonly source?: string;
    readonly target?: string;
    readonly relationType?: string;
    readonly limit?: number;
  }) => Promise<TaskRelationProjectionRead>;
  readonly readDecisions: (decisionIds?: readonly string[]) => Promise<readonly Record<string, unknown>[]>;
  readonly close: () => Promise<void>;
}

export function createPgTaskProjectionSource(options: PgTaskProjectionSourceOptions): PgTaskProjectionSource {
  const maxItems = options.maxItems ?? 4096;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 4096)
    throw new Error("postgres task projection maxItems must be between 1 and 4096");
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])],
    path = options.path ?? "postgres:task-projection";
  const readCut = () =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const result = await client.query<{ watermark: string; source_revision: string }>(
          `SELECT watermark::text, source_revision::text FROM ha_projection_meta
           WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND projection_name = 'task/v1'
             AND (cardinality($4::text[]) = 0 OR readers && $4::text[])`,
          [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
        );
        const watermark = Number(result.rows[0]?.watermark ?? 0),
          sourceRevision = Number(result.rows[0]?.source_revision ?? 0);
        return { status: watermark === sourceRevision ? "ready" : "pending", watermark, sourceRevision } as const;
      },
      claims,
    );
  const readSnapshot = (taskId: string) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const result = await client.query<{ snapshot: TaskLifecycleSnapshot }>(
          `SELECT snapshot FROM ha_task_snapshots
           WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4
             AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
          [claims.tenantId, claims.projectId, claims.policyEpoch, taskId, readers],
        );
        return result.rows[0]?.snapshot ?? null;
      },
      claims,
    );
  const read = (taskId: string): Promise<TaskProjectionRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers),
          result = await client.query<{ snapshot: TaskLifecycleSnapshot }>(
            `SELECT snapshot FROM ha_task_snapshots
             WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, taskId, readers],
          ),
          snapshot = result.rows[0]?.snapshot ?? null;
        return {
          status: cut.status,
          snapshot: snapshot ?? emptySnapshot(),
          packagePath: null,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: snapshot === null && cut.sourceRevision > 0 ? ["projection_missing"] : [],
          catchUp: { maxItems, reducedItems: 0, storeTransactions: 0 },
        };
      },
      claims,
    );
  const list = (query: TaskProjectionListQuery = {}) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (query.status !== undefined) {
          values.push(query.status);
          where.push(`snapshot #>> '{task,status}' = $${values.length}`);
        }
        if (query.search !== undefined) {
          const search = query.search.replace(/[\\%_]/gu, "\\$&");
          values.push(`${search}%`, `%${search}%`);
          where.push(
            `(task_id ILIKE $${values.length - 1} ESCAPE '\\' OR snapshot #>> '{task,title}' ILIKE $${values.length} ESCAPE '\\')`,
          );
        }
        if (query.taskIds !== undefined) {
          values.push(query.taskIds);
          where.push(`task_id = ANY($${values.length}::text[])`);
        }
        if (query.changedAfterRevision !== undefined) {
          values.push(query.changedAfterRevision);
          where.push(`workspace_revision > $${values.length}`);
        }
        if (query.updatedAfter !== undefined) {
          values.push(query.updatedAfter);
          where.push(`updated_at >= $${values.length}::timestamptz`);
        }
        if (query.updatedBefore !== undefined) {
          values.push(query.updatedBefore);
          where.push(`updated_at <= $${values.length}::timestamptz`);
        }
        if (query.parentTaskId !== undefined) {
          values.push(query.parentTaskId);
          where.push(`snapshot #>> '{task,metadata,parentTaskId}' IS NOT DISTINCT FROM $${values.length}`);
        }
        for (const [key, value] of [
          ["workKind", query.workKind],
          ["riskTier", query.riskTier],
          ["urgency", query.urgency],
          ["slug", query.slug],
        ] as const)
          if (value !== undefined) {
            values.push(value);
            where.push(`snapshot #>> '{task,metadata,${key}}' = $${values.length}`);
          }
        if (query.openOnly === true) where.push(`snapshot #>> '{task,status}' NOT IN ('done', 'cancelled')`);
        if (query.activePackagesOnly === true)
          where.push(`COALESCE(snapshot #>> '{task,packageDisposition}', 'active') = 'active'`);
        if (query.workRootsOnly === true)
          where.push(
            `(snapshot #>> '{task,taskClass}' = 'work' OR (
               snapshot #>> '{task,metadata,parentTaskId}' IS NULL AND EXISTS (
                 SELECT 1 FROM ha_task_snapshots AS child
                 WHERE child.tenant_id = ha_task_snapshots.tenant_id
                   AND child.project_id = ha_task_snapshots.project_id
                   AND child.policy_epoch = ha_task_snapshots.policy_epoch
                   AND (cardinality($4::text[]) = 0 OR child.readers && $4::text[])
                   AND child.snapshot #>> '{task,metadata,parentTaskId}' = ha_task_snapshots.task_id
               )
             ))`,
          );
        if (query.cursor !== undefined) {
          const cursor = decodeTaskListCursor(query.cursor, query.pinnedFirst === true ? 2 : 1);
          if (query.pinnedFirst === true) {
            const cursorPinned = cursor[0]!;
            if (cursorPinned !== "0" && cursorPinned !== "1") throw new Error("query cursor is invalid");
            values.push(cursorPinned === "1", cursorPinned === "1", cursor[1]!);
            const pinnedExpression = "COALESCE((snapshot #>> '{task,pinned}')::boolean, false)";
            where.push(
              `(${pinnedExpression} < $${values.length - 2} OR (${pinnedExpression} = $${values.length - 1} AND task_id > $${values.length}))`,
            );
          } else {
            values.push(cursor[0]);
            where.push(`task_id > $${values.length}`);
          }
        }
        const limit = Math.min(Math.max(query.limit ?? maxItems, 1), maxItems);
        values.push(limit + 1);
        const result = await client.query<{
          task_id: string;
          workspace_revision: string;
          snapshot: TaskLifecycleSnapshot;
          updated_at: string;
        }>(
          `SELECT task_id, workspace_revision::text, snapshot, updated_at::text FROM ha_task_snapshots
           WHERE ${where.join(" AND ")} ORDER BY ${query.pinnedFirst ? "COALESCE((snapshot #>> '{task,pinned}')::boolean, false) DESC, " : ""}task_id LIMIT $${values.length}`,
          values,
        );
        const truncated = result.rows.length > limit,
          rows = (truncated ? result.rows.slice(0, limit) : result.rows).map((row) => ({
            taskId: row.task_id,
            packagePath: null,
            generation: "v1" as const,
            workspaceRevision: Number(row.workspace_revision),
            createdAt: null,
            completedAt: null,
            updatedAt: row.updated_at,
            snapshot: row.snapshot,
          }));
        return {
          status: cut.status,
          rows,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: [],
          ...(truncated
            ? {
                page: {
                  limit,
                  cursor: query.cursor ?? null,
                  nextCursor:
                    rows.at(-1) === undefined
                      ? null
                      : encodeTaskListCursor(
                          query.pinnedFirst === true
                            ? [rows.at(-1)!.snapshot.task?.pinned === true ? "1" : "0", rows.at(-1)!.taskId]
                            : [rows.at(-1)!.taskId],
                        ),
                },
              }
            : {}),
        };
      },
      claims,
    );
  const readFacts = (query: { readonly limit?: number; readonly refs?: readonly string[] } = {}) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (query.refs !== undefined) {
          values.push(query.refs);
          where.push(`value->>'ref' = ANY($${values.length}::text[])`);
        }
        values.push(Math.min(Math.max(query.limit ?? maxItems, 1), maxItems));
        const result = await client.query<{ value: FactProjectionRow }>(
          `SELECT value FROM ha_facts WHERE ${where.join(" AND ")} ORDER BY fact_id LIMIT $${values.length}`,
          values,
        );
        if (result.rows.length === 0) return [];
        const facts = result.rows.map((row) => row.value),
          refs = facts.map((fact) => fact.ref),
          relations = await client.query<{
            target_ref: string;
            relation_type: string;
            relation_state: string;
          }>(
            `SELECT target_ref, relation_type, relation_state FROM ha_relations
             WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3
               AND target_ref = ANY($4::text[]) AND relation_type = 'supersedes-fact'
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, refs, readers],
          );
        const livenessRelations = relations.rows.map((relation) => ({
          targetRef: relation.target_ref,
          relationType: relation.relation_type,
          state: relation.relation_state,
        }));
        return facts.map((fact) => {
          const state = factLiveness(fact, livenessRelations);
          return { ...fact, state, invalidated: factInvalidated(state), archived: fact.archived === true };
        });
      },
      claims,
    );
  const readRelations = (
    query: {
      readonly source?: string;
      readonly target?: string;
      readonly relationType?: string;
      readonly limit?: number;
    } = {},
  ) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (query.source !== undefined) {
          values.push(query.source);
          where.push(`source_ref = $${values.length}`);
        }
        if (query.target !== undefined) {
          values.push(query.target);
          where.push(`target_ref = $${values.length}`);
        }
        if (query.relationType !== undefined) {
          values.push(query.relationType);
          where.push(`relation_type = $${values.length}`);
        }
        values.push(Math.min(Math.max(query.limit ?? maxItems, 1), maxItems));
        const result = await client.query<{
          relation_id: string;
          source_ref: string;
          target_ref: string;
          relation_type: string;
          relation_state: string;
          workspace_revision: string;
          value: Record<string, unknown>;
        }>(
          `SELECT relation_id, source_ref, target_ref, relation_type, relation_state, workspace_revision::text, value
           FROM ha_relations WHERE ${where.join(" AND ")} ORDER BY relation_id LIMIT $${values.length}`,
          values,
        );
        return {
          status: cut.status,
          rows: result.rows.map(
            (row) =>
              ({
                relationId: row.relation_id,
                workspaceRevision: Number(row.workspace_revision),
                sourceRef: row.source_ref,
                targetRef: row.target_ref,
                relationType: row.relation_type as TaskRelationProjectionRow["relationType"],
                direction: String(row.value.direction ?? "directed") as never,
                strength: String(row.value.strength ?? "strong") as never,
                origin: String(row.value.origin ?? "event") as never,
                state: row.relation_state as never,
                targetObservedVersion: (row.value.targetObservedVersion as never) ?? null,
                currentTargetVersion: (row.value.currentTargetVersion as never) ?? null,
                freshness: String(row.value.freshness ?? "suspect") as never,
                rationale: String(row.value.rationale ?? ""),
                ownerRef: String(row.value.ownerRef ?? relationOwnerRef(row.source_ref)),
                sourcePath: String(row.value.sourcePath ?? "event:unknown"),
                recordIndex: Number(row.value.recordIndex ?? 0),
              }) as TaskRelationProjectionRow,
          ),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      },
      claims,
    );
  const readDecisions = (decisionIds?: readonly string[]) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (decisionIds !== undefined) {
          values.push(decisionIds);
          where.push(`decision_id = ANY($${values.length}::text[])`);
        }
        const result = await client.query<{ value: Record<string, unknown> }>(
          `SELECT value FROM ha_decisions WHERE ${where.join(" AND ")} ORDER BY decision_id`,
          values,
        );
        return result.rows.map((row) => row.value);
      },
      claims,
    );
  const readDecision = async (decisionId: string): Promise<Record<string, unknown> | null> => {
    const result = await readDecisions([decisionId]);
    return result[0] ?? null;
  };
  return {
    path,
    readCut,
    read,
    list,
    readSnapshot,
    readDecision,
    readFacts,
    readRelations,
    readDecisions,
    close: async () => {
      if (options.ownsPool === true) await options.pool.end();
    },
  };
}

async function readCutInTransaction(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
): Promise<PgProjectionCut> {
  const result = await client.query<{ watermark: string; source_revision: string }>(
    `SELECT watermark::text, source_revision::text FROM ha_projection_meta
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND projection_name = 'task/v1'
       AND (cardinality($4::text[]) = 0 OR readers && $4::text[])`,
    [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
  );
  const watermark = Number(result.rows[0]?.watermark ?? 0),
    sourceRevision = Number(result.rows[0]?.source_revision ?? 0);
  return { status: watermark === sourceRevision ? "ready" : "pending", watermark, sourceRevision };
}

function emptySnapshot(): TaskLifecycleSnapshot {
  return emptyTaskLifecycleSnapshot(0);
}

function encodeTaskListCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeTaskListCursor(value: string, expected: number): readonly string[] {
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
