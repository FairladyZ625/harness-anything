import type { PoolClient } from "pg";
import type {
  AgentRuntimeEventV1,
  RuntimeDispatchProjectionRow,
  TaskProjectionQueries,
  RuntimeSession,
} from "@harness-anything/kernel";
import { publicRuntimeDispatch } from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
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
  | "readRuntimeDispatches"
  | "readRuntimeDispatchById"
  | "readRuntimeDispatchByDispatchKey"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesBySession"
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
    const parameters = [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, ...values];
    if (limit !== undefined) parameters.push(limit);
    const result = await client.query<{ event_json: string }>(
      `SELECT event_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
       AND (cardinality($5::text[])=0 OR readers && $5::text[])
       AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
       AND event_json::jsonb->>'schema'='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested'
       AND ${predicate} ORDER BY ${order}${limit === undefined ? "" : ` LIMIT $${parameters.length}`}`,
      parameters,
    );
    return result.rows.map(({ event_json }) => JSON.parse(event_json) as Dispatch);
  };
  const projected = async (client: PoolClient, event: Dispatch): Promise<RuntimeDispatchProjectionRow> => {
    const result = await client.query<{ event_json: string }>(
      `SELECT event_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
       AND (cardinality($5::text[])=0 OR readers && $5::text[]) AND event_type='runtime_session_outcome_observed'
       AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
       AND event_json::jsonb->>'schema'='agent-runtime-event/v1' AND event_json::jsonb#>>'{payload,dispatchId}'=$6
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
  const byField = (field: string, value: string, first: boolean) =>
    transaction(async (client) => {
      const rows = await readDispatchRows(
        client,
        `event_json::jsonb#>>'{payload,${field}}'=$6`,
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
          `event_json::jsonb#>>'{payload,runtimeSessionId}'=$6${definitionSnapshotRef === undefined ? "" : " AND event_json::jsonb#>>'{payload,definitionSnapshotRef}'=$7"}`,
          definitionSnapshotRef === undefined ? [sessionId] : [sessionId, definitionSnapshotRef],
          "ha_events.revision",
          1,
        );
        return rows[0] ? publicRuntimeDispatch(rows[0]) : null;
      }),
    readRuntimeDispatches: () =>
      transaction(async (client) => (await readDispatchRows(client, "true")).map(publicRuntimeDispatch)),
    readRuntimeDispatchById: async (id) => (await byField("dispatchId", id, true))[0] ?? null,
    readRuntimeDispatchByDispatchKey: async (key) => (await byField("dispatchKey", key, true))[0] ?? null,
    readRuntimeDispatchByResumeSource: async (id) => (await byField("resumedFromDispatchId", id, true))[0] ?? null,
    readRuntimeDispatchesBySession: (id) => byField("runtimeSessionId", id, false),
    readRuntimeDispatchesByAttemptGroup: (id) => byField("attemptGroupId", id, false),
    readRuntimeDispatchesByDecision: (id) => byField("reviewTarget,decisionId", id, false),
    readRuntimeDispatchesByTaskExecution: (taskId, executionId) =>
      transaction(async (client) => {
        const rows = await readDispatchRows(
          client,
          "event_json::jsonb#>>'{payload,taskId}'=$6 AND event_json::jsonb#>>'{payload,executionId}'=$7",
          [taskId, executionId],
        );
        return Promise.all(rows.map((event) => projected(client, event)));
      }),
    readRuntimeDispatchesByMember: ({ agentId, squadId, limit }) =>
      transaction(async (client) => {
        if ((agentId === undefined) === (squadId === undefined))
          throw new Error("runtime dispatch member page requires exactly one of agentId or squadId");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch member page requires a limit from 1 to 500");
        const field = agentId === undefined ? "squadId" : "agentId",
          value = agentId ?? squadId!,
          raw = await readDispatchRows(
            client,
            `event_json::jsonb#>>'{payload,${field}}'=$6`,
            [value],
            "COALESCE(event_json::jsonb#>>'{payload,startedAt}',event_json::jsonb->>'occurredAt') DESC,event_json::jsonb#>>'{payload,dispatchId}' DESC",
            limit + 1,
          ),
          sessions = await client.query<{ event_json: string; session: RuntimeSession }>(
            `SELECT DISTINCT ON (d.event_json::jsonb#>>'{payload,runtimeSessionId}') d.event_json, p.value AS session
           FROM ha_events d JOIN ha_projection_values p ON p.tenant_id=d.tenant_id AND p.project_id=d.project_id AND p.policy_epoch=d.policy_epoch
             AND p.model='runtime-session' AND p.entity_id=d.event_json::jsonb#>>'{payload,runtimeSessionId}'
           WHERE d.tenant_id=$1 AND d.project_id=$2 AND d.repo_id=$3 AND d.policy_epoch=$4
             AND d.revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1')
             AND (cardinality($5::text[])=0 OR (d.readers && $5::text[] AND p.readers && $5::text[]))
             AND d.event_type='runtime_dispatch_requested' AND d.event_json::jsonb#>>'{payload,${field}}'=$6
           ORDER BY d.event_json::jsonb#>>'{payload,runtimeSessionId}',COALESCE(d.event_json::jsonb#>>'{payload,startedAt}',d.event_json::jsonb->>'occurredAt') DESC,d.event_json::jsonb#>>'{payload,dispatchId}' DESC`,
            [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers, value],
          );
        return {
          rows: raw.slice(0, limit).map(publicRuntimeDispatch),
          truncated: raw.length > limit,
          sessions: sessions.rows.map(({ event_json, session }) => {
            const event = JSON.parse(event_json) as Dispatch;
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
          "event_json::jsonb#>>'{payload,startedAt}'>=$6 AND (event_json::jsonb#>>'{payload,startedAt}',event_json::jsonb#>>'{payload,dispatchId}')>($7::text,$8::text)",
          [startedAtGte, cursor?.startedAt ?? "", cursor?.dispatchId ?? ""],
          "event_json::jsonb#>>'{payload,startedAt}', event_json::jsonb#>>'{payload,dispatchId}'",
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
