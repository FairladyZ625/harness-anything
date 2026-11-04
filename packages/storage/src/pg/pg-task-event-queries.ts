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
    readTaskEventExists: async (id) => (await readRows("task_index_id=$6", [id], true)).length > 0,
    readTaskSubmissionOperation: async (taskId, executionId) =>
      (
        await readRows(
          "event_schema='task-event/v1' AND event_type='execution_submitted' AND canonical_task_id=$6 AND task_execution_id=$7",
          [taskId, executionId],
          true,
        )
      )[0]?.op_id ?? null,
    readTaskCompletion: async (taskId, executionId) => {
      const row = (
        await readRows(
          "event_schema='task-event/v1' AND event_type='task_completed' AND canonical_task_id=$6 AND (task_execution_id=$7 OR (task_execution_id IS NULL AND $7::text IS NULL))",
          [taskId, executionId],
          true,
        )
      )[0];
      return row ? (JSON.parse(row.event_json) as ReturnType<TaskProjectionQueries["readTaskCompletion"]>) : null;
    },
    readSettingsEvent: async () => {
      const row = (await readRows("event_schema='settings-event/v1'", [], true))[0];
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
              "event_schema='task-progress-event/v1' AND payload_task_id=$6",
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
            "event_schema='fact-event/v1' AND event_type='fact_recorded' AND registers_domain_type IS NOT NULL",
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
