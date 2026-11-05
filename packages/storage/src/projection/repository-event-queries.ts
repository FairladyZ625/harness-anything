import { assertRuntimeDispatchKeyIndexReady, assertRuntimeMemberIndexReady } from "./runtime-member-index.ts";
import { prefixUpperBound } from "./document-read-range.ts";
import { checkedPageLimit } from "./task-query-projection.ts";
import { readArtifactEntityState } from "./artifact-entity-state-projection.ts";
import { readEventList } from "./event-list-query.ts";
import {
  privateRuntimeEventTypes,
  publicRuntimeDispatch,
} from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { isSettingsEvent, type SettingsEventV1 } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  isAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type {
  TaskProjectionQueries,
  RuntimeDispatchProjectionRow,
  RuntimeDispatchMemberSession,
} from "@harness-anything/kernel";
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
const RUNTIME_DISPATCH_BY_KEY_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND dispatch_key = ? ORDER BY workspace_revision")} LIMIT 1`;
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
const RUNTIME_DISPATCHES_BY_TASK_IDS_SQL = (count: number) =>
  RUNTIME_DISPATCHES_SQL.replace(
    "ORDER BY workspace_revision",
    `AND json_extract(event_json, '$.payload.taskId') IN (${Array.from({ length: count }, () => "?").join(",")}) ORDER BY workspace_revision`,
  );
// One index seek per requested task, never the task's total dispatch history: the event index
// carries (taskId, effective time DESC, dispatchId DESC), where effective time is
// `startedAt ?? occurredAt`, the same fallback the dispatch row uses.
const RUNTIME_LATEST_DISPATCH_BY_TASK_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.taskId') = ?",
  "ORDER BY COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC, json_extract(event_json, '$.payload.dispatchId') DESC LIMIT 1",
].join(" ");
const RUNTIME_LATEST_DISPATCH_BY_SESSION_SQL = [
  "SELECT event_json FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.runtimeSessionId') = ?",
  "ORDER BY COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC, json_extract(event_json, '$.payload.dispatchId') DESC LIMIT 1",
].join(" ");
const RUNTIME_DISPATCH_BY_ID_PREFIX_SQL = RUNTIME_DISPATCHES_SQL.replace(
  "ORDER BY workspace_revision",
  "AND json_extract(event_json, '$.payload.dispatchId') >= ? AND json_extract(event_json, '$.payload.dispatchId') < ? ORDER BY json_extract(event_json, '$.payload.dispatchId')",
).concat(" LIMIT ?");
const RUNTIME_DISPATCH_COUNT_BY_AGENT_SQL = [
  "SELECT COUNT(*) AS count FROM event_index",
  "WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'",
  "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'",
  "AND json_extract(event_json, '$.payload.agentId') = ?",
].join(" ");
// The member page answers "an executor's newest dispatches" in one index scan: newest first,
// bounded by the caller's limit, so a detail-page first screen never pays for total history.
const RUNTIME_DISPATCHES_BY_MEMBER_SQL = (member: "agentId" | "squadId") =>
  [
    RUNTIME_DISPATCHES_SQL.replace(
      "ORDER BY workspace_revision",
      `AND json_extract(event_json, '$.payload.${member}') = ? ORDER BY COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC, json_extract(event_json, '$.payload.dispatchId') DESC LIMIT ?`,
    ),
  ].join(" ");
// Full-history ingredients for the member's task-group totals: one row per session the member
// dispatched, carrying its distinct bindings and the latest member dispatch's decision target.
// The single grouping normalization lives in the daemon; this query only selects raw ingredients.
const RUNTIME_DISPATCH_MEMBER_SESSIONS_SQL = (member: "agentId" | "squadId") => {
  const session = "json_extract(event_json, '$.payload.runtimeSessionId')",
    candidate = (after: boolean) => `SELECT workspace_revision FROM event_index
      WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested'
      AND json_extract(event_json, '$.payload.${member}') = ? AND runtime_session_present=1
      ${after ? `AND ${session} > (SELECT ${session} FROM event_index WHERE workspace_revision=latest.revision)` : ""}
      ORDER BY ${session}, COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC,
        json_extract(event_json, '$.payload.dispatchId') DESC LIMIT 1`;
  return `WITH RECURSIVE latest(revision) AS (
    SELECT (${candidate(false)}) UNION ALL SELECT (${candidate(true)}) FROM latest WHERE revision IS NOT NULL
  ) SELECT json_extract(d.event_json, '$.payload.runtimeSessionId') AS runtimeSessionId,
    CASE WHEN json_extract(d.event_json, '$.payload.reviewTarget.kind')='decision' THEN json_extract(d.event_json, '$.payload.reviewTarget.decisionId') END AS latestDecisionId,
    (SELECT group_concat(DISTINCT b.task_id) FROM runtime_session_task_binding b
      WHERE b.runtime_session_id=json_extract(d.event_json, '$.payload.runtimeSessionId')) AS taskIds
  FROM latest CROSS JOIN event_index d ON d.workspace_revision=latest.revision ORDER BY runtimeSessionId`;
};
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
export function repositoryEventQueries(
  withRead: RepositoryReadSession,
): Pick<
  TaskProjectionQueries,
  | "readRuntimeDispatch"
  | "readRuntimeDispatchById"
  | "readRuntimeDispatchByDispatchKey"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesBySession"
  | "readRuntimeDispatchEventsBySession"
  | "readRuntimeDispatchesByTaskIds"
  | "readLatestRuntimeDispatchesByTaskIds"
  | "readLatestRuntimeDispatchBySession"
  | "readRuntimeDispatchByDispatchIdPrefix"
  | "countRuntimeDispatchesByAgent"
  | "readRuntimeDispatchesByTaskExecution"
  | "readRuntimeDispatchesByAttemptGroup"
  | "readRuntimeDispatchesByDecision"
  | "readRuntimeDispatchPage"
  | "readRuntimeDispatchesByMember"
  | "readRuntimeSessionEvents"
  | "readScheduleEvents"
  | "readScheduleOutputEvents"
  | "readReckoningEvents"
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
    readDocuments: (prefix, page) =>
      withRead((db, cut) => {
        const rows = readDocumentRows(db, prefix, page),
          selected = page === undefined ? rows : rows.slice(0, page.limit);
        return {
          ...cut,
          documents: selected,
          ...(page === undefined
            ? {}
            : { page: { nextPath: rows.length > page.limit ? selected.at(-1)!.path : null } }),
        };
      }),
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
              ) as import("@harness-anything/kernel/internal/domain/canonical-event-summary.ts").CanonicalEventSummary,
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
    readRuntimeDispatchById: (dispatchId) =>
      withRead((db) => projectedDispatch(db, queryRow(db, RUNTIME_DISPATCH_BY_ID_SQL, dispatchId))),
    readRuntimeDispatchByDispatchKey: (dispatchKey) =>
      withRead((db) => {
        assertRuntimeDispatchKeyIndexReady(db);
        return projectedDispatch(db, queryRow(db, RUNTIME_DISPATCH_BY_KEY_SQL, dispatchKey));
      }),
    readRuntimeDispatchByResumeSource: (dispatchId) =>
      withRead((db) => projectedDispatch(db, queryRow(db, RUNTIME_DISPATCH_BY_RESUME_SOURCE_SQL, dispatchId))),
    readRuntimeDispatchesBySession: (runtimeSessionIdValue) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_FIELD_SQL("runtimeSessionId"), runtimeSessionIdValue).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        }),
      ),
    readRuntimeDispatchEventsBySession: (runtimeSessionIdValue) =>
      withRead((db) =>
        queryRows(db, RUNTIME_DISPATCHES_BY_FIELD_SQL("runtimeSessionId"), runtimeSessionIdValue)
          .map((row) => JSON.parse(String(row.event_json)))
          .filter(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
              isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
          )
          .map(publicRuntimeDispatch),
      ),
    readRuntimeDispatchesByTaskIds: (taskIds) =>
      withRead((db) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task read requires 1..500 unique task ids");
        return queryRows(db, RUNTIME_DISPATCHES_BY_TASK_IDS_SQL(taskIds.length), ...taskIds)
          .map((row) => JSON.parse(String(row.event_json)))
          .filter(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
              isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
          )
          .map(publicRuntimeDispatch);
      }),
    readLatestRuntimeDispatchesByTaskIds: (taskIds) =>
      withRead((db) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task latest read requires 1..500 unique task ids");
        return taskIds.flatMap((taskId) => {
          const row = queryRow(db, RUNTIME_LATEST_DISPATCH_BY_TASK_SQL, taskId);
          if (row === undefined) return [];
          const event = JSON.parse(String(row.event_json));
          return isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested"
            ? [publicRuntimeDispatch(event)]
            : [];
        });
      }),
    readLatestRuntimeDispatchBySession: (runtimeSessionId) =>
      withRead((db) => {
        if (typeof runtimeSessionId !== "string" || runtimeSessionId.length === 0)
          throw new Error("runtime dispatch session latest read requires a non-empty session id");
        const row = queryRow(db, RUNTIME_LATEST_DISPATCH_BY_SESSION_SQL, runtimeSessionId);
        if (row === undefined) return null;
        const event = JSON.parse(String(row.event_json));
        return isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested"
          ? publicRuntimeDispatch(event)
          : null;
      }),
    readRuntimeDispatchByDispatchIdPrefix: (prefix, limit) =>
      withRead((db) => {
        if (typeof prefix !== "string" || prefix.length === 0)
          throw new Error("runtime dispatch id prefix requires a non-empty prefix");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch id prefix limit must be from 1 to 500");
        return queryRows(db, RUNTIME_DISPATCH_BY_ID_PREFIX_SQL, prefix, `${prefix}\uFFFF`, limit).flatMap((row) => {
          const projected = projectedDispatch(db, row);
          return projected ? [projected] : [];
        });
      }),
    countRuntimeDispatchesByAgent: (agentId) =>
      withRead((db) => Number(queryRow(db, RUNTIME_DISPATCH_COUNT_BY_AGENT_SQL, agentId)?.count ?? 0)),
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
    readRuntimeDispatchesByMember: ({ agentId, squadId, limit }) =>
      withRead((db) => {
        if ((agentId === undefined) === (squadId === undefined))
          throw new Error("runtime dispatch member page requires exactly one of agentId or squadId");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
          throw new Error("runtime dispatch member page requires a limit from 1 to 500");
        assertRuntimeMemberIndexReady(db);
        const member: "agentId" | "squadId" = agentId === undefined ? "squadId" : "agentId",
          value = agentId ?? squadId!,
          raw = queryRows(db, RUNTIME_DISPATCHES_BY_MEMBER_SQL(member), value, limit + 1),
          rows = raw
            .slice(0, limit)
            .map((row) => JSON.parse(String(row.event_json)))
            .filter(
              (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
                isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
            )
            .map(publicRuntimeDispatch),
          sessions = queryRows(db, RUNTIME_DISPATCH_MEMBER_SESSIONS_SQL(member), value, value).map(
            (row): RuntimeDispatchMemberSession => ({
              runtimeSessionId: String(row.runtimeSessionId),
              taskIds: String(row.taskIds ?? "")
                .split(",")
                .filter(Boolean)
                .sort(),
              latestDecisionId: row.latestDecisionId === null ? null : String(row.latestDecisionId),
            }),
          );
        return { rows, truncated: raw.length > limit, sessions };
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
export function readDocumentRows(
  db: DatabaseSync,
  prefix: string,
  page?: { readonly limit: number; readonly afterPath?: string },
) {
  const upper = prefixUpperBound(prefix),
    values: (string | number)[] = [prefix, ...(upper === null ? [] : [upper])],
    afterPredicate = page?.afterPath === undefined ? "" : "AND path > ?";
  if (page?.afterPath !== undefined) values.push(page.afterPath);
  if (page !== undefined) values.push(checkedPageLimit(page.limit) + 1);
  return queryRows(
    db,
    "SELECT path, json_extract(value_json, '$.blobSha256') AS blob_sha256, " +
      "json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS media_type, " +
      "json_extract(value_json, '$.policyId') AS policy_id " +
      `FROM document WHERE path >= ? ${upper === null ? "" : "AND path < ?"} ${afterPredicate} ORDER BY path ${page === undefined ? "" : "LIMIT ?"}`,
    ...values,
  ).map((row) => ({
    path: String(row.path),
    blobSha256: String(row.blob_sha256),
    size: Number(row.size),
    mediaType: String(row.media_type),
    // `null` only for a row a hand-written fixture inserted without one; every production write
    // model stores the policy the claim was written under.
    policyId: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
  }));
}
