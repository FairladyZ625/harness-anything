import type * as ReadSet from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { pgCoreReadQueries } from "./pg-core-reads.ts";
import { projectPgFactLiveness, readPgFactsInTransaction } from "./pg-fact-reads.ts";
import { pgGraphQueries, type PgGraphQueries } from "./pg-graph-queries.ts";
import { pgKnowledgeQueries, type PgKnowledgeQueries } from "./pg-knowledge-queries.ts";
import { pgAggregateQueries, type PgAggregateQueries } from "./pg-aggregate-queries.ts";
import { pgValueQueries, type PgValueQueries } from "./pg-value-queries.ts";
import { pgTaskEventQueries, type PgTaskEventQueries } from "./pg-task-event-queries.ts";
import { pgRelationPortQueries, type PgRelationPortQueries } from "./pg-relation-port-queries.ts";
import { pgTaskIndexQueries, type PgTaskIndexQueries } from "./pg-task-index-queries.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { pgRuntimeDispatchQueries, type PgRuntimeDispatchQueries } from "./pg-runtime-dispatch-queries.ts";
import { pgDispatchLifecycleQueries, type PgDispatchLifecycleQueries } from "./pg-dispatch-lifecycle.ts";
import { pgInboxQueries } from "./pg-inbox.ts";
import { pgPeerRequestQueries } from "./pg-peer-request.ts";
import type { Pool } from "pg";
import { pgEventQueries, readCutInTransaction } from "./pg-event-queries.ts";
import { decodePageCursor, encodePageCursor } from "../projection/page-cursor.ts";
import type {
  DecisionAgendaProjectionPageRead,
  DecisionProjectionListRead,
  DecisionProjectionRead,
  FactProjectionRead,
  FactProjectionSearchRead,
  LeaseV1,
  TaskProjectionQueries,
  TaskProjectionListQuery,
  TaskProjectionListRead,
  TaskProjectionRead,
  TaskRelationProjectionRead,
} from "@harness-anything/kernel";
import type {
  DecisionListFilters,
  DecisionListSummaryRow,
  DecisionPageQuery,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { FactSearchFilters } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import type { FactProjectionRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { EventListPage, EventListQuery } from "@harness-anything/kernel/internal/domain/event-list.ts";
import { assertPgDecisionIndexReady } from "./pg-decision-index-migration.ts";
import { listPgDecisionRows } from "./pg-decision-list.ts";
import { effectiveLeaseValue } from "@harness-anything/kernel/internal/domain/task-lease-policy.ts";
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
  readonly now?: () => string;
}

export interface PgProjectionCut {
  readonly status: ReadSet.ReadSetProjectionCut["status"];
  readonly watermark: number;
  readonly sourceRevision: number;
}

/**
 * Native asynchronous PG queries. The synchronous reader worker composes these methods
 * inside one pinned transaction without changing the public TaskProjectionQueries port.
 */
export interface PgTaskProjectionSource
  extends PgRuntimeDispatchQueries,
    PgDispatchLifecycleQueries,
    PgTaskIndexQueries,
    PgRelationPortQueries,
    PgTaskEventQueries,
    PgValueQueries,
    PgAggregateQueries,
    PgKnowledgeQueries,
    PgGraphQueries {
  readonly path: string;
  readonly readCut: () => Promise<PgProjectionCut>;
  readonly read: (
    taskId: string,
    presentationStatus?: boolean,
    presentationRollup?: boolean,
  ) => Promise<TaskProjectionRead>;
  readonly list: (query?: TaskProjectionListQuery) => Promise<TaskProjectionListRead>;
  readonly readSnapshot: (taskId: string) => Promise<TaskLifecycleSnapshot | null>;
  readonly readDecision: (decisionId: string, withBody?: boolean) => Promise<DecisionProjectionRead>;
  readonly readFact: (factId: string) => Promise<FactProjectionRead>;
  readonly readFacts: (query?: {
    readonly limit?: number;
    readonly refs?: readonly string[];
  }) => Promise<readonly FactProjectionRow[]>;
  readonly readRelations: (query?: {
    readonly source?: string;
    readonly taskOwned?: boolean;
    readonly target?: string;
    readonly relationType?: string;
    readonly limit?: number;
  }) => Promise<TaskRelationProjectionRead>;
  readonly readDecisions: (decisionIds: readonly string[], withBody?: boolean) => Promise<DecisionProjectionListRead>;
  readonly listDecisions: {
    (filters: DecisionListFilters, selection: "summary"): Promise<DecisionProjectionListRead<DecisionListSummaryRow>>;
    (filters?: DecisionListFilters, selection?: "review"): Promise<DecisionProjectionListRead>;
  };
  readonly searchFacts: (filters: FactSearchFilters) => Promise<FactProjectionSearchRead>;
  readonly listDecisionAgendaPage: (query: DecisionPageQuery) => Promise<DecisionAgendaProjectionPageRead>;
  readonly currentLease: (taskId: string, now?: string) => Promise<LeaseV1 | null>;
  readonly currentLeaseForExecution: (executionId: string, now?: string) => Promise<LeaseV1 | null>;
  readonly readCanonicalEvents: (
    ...args: Parameters<TaskProjectionQueries["readCanonicalEvents"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readCanonicalEvents"]>>;
  readonly readScheduleEvents: (
    ...args: Parameters<TaskProjectionQueries["readScheduleEvents"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readScheduleEvents"]>>;
  readonly readReckoningEvents: (
    ...args: Parameters<TaskProjectionQueries["readReckoningEvents"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readReckoningEvents"]>>;
  readonly readScheduleOutputEvents: (
    ...args: Parameters<TaskProjectionQueries["readScheduleOutputEvents"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readScheduleOutputEvents"]>>;
  readonly readRuntimeSessionEvents: (
    ...args: Parameters<TaskProjectionQueries["readRuntimeSessionEvents"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readRuntimeSessionEvents"]>>;
  readonly readRuntimeSessionEventsByType: (
    ...args: Parameters<TaskProjectionQueries["readRuntimeSessionEventsByType"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readRuntimeSessionEventsByType"]>>;
  readonly readEventList: (query: EventListQuery) => Promise<EventListPage>;
  readonly readEventWitness: (revision: number) => Promise<ReturnType<TaskProjectionQueries["readEventWitness"]>>;
  readonly readEventSummaries: (
    ...args: Parameters<TaskProjectionQueries["readEventSummaries"]>
  ) => Promise<ReturnType<TaskProjectionQueries["readEventSummaries"]>>;
  readonly readOperation: (opId: string) => Promise<ReturnType<TaskProjectionQueries["readOperation"]>>;
  readonly readTaskOperation: (opId: string) => Promise<ReturnType<TaskProjectionQueries["readTaskOperation"]>>;
  readonly close: () => Promise<void>;
}

export function createPgTaskProjectionSource(options: PgTaskProjectionSourceOptions): PgTaskProjectionSource {
  const maxItems = options.maxItems ?? 4096,
    now = options.now ?? (() => new Date().toISOString());
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 4096)
    throw new Error("postgres task projection maxItems must be between 1 and 4096");
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])],
    repoId = options.repoId,
    path = options.path ?? "postgres:task-projection";
  if (!repoId) throw new TypeError("PostgreSQL task projection requires a repository id for cut validation");
  const { readCut, readSnapshot, read, list, readDecisions, readDecision } = pgCoreReadQueries(options);
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
        return projectPgFactLiveness(
          client,
          options,
          result.rows.map(({ value }) => value),
        );
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const searchFacts = (filters: FactSearchFilters): Promise<FactProjectionSearchRead> =>
    withPostgresTransaction(options.pool, (client) => readPgFactsInTransaction(client, options, filters), claims, {
      isolationLevel: "repeatable read",
    });
  const readRelations = (
    query: {
      readonly source?: string;
      readonly taskOwned?: boolean;
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
  const readFact = async (factId: string): Promise<FactProjectionRead> => {
    const result = await searchFacts({ refs: [`fact/${factId}`], limit: storageReadPolicy.defaultValue.pageSizes.one });
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
        await assertPgDecisionIndexReady(client, options.scope);
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          cursor = query.cursor === undefined ? null : (decodePageCursor(query.cursor, 1)[0] ?? null),
          limit = checkedPageLimit(query.limit ?? 100),
          values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers, query.state];
        if (cursor !== null) values.push(cursor);
        values.push(limit + 1);
        const rows = await client.query<{ decision_id: string; value: DecisionDocumentShape }>(
          `SELECT decision_id, value FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND decision_state=$5${cursor === null ? "" : ' AND decision_id COLLATE "C" > $6'} ORDER BY decision_id COLLATE "C" LIMIT $${values.length}`,
          values,
        );
        const visible = rows.rows.slice(0, limit),
          decisions = visible.map(({ decision_id, value }) => ({
            decisionId: decision_id,
            title: String(value.title ?? ""),
            riskTier: value.riskTier as "low" | "medium" | "high",
            urgency: value.urgency as "low" | "medium" | "high",
            proposedAt: String(value.proposedAt ?? ""),
          }));
        const last = decisions.at(-1);
        return {
          status: cut.status,
          decisions,
          page: {
            limit,
            cursor: query.cursor ?? null,
            nextCursor: rows.rows.length > limit && last ? encodePageCursor([last.decisionId]) : null,
          },
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readLease = (
    column: "task_id" | "(CASE WHEN jsonb_typeof(raw_lease)='object' THEN raw_lease->>'executionId' END)",
    id: string,
    now: string,
  ) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const result = await client.query<{ lease: LeaseV1 | null }>(
          `SELECT raw_lease AS lease FROM ha_task_snapshots
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${column}=$4
             AND (cardinality($5::text[])=0 OR readers && $5::text[])
           ORDER BY task_id LIMIT 1`,
          [claims.tenantId, claims.projectId, claims.policyEpoch, id, readers],
        );
        return effectiveLeaseValue(result.rows[0]?.lease ?? null, now);
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const currentLease = (taskId: string, at = now()) => readLease("task_id", taskId, at);
  const currentLeaseForExecution = (executionId: string, at = now()) =>
    readLease("(CASE WHEN jsonb_typeof(raw_lease)='object' THEN raw_lease->>'executionId' END)", executionId, at);
  function listDecisions(
    filters: DecisionListFilters,
    selection: "summary",
  ): Promise<DecisionProjectionListRead<DecisionListSummaryRow>>;
  function listDecisions(filters?: DecisionListFilters, selection?: "review"): Promise<DecisionProjectionListRead>;
  function listDecisions(
    filters: DecisionListFilters = {},
    selection?: "summary" | "review",
  ): Promise<DecisionProjectionListRead<DecisionListSummaryRow>> {
    return withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId);
        const result =
          selection === "summary"
            ? await listPgDecisionRows(client, options.scope, repoId, filters, selection)
            : await listPgDecisionRows(client, options.scope, repoId, filters, selection);
        return { ...cut, ...result };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  }
  return {
    path,
    ...pgEventQueries(options),
    ...pgRuntimeDispatchQueries(options),
    ...pgDispatchLifecycleQueries(options),
    ...pgInboxQueries(options),
    ...pgPeerRequestQueries(options),
    ...pgTaskIndexQueries(options, { read, list }, now),
    ...pgRelationPortQueries(options),
    ...pgTaskEventQueries(options),
    ...pgValueQueries(options),
    ...pgAggregateQueries(options),
    ...pgKnowledgeQueries(options, { readDecision }),
    ...pgGraphQueries(options),
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

type DecisionDocumentShape = Record<string, unknown>;
