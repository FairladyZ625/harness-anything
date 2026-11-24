import type { PoolClient } from "pg";
import type {
  DecisionProjectionListRead,
  DecisionProjectionRead,
  TaskProjectionListQuery,
  TaskProjectionListRead,
  TaskProjectionRead,
} from "@harness-anything/kernel";
import { taskAttribution } from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import {
  emptyTaskLifecycleSnapshot,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { effectiveLeaseValue } from "@harness-anything/kernel/internal/domain/task-lease-policy.ts";
import { getClientDialectCapabilities } from "../postgres/dialect.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { decodePageCursor, encodePageCursor } from "../projection/iso-timestamp-sql.ts";
import { readPgDecisionRows } from "./pg-decision-reads.ts";
import { pgTaskAttributionColumns, readCutInTransaction } from "./pg-event-queries.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { presentationStatusSql, readScopedTaskIds } from "./pg-task-index-queries.ts";
import { assertPgTaskParentIndexReady } from "./pg-task-parent-index.ts";
import type { PgProjectionCut, PgTaskProjectionSourceOptions } from "./pg-task-source.ts";

export interface PgCoreReadQueries {
  readonly readCut: () => Promise<PgProjectionCut>;
  readonly readSnapshot: (taskId: string) => Promise<TaskLifecycleSnapshot | null>;
  readonly read: (
    taskId: string,
    presentationStatus?: boolean,
    presentationRollup?: boolean,
  ) => Promise<TaskProjectionRead>;
  readonly list: (query?: TaskProjectionListQuery) => Promise<TaskProjectionListRead>;
  readonly readDecisions: (decisionIds: readonly string[], withBody?: boolean) => Promise<DecisionProjectionListRead>;
  readonly readDecision: (decisionId: string, withBody?: boolean) => Promise<DecisionProjectionRead>;
}

function presentSnapshot(snapshot: TaskLifecycleSnapshot, status: string): TaskLifecycleSnapshot {
  if (!snapshot.task || snapshot.task.status === status) return snapshot;
  return { ...snapshot, task: { ...snapshot.task, status: status as typeof snapshot.task.status } };
}

function toIsoTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new Error(`invalid PostgreSQL projection timestamp: ${value}`);
  return timestamp.toISOString();
}

async function hydrateSnapshots(
  client: PoolClient,
  scope: PgProjectionScope,
  snapshots: readonly TaskLifecycleSnapshot[],
  now: string,
  decisionRelationsOnly = false,
): Promise<readonly TaskLifecycleSnapshot[]> {
  if (!snapshots.length) return [];
  const relations: Awaited<ReturnType<typeof readRelationsInTransaction>>[number][] = [];
  if (decisionRelationsOnly) {
    // One indexed seek per task: an ANY list over task ids lets the planner scan every relation
    // that targets an unrelated task, which is the session history an aggregate page must not pay.
    for (const { task } of snapshots)
      if (task)
        relations.push(
          ...(await readRelationsInTransaction(client, scope, [...(scope.readers ?? [])], {
            target: `task/${task.taskId}`,
            sourceRoot: "decision/",
            relationType: "derives",
          })),
        );
  } else
    relations.push(
      ...(await readRelationsInTransaction(client, scope, [...(scope.readers ?? [])], {
        targets: snapshots.flatMap(({ task }) => (task ? [`task/${task.taskId}`] : [])),
      })),
    );
  return snapshots.map((snapshot) => {
    const effective = effectiveLeaseValue(snapshot.lease, now),
      lease = effective?.phase === "released" ? null : effective;
    return {
      ...snapshot,
      executions: [...snapshot.executions].sort(
        (a, b) =>
          a.iteration - b.iteration ||
          a.claimedAt.localeCompare(b.claimedAt) ||
          a.executionId.localeCompare(b.executionId),
      ),
      reviews: [...snapshot.reviews].sort((a, b) => a.reviewId.localeCompare(b.reviewId)),
      lease,
      decisionRelations: relations
        .filter((relation) => relation.targetRef === `task/${snapshot.task?.taskId}`)
        .map(({ relationId, sourceRef, targetRef, relationType, state, strength, freshness }) => ({
          relationId,
          sourceRef,
          targetRef,
          relationType,
          state,
          strength,
          freshness,
        })),
    };
  });
}

export function pgCoreReadQueries(options: PgTaskProjectionSourceOptions): PgCoreReadQueries {
  const maxItems = options.maxItems ?? 4096,
    now = options.now ?? (() => new Date().toISOString());
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 4096)
    throw new Error("postgres task projection maxItems must be between 1 and 4096");
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])],
    repoId = options.repoId;
  if (!repoId) throw new TypeError("PostgreSQL task projection requires a repository id for cut validation");
  const readCut = () =>
    withPostgresTransaction(
      options.pool,
      async (client) => readCutInTransaction(client, claims, readers, repoId),
      claims,
      { isolationLevel: "repeatable read" },
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
        const snapshot = result.rows[0]?.snapshot;
        return snapshot ? (await hydrateSnapshots(client, options.scope, [snapshot], now()))[0]! : null;
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const read = (taskId: string, presentationStatus = false, presentationRollup = true): Promise<TaskProjectionRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (presentationStatus) await assertPgTaskParentIndexReady(client, options.scope);
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          // Keep main's bounded raw path: presentationStatus=false only projects the task's own
          // snapshot status, never the recursive subtree rollup. The rollup is computed only when
          // the caller reads presentation status; an explicit raw caller may skip even the scalar.
          presentation = presentationStatus
            ? presentationStatusSql(5, getClientDialectCapabilities(client))
            : presentationRollup
              ? "snapshot #>> '{task,status}'"
              : "NULL::text",
          result = await client.query<{
            snapshot: TaskLifecycleSnapshot;
            package_path: string | null;
            presentation_status: string;
          }>(
            `SELECT snapshot, package_path, ${presentation} AS presentation_status FROM ha_task_snapshots
             WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, taskId, readers],
          ),
          snapshot = result.rows[0]?.snapshot
            ? (await hydrateSnapshots(client, options.scope, [result.rows[0].snapshot], now()))[0]!
            : null;
        return {
          status: cut.status,
          snapshot:
            snapshot === null
              ? emptyTaskLifecycleSnapshot(0)
              : presentationStatus
                ? presentSnapshot(snapshot, result.rows[0]!.presentation_status)
                : snapshot,
          packagePath: result.rows[0]?.package_path ?? null,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: [],
          catchUp: { maxItems, reducedItems: 0, storeTransactions: 0 },
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const list = (query: TaskProjectionListQuery = {}): Promise<TaskProjectionListRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        await assertPgTaskParentIndexReady(client, options.scope);
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (query.status !== undefined) {
          values.push(query.status);
          where.push(
            `${query.presentationStatus ? presentationStatusSql(4, getClientDialectCapabilities(client)) : "task_status"} = $${values.length}`,
          );
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
          where.push(`task_id = ANY($${values.length}::text[])`);
        }
        if (query.submissionCommitShas !== undefined) {
          values.push(query.submissionCommitShas);
          where.push(
            `(submission_commit_sha = ANY($${values.length}::text[]) OR external_commit_sha = ANY($${values.length}::text[]))`,
          );
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
          if (query.parentTaskId === null) where.push("parent_task_id IS NULL");
          else {
            values.push(query.parentTaskId);
            where.push(`parent_task_id = $${values.length}`);
          }
        }
        if (query.scopeRootTaskId !== undefined) {
          await assertPgTaskParentIndexReady(client, options.scope);
          values.push(await readScopedTaskIds(client, options.scope, readers, query.scopeRootTaskId));
          where.push(`task_id=ANY($${values.length}::text[])`);
        }
        for (const [key, value] of [
          ["workKind", query.workKind],
          ["riskTier", query.riskTier],
          ["urgency", query.urgency],
          ["slug", query.slug],
        ] as const)
          if (value !== undefined) {
            values.push(value);
            where.push(
              `task_${key === "workKind" ? "work_kind" : key === "riskTier" ? "risk_tier" : key} = $${values.length}`,
            );
          }
        if (query.openOnly === true) where.push("task_status NOT IN ('done', 'cancelled')");
        const onlyWithLeases = query.leaseOnly === true;
        if (onlyWithLeases) where.push("task_lease_phase IS NOT NULL AND task_lease_phase <> 'released'");
        if (query.activePackagesOnly === true) where.push("task_package_disposition = 'active'");
        if (query.workRootsOnly === true)
          where.push(
            `(task_class = 'work' OR (
               parent_task_id IS NULL AND EXISTS (
                 SELECT 1 FROM ha_task_snapshots AS child
                 WHERE child.tenant_id = ha_task_snapshots.tenant_id
                   AND child.project_id = ha_task_snapshots.project_id
                   AND child.policy_epoch = ha_task_snapshots.policy_epoch
                   AND (cardinality($4::text[]) = 0 OR child.readers && $4::text[])
                   AND child.parent_task_id = ha_task_snapshots.task_id
               )
             ))`,
          );
        if (query.cursor !== undefined) {
          const cursor = decodePageCursor(query.cursor, query.pinnedFirst === true ? 2 : 1);
          if (query.pinnedFirst === true) {
            const cursorPinned = cursor[0]!;
            if (cursorPinned !== "0" && cursorPinned !== "1") throw new Error("query cursor is invalid");
            values.push(cursorPinned === "1", cursorPinned === "1", cursor[1]!);
            const pinnedExpression = "task_pinned";
            where.push(
              `(${pinnedExpression} < $${values.length - 2} OR (${pinnedExpression} = $${values.length - 1} AND task_id > $${values.length}))`,
            );
          } else {
            values.push(cursor[0]);
            where.push(`task_id > $${values.length}`);
          }
        }
        const paged = query.limit !== undefined || query.cursor !== undefined,
          limit = paged ? checkedPageLimit(query.limit ?? 100) : null;
        const limitParameter = limit === null ? null : values.push(limit + 1);
        const repoParameter = values.push(repoId),
          presentation = query.presentationStatus
            ? presentationStatusSql(4, getClientDialectCapabilities(client))
            : "task_status",
          result = await client.query<{
            task_id: string;
            package_path: string | null;
            generation: "v0" | "v1";
            workspace_revision: string;
            snapshot: TaskLifecycleSnapshot;
            presentation_status: string;
            created_at: string | null;
            completed_at: string | null;
            updated_at: string;
            origin_node_id: string | null;
            latest_node_id: string | null;
            latest_person_id: string | null;
            latest_at: string | null;
          }>(
            `SELECT task_id, package_path, generation, workspace_revision::text, snapshot, ${pgTaskAttributionColumns(repoParameter)}, created_at::text, completed_at::text, updated_at::text, ${presentation} AS presentation_status FROM ha_task_snapshots
           WHERE ${where.join(" AND ")} ORDER BY ${query.pinnedFirst ? "task_pinned DESC, " : ""}task_id${limitParameter === null ? "" : ` LIMIT $${limitParameter}`}`,
            values,
          );
        const truncated = limit !== null && result.rows.length > limit,
          hydrated = await hydrateSnapshots(
            client,
            options.scope,
            result.rows.map((row) => row.snapshot),
            now(),
            query.presentationStatus === false || query.decisionRelationsOnly === true,
          ),
          rows = (limit === null ? result.rows : result.rows.slice(0, limit)).map((row, index) => ({
            taskId: row.task_id,
            packagePath: row.package_path,
            generation: row.generation,
            workspaceRevision: Number(row.workspace_revision),
            createdAt: row.created_at === null ? null : toIsoTimestamp(row.created_at),
            completedAt: row.completed_at === null ? null : toIsoTimestamp(row.completed_at),
            updatedAt: toIsoTimestamp(row.updated_at),
            ...taskAttribution(
              hydrated[index]!,
              row.origin_node_id,
              row.latest_node_id,
              row.latest_person_id,
              row.latest_at,
            ),
            snapshot: query.presentationStatus
              ? presentSnapshot(hydrated[index]!, row.presentation_status)
              : hydrated[index]!,
          }));
        return {
          status: cut.status,
          rows,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: [],
          ...(limit !== null
            ? {
                page: {
                  limit,
                  cursor: query.cursor ?? null,
                  nextCursor:
                    !truncated || rows.at(-1) === undefined
                      ? null
                      : encodePageCursor(
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
      { isolationLevel: "repeatable read" },
    );
  const readDecisions = (decisionIds: readonly string[], withBody = true): Promise<DecisionProjectionListRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (!Array.isArray(decisionIds) || decisionIds.some((id) => typeof id !== "string" || id.length === 0))
          throw new Error("decision collection read requires non-empty string ids");
        const cut = await readCutInTransaction(client, claims, readers, repoId);
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
        const result = await client.query<{ decision_id: string; value: Record<string, unknown> }>(
          `SELECT decision_id, value FROM ha_decisions WHERE ${where.join(" AND ")}`,
          values,
        );
        const order = new Map<string, number>();
        for (const [index, id] of decisionIds.entries()) if (!order.has(id)) order.set(id, index);
        const orderedRows = [...result.rows].sort(
          (left, right) => (order.get(left.decision_id) ?? Infinity) - (order.get(right.decision_id) ?? Infinity),
        );
        return {
          status: cut.status,
          decisions: await readPgDecisionRows(client, options.scope, repoId, orderedRows, withBody),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readDecision = async (decisionId: string, withBody = true): Promise<DecisionProjectionRead> => {
    const result = await readDecisions([decisionId], withBody);
    return {
      status: result.status,
      decision: result.decisions[0] ?? null,
      watermark: result.watermark,
      sourceRevision: result.sourceRevision,
    };
  };
  return { readCut, readSnapshot, read, list, readDecisions, readDecision };
}
