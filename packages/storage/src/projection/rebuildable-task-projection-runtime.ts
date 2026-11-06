// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import {
  emptyTaskLifecycleSnapshot,
  type LeaseChangeReason,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import {
  TASK_LEASE_BROKER_CONTRACT,
  validateLeaseV1,
  type LeaseHolder,
  type LeaseV1,
} from "@harness-anything/kernel/internal/domain/execution.ts";
import {
  type RuntimeInstallation,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { validateTaskV2 } from "@harness-anything/kernel/internal/domain/task.ts";
import { withoutRetiredTaskSnapshotFields } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import {
  canonicalJson,
  prepareQuery,
  queryPreparedRows,
  queryRow,
  queryRows,
  runSql,
  type ProjectionSqlRow,
} from "./rebuildable-task-projection-sql.ts";
import type { LeaseInterval } from "@harness-anything/kernel";
import type {
  RuntimeSessionPageQuery,
  RuntimeSessionPageRead,
  RuntimeSessionReadQuery,
} from "@harness-anything/kernel";
import { readRelationProjectionRows, readRelationProjectionRowsForTargets } from "./relation-entity-projection.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "@harness-anything/kernel";

const UPSERT_LEASE_SQL = [
  "INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?)",
  "ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json",
].join(" ");
const INSERT_LEASE_INTERVAL_SQL = [
  "INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision,",
  "holder_json, previous_holder_json, lease_expires_at, reason)",
  "VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
].join(" ");
const UPDATE_LEASE_SQL = "UPDATE lease_cas SET lease_json = ? WHERE task_id = ?";
const UPDATE_LEASE_EXPIRY_SQL = [
  "UPDATE lease_interval SET lease_expires_at = ?",
  "WHERE task_id = ? AND execution_id = ? AND released_revision IS NULL",
].join(" ");
const UPDATE_LEASE_RELEASE_SQL = [
  "UPDATE lease_interval SET released_revision = ?",
  "WHERE task_id = ? AND execution_id = ? AND released_revision IS NULL",
].join(" ");
const COUNT_ACTIVE_LEASES_SQL = [
  "SELECT COUNT(*) AS count FROM lease_cas",
  "WHERE json_extract(lease_json, '$.phase') NOT IN ('released', 'orphaned')",
  "AND json_extract(lease_json, '$.expiresAt') > ?",
].join(" ");

// Lease replay/CAS, lifecycle snapshots, and runtime-state reads.
export function replayClaim(
  db: DatabaseSync,
  event: Extract<TaskEventV1, { readonly type: "execution_started" }>,
): void {
  const lease = checkedLease(event.payload.lease, true);
  const reserving = { ...lease, phase: "reserving" as const };
  prepareQuery(db, UPSERT_LEASE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-017 */ db.prepare(sql),
  ).run(event.taskId, canonicalJson(reserving));
  prepareQuery(db, UPDATE_LEASE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-018 */ db.prepare(sql),
  ).run(canonicalJson({ ...lease, phase: "held" }), event.taskId);
  prepareQuery(db, INSERT_LEASE_INTERVAL_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-019 */ db.prepare(sql),
  ).run(
    event.taskId,
    lease.executionId,
    event.workspaceRevision,
    canonicalJson(holder(lease)),
    event.payload.previousHolder === null ? null : canonicalJson(event.payload.previousHolder),
    event.payload.leaseExpiresAt,
    event.payload.reason,
  );
}

export function replayRenew(db: DatabaseSync, event: Extract<TaskEventV1, { readonly type: "lease_renewed" }>): void {
  const current = storedLease(db, event.taskId),
    renewed = checkedLease(event.payload.lease, true);
  const matchesPrevious =
    current !== null &&
    current.phase === "held" &&
    current.executionId === renewed.executionId &&
    canonicalJson(current.actor) === canonicalJson(renewed.actor) &&
    canonicalJson(current.source) === canonicalJson(renewed.source) &&
    current.version + 1 === renewed.version;
  if (!matchesPrevious && canonicalJson(current) !== canonicalJson(renewed))
    throw new Error(`stale lease renewal event for task ${event.taskId}`);
  prepareQuery(db, UPSERT_LEASE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-020 */ db.prepare(sql),
  ).run(event.taskId, canonicalJson(renewed));
  prepareQuery(db, UPDATE_LEASE_EXPIRY_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-021 */ db.prepare(sql),
  ).run(renewed.expiresAt, event.taskId, renewed.executionId);
}

export function replayRelease(db: DatabaseSync, taskId: string, executionId: string, revision: number): void {
  const lease = storedLease(db, taskId);
  if (lease !== null && lease.executionId === executionId)
    prepareQuery(db, UPDATE_LEASE_SQL, (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-022 */ db.prepare(sql),
    ).run(
      canonicalJson({
        ...lease,
        phase: "released",
        version: lease.version + 1,
      }),
      taskId,
    );
  prepareQuery(db, UPDATE_LEASE_RELEASE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-023 */ db.prepare(sql),
  ).run(revision, taskId, executionId);
}

export function readSnapshot(db: DatabaseSync, taskId: string, now?: string): TaskLifecycleSnapshot {
  return readSnapshots(db, [taskId], now).get(taskId) ?? emptyTaskLifecycleSnapshot();
}

export function readSnapshotForTaskEventReduction(
  db: DatabaseSync,
  taskId: string,
  now?: string,
): TaskLifecycleSnapshot {
  return readSnapshotsForTaskEventReduction(db, [taskId], now).get(taskId) ?? emptyTaskLifecycleSnapshot();
}

export function readSnapshots(
  db: DatabaseSync,
  taskIds: readonly string[],
  now?: string,
  decisionRelationsOnly = false,
): ReadonlyMap<string, TaskLifecycleSnapshot> {
  return readSnapshotsInternal(db, taskIds, now, true, decisionRelationsOnly);
}

/** Event reduction folds historical states until a migration event restores the current Task contract. */
export function readSnapshotsForTaskEventReduction(
  db: DatabaseSync,
  taskIds: readonly string[],
  now?: string,
): ReadonlyMap<string, TaskLifecycleSnapshot> {
  return readSnapshotsInternal(db, taskIds, now, false);
}

function readSnapshotsInternal(
  db: DatabaseSync,
  taskIds: readonly string[],
  now: string | undefined,
  validateTask: boolean,
  decisionRelationsOnly = false,
): ReadonlyMap<string, TaskLifecycleSnapshot> {
  if (taskIds.length === 0) return new Map();
  const requested = JSON.stringify(taskIds),
    snapshotRows = queryPreparedRows<{ readonly task_id: string; readonly snapshot_json: string }>(
      prepareQuery(
        db,
        "SELECT task_id, snapshot_json FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?))",
        (sql) => /* @gate-identity check-bypass-write-boundary/bypass-write-024 */ db.prepare(sql),
      ),
      requested,
    ),
    snapshots = new Map<string, TaskLifecycleSnapshot>();
  for (const row of snapshotRows) {
    let snapshot: TaskLifecycleSnapshot;
    try {
      // A cache written before version 38's cleaner still carries the retired code/doc witness
      // field. Drop it here instead of forcing a replay: the field carries no authority, and the
      // replay needed to erase it does not survive attach at canonical scale.
      snapshot = withoutRetiredTaskSnapshotFields(
        JSON.parse(row.snapshot_json) as Record<string, unknown>,
      ) as TaskLifecycleSnapshot;
    } catch {
      throw new Error(`projection snapshot mismatch for task ${row.task_id}`);
    }
    if (validateTask && snapshot.task !== null && validateTaskV2(snapshot.task, true).length)
      throw new Error(`projection snapshot mismatch for task ${row.task_id}`);
    snapshots.set(row.task_id, snapshot);
  }
  const grouped = <Value>(rows: readonly { readonly task_id: string; readonly value_json: string }[]) => {
    const values = new Map<string, Value[]>();
    for (const row of rows) {
      const groupedValues = values.get(row.task_id) ?? [];
      groupedValues.push(JSON.parse(row.value_json) as Value);
      values.set(row.task_id, groupedValues);
    }
    return values;
  };
  const executions = grouped<TaskLifecycleSnapshot["executions"][number]>(
      queryRows(
        db,
        [
          "SELECT task_id, value_json FROM entity_projection WHERE entity_kind = 'execution'",
          "AND task_id IN (SELECT value FROM json_each(?))",
          "ORDER BY task_id, json_extract(value_json, '$.iteration'),",
          "json_extract(value_json, '$.claimedAt'), entity_id",
        ].join(" "),
        requested,
      ) as readonly { readonly task_id: string; readonly value_json: string }[],
    ),
    reviews = grouped<TaskLifecycleSnapshot["reviews"][number]>(
      queryRows(
        db,
        [
          "SELECT task_id, value_json FROM entity_projection WHERE entity_kind = 'review'",
          "AND task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, entity_id",
        ].join(" "),
        requested,
      ) as readonly { readonly task_id: string; readonly value_json: string }[],
    ),
    leases = new Map(
      queryRows<{ readonly task_id: string; readonly lease_json: string }>(
        db,
        "SELECT task_id, lease_json FROM lease_cas WHERE task_id IN (SELECT value FROM json_each(?))",
        requested,
      ).map((row) => [row.task_id, checkedLease(JSON.parse(row.lease_json) as LeaseV1, true)]),
    ),
    relationRows = decisionRelationsOnly
      ? readRelationProjectionRowsForTargets(
          db,
          taskIds.map((taskId) => `task/${taskId}`),
          { relationType: "derives", sourcePrefix: "decision/" },
        )
      : readRelationProjectionRowsForTargets(
          db,
          taskIds.map((taskId) => `task/${taskId}`),
        ),
    relations = new Map<string, ReturnType<typeof lifecycleRelation>[]>();
  for (const row of relationRows) {
    const values = relations.get(row.targetRef) ?? [];
    values.push(lifecycleRelation(row));
    relations.set(row.targetRef, values);
  }
  return new Map(
    taskIds.flatMap((taskId) => {
      const snapshot = snapshots.get(taskId);
      if (!snapshot) return [];
      const stored = leases.get(taskId) ?? null,
        lease = now === undefined ? stored : effectiveLeaseValue(stored, now);
      return [
        [
          taskId,
          {
            ...snapshot,
            executions: executions.get(taskId) ?? [],
            reviews: reviews.get(taskId) ?? [],
            lease: lease?.phase === "released" ? null : lease,
            decisionRelations: relations.get(`task/${taskId}`) ?? [],
          },
        ] as const,
      ];
    }),
  );
}

function lifecycleRelation({
  relationId,
  sourceRef,
  targetRef,
  relationType,
  state,
  strength,
  freshness,
}: ReturnType<typeof readRelationProjectionRows>[number]) {
  return { relationId, sourceRef, targetRef, relationType, state, strength, freshness };
}

export function effectiveLeaseValue(current: LeaseV1 | null, now: string): LeaseV1 | null {
  if (current === null || current.phase === "released") return current;
  if (current.expiresAt > now) return current;
  return current.phase === "reserving" ? null : checkedLease({ ...current, phase: "orphaned" }, true);
}

function leaseIntervalFromRow(row: ProjectionSqlRow): LeaseInterval {
  return {
    taskId: String(row.task_id),
    executionId: String(row.execution_id),
    acquiredRevision: Number(row.acquired_revision),
    releasedRevision: row.released_revision === null ? null : Number(row.released_revision),
    holder: JSON.parse(String(row.holder_json)) as LeaseHolder,
    previousHolder:
      row.previous_holder_json === null ? null : (JSON.parse(String(row.previous_holder_json)) as LeaseHolder),
    leaseExpiresAt: String(row.lease_expires_at),
    reason: String(row.reason) as LeaseChangeReason,
  };
}

export function readIntervals(db: DatabaseSync, taskId: string): readonly LeaseInterval[] {
  const rows = queryPreparedRows(
    prepareQuery(db, "SELECT * FROM lease_interval WHERE task_id = ? ORDER BY acquired_revision", (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-025 */ db.prepare(sql),
    ),
    taskId,
  );
  return rows.map(leaseIntervalFromRow);
}

/** Newest acquisition for one task: `lease_interval_task_acquisition` seeks it directly, so the
 * cost is one row regardless of how many times the task was re-entered. */
export function readLatestInterval(db: DatabaseSync, taskId: string): LeaseInterval | null {
  const row = queryRow(
    db,
    "SELECT * FROM lease_interval WHERE task_id = ? ORDER BY acquired_revision DESC LIMIT 1",
    taskId,
  );
  return row === undefined ? null : leaseIntervalFromRow(row);
}

/** Latest acquisition for one execution, independent of leases from every other task round. */
export function readLatestIntervalForExecution(
  db: DatabaseSync,
  taskId: string,
  executionId: string,
): LeaseInterval | null {
  const row = queryRow(
    db,
    "SELECT * FROM lease_interval WHERE task_id = ? AND execution_id = ? ORDER BY acquired_revision DESC LIMIT 1",
    taskId,
    executionId,
  );
  return row === undefined ? null : leaseIntervalFromRow(row);
}

export function reserve(db: DatabaseSync, lease: LeaseV1, now: string): LeaseV1 {
  const current = effectiveLease(db, lease.taskId, now),
    count = prepareQuery(db, COUNT_ACTIVE_LEASES_SQL, (sql) =>
      /* @gate-identity check-bypass-write-boundary/bypass-write-026 */ db.prepare(sql),
    ).get(now) as { readonly count: number };
  assertLeaseReservation(lease, current, count.count);
  prepareQuery(db, UPSERT_LEASE_SQL, (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-027 */ db.prepare(sql),
  ).run(lease.taskId, canonicalJson(lease));
  return lease;
}

export function assertLeaseReservation(lease: LeaseV1, current: LeaseV1 | null, activeCount: number): void {
  checkedLease(lease);
  if (current !== null && current.phase !== "orphaned" && current.phase !== "released")
    throw new Error(`lease conflict for task ${lease.taskId}`);
  if (activeCount >= TASK_LEASE_BROKER_CONTRACT.capacity)
    throw new Error(
      `lease capacity ${TASK_LEASE_BROKER_CONTRACT.capacity} exhausted; wait for a lease to be released or expire`,
    );
  const expectedVersion = current === null ? 0 : current.version + 1;
  if (lease.phase !== "reserving" || lease.version !== expectedVersion)
    throw new Error(`stale lease reservation for task ${lease.taskId}`);
}

export function changeLease(
  db: DatabaseSync,
  expected: LeaseV1,
  phase: "held" | "released",
  expiresAt: string,
  now: string,
): LeaseV1 {
  const next = changedLeaseAtCut(effectiveLease(db, expected.taskId, now), expected, phase, expiresAt);
  runSql(db, UPDATE_LEASE_SQL, canonicalJson(next), next.taskId);
  return next;
}

export function changedLeaseAtCut(
  current: LeaseV1 | null,
  expected: LeaseV1,
  phase: "held" | "released",
  expiresAt: string,
): LeaseV1 {
  const allowed =
    phase === "released" ? ["reserving", "held"] : expected.phase === "reserving" ? ["reserving"] : ["held"];
  if (
    current === null ||
    current.executionId !== expected.executionId ||
    canonicalJson(current.actor) !== canonicalJson(expected.actor) ||
    canonicalJson(current.source) !== canonicalJson(expected.source) ||
    current.version !== expected.version ||
    !allowed.includes(current.phase)
  )
    throw new Error(`stale lease CAS for task ${expected.taskId}`);
  return checkedLease({ ...current, phase, expiresAt, version: current.version + 1 });
}

export function effectiveLease(db: DatabaseSync, taskId: string, now: string): LeaseV1 | null {
  return effectiveLeaseValue(storedLease(db, taskId), now);
}

export function storedLease(db: DatabaseSync, taskId: string): LeaseV1 | null {
  const row = queryRows(db, "SELECT lease_json FROM lease_cas WHERE task_id = ?", taskId)[0];
  return row === undefined ? null : checkedLease(JSON.parse(String(row.lease_json)) as LeaseV1, true);
}
export function readRuntimeInstallation(db: DatabaseSync, installationId: string): RuntimeInstallation | null {
  const row = queryRows(db, "SELECT value_json FROM runtime_installation WHERE installation_id = ?", installationId)[0];
  return row ? (JSON.parse(String(row.value_json)) as RuntimeInstallation) : null;
}
export function readRuntimeInstallations(db: DatabaseSync): RuntimeInstallation[] {
  return queryRows(db, "SELECT value_json FROM runtime_installation ORDER BY installation_id").map(
    (row) => JSON.parse(String(row.value_json)) as RuntimeInstallation,
  );
}
export function readRuntimeSession(db: DatabaseSync, sessionId: string): RuntimeSession | null {
  const row = queryRows(db, "SELECT value_json FROM runtime_session WHERE runtime_session_id = ?", sessionId)[0];
  return row ? (JSON.parse(String(row.value_json)) as RuntimeSession) : null;
}
export function readRuntimeSessions(db: DatabaseSync, query?: RuntimeSessionReadQuery): RuntimeSession[] {
  if (query?.runtimeSessionId !== undefined) {
    const session = readRuntimeSession(db, query.runtimeSessionId);
    if (!session) return [];
    if (query.unsettledOnly && session.outcome !== null) return [];
    if (query.nonExitedOnly && session.liveness === "exited") return [];
    if (
      query.executionOwnerNodeId !== undefined &&
      runtimeSessionExecutionNode(db, session.runtimeSessionId) !== query.executionOwnerNodeId
    )
      return [];
    return [session];
  }
  const clauses: string[] = [],
    values: string[] = [];
  // runtime_session_unsettled_order covers the outcome filter and the recovery ORDER BY together,
  // so the read cannot fall back to scanning the repository's settled history.
  if (query?.unsettledOnly || query?.inFlightOnly) clauses.push("json_extract(value_json, '$.outcome') IS NULL");
  if (query?.nonExitedOnly) clauses.push("json_extract(value_json, '$.liveness') <> 'exited'");
  if (query?.providerSessionId !== undefined) {
    clauses.push("json_extract(value_json, '$.providerSessionId') = ?");
    values.push(query.providerSessionId);
  }
  // Edge recovery is scoped by the canonical dispatch source stored beside the session. The
  // node_unsettled index applies both predicates before any session row is visited.
  if (query?.executionOwnerNodeId !== undefined) {
    clauses.push("execution_node_id = ?");
    values.push(query.executionOwnerNodeId);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return queryRows(db, `SELECT value_json FROM runtime_session${where} ORDER BY runtime_session_id`, ...values).map(
    (row) => JSON.parse(String(row.value_json)) as RuntimeSession,
  );
}
function runtimeSessionExecutionNode(db: DatabaseSync, runtimeSessionId: string): string | null {
  const row = queryRows(
    db,
    "SELECT execution_node_id FROM runtime_session WHERE runtime_session_id = ?",
    runtimeSessionId,
  )[0];
  return row === undefined ? null : String(row.execution_node_id ?? "");
}
export function readRuntimeSessionsForTask(db: DatabaseSync, taskId: string): RuntimeSession[] {
  return queryRows(
    db,
    [
      "SELECT runtime_session.value_json FROM runtime_session_task_binding",
      "JOIN runtime_session USING(runtime_session_id) WHERE runtime_session_task_binding.task_id = ?",
      "GROUP BY runtime_session.runtime_session_id ORDER BY runtime_session.runtime_session_id",
    ].join(" "),
    taskId,
  ).map((row) => JSON.parse(String(row.value_json)) as RuntimeSession);
}
export function readRuntimeSessionPage(db: DatabaseSync, query: RuntimeSessionPageQuery): RuntimeSessionPageRead {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 64)
    throw new Error("runtime session page limit must be between 1 and 64");
  const after = query.afterRuntimeSessionId,
    taskId = query.taskId;
  const rows = taskId
    ? queryRows(
        db,
        [
          "SELECT runtime_session.value_json FROM runtime_session_task_binding",
          "JOIN runtime_session USING(runtime_session_id)",
          "WHERE runtime_session_task_binding.task_id = ?",
          ...(after === undefined ? [] : ["AND runtime_session_task_binding.runtime_session_id > ?"]),
          "GROUP BY runtime_session_task_binding.runtime_session_id ORDER BY runtime_session_task_binding.runtime_session_id LIMIT ?",
        ].join(" "),
        taskId,
        ...(after === undefined ? [] : [after]),
        query.limit + 1,
      )
    : queryRows(
        db,
        [
          "SELECT value_json FROM runtime_session",
          ...(after === undefined ? [] : ["WHERE runtime_session_id > ?"]),
          "ORDER BY runtime_session_id LIMIT ?",
        ].join(" "),
        ...(after === undefined ? [] : [after]),
        query.limit + 1,
      );
  const sessions = rows.slice(0, query.limit).map((row) => JSON.parse(String(row.value_json)) as RuntimeSession),
    lastId = sessions.at(-1)?.runtimeSessionId;
  if (lastId === undefined) return { rows: sessions, nextRuntimeSessionId: null, remainingCount: 0 };
  if (query.includeRemainingCount !== true) {
    const hasMore = rows.length > query.limit;
    return { rows: sessions, nextRuntimeSessionId: hasMore ? lastId : null, remainingCount: hasMore ? null : 0 };
  }
  const countRow = taskId
    ? queryRows(
        db,
        [
          "SELECT COUNT(DISTINCT runtime_session.runtime_session_id) AS count",
          "FROM runtime_session_task_binding JOIN runtime_session USING(runtime_session_id)",
          "WHERE runtime_session_task_binding.task_id = ? AND runtime_session.runtime_session_id > ?",
        ].join(" "),
        taskId,
        lastId,
      )[0]
    : queryRows(db, "SELECT COUNT(*) AS count FROM runtime_session WHERE runtime_session_id > ?", lastId)[0];
  const remainingCount = Number(countRow?.count ?? 0);
  return { rows: sessions, nextRuntimeSessionId: remainingCount > 0 ? lastId : null, remainingCount };
}
export function refreshRuntimeSessionAssociations(db: DatabaseSync, session: RuntimeSession): void {
  runSql(db, "DELETE FROM runtime_session_task_binding WHERE runtime_session_id = ?", session.runtimeSessionId);
  for (const binding of session.taskBindings)
    runSql(
      db,
      [
        "INSERT INTO runtime_session_task_binding(task_id, runtime_session_id, execution_id, bound_at)",
        "VALUES (?, ?, ?, ?)",
      ].join(" "),
      binding.taskId,
      session.runtimeSessionId,
      binding.executionId,
      binding.boundAt,
    );
}
function holder(lease: LeaseV1): LeaseHolder {
  return {
    taskId: lease.taskId,
    executionId: lease.executionId,
    actor: lease.actor,
    source: lease.source,
  };
}
function checkedLease(lease: LeaseV1, historical = false): LeaseV1 {
  const issues = validateLeaseV1(lease, historical);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
  return lease;
}
