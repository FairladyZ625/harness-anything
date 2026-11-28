import {
  FLEET_RECENT_DISPATCH_LIMIT,
  FLEET_RECENT_EVENT_LIMIT,
  FLEET_RECENT_TASK_LIMIT,
  fleetEventSummary,
  type FleetNodeActivity,
  type FleetRecentDispatch,
  type FleetRecentTask,
} from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { assertEventSummaryReadIndexReady } from "./event-summary-read-index.ts";
import {
  storageReadPolicy,
  validateStorageReadWindow,
} from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { assertRuntimeDispatchKeyIndexReady, assertRuntimeMemberIndexReady } from "./runtime-member-index.ts";
import { prefixUpperBound } from "./document-read-range.ts";
import { sqliteDispatchPageTimeKey } from "./projection-tables.ts";
import { checkedPageLimit } from "./task-query-projection.ts";
import { readArtifactEntityState } from "./artifact-entity-state-projection.ts";
import { readEventList } from "./event-list-query.ts";
import {
  assertRuntimeEventTypes,
  compareRuntimeDispatchPageKeys,
  runtimeDispatchPageKey,
  runtimeDispatchPageTimeKey,
  privateRuntimeEventTypes,
  publicRuntimeDispatch,
} from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { normalizePersistedTimestamp } from "@harness-anything/kernel/internal/domain/timestamp.ts";
import { isSettingsEvent, type SettingsEventV1 } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  isAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type {
  TaskProjectionQueries,
  CanonicalEventSummary,
  RuntimeDispatchProjectionRow,
  RuntimeDispatchMemberSession,
} from "@harness-anything/kernel";
import { hydrateEventsByRevisions, type BatchEventsByRevisionsReader } from "./rebuildable-task-projection-sql.ts";
import { queryRow, queryRows } from "./rebuildable-task-projection-sql.ts";

/** Both center sessions and materialized edge cuts use these event-backed repository queries. */
export type RepositoryReadSession = <A>(
  read: (db: DatabaseSync, cut: ReturnType<TaskProjectionQueries["readCut"]>) => A,
) => A;
const RUNTIME_DISPATCH_SESSION_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "AND runtime_session_id = ?",
  "ORDER BY workspace_revision LIMIT 1",
].join(" ");
const RUNTIME_DISPATCH_SQL = RUNTIME_DISPATCH_SESSION_SQL.replace(
  "ORDER BY",
  "AND definition_snapshot_ref = ? ORDER BY",
);
const RUNTIME_DISPATCHES_SQL = [
  "SELECT workspace_revision, dispatch_id FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "ORDER BY workspace_revision",
].join(" ");
const RUNTIME_DISPATCH_BY_ID_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND dispatch_id = ? ORDER BY workspace_revision")} LIMIT 1`;
const RUNTIME_DISPATCH_BY_KEY_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND dispatch_key = ? ORDER BY workspace_revision")} LIMIT 1`;
const RUNTIME_DISPATCH_BY_RESUME_SOURCE_SQL = `${RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", "AND resumed_from_dispatch_id = ? ORDER BY workspace_revision")} LIMIT 1`;
const RUNTIME_DISPATCHES_BY_COLUMN_SQL = (column: string) =>
  RUNTIME_DISPATCHES_SQL.replace("ORDER BY workspace_revision", `AND ${column} = ? ORDER BY workspace_revision`);
// Drive the join from the requested ids. A JSON-list IN predicate can make SQLite choose the
// event-type index and read every dispatch instead of seeking by decision id.
const DECISION_REVIEW_DISPATCHES_SQL = RUNTIME_DISPATCHES_SQL.replace(
  "FROM event_index",
  "FROM (SELECT DISTINCT value FROM json_each(?)) AS requested CROSS JOIN event_index",
).replace(
  "ORDER BY",
  `AND review_target_kind = 'decision'
   AND review_target_decision_id = requested.value ORDER BY`,
);
const RUNTIME_DISPATCHES_BY_TASK_EXECUTION_SQL = RUNTIME_DISPATCHES_SQL.replace(
  "ORDER BY workspace_revision",
  "AND payload_task_id = ? AND execution_id = ? ORDER BY workspace_revision",
);
const RUNTIME_DISPATCHES_BY_SINGLE_TASK_ID_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "AND payload_task_id = ?",
  "ORDER BY workspace_revision",
].join(" ");
// Drive multi-task lookups from the requested ids so SQLite seeks `event_index_runtime_task_revision`
// instead of scanning all dispatches through `event_index_type_instant`.
const RUNTIME_DISPATCHES_BY_TASK_IDS_SQL = [
  "SELECT event_index.workspace_revision FROM (SELECT DISTINCT value FROM json_each(?)) AS requested",
  "CROSS JOIN event_index",
  "WHERE event_index.event_schema = 'agent-runtime-event/v1'",
  "AND event_index.event_type = 'runtime_dispatch_requested'",
  "AND event_index.payload_task_id = requested.value",
  "ORDER BY event_index.workspace_revision",
].join(" ");
// One index seek per requested task, never the task's total dispatch history: the event index
// carries (payload_task_id, dispatch_activity_at DESC, dispatch_id DESC), where effective time is
// `startedAt ?? occurredAt`, the same fallback the dispatch row uses.
const RUNTIME_LATEST_DISPATCH_BY_TASK_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "AND payload_task_id = ?",
  "ORDER BY dispatch_activity_at DESC, dispatch_id DESC LIMIT 1",
].join(" ");
const RUNTIME_LATEST_DISPATCH_BY_SESSION_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "AND runtime_session_id = ?",
  "ORDER BY dispatch_activity_at DESC, dispatch_id DESC LIMIT 1",
].join(" ");
// Unary `+event_type` keeps SQLite on the covering `event_index_runtime_dispatch_id` range seek
// instead of falling back to `event_index_type_instant (event_type=?)` when ANALYZE has not run.
const RUNTIME_DISPATCH_BY_ID_PREFIX_SQL = [
  "SELECT workspace_revision, dispatch_id FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND +event_type = 'runtime_dispatch_requested'",
  "AND dispatch_id >= ? AND dispatch_id < ?",
  "ORDER BY dispatch_id LIMIT ?",
].join(" ");
const RUNTIME_DISPATCH_COUNT_BY_AGENT_SQL = [
  "SELECT COUNT(*) AS count FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_dispatch_requested'",
  "AND agent_id = ?",
].join(" ");
// The member page answers "an executor's newest dispatches" in one index scan: newest first,
// bounded by the caller's limit, so a detail-page first screen never pays for total history.
const RUNTIME_DISPATCHES_BY_MEMBER_SQL = (memberColumn: "agent_id" | "squad_id", scope: string) =>
  [
    "SELECT workspace_revision FROM event_index AS dispatch",
    "WHERE event_schema = 'agent-runtime-event/v1'",
    "AND event_type = 'runtime_dispatch_requested'",
    `AND ${memberColumn} = ? ${scope}`,
    "ORDER BY dispatch_activity_at DESC, dispatch_id DESC LIMIT ?",
  ].join(" ");
// As in dispatchAttribution, a runtime-sourced request inherits the launch event's source.
const memberDispatchNodeSql = `COALESCE(dispatch.source_resolved_node_id,
  CASE WHEN dispatch.source_runtime_session_id IS NOT NULL THEN (
    SELECT launch.source_resolved_node_id FROM event_index launch
    WHERE launch.event_schema='agent-runtime-event/v1'
      AND launch.event_type='runtime_session_started'
      AND launch.runtime_session_id=dispatch.source_runtime_session_id
    ORDER BY launch.workspace_revision DESC LIMIT 1
  ) END)`;
// Full-history ingredients for the member's task-group totals: one row per session the member
// dispatched, carrying its distinct bindings and the latest member dispatch's decision target.
// The single grouping normalization lives in the daemon; this query only selects raw ingredients.
const RUNTIME_DISPATCH_MEMBER_SESSIONS_SQL = (memberColumn: "agent_id" | "squad_id", scope: string) => {
  const candidate = (after: boolean) => `SELECT workspace_revision FROM event_index AS dispatch
      WHERE event_schema = 'agent-runtime-event/v1'
      AND event_type = 'runtime_dispatch_requested'
      AND ${memberColumn} = ? AND runtime_session_present=1
      ${scope}
      ${after ? "AND runtime_session_id > (SELECT runtime_session_id FROM event_index WHERE workspace_revision=latest.revision)" : ""}
      ORDER BY runtime_session_id, dispatch_activity_at DESC, dispatch_id DESC LIMIT 1`;
  return `WITH RECURSIVE latest(revision) AS (
    SELECT (${candidate(false)}) UNION ALL SELECT (${candidate(true)}) FROM latest WHERE revision IS NOT NULL
  ) SELECT d.runtime_session_id AS runtimeSessionId,
    CASE WHEN d.review_target_kind='decision' THEN d.review_target_decision_id END AS latestDecisionId,
    (SELECT group_concat(DISTINCT b.task_id) FROM runtime_session_task_binding b
      WHERE b.runtime_session_id=d.runtime_session_id) AS taskIds
  FROM latest CROSS JOIN event_index d ON d.workspace_revision=latest.revision ORDER BY runtimeSessionId`;
};
const dispatchIdColumn = "dispatch_id";
const RUNTIME_OUTCOME_BY_DISPATCH_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND event_type = 'runtime_session_outcome_observed'",
  "AND dispatch_id = ?",
  "ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");
const RUNTIME_OUTCOME_BY_DISPATCH_MAX_REVISION_SQL = RUNTIME_OUTCOME_BY_DISPATCH_SQL.replace(
  "ORDER BY workspace_revision DESC LIMIT 1",
  "AND workspace_revision <= ? ORDER BY workspace_revision DESC LIMIT 1",
);
const RUNTIME_SESSION_EVENTS_SQL = [
  "SELECT workspace_revision FROM event_index WHERE workspace_revision > ?",
  "AND event_schema = 'agent-runtime-event/v1'",
  "AND runtime_session_id = ?",
  `AND event_type NOT IN (${privateRuntimeEventTypes.map((type) => `'${type}'`).join(", ")})`,
  "ORDER BY workspace_revision LIMIT ?",
].join(" ");
// Narrow one session to the requested event types: a caller looking for its newest outcome must
// not receive the session's other events only to discard them in JavaScript. event_index_runtime_session
// bounds the scan to that session and revision order; it deliberately carries no type column, because
// a session+type index would also be chosen for the dispatch lookup and replace its one-row seek.
const RUNTIME_SESSION_EVENTS_BY_TYPE_BASE_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'agent-runtime-event/v1'",
  "AND runtime_session_id = ?",
  "AND event_type IN (SELECT value FROM json_each(?))",
  `AND event_type NOT IN (${privateRuntimeEventTypes.map((type) => `'${type}'`).join(", ")})`,
].join(" ");
const RUNTIME_SESSION_EVENTS_BY_TYPE_SQL = `${RUNTIME_SESSION_EVENTS_BY_TYPE_BASE_SQL} ORDER BY workspace_revision`;
const RUNTIME_SESSION_EVENTS_BY_TYPE_WINDOW_SQL = (order: "ASC" | "DESC", maxRevision: boolean) =>
  [
    "SELECT workspace_revision FROM event_index",
    "WHERE workspace_revision > ?",
    ...(maxRevision ? ["AND workspace_revision <= ?"] : []),
    "AND event_schema = 'agent-runtime-event/v1'",
    "AND runtime_session_id = ?",
    "AND event_type IN (SELECT value FROM json_each(?))",
    `AND event_type NOT IN (${privateRuntimeEventTypes.map((type) => `'${type}'`).join(", ")})`,
    `ORDER BY workspace_revision ${order} LIMIT ?`,
  ].join(" ");
const RUNTIME_SESSION_CONTROL_REQUESTS_SQL = (order: "ASC" | "DESC", maxRevision: boolean) =>
  [
    "SELECT workspace_revision FROM event_index",
    "WHERE workspace_revision > ?",
    ...(maxRevision ? ["AND workspace_revision <= ?"] : []),
    "AND event_schema = 'agent-runtime-event/v1'",
    "AND runtime_session_id = ?",
    "AND (event_type IN ('runtime_cancel_requested', 'runtime_steer_requested')",
    "OR (event_type = 'runtime_session_liveness_changed'",
    "AND has_control_request = 1))",
    `ORDER BY workspace_revision ${order} LIMIT ?`,
  ].join(" ");
const RUNTIME_SESSION_CANCEL_CONTROL_REQUESTS_SQL = (order: "ASC" | "DESC", maxRevision: boolean) =>
  [
    "SELECT workspace_revision FROM event_index",
    "WHERE workspace_revision > ?",
    ...(maxRevision ? ["AND workspace_revision <= ?"] : []),
    "AND event_schema = 'agent-runtime-event/v1'",
    "AND runtime_session_id = ?",
    "AND (event_type = 'runtime_cancel_requested'",
    "OR (event_type = 'runtime_session_liveness_changed'",
    "AND control_request_action = 'cancel'))",
    `ORDER BY workspace_revision ${order} LIMIT ?`,
  ].join(" ");
const RUNTIME_SESSION_CONTROL_RECEIPTS_SQL = (
  order: "ASC" | "DESC",
  appliedSteerOnly: boolean,
  byRequestOpId: boolean,
  maxRevision: boolean,
) =>
  [
    "SELECT workspace_revision FROM event_index",
    "WHERE workspace_revision > ?",
    ...(maxRevision ? ["AND workspace_revision <= ?"] : []),
    "AND event_schema = 'agent-runtime-event/v1'",
    "AND event_type IN ('runtime_session_provider_bound', 'runtime_session_liveness_changed')",
    "AND runtime_session_id = ?",
    byRequestOpId
      ? "AND control_receipt_request_op_id IS NOT NULL AND control_receipt_request_op_id = ?"
      : appliedSteerOnly
        ? "AND control_receipt_status = 'applied' AND has_control_receipt_steer_version = 1"
        : "AND has_control_receipt = 1",
    `ORDER BY workspace_revision ${order} LIMIT ?`,
  ].join(" ");
const SCHEDULE_EVENTS_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'schedule-event/v1'",
  "ORDER BY workspace_revision",
].join(" ");
const SCHEDULE_EVENTS_BY_ID_SQL = [
  "SELECT workspace_revision FROM event_index",
  "WHERE event_schema = 'schedule-event/v1'",
  "AND entity_id = ?",
  "ORDER BY workspace_revision",
].join(" ");

type RevisionRow = Readonly<{ readonly workspace_revision: number; readonly dispatch_id?: string | null }>;

function hydrateOrderedEvents(
  rows: readonly RevisionRow[],
  readEventsByRevisions: BatchEventsByRevisionsReader | undefined,
): CanonicalEventV1[] {
  if (rows.length === 0) return [];
  const revisions = rows.map((row) => Number(row.workspace_revision));
  const hydrated = hydrateEventsByRevisions(revisions, readEventsByRevisions);
  return revisions.map((revision) => hydrated.get(revision)!);
}

function hydrateOrderedDispatches(
  rows: readonly RevisionRow[],
  readEventsByRevisions: BatchEventsByRevisionsReader | undefined,
): Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>[] {
  return hydrateOrderedEvents(rows, readEventsByRevisions)
    .filter(
      (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
        isAgentRuntimeEvent(event) && event.type === "runtime_dispatch_requested",
    )
    .map(publicRuntimeDispatch);
}

export function repositoryEventQueries(
  withRead: RepositoryReadSession,
  readEventsByRevisions?: BatchEventsByRevisionsReader,
  withDb: <A>(read: (db: DatabaseSync) => A) => A = (read) => withRead((db) => read(db)),
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
  | "readRuntimeDispatchesByDecisions"
  | "readRuntimeDispatchPage"
  | "readRuntimeDispatchesByMember"
  | "readRuntimeSessionEvents"
  | "readRuntimeSessionEventsByType"
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
    readArtifactEntityState: (kind, id) => withDb((db) => readArtifactEntityState(db, kind, id)),
    readEventList: (query) => withDb((db) => readEventList(db, query)),
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
      withDb((db) => {
        const row = queryRow(db, "SELECT witness_json FROM event_summary WHERE workspace_revision = ?", revision);
        return row
          ? (JSON.parse(String(row.witness_json)) as ReturnType<TaskProjectionQueries["readEventWitness"]>)
          : null;
      }),
    readEventSummaries: (afterRevision, limit, fields, beforeRevision, order) =>
      withRead((db, cut) => {
        if (
          !validateStorageReadWindow(
            limit,
            storageReadPolicy.defaultValue.pageSizes.summaries,
            afterRevision,
            beforeRevision,
          )
        )
          throw new Error("event summary page requires a non-negative revision and a limit from 1 to 2048");
        const scanOrder = order ?? (beforeRevision === undefined ? "asc" : "desc");
        if (scanOrder !== "asc" && scanOrder !== "desc")
          throw new Error("event summary page order must be asc or desc");
        if (fields === "fleet" || (typeof fields === "object" && "fleetNodeIds" in fields)) {
          assertEventSummaryReadIndexReady(db);
          return {
            ...cut,
            events: readFleetEventHeaders(db, afterRevision, limit, beforeRevision, scanOrder),
            ...(typeof fields === "object" ? { fleetActivity: readFleetNodeActivity(db, fields.fleetNodeIds) } : {}),
          };
        }
        if (typeof fields === "object") {
          const filters: string[] = [],
            values: string[] = [];
          if (fields.actorPersonId !== undefined) {
            filters.push("AND actor_person_id = ?");
            values.push(fields.actorPersonId);
          }
          if (fields.nodeId !== undefined) {
            filters.push("AND source_node_id = ?");
            values.push(fields.nodeId);
          }
          const selected = [...new Set(fields.taskIds)].flatMap((taskId) =>
            queryRows(
              db,
              "SELECT summary_json FROM event_summary WHERE json_extract(summary_json, '$.taskId') = ? " +
                `AND workspace_revision > ? ${filters.join(" ")} ORDER BY workspace_revision DESC LIMIT ?`,
              taskId,
              afterRevision,
              ...values,
              limit + 1,
            ).map(
              (row) => JSON.parse(String(row.summary_json)) as import("@harness-anything/kernel").CanonicalEventSummary,
            ),
          );
          selected.sort((left, right) => right.workspaceRevision - left.workspaceRevision);
          return { ...cut, events: selected.slice(0, limit).reverse(), hasMore: selected.length > limit };
        }
        const rawRows =
            beforeRevision === undefined
              ? queryRows(
                  db,
                  `SELECT summary_json FROM event_summary WHERE workspace_revision > ? ORDER BY workspace_revision ${scanOrder === "asc" ? "ASC" : "DESC"} LIMIT ?`,
                  afterRevision,
                  limit,
                )
              : queryRows(
                  db,
                  `SELECT summary_json FROM event_summary WHERE workspace_revision > ? AND workspace_revision < ? ORDER BY workspace_revision ${scanOrder === "asc" ? "ASC" : "DESC"} LIMIT ?`,
                  afterRevision,
                  beforeRevision,
                  limit,
                ),
          rows = scanOrder === "desc" ? rawRows.toReversed() : rawRows;
        return {
          ...cut,
          events: rows.map(
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
        const row = queryRow<RevisionRow>(
          db,
          "SELECT workspace_revision FROM event_index WHERE workspace_revision = ?",
          Number(entity.workspace_revision),
        );
        const event = row
          ? (hydrateOrderedEvents([row], readEventsByRevisions)[0] as SettingsEventV1 | undefined)
          : undefined;
        if (!event || !isSettingsEvent(event))
          throw Object.assign(new Error("Settings provenance is missing from the projection cut."), {
            code: "projection_pending",
          });
        return event;
      }),
    readRuntimeDispatch: (runtimeSessionIdValue, definitionSnapshotRef) =>
      withDb((db) => {
        const row =
          definitionSnapshotRef === undefined
            ? queryRow<RevisionRow>(db, RUNTIME_DISPATCH_SESSION_SQL, runtimeSessionIdValue)
            : queryRow<RevisionRow>(db, RUNTIME_DISPATCH_SQL, runtimeSessionIdValue, definitionSnapshotRef);
        if (!row) return null;
        return hydrateOrderedDispatches([row], readEventsByRevisions)[0] ?? null;
      }),
    readRuntimeDispatchById: (dispatchId) =>
      withDb(
        (db) =>
          hydrateProjectedDispatches(
            db,
            maybeRow(queryRow<RevisionRow>(db, RUNTIME_DISPATCH_BY_ID_SQL, dispatchId)),
            readEventsByRevisions,
          )[0] ?? null,
      ),
    readRuntimeDispatchByDispatchKey: (dispatchKey) =>
      withDb((db) => {
        assertRuntimeDispatchKeyIndexReady(db);
        return (
          hydrateProjectedDispatches(
            db,
            maybeRow(queryRow<RevisionRow>(db, RUNTIME_DISPATCH_BY_KEY_SQL, dispatchKey)),
            readEventsByRevisions,
          )[0] ?? null
        );
      }),
    readRuntimeDispatchByResumeSource: (dispatchId) =>
      withDb(
        (db) =>
          hydrateProjectedDispatches(
            db,
            maybeRow(queryRow<RevisionRow>(db, RUNTIME_DISPATCH_BY_RESUME_SOURCE_SQL, dispatchId)),
            readEventsByRevisions,
          )[0] ?? null,
      ),
    readRuntimeDispatchesBySession: (runtimeSessionIdValue) =>
      withDb((db) =>
        hydrateProjectedDispatches(
          db,
          queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_COLUMN_SQL("runtime_session_id"), runtimeSessionIdValue),
          readEventsByRevisions,
        ),
      ),
    readRuntimeDispatchEventsBySession: (runtimeSessionIdValue) =>
      withDb((db) =>
        hydrateOrderedDispatches(
          queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_COLUMN_SQL("runtime_session_id"), runtimeSessionIdValue),
          readEventsByRevisions,
        ),
      ),
    readRuntimeDispatchesByTaskIds: (taskIds) =>
      withDb((db) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task read requires 1..500 unique task ids");
        const rows =
          taskIds.length === 1
            ? queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_SINGLE_TASK_ID_SQL, taskIds[0]!)
            : queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_TASK_IDS_SQL, JSON.stringify(taskIds));
        return hydrateOrderedDispatches(rows, readEventsByRevisions);
      }),
    readLatestRuntimeDispatchesByTaskIds: (taskIds) =>
      withDb((db) => {
        if (
          !Array.isArray(taskIds) ||
          taskIds.length === 0 ||
          taskIds.length > 500 ||
          taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
          new Set(taskIds).size !== taskIds.length
        )
          throw new Error("runtime dispatch task latest read requires 1..500 unique task ids");
        const matched = taskIds.flatMap((taskId) => {
          const row = queryRow<RevisionRow>(db, RUNTIME_LATEST_DISPATCH_BY_TASK_SQL, taskId);
          return row === undefined ? [] : [row];
        });
        return hydrateOrderedDispatches(matched, readEventsByRevisions);
      }),
    readLatestRuntimeDispatchBySession: (runtimeSessionId) =>
      withDb((db) => {
        if (typeof runtimeSessionId !== "string" || runtimeSessionId.length === 0)
          throw new Error("runtime dispatch session latest read requires a non-empty session id");
        const row = queryRow<RevisionRow>(db, RUNTIME_LATEST_DISPATCH_BY_SESSION_SQL, runtimeSessionId);
        if (row === undefined) return null;
        return hydrateOrderedDispatches([row], readEventsByRevisions)[0] ?? null;
      }),
    readRuntimeDispatchByDispatchIdPrefix: (prefix, limit) =>
      withDb((db) => {
        if (typeof prefix !== "string" || prefix.length === 0)
          throw new Error("runtime dispatch id prefix requires a non-empty prefix");
        if (!validateStorageReadWindow(limit, storageReadPolicy.defaultValue.pageSizes.standard))
          throw new Error("runtime dispatch id prefix limit must be from 1 to 500");
        return hydrateProjectedDispatches(
          db,
          queryRows<RevisionRow>(db, RUNTIME_DISPATCH_BY_ID_PREFIX_SQL, prefix, `${prefix}\uFFFF`, limit),
          readEventsByRevisions,
        );
      }),
    countRuntimeDispatchesByAgent: (agentId) =>
      withDb((db) => Number(queryRow(db, RUNTIME_DISPATCH_COUNT_BY_AGENT_SQL, agentId)?.count ?? 0)),
    readRuntimeDispatchesByTaskExecution: (taskId, executionId) =>
      withDb((db) =>
        hydrateProjectedDispatches(
          db,
          queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_TASK_EXECUTION_SQL, taskId, executionId),
          readEventsByRevisions,
        ),
      ),
    readRuntimeDispatchesByAttemptGroup: (attemptGroupId) =>
      withDb((db) =>
        hydrateProjectedDispatches(
          db,
          queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_COLUMN_SQL("attempt_group_id"), attemptGroupId),
          readEventsByRevisions,
        ),
      ),
    readRuntimeDispatchesByDecision: (decisionId) =>
      withDb((db) =>
        hydrateProjectedDispatches(
          db,
          queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_COLUMN_SQL("review_target_decision_id"), decisionId),
          readEventsByRevisions,
        ),
      ),
    readRuntimeDispatchesByDecisions: (decisionIds) =>
      decisionIds.length === 0
        ? []
        : withDb((db) =>
            hydrateOrderedDispatches(
              queryRows<RevisionRow>(db, DECISION_REVIEW_DISPATCHES_SQL, JSON.stringify(decisionIds)),
              readEventsByRevisions,
            ),
          ),
    readRuntimeDispatchPage: ({
      taskIds,
      agentId,
      squadId,
      personId,
      startedAtGte,
      startedAtLte,
      order = "asc",
      maxRevision,
      cursor,
      limit: pageLimit,
    }) =>
      withDb((db) => {
        if (!validateStorageReadWindow(pageLimit, storageReadPolicy.defaultValue.pageSizes.standard))
          throw new Error("runtime dispatch page requires a limit from 1 to 500");
        if (order !== "asc" && order !== "desc") throw new Error("runtime dispatch page order must be asc or desc");
        if (agentId !== undefined && squadId !== undefined)
          throw new Error("runtime dispatch page cannot filter by both agentId and squadId");
        if (agentId !== undefined && agentId.length === 0)
          throw new Error("runtime dispatch page agentId must be non-empty");
        if (squadId !== undefined && squadId.length === 0)
          throw new Error("runtime dispatch page squadId must be non-empty");
        if (personId !== undefined && personId.length === 0)
          throw new Error("runtime dispatch page personId must be non-empty");
        if (maxRevision !== undefined && (!Number.isSafeInteger(maxRevision) || maxRevision < 0))
          throw new Error("runtime dispatch page maxRevision must be a non-negative safe integer");
        const minMs = runtimeDispatchPageTimeKey(startedAtGte);
        if (startedAtLte !== undefined && startedAtLte === "") throw new Error("Invalid dispatch page timestamp");
        const maxMs = startedAtLte === undefined ? null : runtimeDispatchPageTimeKey(startedAtLte);
        const clauses: string[] = [
            "event_schema = 'agent-runtime-event/v1'",
            "event_type = 'runtime_dispatch_requested'",
          ],
          baseArgs: (string | number)[] = [];
        if (agentId !== undefined) {
          clauses.push("agent_id = ?");
          baseArgs.push(agentId);
        }
        if (squadId !== undefined) {
          clauses.push("squad_id = ?");
          baseArgs.push(squadId);
        }
        if (personId !== undefined) {
          clauses.push("actor_person_id = ?");
          baseArgs.push(personId);
        }
        if (maxRevision !== undefined) {
          clauses.push("workspace_revision <= ?");
          baseArgs.push(maxRevision);
        }
        let orderBy: string;
        if (order === "asc") {
          const after = runtimeDispatchPageTimeKey(cursor?.startedAt ?? "");
          clauses.push(`${sqliteDispatchPageTimeKey} >= ?`);
          baseArgs.push(Math.max(minMs, after));
          if (maxMs !== null) {
            clauses.push(`${sqliteDispatchPageTimeKey} <= ?`);
            baseArgs.push(maxMs);
          }
          clauses.push(`(${sqliteDispatchPageTimeKey}, ${dispatchIdColumn}) > (?, ?)`);
          baseArgs.push(after, cursor?.dispatchId ?? "");
          orderBy = `${sqliteDispatchPageTimeKey} ASC, ${dispatchIdColumn} ASC`;
        } else {
          clauses.push(`${sqliteDispatchPageTimeKey} >= ?`);
          baseArgs.push(minMs);
          if (cursor !== undefined) {
            if (cursor.startedAt === "") throw new Error("Invalid dispatch page timestamp");
            const cursorMs = runtimeDispatchPageTimeKey(cursor.startedAt),
              effectiveMax = maxMs === null ? cursorMs : Math.min(maxMs, cursorMs);
            clauses.push(`${sqliteDispatchPageTimeKey} <= ?`);
            baseArgs.push(effectiveMax);
            clauses.push(
              `(${sqliteDispatchPageTimeKey} < ? OR (${sqliteDispatchPageTimeKey} = ? AND ${dispatchIdColumn} > ?))`,
            );
            baseArgs.push(cursorMs, cursorMs, cursor.dispatchId);
          } else if (maxMs !== null) {
            clauses.push(`${sqliteDispatchPageTimeKey} <= ?`);
            baseArgs.push(maxMs);
          }
          orderBy = `${sqliteDispatchPageTimeKey} DESC, ${dispatchIdColumn} ASC`;
        }
        type DispatchPageIndexRow = Readonly<{
          readonly workspace_revision: number;
          readonly dispatch_id: string | null;
          readonly dispatch_activity_at: string | null;
        }>;
        const buildSql = (byTask: boolean) =>
            `SELECT workspace_revision, dispatch_id, dispatch_activity_at FROM event_index WHERE ${[
              ...clauses,
              ...(byTask ? ["payload_task_id = ?"] : []),
            ].join(" AND ")} ORDER BY ${orderBy} LIMIT ?`,
          compareKeys =
            order === "asc"
              ? compareRuntimeDispatchPageKeys
              : (left: ReturnType<typeof runtimeDispatchPageKey>, right: ReturnType<typeof runtimeDispatchPageKey>) =>
                  runtimeDispatchPageTimeKey(right.startedAt) - runtimeDispatchPageTimeKey(left.startedAt) ||
                  Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId)),
          raw =
            taskIds === undefined
              ? queryRows<DispatchPageIndexRow>(db, buildSql(false), ...baseArgs, pageLimit + 1)
              : taskIds
                  .flatMap((taskId) =>
                    queryRows<DispatchPageIndexRow>(db, buildSql(true), ...baseArgs, taskId, pageLimit + 1),
                  )
                  .map((row) => {
                    const startedAt = row.dispatch_activity_at ?? "";
                    return {
                      row,
                      key: {
                        startedAt: normalizePersistedTimestamp(startedAt) ?? startedAt,
                        dispatchId: row.dispatch_id ?? "",
                      },
                    };
                  })
                  .sort((left, right) => compareKeys(left.key, right.key))
                  .slice(0, pageLimit + 1)
                  .map(({ row }) => row),
          done = raw.length <= pageLimit,
          rows = hydrateProjectedDispatches(db, raw.slice(0, pageLimit), readEventsByRevisions, maxRevision),
          last = rows.at(-1)?.event;
        return {
          rows,
          done,
          nextCursor: !done && last ? runtimeDispatchPageKey(last) : null,
        };
      }),
    readRuntimeDispatchesByMember: ({ agentId, squadId, personId, nodeId, limit }) =>
      withDb((db) => {
        if ((agentId === undefined) === (squadId === undefined))
          throw new Error("runtime dispatch member page requires exactly one of agentId or squadId");
        if (!validateStorageReadWindow(limit, storageReadPolicy.defaultValue.pageSizes.standard))
          throw new Error("runtime dispatch member page requires a limit from 1 to 500");
        assertRuntimeMemberIndexReady(db);
        const memberColumn: "agent_id" | "squad_id" = agentId === undefined ? "squad_id" : "agent_id",
          scope = [
            personId === undefined ? "" : "AND dispatch.actor_person_id = ?",
            nodeId === undefined ? "" : `AND ${memberDispatchNodeSql} = ?`,
          ].join(" "),
          args = [
            agentId ?? squadId!,
            ...(personId === undefined ? [] : [personId]),
            ...(nodeId === undefined ? [] : [nodeId]),
          ],
          raw = queryRows<RevisionRow>(db, RUNTIME_DISPATCHES_BY_MEMBER_SQL(memberColumn, scope), ...args, limit + 1),
          rows = hydrateOrderedDispatches(raw.slice(0, limit), readEventsByRevisions),
          sessions = queryRows(db, RUNTIME_DISPATCH_MEMBER_SESSIONS_SQL(memberColumn, scope), ...args, ...args).map(
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
      withDb((db) => {
        if (!validateStorageReadWindow(limit, undefined, afterRevision))
          throw new Error("runtime session event page requires a non-negative revision and a positive limit");
        const rows = queryRows<RevisionRow>(
          db,
          RUNTIME_SESSION_EVENTS_SQL,
          afterRevision,
          runtimeSessionIdValue,
          limit,
        );
        return hydrateOrderedEvents(rows, readEventsByRevisions)
          .filter((event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event))
          .map((event) => (event.type === "runtime_dispatch_requested" ? publicRuntimeDispatch(event) : event));
      }),
    readRuntimeSessionEventsByType: (runtimeSessionIdValue, types, options) =>
      withDb((db) => {
        const requested = assertRuntimeEventTypes(types),
          afterRevision = options?.afterRevision,
          maxRevision = options?.maxRevision,
          filter = options?.filter,
          order = options?.order === "desc" ? "DESC" : "ASC",
          windowed =
            afterRevision !== undefined ||
            options?.limit !== undefined ||
            options?.order !== undefined ||
            filter !== undefined;
        if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
          throw new Error("runtime session event read afterRevision must be a non-negative safe integer");
        if (maxRevision !== undefined && (!Number.isSafeInteger(maxRevision) || maxRevision < 0))
          throw new Error("runtime session event read maxRevision must be a non-negative safe integer");
        if (maxRevision !== undefined && afterRevision !== undefined && maxRevision < afterRevision)
          throw new Error("runtime session event read maxRevision must not precede afterRevision");
        if (
          options?.limit !== undefined &&
          !validateStorageReadWindow(options.limit, storageReadPolicy.defaultValue.pageSizes.standard)
        )
          throw new Error("runtime session event read limit must be between 1 and 500");
        const boundedAfterRevision = afterRevision ?? 0,
          limit = options?.limit ?? 500,
          requestOpId =
            filter === "control_receipt" && typeof options?.requestOpId === "string" && options.requestOpId.length > 0
              ? options.requestOpId
              : null,
          revisionValues = [boundedAfterRevision, ...(maxRevision === undefined ? [] : [maxRevision])];
        const rows = windowed
          ? (() => {
              if (!validateStorageReadWindow(limit, undefined, boundedAfterRevision))
                throw new Error("runtime session event page requires a non-negative revision and a positive limit");
              if (filter === "control_request")
                return queryRows<RevisionRow>(
                  db,
                  RUNTIME_SESSION_CONTROL_REQUESTS_SQL(order, maxRevision !== undefined),
                  ...revisionValues,
                  runtimeSessionIdValue,
                  limit,
                );
              if (filter === "cancel_control_request")
                return queryRows<RevisionRow>(
                  db,
                  RUNTIME_SESSION_CANCEL_CONTROL_REQUESTS_SQL(order, maxRevision !== undefined),
                  ...revisionValues,
                  runtimeSessionIdValue,
                  limit,
                );
              if (filter === "control_receipt" || filter === "applied_steer_receipt")
                return queryRows<RevisionRow>(
                  db,
                  RUNTIME_SESSION_CONTROL_RECEIPTS_SQL(
                    order,
                    filter === "applied_steer_receipt",
                    requestOpId !== null,
                    maxRevision !== undefined,
                  ),
                  ...revisionValues,
                  runtimeSessionIdValue,
                  ...(requestOpId === null ? [] : [requestOpId]),
                  limit,
                );
              return queryRows<RevisionRow>(
                db,
                RUNTIME_SESSION_EVENTS_BY_TYPE_WINDOW_SQL(order, maxRevision !== undefined),
                ...revisionValues,
                runtimeSessionIdValue,
                JSON.stringify(requested),
                limit,
              );
            })()
          : maxRevision === undefined
            ? queryRows<RevisionRow>(
                db,
                RUNTIME_SESSION_EVENTS_BY_TYPE_SQL,
                runtimeSessionIdValue,
                JSON.stringify(requested),
              )
            : queryRows<RevisionRow>(
                db,
                `${RUNTIME_SESSION_EVENTS_BY_TYPE_BASE_SQL} AND workspace_revision <= ? ORDER BY workspace_revision ${order}`,
                runtimeSessionIdValue,
                JSON.stringify(requested),
                maxRevision,
              );
        return hydrateOrderedEvents(rows, readEventsByRevisions)
          .filter((event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event))
          .map((event) => (event.type === "runtime_dispatch_requested" ? publicRuntimeDispatch(event) : event));
      }),
    readScheduleEvents: (scheduleId) =>
      withRead((db, cut) => {
        const rows = queryRows<RevisionRow>(
          db,
          scheduleId === undefined ? SCHEDULE_EVENTS_SQL : SCHEDULE_EVENTS_BY_ID_SQL,
          ...(scheduleId === undefined ? [] : [scheduleId]),
        );
        return {
          status: cut.status,
          events: hydrateOrderedEvents(rows, readEventsByRevisions),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readReckoningEvents: ({ type, after, before }) =>
      withDb((db) => {
        const rows = queryRows<RevisionRow>(
          db,
          "SELECT workspace_revision FROM event_index WHERE event_type = ? " +
            "AND occurred_at_ms >= ? AND occurred_at_ms <= ? ORDER BY workspace_revision",
          type,
          Date.parse(after),
          Date.parse(before),
        );
        return hydrateOrderedEvents(rows, readEventsByRevisions);
      }),
    readScheduleOutputEvents: (runtimeSessionIds) =>
      withDb((db) => {
        if (runtimeSessionIds.length === 0) return [];
        const sql = [
          "SELECT workspace_revision FROM event_index",
          `WHERE actor_executor_id IN (${runtimeSessionIds.map(() => "?").join(",")})`,
          "AND event_schema IN ('fact-event/v1','decision-event/v1','task-event/v1')",
          "ORDER BY workspace_revision",
        ].join(" ");
        const rows = queryRows<RevisionRow>(db, sql, ...runtimeSessionIds.map((id) => `runtime-session:${id}`));
        return hydrateOrderedEvents(rows, readEventsByRevisions);
      }),
  };
}

function maybeRow(row: RevisionRow | undefined): readonly RevisionRow[] {
  return row === undefined ? [] : [row];
}

function hydrateProjectedDispatches(
  db: DatabaseSync,
  rows: readonly RevisionRow[],
  readEventsByRevisions: BatchEventsByRevisionsReader | undefined,
  maxRevision?: number,
): RuntimeDispatchProjectionRow[] {
  if (rows.length === 0) return [];
  const entries = rows.map((row) => {
    const dispatchRevision = Number(row.workspace_revision);
    const dispatchId = typeof row.dispatch_id === "string" && row.dispatch_id.length > 0 ? row.dispatch_id : null;
    const outcomeRow =
      dispatchId === null
        ? undefined
        : maxRevision === undefined
          ? queryRow<RevisionRow>(db, RUNTIME_OUTCOME_BY_DISPATCH_SQL, dispatchId)
          : queryRow<RevisionRow>(db, RUNTIME_OUTCOME_BY_DISPATCH_MAX_REVISION_SQL, dispatchId, maxRevision);
    const outcomeRevision = outcomeRow ? Number(outcomeRow.workspace_revision) : null;
    return { dispatchRevision, outcomeRevision };
  });
  const revisions: number[] = [];
  for (const entry of entries) {
    revisions.push(entry.dispatchRevision);
    if (entry.outcomeRevision !== null) revisions.push(entry.outcomeRevision);
  }
  const hydrated = hydrateEventsByRevisions(revisions, readEventsByRevisions);
  const projected: RuntimeDispatchProjectionRow[] = [];
  for (const entry of entries) {
    const event = hydrated.get(entry.dispatchRevision);
    if (!event || !isAgentRuntimeEvent(event) || event.type !== "runtime_dispatch_requested") continue;
    const outcome = entry.outcomeRevision === null ? null : (hydrated.get(entry.outcomeRevision) ?? null);
    if (!outcome || !isAgentRuntimeEvent(outcome) || outcome.type !== "runtime_session_outcome_observed") {
      projected.push({ event: publicRuntimeDispatch(event), metrics: null, endedAt: null, outcome: null });
      continue;
    }
    const rawMetrics = outcome.payload.runtimeMetrics ?? null,
      cacheWriteTokens = outcome.payload.cacheWriteTokens ?? rawMetrics?.cacheWriteTokens,
      metrics =
        rawMetrics === null || cacheWriteTokens === undefined ? rawMetrics : { ...rawMetrics, cacheWriteTokens };
    projected.push({
      event: publicRuntimeDispatch(event),
      metrics,
      endedAt: outcome.payload.endedAt ?? null,
      outcome: outcome.payload.outcome,
    });
  }
  return projected;
}

/** Document descriptors at this cut, shared by replica publication and repository document lists. */
export function readDocumentRows(
  db: DatabaseSync,
  prefix: string,
  page?: {
    readonly limit: number;
    readonly afterPath?: string;
    readonly afterRevision?: number;
    readonly includeHistory?: boolean;
    readonly excludeTaskPackages?: boolean;
  },
) {
  const upper = prefixUpperBound(prefix),
    values: (string | number)[] = [prefix, ...(upper === null ? [] : [upper])],
    afterPredicate = page?.afterPath === undefined ? "" : "AND path > ?";
  if (page?.afterPath !== undefined) values.push(page.afterPath);
  const revisionPredicate = page?.afterRevision === undefined ? "" : "AND workspace_revision > ?";
  if (page?.afterRevision !== undefined) values.push(page.afterRevision);
  if (page !== undefined) values.push(checkedPageLimit(page.limit) + 1);
  const indexed = (table: string) =>
    page?.afterRevision === undefined ? table : `${table} INDEXED BY ${table}_revision`;
  const tables = page?.includeHistory ? ["document", "document_history"] : ["document"],
    source =
      !page?.includeHistory && !page?.excludeTaskPackages
        ? indexed("document")
        : `(${tables
            .flatMap((table) =>
              page?.excludeTaskPackages
                ? [
                    `SELECT *, ${table === "document_history" ? 1 : 0} AS retired FROM ${indexed(table)} WHERE path < 'tasks/task_'`,
                    `SELECT *, ${table === "document_history" ? 1 : 0} AS retired FROM ${indexed(table)} WHERE path >= 'tasks/task\`'`,
                  ]
                : [`SELECT *, ${table === "document_history" ? 1 : 0} AS retired FROM ${indexed(table)}`],
            )
            .join(" UNION ALL ")})`;
  return queryRows(
    db,
    (page?.afterRevision === undefined
      ? "SELECT "
      : page?.includeHistory || page?.excludeTaskPackages
        ? "SELECT retired, "
        : "SELECT 0 AS retired, ") +
      "path, json_extract(value_json, '$.blobSha256') AS blob_sha256, " +
      "json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS media_type, " +
      "json_extract(value_json, '$.policyId') AS policy_id " +
      `FROM ${source} WHERE path >= ? ${upper === null ? "" : "AND path < ?"} ${afterPredicate} ${revisionPredicate} ORDER BY path ${page === undefined ? "" : "LIMIT ?"}`,
    ...values,
  ).map((row) => ({
    path: String(row.path),
    ...(page?.afterRevision === undefined ? {} : { retired: Number(row.retired) === 1 }),
    blobSha256: String(row.blob_sha256),
    size: Number(row.size),
    mediaType: String(row.media_type),
    // `null` only for a row a hand-written fixture inserted without one; every production write
    // model stores the policy the claim was written under.
    policyId: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
  }));
}

const fleetHeader = `json_object(
 'eventId',json_extract(row_json,'$.eventId'), 'schema',json_extract(row_json,'$.schema'),
 'type',event_type, 'occurredAt',occurred_at, 'workspaceRevision',workspace_revision,
 'taskId',COALESCE(json_extract(summary_json,'$.taskId'),json_extract(summary_json,'$.payload.taskId')),
 'source',witness_json->'$.source', 'nodeId',source_node_id,
 'actor',json_object('principal',json_object('personId',actor_person_id),'executor',json_object('id',actor_executor_id)),
 'payload',json_object('title',json_extract(summary_json,'$.payload.title'),
   'statement',json_extract(summary_json,'$.payload.statement'),'text',json_extract(summary_json,'$.payload.text'))
)`;

function readFleetEventHeaders(
  db: DatabaseSync,
  after: number,
  limit: number,
  before?: number,
  order: "asc" | "desc" = before === undefined ? "asc" : "desc",
): CanonicalEventSummary[] {
  const dir = order === "asc" ? "ASC" : "DESC",
    rawRows =
      before === undefined
        ? queryRows<{ header: string }>(
            db,
            `SELECT ${fleetHeader} AS header FROM event_summary WHERE workspace_revision>?
             ORDER BY workspace_revision ${dir} LIMIT ?`,
            after,
            limit,
          )
        : queryRows<{ header: string }>(
            db,
            `SELECT ${fleetHeader} AS header FROM event_summary WHERE workspace_revision>? AND workspace_revision<?
             ORDER BY workspace_revision ${dir} LIMIT ?`,
            after,
            before,
            limit,
          ),
    rows = order === "desc" ? rawRows.toReversed() : rawRows;
  return rows.map(({ header }) => JSON.parse(header) as CanonicalEventSummary);
}

/** One batched read, with a top-N index probe per node and point joins after each limit. */
function readFleetNodeActivity(db: DatabaseSync, nodeIds: readonly string[]): FleetNodeActivity[] {
  return queryRows<{
    node_id: string;
    tasks: string;
    dispatches: string;
    events: string;
  }>(
    db,
    `SELECT nodes.value AS node_id,
    (SELECT json_group_array(json_object('taskId',a.task_id,
       'title',json_extract(t.snapshot_json,'$.task.title'),
       'coordinationStatus',COALESCE(t.status,'unknown'),'personId',a.person_id,'updatedAt',a.updated_at))
     FROM (SELECT * FROM fleet_node_task WHERE node_id=nodes.value
           ORDER BY updated_at DESC,task_id LIMIT ${FLEET_RECENT_TASK_LIMIT}) a
     JOIN task_snapshot t ON t.task_id=a.task_id) AS tasks,
    (SELECT json_group_array(json_object(
       'dispatchId',e.dispatch_id,
       'runtimeSessionId',e.runtime_session_id,
       'taskId',a.activity_task_id,'taskTitle',json_extract(t.snapshot_json,'$.task.title'),
       'agentId',e.agent_id,
       'agentLabel',COALESCE(e.agent_name,e.agent_id),
       'personId',a.actor_person_id, 'status',COALESCE(json_extract(s.value_json,'$.outcome'),
         CASE WHEN json_extract(s.value_json,'$.liveness') IN ('live','stale') THEN 'running' ELSE 'unknown' END),
       'startedAt',a.dispatch_started_at))
     FROM (SELECT workspace_revision,activity_task_id,actor_person_id,dispatch_started_at FROM event_summary
           WHERE source_node_id=nodes.value AND event_type='runtime_dispatch_requested'
           ORDER BY dispatch_started_at DESC,workspace_revision DESC LIMIT ${FLEET_RECENT_DISPATCH_LIMIT}) a
     JOIN event_index e USING(workspace_revision)
     LEFT JOIN task_snapshot t ON t.task_id=a.activity_task_id
     LEFT JOIN runtime_session s ON s.runtime_session_id=e.runtime_session_id) AS dispatches,
    (SELECT json_group_array(json(header))
     FROM (SELECT ${fleetHeader} AS header FROM event_summary WHERE source_node_id=nodes.value
           ORDER BY workspace_revision DESC LIMIT ${FLEET_RECENT_EVENT_LIMIT})) AS events
    FROM json_each(?) nodes`,
    JSON.stringify(nodeIds),
  ).map((row) => ({
    nodeId: row.node_id,
    recentTasks: JSON.parse(row.tasks) as FleetRecentTask[],
    recentDispatches: JSON.parse(row.dispatches) as FleetRecentDispatch[],
    recentEvents: (JSON.parse(row.events) as CanonicalEventSummary[]).map(fleetEventSummary),
  }));
}
