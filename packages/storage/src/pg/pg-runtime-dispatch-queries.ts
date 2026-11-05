import { assertPgEventReadIndexReady } from "./pg-event-read-index-migration.ts";
import { prefixUpperBound } from "../projection/document-read-range.ts";
import type { PoolClient } from "pg";
import type {
  AgentRuntimeEventV1,
  RuntimeDispatchProjectionRow,
  TaskProjectionQueries,
  RuntimeSession,
} from "@harness-anything/kernel";
import { publicRuntimeDispatch } from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { eventIndexEvent } from "./pg-event-queries.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";

export type AsyncQueries<Keys extends keyof TaskProjectionQueries> = {
  readonly [Key in Keys]-?: NonNullable<TaskProjectionQueries[Key]> extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Result>
    : never;
};
type Dispatch = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;
export type PgRuntimeDispatchQueries = AsyncQueries<
  | "readRuntimeDispatch"
  | "readRuntimeDispatchById"
  | "readRuntimeDispatchByDispatchKey"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesBySession"
  | "readRuntimeDispatchEventsBySession"
  | "readRuntimeDispatchesByTaskIds"
  | "readLatestRuntimeDispatchesByTaskIds"
  | "readRuntimeDispatchByDispatchIdPrefix"
  | "countRuntimeDispatchesByAgent"
  | "readRuntimeDispatchesByTaskExecution"
  | "readRuntimeDispatchesByAttemptGroup"
  | "readRuntimeDispatchesByDecision"
  | "readRuntimeDispatchPage"
  | "readRuntimeDispatchesByMember"
>;

/** Runtime dispatches are canonical-event queries; no second runtime state reducer is needed. */
export function pgRuntimeDispatchQueries(options: PgTaskProjectionSourceOptions): PgRuntimeDispatchQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])];
  const transaction = <Result>(read: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, read, scope, { isolationLevel: "repeatable read" });
  const readDispatchRows = async (
    client: PoolClient,
    predicate: string,
    values: readonly unknown[] = [],
    order = "ha_events.revision",
    limit?: number,
  ): Promise<Dispatch[]> => {
    await assertPgEventReadIndexReady(client, scope, repoId);
    const parameters = [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, ...values];
    if (limit !== undefined) parameters.push(limit);
    const result = await client.query<{ event_json: string }>(
      `SELECT event_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
       AND (cardinality($5::text[])=0 OR readers && $5::text[])
       AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
       AND event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested'
       AND ${predicate} ORDER BY ${order}${limit === undefined ? "" : ` LIMIT $${parameters.length}`}`,
      parameters,
    );
    return result.rows.map(({ event_json }) => eventIndexEvent(JSON.parse(event_json) as Dispatch));
  };
  const projected = async (client: PoolClient, event: Dispatch): Promise<RuntimeDispatchProjectionRow> => {
    const result = await client.query<{ event_json: string }>(
      `SELECT event_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
       AND (cardinality($5::text[])=0 OR readers && $5::text[]) AND event_type='runtime_session_outcome_observed'
       AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
       AND event_schema='agent-runtime-event/v1' AND dispatch_id=$6
       ORDER BY ha_events.revision DESC LIMIT 1`,
      [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, event.payload.dispatchId],
    );
    const outcome = result.rows[0]
      ? (JSON.parse(result.rows[0].event_json) as Extract<
          AgentRuntimeEventV1,
          { readonly type: "runtime_session_outcome_observed" }
        >)
      : null;
    return {
      event: publicRuntimeDispatch(event),
      metrics: outcome?.payload.runtimeMetrics ?? null,
      endedAt: outcome?.payload.endedAt ?? null,
      outcome: outcome?.payload.outcome ?? null,
    };
  };
  const dispatchFields = {
    dispatchId: "dispatch_id",
    resumedFromDispatchId: "resumed_from_dispatch_id",
    runtimeSessionId: "runtime_session_id",
    attemptGroupId: "attempt_group_id",
    "reviewTarget,decisionId": "review_decision_id",
  } as const;
  const byField = (field: keyof typeof dispatchFields, value: string, first: boolean) =>
    transaction(async (client) => {
      const rows = await readDispatchRows(
        client,
        `${dispatchFields[field]}=$6`,
        [value],
        "ha_events.revision",
        first ? 1 : undefined,
      );
      return Promise.all(rows.map((event) => projected(client, event)));
    });
  return {
    readRuntimeDispatch: (sessionId, definitionSnapshotRef) =>
      transaction(async (client) => {
        const rows = await readDispatchRows(
          client,
          `runtime_session_id=$6${definitionSnapshotRef === undefined ? "" : " AND definition_snapshot_ref=$7"}`,
          definitionSnapshotRef === undefined ? [sessionId] : [sessionId, definitionSnapshotRef],
          "ha_events.revision",
          1,
        );
        return rows[0] ? publicRuntimeDispatch(rows[0]) : null;
      }),
    readRuntimeDispatchById: async (id) => (await byField("dispatchId", id, true))[0] ?? null,
    readRuntimeDispatchByDispatchKey: (key) =>
      transaction(async (client) => {
        // The scalar column covers both historical and current non-reviewer spellings. Reviewer
        // keys are qualified by a read-time transform, so their normalized projection row remains
        // the only place that carries the qualified bytes; both branches are index seeks.
        const [event] = await readDispatchRows(
          client,
          `(dispatch_key=$6 OR revision = (SELECT workspace_revision FROM ha_projection_values
            WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4
              AND model='runtime-dispatch-key' AND entity_id=$6
              AND (cardinality($5::text[])=0 OR readers && $5::text[]) ORDER BY workspace_revision LIMIT 1))`,
          [key],
          "ha_events.revision",
          1,
        );
        return event ? projected(client, event) : null;
      }),
    readRuntimeDispatchByResumeSource: async (id) => (await byField("resumedFromDispatchId", id, true))[0] ?? null,
    readRuntimeDispatchesBySession: (id) => byField("runtimeSessionId", id, false),
    readRuntimeDispatchEventsBySession: (id) =>
      transaction(async (client) =>
        (await readDispatchRows(client, "runtime_session_id=$6", [id])).map(publicRuntimeDispatch),
      ),
    readRuntimeDispatchesByTaskIds: (taskIds) =>
      transaction(async (client) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task read requires 1..500 unique task ids");
        return (await readDispatchRows(client, "payload_task_id = ANY($6::text[])", [taskIds])).map(
          publicRuntimeDispatch,
        );
      }),
    readLatestRuntimeDispatchesByTaskIds: (taskIds) =>
      transaction(async (client) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task latest read requires 1..500 unique task ids");
        await assertPgEventReadIndexReady(client, scope, repoId);
        // One LATERAL index seek per requested id: the task's total dispatch history is never
        // materialized just to pick its newest row.
        const result = await client.query<{ event_json: string }>(
          `SELECT latest.event_json
             FROM unnest($6::text[]) WITH ORDINALITY AS requested(task_id, position)
             CROSS JOIN LATERAL (
               SELECT ha_events.event_json
                 FROM ha_events
                WHERE ha_events.tenant_id=$1 AND ha_events.project_id=$2 AND ha_events.repo_id=$3
                  AND ha_events.policy_epoch=$4
                  AND (cardinality($5::text[])=0 OR ha_events.readers && $5::text[])
                  AND ha_events.revision <= (SELECT watermark FROM ha_projection_meta
                    WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
                  AND ha_events.event_schema='agent-runtime-event/v1'
                  AND ha_events.event_type='runtime_dispatch_requested'
                  AND ha_events.payload_task_id=requested.task_id
                ORDER BY COALESCE(ha_events.dispatch_started_at, ha_events.occurred_at) DESC, ha_events.dispatch_id DESC
                LIMIT 1
             ) AS latest
            ORDER BY requested.position`,
          [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, taskIds],
        );
        return result.rows.map(({ event_json }) =>
          publicRuntimeDispatch(eventIndexEvent(JSON.parse(event_json) as Dispatch)),
        );
      }),
    readRuntimeDispatchByDispatchIdPrefix: (prefix, limit) =>
      transaction(async (client) => {
        if (typeof prefix !== "string" || prefix.length === 0)
          throw new Error("runtime dispatch id prefix requires a non-empty prefix");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch id prefix limit must be from 1 to 500");
        const upper = prefixUpperBound(prefix);
        const rows = await readDispatchRows(
          client,
          `dispatch_id >= $6${upper === null ? "" : " AND dispatch_id < $7"}`,
          [prefix, ...(upper === null ? [] : [upper])],
          "dispatch_id",
          limit,
        );
        return Promise.all(rows.map((event) => projected(client, event)));
      }),
    countRuntimeDispatchesByAgent: (agentId) =>
      transaction(async (client) => {
        await assertPgEventReadIndexReady(client, scope, repoId);
        const result = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
           AND (cardinality($5::text[])=0 OR readers && $5::text[])
           AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
           AND event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested'
           AND agent_id=$6`,
          [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, agentId],
        );
        return Number(result.rows[0]?.count ?? 0);
      }),
    readRuntimeDispatchesByAttemptGroup: (id) => byField("attemptGroupId", id, false),
    readRuntimeDispatchesByDecision: (id) => byField("reviewTarget,decisionId", id, false),
    readRuntimeDispatchesByTaskExecution: (taskId, executionId) =>
      transaction(async (client) => {
        const rows = await readDispatchRows(client, "payload_task_id=$6 AND payload_execution_id=$7", [
          taskId,
          executionId,
        ]);
        return Promise.all(rows.map((event) => projected(client, event)));
      }),
    readRuntimeDispatchesByMember: ({ agentId, squadId, limit }) =>
      transaction(async (client) => {
        if ((agentId === undefined) === (squadId === undefined))
          throw new Error("runtime dispatch member page requires exactly one of agentId or squadId");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch member page requires a limit from 1 to 500");
        const field = agentId === undefined ? "squad_id" : "agent_id",
          value = agentId ?? squadId!,
          raw = await readDispatchRows(
            client,
            `${field}=$6`,
            [value],
            "dispatch_activity_at DESC,dispatch_id DESC",
            limit + 1,
          ),
          candidate = (after: boolean) => `SELECT d.event_json,p.value AS session,d.runtime_session_id
            FROM ha_events d JOIN ha_projection_values p ON p.tenant_id=d.tenant_id AND p.project_id=d.project_id
              AND p.policy_epoch=d.policy_epoch AND p.model='runtime-session' AND p.owner_id='' AND p.entity_id=d.runtime_session_id COLLATE "default"
            WHERE d.tenant_id=$1 AND d.project_id=$2 AND d.repo_id=$3 AND d.policy_epoch=$4
              AND d.revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
              AND (cardinality($5::text[])=0 OR (d.readers && $5::text[] AND p.readers && $5::text[]))
              AND d.event_schema='agent-runtime-event/v1' AND d.event_type='runtime_dispatch_requested' AND d.runtime_session_present AND d.${field}=$6
              ${after ? "AND d.runtime_session_id > previous.runtime_session_id" : ""}
            ORDER BY d.runtime_session_id,d.dispatch_activity_at DESC,d.dispatch_id DESC LIMIT 1`,
          // One index seek per distinct session; the lateral query returning no row ends the recursion.
          // https://wiki.postgresql.org/wiki/Loose_indexscan
          sessions = await client.query<{ event_json: string; session: string }>(
            `WITH RECURSIVE latest AS ((${candidate(false)}) UNION ALL
              SELECT next.* FROM latest previous CROSS JOIN LATERAL (${candidate(true)}) next)
              SELECT event_json,session FROM latest ORDER BY runtime_session_id`,
            [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, value],
          );
        return {
          rows: raw.slice(0, limit).map(publicRuntimeDispatch),
          truncated: raw.length > limit,
          sessions: sessions.rows.map(({ event_json, session: serializedSession }) => {
            const event = JSON.parse(event_json) as Dispatch,
              session = JSON.parse(serializedSession) as RuntimeSession;
            return {
              runtimeSessionId: session.runtimeSessionId,
              taskIds: [...new Set(session.taskBindings.map(({ taskId }) => taskId))].sort(),
              latestDecisionId:
                event.payload.reviewTarget?.kind === "decision" ? event.payload.reviewTarget.decisionId! : null,
            };
          }),
        };
      }),
    readRuntimeDispatchPage: ({ startedAtGte, cursor, limit }) =>
      transaction(async (client) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch page requires a limit from 1 to 500");
        const rows = await readDispatchRows(
          client,
          "dispatch_started_at>=$6 AND (dispatch_started_at,dispatch_id)>($7::text,$8::text)",
          [startedAtGte, cursor?.startedAt ?? "", cursor?.dispatchId ?? ""],
          "dispatch_started_at, dispatch_id",
          limit + 1,
        );
        const selected = rows.slice(0, limit),
          last = selected.at(-1),
          done = rows.length <= limit;
        return {
          rows: await Promise.all(selected.map((event) => projected(client, event))),
          done,
          nextCursor:
            !done && last ? { startedAt: last.payload.startedAt!, dispatchId: last.payload.dispatchId } : null,
        };
      }),
  };
}
