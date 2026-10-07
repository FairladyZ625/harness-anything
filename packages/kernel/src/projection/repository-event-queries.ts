import { readArtifactEntityState } from "./artifact-entity-state-projection.ts";
import { readEventList } from "./event-list-query.ts";
import { privateRuntimeEventTypes, publicRuntimeDispatch } from "../domain/runtime-public-query.ts";
import { isSettingsEvent, type SettingsEventV1 } from "../domain/settings-event.ts";
import type { DatabaseSync } from "node:sqlite";
import { isAgentRuntimeEvent, type AgentRuntimeEventV1 } from "../domain/agent-runtime.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import type { TaskProjectionQueries, RuntimeDispatchProjectionRow } from "./task-projection-port.ts";
import { queryRow, queryRows } from "./rebuildable-task-projection-sql.ts";

/** Both center sessions and materialized edge cuts use these event-backed repository queries. */
export type RepositoryReadSession = <A>(
  read: (db: DatabaseSync, cut: ReturnType<TaskProjectionQueries["readCut"]>) => A,
) => A;
const RUNTIME_DISPATCH_SESSION_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.runtimeSessionId') = ?",
  "ORDER BY workspace_revision LIMIT 1",
].join(" ");
const RUNTIME_DISPATCH_SQL = RUNTIME_DISPATCH_SESSION_SQL.replace(
  "ORDER BY",
  "AND json_extract(event_json, '$.payload.definitionSnapshotRef') = ? ORDER BY",
);
const RUNTIME_DISPATCHES_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "ORDER BY workspace_revision",
].join(" ");
const RUNTIME_DISPATCH_BY_ID_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND json_extract(event_json, '$.payload.dispatchId') = ? ORDER BY workspace_revision")} LIMIT 1`;
const RUNTIME_DISPATCH_BY_RESUME_SOURCE_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND json_extract(event_json, '$.payload.resumedFromDispatchId') = ? ORDER BY workspace_revision")} LIMIT 1`;
const RUNTIME_DISPATCHES_BY_FIELD_SQL = (field: string) =>
  RUNTIME_DISPATCHES_SQL.replace(
    "ORDER BY workspace_revision",
    `AND json_extract(event_json, '$.payload.${field}') = ? ORDER BY workspace_revision`,
  );
const RUNTIME_DISPATCHES_BY_TASK_EXECUTION_SQL = RUNTIME_DISPATCHES_SQL.replace(
  "ORDER BY workspace_revision",
  "AND json_extract(event_json, '$.payload.taskId') = ? AND json_extract(event_json, '$.payload.executionId') = ? ORDER BY workspace_revision",
);
const RUNTIME_DISPATCH_PAGE_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.startedAt') >= ?",
  "AND (json_extract(event_json, '$.payload.startedAt') > ? OR",
  "(json_extract(event_json, '$.payload.startedAt') = ? AND json_extract(event_json, '$.payload.dispatchId') > ?))",
  "ORDER BY json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.payload.dispatchId') LIMIT ?",
].join(" ");
const RUNTIME_OUTCOME_BY_DISPATCH_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_session_outcome_observed'",
  "AND json_extract(event_json, '$.payload.dispatchId') = ?",
  "ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");
const RUNTIME_SESSION_EVENTS_SQL = [
  "SELECT event_json FROM event_index WHERE workspace_revision > ?",
  "AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.payload.runtimeSessionId') = ?",
  `AND json_extract(event_json, '$.type') NOT IN (${privateRuntimeEventTypes.map((type) => `'${type}'`).join(", ")})`,
  "ORDER BY workspace_revision LIMIT ?",
].join(" ");
const SCHEDULE_EVENTS_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'schedule-event/v1'",
  "ORDER BY workspace_revision",
].join(" ");
const SCHEDULE_EVENTS_BY_ID_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'schedule-event/v1'",
  "AND json_extract(event_json, '$.entity.id') = ?",
  "ORDER BY workspace_revision",
].join(" ");
const CI_RUN_OBSERVATIONS_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'ci-run-observation/v3'",
  "ORDER BY workspace_revision DESC LIMIT ?",
].join(" ");

export function repositoryEventQueries(
  withRead: RepositoryReadSession,
): Pick<
  TaskProjectionQueries,
  | "readRuntimeDispatch"
  | "readRuntimeDispatches"
  | "readRuntimeDispatchById"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesBySession"
  | "readRuntimeDispatchesByTaskExecution"
  | "readRuntimeDispatchesByAttemptGroup"
  | "readRuntimeDispatchesByDecision"
  | "readRuntimeDispatchPage"
  | "readRuntimeSessionEvents"
  | "readScheduleEvents"
  | "readScheduleOutputEvents"
  | "readReckoningEvents"
  | "readCiRunObservations"
  | "readSettingsEvent"
  | "readArtifactEntityState"
  | "readEventList"
  | "readEventSummaries"
  | "readEventWitness"
  | "readDocuments"
> {
  return {
    readArtifactEntityState: (kind, id) => withRead((db) => readArtifactEntityState(db, kind, id)),
    readEventList: (query) => withRead((db) => readEventList(db, query)),
    readDocuments: (prefix) => withRead((db, cut) => ({ ...cut, documents: readDocumentRows(db, prefix) })),
    readEventWitness: (revision) =>
      withRead((db) => {
        const row = queryRow(db, "SELECT witness_json FROM event_summary WHERE workspace_revision = ?", revision);
        return row
          ? (JSON.parse(String(row.witness_json)) as ReturnType<TaskProjectionQueries["readEventWitness"]>)
          : null;
      }),
    readEventSummaries: (afterRevision, limit) =>
      withRead((db, cut) => {
        if (
          !Number.isSafeInteger(afterRevision) ||
          afterRevision < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 2048
        )
          throw new Error("event summary page requires a non-negative revision and a limit from 1 to 2048");
        return {
          ...cut,
          events: queryRows(
            db,
            "SELECT summary_json FROM event_summary WHERE workspace_revision > ? ORDER BY workspace_revision LIMIT ?",
            afterRevision,
            limit,
          ).map(
            (row) =>
              JSON.parse(
                String(row.summary_json),
              ) as import("../domain/canonical-event-summary.ts").CanonicalEventSummary,
          ),
        };
      }),
    readSettingsEvent: () =>
      withRead((db) => {
        const entity = queryRow(
          db,
          "SELECT workspace_revision FROM entity_projection WHERE entity_kind = 'settings' AND entity_id = 'repository'",
        );
        if (!entity) return null;
        const row = queryRow(
          db,
          "SELECT event_json FROM event_index WHERE workspace_revision = ?",
          Number(entity.workspace_revision),
        );
        const event = row ? (JSON.parse(String(row.event_json)) as SettingsEventV1) : null;
        if (!event || !isSettingsEvent(event))
          throw Object.assign(new Error("Settings provenance is missing from the projection cut."), {
            code: "projection_pending",
          });
        return event;
      }),
    readRuntimeDispatch: (runtimeSessionIdValue, definitionSnapshotRef) =>
      withRead((db) => {
        const row =
          definitionSnapshotRef === undefined
            ? queryRow(db, RUNTIME_DISPATCH_SESSION_SQL, runtimeSessionIdValue)
            : queryRow(db, RUNTIME_DISPATCH_SQL, runtimeSessionIdValue, definitionSnapshotRef);
        if (!row) return null;
        const event = JSON.parse(String(row.event_json));
        return isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested"
          ? publicRuntimeDispatch(event)
          : null;
      }),
    readRuntimeDispatches: () =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_SQL)
          .map((row) => JSON.parse(String(row.event_json)))
          .filter(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
              isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
          )
          .map(publicRuntimeDispatch),
      ),
    readRuntimeDispatchById: (dispatchId) =>
      withRead((db) => projectedDispatch(db, queryRow(db, RUNTIME_DISPATCH_BY_ID_SQL, dispatchId))),
    readRuntimeDispatchByResumeSource: (dispatchId) =>
      withRead((db) => projectedDispatch(db, queryRow(db, RUNTIME_DISPATCH_BY_RESUME_SOURCE_SQL, dispatchId))),
    readRuntimeDispatchesBySession: (runtimeSessionIdValue) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_FIELD_SQL("runtimeSessionId"), runtimeSessionIdValue).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        }),
      ),
    readRuntimeDispatchesByTaskExecution: (taskId, executionId) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_TASK_EXECUTION_SQL, taskId, executionId).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        }),
      ),
    readRuntimeDispatchesByAttemptGroup: (attemptGroupId) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_FIELD_SQL("attemptGroupId"), attemptGroupId).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        }),
      ),
    readRuntimeDispatchesByDecision: (decisionId) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_FIELD_SQL("reviewTarget.decisionId"), decisionId).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        }),
      ),
    readRuntimeDispatchPage: ({ startedAtGte, cursor, limit: pageLimit }) =>
      withRead((db) => {
        if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500)
          throw new Error("runtime dispatch page requires a limit from 1 to 500");
        const afterStartedAt = cursor?.startedAt ?? "",
          afterDispatchId = cursor?.dispatchId ?? "",
          raw = queryRows(
            db,
            RUNTIME_DISPATCH_PAGE_SQL,
            startedAtGte,
            afterStartedAt,
            afterStartedAt,
            afterDispatchId,
            pageLimit + 1,
          ),
          done = raw.length <= pageLimit,
          rows = raw.slice(0, pageLimit).flatMap((row) => {
            const projected = projectedDispatch(db, row);
            return projected ? [projected] : [];
          }),
          last = rows.at(-1)?.event.payload;
        return {
          rows,
          done,
          nextCursor: !done && last?.startedAt ? { startedAt: last.startedAt, dispatchId: last.dispatchId } : null,
        };
      }),
    readRuntimeSessionEvents: (runtimeSessionIdValue, afterRevision, limit) =>
      withRead((db) => {
        if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1)
          throw new Error("runtime session event page requires a non-negative revision and a positive limit");
        return queryRows(db, RUNTIME_SESSION_EVENTS_SQL, afterRevision, runtimeSessionIdValue, limit)
          .map((row) => JSON.parse(String(row.event_json)))
          .filter((event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event))
          .map((event) => (event.type === "runtime_dispatch_requested" ? publicRuntimeDispatch(event) : event));
      }),
    readScheduleEvents: (scheduleId) =>
      withRead((db, cut) => {
        return {
          status: cut.status,
          events: queryRows(
            db,
            scheduleId === undefined ? SCHEDULE_EVENTS_SQL : SCHEDULE_EVENTS_BY_ID_SQL,
            ...(scheduleId === undefined ? [] : [scheduleId]),
          ).map((row) => JSON.parse(String(row.event_json))) as CanonicalEventV1[],
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readReckoningEvents: ({ type, after, before }) =>
      withRead((db) =>
        queryRows(
          db,
          "SELECT event_json FROM event_index WHERE json_extract(event_json, '$.type') = ? " +
            "AND json_extract(event_json, '$.occurredAt') >= ? AND json_extract(event_json, '$.occurredAt') <= ? " +
            "ORDER BY workspace_revision",
          type,
          after,
          before,
        ).map((row) => JSON.parse(String(row.event_json)) as CanonicalEventV1),
      ),
    readScheduleOutputEvents: (runtimeSessionIds) =>
      withRead((db) => {
        if (runtimeSessionIds.length === 0) return [];
        const sql = [
          "SELECT event_json FROM event_index",
          `WHERE json_extract(event_json, '$.actor.executor.id') IN (${runtimeSessionIds.map(() => "?").join(",")})`,
          "AND json_extract(event_json, '$.schema') IN ('fact-event/v1','decision-event/v1','task-event/v1')",
          "ORDER BY workspace_revision",
        ].join(" ");
        return queryRows(db, sql, ...runtimeSessionIds.map((id) => `runtime-session:${id}`)).map(
          (row) => JSON.parse(String(row.event_json)) as CanonicalEventV1,
        );
      }),
    readCiRunObservations: (pageLimit) =>
      withRead((db, cut) => {
        if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 2_000)
          throw new Error("ci run observation page requires a limit from 1 to 2000");
        return {
          status: cut.status,
          events: queryRows(db, CI_RUN_OBSERVATIONS_SQL, pageLimit)
            .map((row) => JSON.parse(String(row.event_json)))
            .filter((event) => event.schema === "ci-run-observation/v3"),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
  };
}

function projectedDispatch(
  db: DatabaseSync,
  row: Readonly<Record<string, unknown>> | undefined,
): RuntimeDispatchProjectionRow | null {
  if (!row) return null;
  const event = JSON.parse(String(row.event_json)) as { readonly schema: string };
  if (!isAgentRuntimeEvent(event) || event.type !== "runtime_dispatch_requested") return null;
  const outcomeRow = queryRow(db, RUNTIME_OUTCOME_BY_DISPATCH_SQL, event.payload.dispatchId),
    outcome = outcomeRow ? (JSON.parse(String(outcomeRow.event_json)) as { readonly schema: string }) : null;
  if (!outcome || !isAgentRuntimeEvent(outcome) || outcome.type !== "runtime_session_outcome_observed")
    return { event: publicRuntimeDispatch(event), metrics: null, endedAt: null, outcome: null };
  return {
    event: publicRuntimeDispatch(event),
    metrics: outcome.payload.runtimeMetrics ?? null,
    endedAt: outcome.payload.endedAt ?? null,
    outcome: outcome.payload.outcome,
  };
}

/** Document descriptors at this cut, shared by replica publication and repository document lists. */
export function readDocumentRows(db: DatabaseSync, prefix: string) {
  return queryRows(
    db,
    "SELECT path, json_extract(value_json, '$.blobSha256') AS blob_sha256, " +
      "json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS media_type " +
      "FROM document WHERE substr(path, 1, length(?)) = ? ORDER BY path",
    prefix,
    prefix,
  ).map((row) => ({
    path: String(row.path),
    blobSha256: String(row.blob_sha256),
    size: Number(row.size),
    mediaType: String(row.media_type),
  }));
}
