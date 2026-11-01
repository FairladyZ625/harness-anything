import type { TaskProjectionQueries } from "@harness-anything/kernel";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction, readEventRowsInTransaction } from "./pg-event-queries.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgTaskEventQueries = AsyncQueries<
  | "readTaskEventExists"
  | "readTaskSubmissionOperation"
  | "readTaskCompletion"
  | "readProgress"
  | "readSettingsEvent"
  | "listFactDomainTypes"
>;
export function pgTaskEventQueries(options: PgTaskProjectionSourceOptions): PgTaskEventQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])];
  const readRows = (predicate: string, values: readonly unknown[], latest = false) =>
    withPostgresTransaction(
      options.pool,
      (client) =>
        readEventRowsInTransaction(
          client,
          scope,
          readers,
          repoId,
          predicate,
          values,
          latest ? "DESC" : "ASC",
          latest ? 1 : undefined,
        ),
      scope,
      { isolationLevel: "repeatable read" },
    );
  return {
    readTaskEventExists: async (id) =>
      (
        await readRows(
          `CASE event_json::jsonb->>'schema'
       WHEN 'task-progress-event/v1' THEN event_json::jsonb#>>'{payload,taskId}'
       WHEN 'agent-runtime-event/v1' THEN CASE event_type
         WHEN 'runtime_session_task_bound' THEN event_json::jsonb#>>'{payload,taskId}'
         WHEN 'runtime_session_started' THEN event_json::jsonb#>>'{payload,taskBinding,taskId}' END
       WHEN 'migration-import-event/v1' THEN COALESCE(event_json::jsonb#>>'{payload,entity,task,taskId}',
         event_json::jsonb#>>'{payload,entity,execution,taskId}', event_json::jsonb#>>'{payload,entity,fact,taskId}')
       ELSE event_json::jsonb->>'taskId' END=$6`,
          [id],
          true,
        )
      ).length > 0,
    readTaskSubmissionOperation: async (taskId, executionId) =>
      (
        await readRows(
          "event_json::jsonb->>'schema'='task-event/v1' AND event_type='execution_submitted' AND event_json::jsonb->>'taskId'=$6 AND event_json::jsonb#>>'{payload,execution,executionId}'=$7",
          [taskId, executionId],
          true,
        )
      )[0]?.op_id ?? null,
    readTaskCompletion: async (taskId, executionId) => {
      const row = (
        await readRows(
          "event_json::jsonb->>'schema'='task-event/v1' AND event_type='task_completed' AND event_json::jsonb->>'taskId'=$6 AND event_json::jsonb#>>'{payload,execution,executionId}' IS NOT DISTINCT FROM $7::text",
          [taskId, executionId],
          true,
        )
      )[0];
      return row ? (JSON.parse(row.event_json) as ReturnType<TaskProjectionQueries["readTaskCompletion"]>) : null;
    },
    readSettingsEvent: async () => {
      const row = (await readRows("event_json::jsonb->>'schema'='settings-event/v1'", [], true))[0];
      return row ? (JSON.parse(row.event_json) as ReturnType<TaskProjectionQueries["readSettingsEvent"]>) : null;
    },
    readProgress: (id) =>
      withPostgresTransaction(
        options.pool,
        async (client) => ({
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          rows: (
            await readEventRowsInTransaction(
              client,
              scope,
              readers,
              repoId,
              "event_json::jsonb->>'schema'='task-progress-event/v1' AND event_json::jsonb#>>'{payload,taskId}'=$6",
              [id],
            )
          ).map(({ event_json }) => JSON.parse(event_json)) as ReturnType<
            TaskProjectionQueries["readProgress"]
          >["rows"],
        }),
        scope,
        { isolationLevel: "repeatable read" },
      ),
    listFactDomainTypes: () =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const rows = await readEventRowsInTransaction(
            client,
            scope,
            readers,
            repoId,
            "event_json::jsonb->>'schema'='fact-event/v1' AND event_type='fact_recorded' AND event_json::jsonb#>>'{payload,registersDomainType}' IS NOT NULL",
            [],
          );
          const domainTypes = rows
            .map(({ event_json, revision }) => {
              const event = JSON.parse(event_json);
              return {
                domainType: event.payload.registersDomainType as string,
                registeredByFactId: event.factId as string,
                workspaceRevision: Number(revision),
              };
            })
            .sort((left, right) =>
              left.domainType < right.domainType ? -1 : left.domainType > right.domainType ? 1 : 0,
            );
          return { ...(await readCutInTransaction(client, scope, readers, repoId)), domainTypes } as ReturnType<
            TaskProjectionQueries["listFactDomainTypes"]
          >;
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
