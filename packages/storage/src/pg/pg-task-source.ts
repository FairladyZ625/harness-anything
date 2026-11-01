import type { Pool } from "pg";
import type {
  DecisionAgendaProjectionPageRead,
  DecisionProjectionListRead,
  DecisionProjectionRead,
  FactProjectionRead,
  FactProjectionSearchRead,
  LeaseV1,
  TaskProjectionListQuery,
  TaskProjectionListRead,
  TaskProjectionRead,
  TaskRelationProjectionRead,
} from "@harness-anything/kernel";
import type {
  DecisionListFilters,
  DecisionPageQuery,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { FactSearchFilters } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import type {
  FactProjectionRow,
  TaskRelationProjectionRow,
} from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { EntityVersionWitness } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import {
  relationFreshnessAnchorForType,
  type RelationType,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { relationFreshnessAtCut } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import { keycloakPersonIdentityWitness } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import { parseEntityRef } from "@harness-anything/kernel/internal/domain/entity-ref.ts";
import { factInvalidated, factLiveness } from "@harness-anything/kernel/internal/domain/fact-liveness.ts";
import { relationOwnerRef } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { readPgDecisionRows } from "./pg-decision-reads.ts";
import { compareDecisionIds, decisionLegacyId, decisionLegacyNumber } from "../projection/decision-projection-reads.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";

export interface PgTaskProjectionSourceOptions {
  readonly pool: Pool;
  readonly scope: PgProjectionScope;
  /** A2 ledger scope used to compare the projection watermark to the durable repository head. */
  readonly repoId: string;
  readonly path?: string;
  readonly maxItems?: number;
  readonly ownsPool?: boolean;
}

export interface PgProjectionCut {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
}

const RETIRED_TASK_SQL = `NOT (
  COALESCE(child.snapshot #>> '{task,packageDisposition}', 'active') = 'archived'
  AND child.snapshot #>> '{task,supersededBy}' IS NOT NULL
)`;

const presentationStatusSql = (readersParameter: number) => `CASE
  WHEN ha_task_snapshots.snapshot #>> '{task,status}' IN ('done','cancelled') THEN ha_task_snapshots.snapshot #>> '{task,status}'
  WHEN ha_task_snapshots.snapshot #>> '{task,taskClass}' = 'work' OR (ha_task_snapshots.snapshot #>> '{task,metadata,parentTaskId}' IS NULL AND EXISTS (
    SELECT 1 FROM ha_task_snapshots child WHERE child.tenant_id=ha_task_snapshots.tenant_id AND child.project_id=ha_task_snapshots.project_id AND child.policy_epoch=ha_task_snapshots.policy_epoch AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[]) AND child.snapshot #>> '{task,metadata,parentTaskId}'=ha_task_snapshots.task_id
  )) THEN COALESCE((WITH RECURSIVE members(task_id,status) AS (
    SELECT child.task_id, child.snapshot #>> '{task,status}' FROM ha_task_snapshots child WHERE child.tenant_id=ha_task_snapshots.tenant_id AND child.project_id=ha_task_snapshots.project_id AND child.policy_epoch=ha_task_snapshots.policy_epoch AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[]) AND child.snapshot #>> '{task,metadata,parentTaskId}'=ha_task_snapshots.task_id AND child.task_id<>ha_task_snapshots.task_id AND ${RETIRED_TASK_SQL}
    UNION SELECT child.task_id, child.snapshot #>> '{task,status}' FROM ha_task_snapshots child JOIN members parent ON child.tenant_id=ha_task_snapshots.tenant_id AND child.project_id=ha_task_snapshots.project_id AND child.policy_epoch=ha_task_snapshots.policy_epoch AND (cardinality($${readersParameter}::text[])=0 OR child.readers && $${readersParameter}::text[]) AND child.snapshot #>> '{task,metadata,parentTaskId}'=parent.task_id WHERE child.task_id<>ha_task_snapshots.task_id AND ${RETIRED_TASK_SQL}
  ) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE status NOT IN ('done','cancelled')) THEN CASE WHEN EXISTS (SELECT 1 FROM members) THEN CASE WHEN EXISTS (SELECT 1 FROM members WHERE status='done') THEN 'done' ELSE 'cancelled' END END WHEN ha_task_snapshots.snapshot #>> '{task,status}'='planned' AND EXISTS (SELECT 1 FROM members WHERE status NOT IN ('planned','cancelled')) THEN 'active' END), ha_task_snapshots.snapshot #>> '{task,status}')
  ELSE ha_task_snapshots.snapshot #>> '{task,status}' END`;

function checkedPageLimit(value: number, maximum = 500): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`query page limit must be an integer between 1 and ${maximum}`);
  return value;
}

function presentSnapshot(snapshot: TaskLifecycleSnapshot, status: string): TaskLifecycleSnapshot {
  if (!snapshot.task || snapshot.task.status === status) return snapshot;
  return { ...snapshot, task: { ...snapshot.task, status: status as typeof snapshot.task.status } };
}

/**
 * Async PG projection primitives. Full synchronous `TaskProjectionQueries` composition and
 * RepoWriter session bridging belong to the subsequent query-port delivery.
 */
export interface PgTaskProjectionSource {
  readonly path: string;
  readonly readCut: () => Promise<PgProjectionCut>;
  readonly read: (taskId: string, presentationStatus?: boolean) => Promise<TaskProjectionRead>;
  readonly list: (query?: TaskProjectionListQuery) => Promise<TaskProjectionListRead>;
  readonly readSnapshot: (taskId: string) => Promise<TaskLifecycleSnapshot | null>;
  readonly readDecision: (decisionId: string) => Promise<DecisionProjectionRead>;
  readonly readFact: (factId: string) => Promise<FactProjectionRead>;
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
  readonly readDecisions: (decisionIds: readonly string[]) => Promise<DecisionProjectionListRead>;
  readonly listDecisions: (filters: DecisionListFilters) => Promise<DecisionProjectionListRead>;
  readonly searchFacts: (filters: FactSearchFilters) => Promise<FactProjectionSearchRead>;
  readonly listDecisionAgendaPage: (query: DecisionPageQuery) => Promise<DecisionAgendaProjectionPageRead>;
  readonly currentLease: (taskId: string, now?: string) => Promise<LeaseV1 | null>;
  readonly currentLeaseForExecution: (executionId: string, now?: string) => Promise<LeaseV1 | null>;
  readonly close: () => Promise<void>;
}

export function createPgTaskProjectionSource(options: PgTaskProjectionSourceOptions): PgTaskProjectionSource {
  const maxItems = options.maxItems ?? 4096;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 4096)
    throw new Error("postgres task projection maxItems must be between 1 and 4096");
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])],
    repoId = options.repoId,
    path = options.path ?? "postgres:task-projection";
  if (!repoId) throw new TypeError("PostgreSQL task projection requires a repository id for cut validation");
  const readCut = () =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        return readCutInTransaction(client, claims, readers, repoId);
      },
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
        return snapshot ? (await hydrateSnapshots(client, options.scope, [snapshot]))[0]! : null;
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const read = (taskId: string, presentationStatus = false): Promise<TaskProjectionRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          result = await client.query<{
            snapshot: TaskLifecycleSnapshot;
            package_path: string | null;
            presentation_status: string;
          }>(
            `SELECT snapshot, package_path, ${presentationStatusSql(5)} AS presentation_status FROM ha_task_snapshots
             WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND task_id = $4
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, taskId, readers],
          ),
          snapshot = result.rows[0]?.snapshot
            ? (await hydrateSnapshots(client, options.scope, [result.rows[0].snapshot]))[0]!
            : null;
        return {
          status: cut.status,
          snapshot:
            snapshot === null
              ? emptySnapshot()
              : presentationStatus
                ? presentSnapshot(snapshot, result.rows[0]!.presentation_status)
                : snapshot,
          packagePath: result.rows[0]?.package_path ?? null,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          warnings: snapshot === null && cut.sourceRevision > 0 ? ["projection_missing"] : [],
          catchUp: { maxItems, reducedItems: 0, storeTransactions: 0 },
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const list = (query: TaskProjectionListQuery = {}) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
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
            `${query.presentationStatus ? presentationStatusSql(4) : "snapshot #>> '{task,status}'"} = $${values.length}`,
          );
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
        const paged = query.limit !== undefined || query.cursor !== undefined,
          limit = paged ? checkedPageLimit(query.limit ?? 100) : maxItems;
        values.push(limit + 1);
        const result = await client.query<{
          task_id: string;
          package_path: string | null;
          generation: "v0" | "v1";
          workspace_revision: string;
          snapshot: TaskLifecycleSnapshot;
          presentation_status: string;
          created_at: string | null;
          completed_at: string | null;
          updated_at: string;
        }>(
          `SELECT task_id, package_path, generation, workspace_revision::text, snapshot, created_at::text, completed_at::text, updated_at::text, ${presentationStatusSql(4)} AS presentation_status FROM ha_task_snapshots
           WHERE ${where.join(" AND ")} ORDER BY ${query.pinnedFirst ? "COALESCE((snapshot #>> '{task,pinned}')::boolean, false) DESC, " : ""}task_id LIMIT $${values.length}`,
          values,
        );
        const truncated = result.rows.length > limit,
          hydrated = await hydrateSnapshots(
            client,
            options.scope,
            result.rows.map((row) => row.snapshot),
          ),
          rows = (truncated ? result.rows.slice(0, limit) : result.rows).map((row, index) => ({
            taskId: row.task_id,
            packagePath: row.package_path,
            generation: row.generation,
            workspaceRevision: Number(row.workspace_revision),
            createdAt: row.created_at === null ? null : toIsoTimestamp(row.created_at),
            completedAt: row.completed_at === null ? null : toIsoTimestamp(row.completed_at),
            updatedAt: toIsoTimestamp(row.updated_at),
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
          ...(query.limit !== undefined || query.cursor !== undefined || truncated
            ? {
                page: {
                  limit,
                  cursor: query.cursor ?? null,
                  nextCursor:
                    !truncated || rows.at(-1) === undefined
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
      { isolationLevel: "repeatable read" },
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
        values.push(checkedPageLimit(query.limit ?? maxItems, maxItems));
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
      { isolationLevel: "repeatable read" },
    );
  const searchFacts = (filters: FactSearchFilters): Promise<FactProjectionSearchRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          where = [
            "tenant_id = $1",
            "project_id = $2",
            "policy_epoch = $3",
            "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
          ];
        if (filters.query?.trim()) {
          values.push(`%${filters.query.trim()}%`);
          where.push(
            `(value->>'statement' ILIKE $${values.length} OR value->>'evidenceSource' ILIKE $${values.length})`,
          );
        }
        for (const [field, value] of [
          ["taskId", filters.taskId],
          ["confidence", filters.confidence],
          ["memoryClass", filters.memoryClass],
        ] as const)
          if (value !== undefined) {
            values.push(value);
            where.push(`value->>'${field}' = $${values.length}`);
          }
        if (filters.refs !== undefined) {
          values.push(filters.refs);
          where.push(`value->>'ref' = ANY($${values.length}::text[])`);
        }
        if (filters.domainType !== undefined) {
          values.push(filters.domainType);
          where.push(`value->'domainTypes' ? $${values.length}`);
        }
        if (filters.observedAfter !== undefined) {
          values.push(filters.observedAfter);
          where.push(`(value->>'observedAt')::timestamptz >= $${values.length}::timestamptz`);
        }
        if (filters.observedBefore !== undefined) {
          values.push(filters.observedBefore);
          where.push(`(value->>'observedAt')::timestamptz <= $${values.length}::timestamptz`);
        }
        if (filters.cursor !== undefined) {
          const cursor = decodeFactCursor(filters.cursor);
          values.push(cursor[0], cursor[0], cursor[1]);
          where.push(
            `((value->>'observedAt') < $${values.length - 2} OR ((value->>'observedAt') = $${values.length - 1} AND fact_id > $${values.length}))`,
          );
        }
        const paged = filters.limit !== undefined || filters.cursor !== undefined,
          limit = filters.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(filters.limit, 500);
        if (limit !== null) values.push(limit + 1);
        const result = await client.query<{ value: FactProjectionRow }>(
          `SELECT value FROM ha_facts WHERE ${where.join(" AND ")} ORDER BY (value->>'observedAt') DESC, fact_id${limit === null ? "" : ` LIMIT $${values.length}`}`,
          values,
        );
        const selected = limit === null ? result.rows : result.rows.slice(0, limit),
          rows = selected.map(({ value }) => value),
          relationResult =
            rows.length === 0
              ? { rows: [] as const }
              : await client.query<{ target_ref: string; relation_state: string }>(
                  `SELECT target_ref, relation_state FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_type='supersedes-fact' AND target_ref = ANY($4::text[]) AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
                  [claims.tenantId, claims.projectId, claims.policyEpoch, rows.map((row) => row.ref), readers],
                );
        const liveness = relationResult.rows.map((row) => ({
          targetRef: row.target_ref,
          relationType: "supersedes-fact" as const,
          state: row.relation_state as never,
        }));
        const facts = rows.map((fact) => {
          const state = factLiveness(fact, liveness);
          return { ...fact, state, invalidated: factInvalidated(state), archived: fact.archived === true };
        });
        return {
          status: cut.status,
          facts,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          ...(limit === null
            ? {}
            : {
                page: {
                  limit,
                  cursor: filters.cursor ?? null,
                  nextCursor:
                    result.rows.length > limit && facts.at(-1)
                      ? encodeFactCursor([facts.at(-1)!.observedAt, facts.at(-1)!.factId])
                      : null,
                },
              }),
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
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
        const cut = await readCutInTransaction(client, claims, readers, repoId);
        return {
          ...cut,
          rows: await readRelationsInTransaction(client, claims, readers, { ...query, limit: query.limit ?? maxItems }),
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readDecisions = (decisionIds: readonly string[]): Promise<DecisionProjectionListRead> =>
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
          `SELECT decision_id, value FROM ha_decisions WHERE ${where.join(" AND ")} ORDER BY array_position($5::text[], decision_id)`,
          values,
        );
        return {
          status: cut.status,
          decisions: await readPgDecisionRows(client, options.scope, repoId, result.rows, true),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readDecision = async (decisionId: string): Promise<DecisionProjectionRead> => {
    const result = await readDecisions([decisionId]);
    return {
      status: result.status,
      decision: result.decisions[0] ?? null,
      watermark: result.watermark,
      sourceRevision: result.sourceRevision,
    };
  };
  const readFact = async (factId: string): Promise<FactProjectionRead> => {
    const result = await searchFacts({ refs: [`fact/${factId}`], limit: 1 });
    return {
      status: result.status,
      fact: result.facts[0] ?? null,
      watermark: result.watermark,
      sourceRevision: result.sourceRevision,
    };
  };
  const listDecisionAgendaPage = (query: DecisionPageQuery): Promise<DecisionAgendaProjectionPageRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          limit = checkedPageLimit(query.limit ?? 100, 100),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers, query.state],
          cursor = query.cursor === undefined ? null : (decodeTaskListCursor(query.cursor, 1)[0] ?? null);
        const rows = await client.query<{ decision_id: string; value: DecisionDocumentShape }>(
          `SELECT decision_id, value FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND value->>'state'=$5`,
          values,
        );
        const ordered = rows.rows
            .filter(({ decision_id }) => cursor === null || compareDecisionIds(decision_id, cursor) > 0)
            .sort((left, right) => compareDecisionIds(left.decision_id, right.decision_id)),
          visible = ordered.slice(0, limit),
          decisions = visible.map(({ decision_id, value }) => ({
            decisionId: decision_id,
            title: String(value.title ?? ""),
            riskTier: value.riskTier as "low" | "medium" | "high",
            urgency: value.urgency as "low" | "medium" | "high",
            proposedAt: String(value.proposedAt ?? ""),
          }));
        return {
          status: cut.status,
          decisions,
          page: {
            limit,
            cursor: query.cursor ?? null,
            nextCursor:
              ordered.length > limit && decisions.at(-1) ? encodeTaskListCursor([decisions.at(-1)!.decisionId]) : null,
          },
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const currentLease = async (taskId: string, now = new Date().toISOString()): Promise<LeaseV1 | null> => {
    const result = await readSnapshot(taskId);
    const lease = result?.lease;
    return lease && lease.phase === "held" && lease.expiresAt > now ? lease : null;
  };
  const currentLeaseForExecution = (executionId: string, now = new Date().toISOString()) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const result = await client.query<{ lease: LeaseV1 }>(
          `SELECT snapshot->'lease' AS lease FROM ha_task_snapshots
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
             AND snapshot #>> '{lease,executionId}'=$4
             AND (cardinality($5::text[])=0 OR readers && $5::text[])
           ORDER BY task_id LIMIT 1`,
          [claims.tenantId, claims.projectId, claims.policyEpoch, executionId, readers],
        );
        const lease = result.rows[0]?.lease;
        return lease && lease.phase === "held" && lease.expiresAt > now ? lease : null;
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const listDecisions = (filters: DecisionListFilters): Promise<DecisionProjectionListRead> =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          result = await client.query<{ decision_id: string; value: DecisionDocumentShape }>(
            `SELECT decision_id,value FROM ha_decisions
             WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
               AND (cardinality($4::text[])=0 OR readers && $4::text[])
             ORDER BY decision_id`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
          ),
          search = filters.search?.trim().toLocaleLowerCase(),
          rows = result.rows
            .filter(({ decision_id, value }) => {
              const legacy = decisionLegacyId(decision_id),
                applies = value.appliesTo as
                  | { modules?: readonly string[]; productLines?: readonly string[] }
                  | undefined;
              return (
                (!search ||
                  `${decision_id} ${String(value.title ?? "")} ${String(value.question ?? "")}`
                    .toLocaleLowerCase()
                    .includes(search)) &&
                (!filters.state || value.state === filters.state) &&
                (!filters.module || applies?.modules?.includes(filters.module)) &&
                (!filters.productLine || applies?.productLines?.includes(filters.productLine)) &&
                (!filters.legacyId || legacy === filters.legacyId) &&
                (!filters.legacyRange ||
                  (legacy !== undefined &&
                    decisionLegacyNumber(decision_id)! >= filters.legacyRange.start &&
                    decisionLegacyNumber(decision_id)! <= filters.legacyRange.end))
              );
            })
            .sort((left, right) => compareDecisionIds(left.decision_id, right.decision_id)),
          paged = filters.limit !== undefined || filters.cursor !== undefined,
          limit = filters.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(filters.limit),
          cursor = filters.cursor === undefined ? null : decodeTaskListCursor(filters.cursor, 1)[0]!;
        const afterCursor =
            cursor === null ? rows : rows.filter(({ decision_id }) => compareDecisionIds(decision_id, cursor) > 0),
          selected = limit === null ? afterCursor : afterCursor.slice(0, limit),
          hasMore = limit !== null && afterCursor.length > limit,
          decisions = await readPgDecisionRows(client, options.scope, repoId, selected, filters.withBody === true);
        return {
          status: cut.status,
          decisions,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          ...(limit === null
            ? {}
            : {
                page: {
                  limit,
                  cursor: filters.cursor ?? null,
                  nextCursor: hasMore && decisions.at(-1) ? encodeTaskListCursor([decisions.at(-1)!.decisionId]) : null,
                },
              }),
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  return {
    path,
    readCut,
    read,
    list,
    readSnapshot,
    readDecision,
    readFact,
    readFacts,
    readRelations,
    readDecisions,
    searchFacts,
    listDecisionAgendaPage,
    listDecisions,
    currentLease,
    currentLeaseForExecution,
    close: async () => {
      if (options.ownsPool === true) await options.pool.end();
    },
  };
}

async function readCutInTransaction(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  repoId: string,
): Promise<PgProjectionCut> {
  const result = await client.query<{ watermark: string }>(
    `SELECT watermark::text FROM ha_projection_meta
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND projection_name = 'task/v1'`,
    [claims.tenantId, claims.projectId, claims.policyEpoch],
  );
  const head = await client.query<{ readonly revision: string }>(
    `SELECT revision::text FROM ha_repo_heads
     WHERE tenant_id = $1 AND project_id = $2 AND repo_id = $3 AND policy_epoch = $4
       AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
    [claims.tenantId, claims.projectId, repoId, claims.policyEpoch, readers],
  );
  const watermark = Number(result.rows[0]?.watermark ?? 0),
    sourceRevision = Number(head.rows[0]?.revision ?? 0);
  if (watermark > sourceRevision)
    throw new Error(`projection watermark ${watermark} exceeds ledger head ${sourceRevision}`);
  return { status: watermark === sourceRevision ? "ready" : "pending", watermark, sourceRevision };
}

function toIsoTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new Error(`invalid PostgreSQL projection timestamp: ${value}`);
  return timestamp.toISOString();
}

type DecisionDocumentShape = Record<string, unknown>;

function encodeFactCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeFactCursor(value: string): readonly [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("fact query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("fact query cursor is invalid");
  return [parsed[0] as string, parsed[1] as string];
}

async function readEntityVersionWitnesses(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  refs: readonly string[],
): Promise<ReadonlyMap<string, EntityVersionWitness>> {
  const result = new Map<string, EntityVersionWitness>();
  for (const ref of refs) {
    const parsed = parseEntityRef(ref);
    if (parsed === null || parsed.externalHarness) {
      result.set(ref, { entityRef: ref, freshness: "unknown", currentVersion: null });
      continue;
    }
    const { kind, id } = parsed;
    const table =
      kind === "task"
        ? "ha_task_snapshots"
        : kind === "decision"
          ? "ha_decisions"
          : kind === "fact"
            ? "ha_facts"
            : kind === "agent"
              ? "ha_agents"
              : kind === "squad"
                ? "ha_squads"
                : null;
    const idColumn =
      kind === "task"
        ? "task_id"
        : kind === "decision"
          ? "decision_id"
          : kind === "fact"
            ? "fact_id"
            : kind === "agent"
              ? "agent_id"
              : kind === "squad"
                ? "squad_id"
                : null;
    if (!table || !idColumn) {
      result.set(ref, { entityRef: ref, freshness: "unknown", currentVersion: null });
      continue;
    }
    const row = await client.query<{
      workspace_revision: string;
      value?: Record<string, unknown>;
      snapshot?: TaskLifecycleSnapshot;
    }>(
      `SELECT workspace_revision::text, ${kind === "decision" || kind === "fact" ? "value" : kind === "task" ? "snapshot" : "declaration AS value"} FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${idColumn}=$4 AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
      [claims.tenantId, claims.projectId, claims.policyEpoch, id, readers],
    );
    if (!row.rows[0]) result.set(ref, { entityRef: ref, freshness: "orphaned", currentVersion: null });
    else {
      const value = row.rows[0].value;
      result.set(ref, {
        entityRef: ref,
        freshness: "current",
        currentVersion: Number(row.rows[0].workspace_revision),
        ...(value?.state ? { state: String(value.state) } : {}),
      });
    }
  }
  return result;
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

interface PgRelationQuery {
  readonly source?: string;
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly relationType?: string;
  readonly limit?: number;
}

async function readRelationsInTransaction(
  client: import("pg").PoolClient,
  claims: PgProjectionScope,
  readers: readonly string[],
  query: PgRelationQuery,
): Promise<readonly TaskRelationProjectionRow[]> {
  const values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
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
  if (query.targets !== undefined) {
    values.push(query.targets);
    where.push(`target_ref = ANY($${values.length}::text[])`);
  }
  if (query.target !== undefined) {
    values.push(query.target);
    where.push(`target_ref = $${values.length}`);
  }
  if (query.relationType !== undefined) {
    values.push(query.relationType);
    where.push(`relation_type = $${values.length}`);
  }
  if (query.limit !== undefined) values.push(checkedPageLimit(query.limit, 4096));
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
           FROM ha_relations WHERE ${where.join(" AND ")} ORDER BY relation_id${query.limit === undefined ? "" : ` LIMIT $${values.length}`}`,
    values,
  );
  const refs = [...new Set(result.rows.flatMap((row) => [row.source_ref, row.target_ref]))],
    witnesses = await readEntityVersionWitnesses(client, claims, readers, refs);
  return result.rows.map((row) => {
    const targetObservedVersion = (row.value.targetObservedVersion as never) ?? null,
      target = keycloakPersonIdentityWitness(row.target_ref, targetObservedVersion) ??
        witnesses.get(row.target_ref) ?? {
          entityRef: row.target_ref,
          freshness: "unknown" as const,
          currentVersion: null,
        };
    return {
      relationId: row.relation_id,
      workspaceRevision: Number(row.workspace_revision),
      sourceRef: row.source_ref,
      targetRef: row.target_ref,
      relationType: row.relation_type as TaskRelationProjectionRow["relationType"],
      direction: String(row.value.direction ?? "directed") as never,
      strength: String(row.value.strength ?? "strong") as never,
      origin: String(row.value.origin ?? "event") as never,
      state: row.relation_state as never,
      targetObservedVersion,
      currentTargetVersion: target.currentVersion,
      freshness: relationFreshnessAtCut({
        anchor: relationFreshnessAnchorForType(row.relation_type as RelationType),
        target,
        targetObservedVersion,
        ...(relationFreshnessAnchorForType(row.relation_type as RelationType) === "source"
          ? { source: witnesses.get(row.source_ref) }
          : {}),
      }),
      rationale: String(row.value.rationale ?? ""),
      ownerRef: String(row.value.ownerRef ?? relationOwnerRef(row.source_ref)),
      sourcePath: String(row.value.sourcePath ?? "event:unknown"),
      recordIndex: Number(row.value.recordIndex ?? 0),
    } as TaskRelationProjectionRow;
  });
}

async function hydrateSnapshots(
  client: import("pg").PoolClient,
  scope: PgProjectionScope,
  snapshots: readonly TaskLifecycleSnapshot[],
): Promise<readonly TaskLifecycleSnapshot[]> {
  if (!snapshots.length) return [];
  const relations = await readRelationsInTransaction(client, scope, [...(scope.readers ?? [])], {
    targets: snapshots.flatMap(({ task }) => (task ? [`task/${task.taskId}`] : [])),
  });
  const now = new Date().toISOString();
  return snapshots.map((snapshot) => {
    const stored = snapshot.lease,
      lease =
        stored === null || stored.phase === "released"
          ? null
          : stored.expiresAt > now
            ? stored
            : stored.phase === "reserving"
              ? null
              : { ...stored, phase: "orphaned" as const };
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
