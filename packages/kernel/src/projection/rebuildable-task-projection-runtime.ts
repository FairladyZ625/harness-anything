// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import {
  emptyTaskLifecycleSnapshot,
  type LeaseChangeReason,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../domain/task-lifecycle.contract.ts";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseHolder, type LeaseV1 } from "../domain/execution.ts";
import { markRuntimeSessionUnknown, type RuntimeInstallation, type RuntimeSession } from "../domain/agent-runtime.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import type { LeaseInterval } from "./projection-reads.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

const UPSERT_LEASE_SQL = [
  "INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?)",
  "ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json",
].join(" ");
const INSERT_LEASE_INTERVAL_SQL = [
  "INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision,",
  "holder_json, previous_holder_json, lease_expires_at, reason)",
  "VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
].join(" ");
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
  const lease = checkedLease(event.payload.lease);
  const reserving = { ...lease, phase: "reserving" as const };
  db.prepare(UPSERT_LEASE_SQL).run(event.taskId, canonicalJson(reserving));
  db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(
    canonicalJson({ ...lease, phase: "held" }),
    event.taskId,
  );
  db.prepare(INSERT_LEASE_INTERVAL_SQL).run(
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
    renewed = checkedLease(event.payload.lease);
  const matchesPrevious =
    current !== null &&
    current.phase === "held" &&
    current.executionId === renewed.executionId &&
    canonicalJson(current.actor) === canonicalJson(renewed.actor) &&
    canonicalJson(current.source) === canonicalJson(renewed.source) &&
    current.version + 1 === renewed.version;
  if (!matchesPrevious && canonicalJson(current) !== canonicalJson(renewed))
    throw new Error(`stale lease renewal event for task ${event.taskId}`);
  db.prepare(UPSERT_LEASE_SQL).run(event.taskId, canonicalJson(renewed));
  db.prepare(UPDATE_LEASE_EXPIRY_SQL).run(renewed.expiresAt, event.taskId, renewed.executionId);
}

export function replayRelease(db: DatabaseSync, taskId: string, executionId: string, revision: number): void {
  const lease = storedLease(db, taskId);
  if (lease !== null && lease.executionId === executionId)
    db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(
      canonicalJson({
        ...lease,
        phase: "released",
        version: lease.version + 1,
      }),
      taskId,
    );
  db.prepare(UPDATE_LEASE_RELEASE_SQL).run(revision, taskId, executionId);
}

export function readSnapshot(db: DatabaseSync, taskId: string, now?: string): TaskLifecycleSnapshot {
  const row = db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as
    | { readonly snapshot_json: string }
    | undefined;
  if (row === undefined) return emptyTaskLifecycleSnapshot();
  let snapshot: TaskLifecycleSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot;
  } catch {
    throw new Error(`projection snapshot mismatch for task ${taskId}`);
  }
  const lease = now === undefined ? storedLease(db, taskId) : effectiveLease(db, taskId, now);
  // The stored snapshot is pure task-aggregate state; the decision relations this task is a
  // target of are stamped at read time as-of the applied cut, the same join the live lease uses.
  const decisionRelations = (
    queryRows(db, "SELECT row_json FROM relation_edge WHERE target_ref = ?", `task/${taskId}`) as readonly {
      readonly row_json: string;
    }[]
  ).map((edge) => {
    const parsed = JSON.parse(edge.row_json) as {
      readonly relationId: string;
      readonly sourceRef: string;
      readonly targetRef: string;
      readonly relationType: string;
      readonly state: string;
    };
    return {
      relationId: parsed.relationId,
      sourceRef: parsed.sourceRef,
      targetRef: parsed.targetRef,
      relationType: parsed.relationType,
      state: parsed.state,
    };
  });
  return {
    ...snapshot,
    lease: lease?.phase === "released" ? null : lease,
    decisionRelations,
  };
}

export function readIntervals(db: DatabaseSync, taskId: string): readonly LeaseInterval[] {
  const rows = db
    .prepare("SELECT * FROM lease_interval WHERE task_id = ? ORDER BY acquired_revision")
    .all(taskId) as unknown as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    taskId: String(row.task_id),
    executionId: String(row.execution_id),
    acquiredRevision: Number(row.acquired_revision),
    releasedRevision: row.released_revision === null ? null : Number(row.released_revision),
    holder: JSON.parse(String(row.holder_json)) as LeaseHolder,
    previousHolder:
      row.previous_holder_json === null ? null : (JSON.parse(String(row.previous_holder_json)) as LeaseHolder),
    leaseExpiresAt: String(row.lease_expires_at),
    reason: String(row.reason) as LeaseChangeReason,
  }));
}

export function reserve(db: DatabaseSync, lease: LeaseV1, now: string): LeaseV1 {
  checkedLease(lease);
  const current = effectiveLease(db, lease.taskId, now);
  if (current !== null && current.phase !== "orphaned" && current.phase !== "released")
    throw new Error(`lease conflict for task ${lease.taskId}`);
  const count = db.prepare(COUNT_ACTIVE_LEASES_SQL).get(now) as { readonly count: number };
  if (count.count >= TASK_LEASE_BROKER_CONTRACT.capacity)
    throw new Error(
      `lease capacity ${TASK_LEASE_BROKER_CONTRACT.capacity} exhausted; wait for a lease to be released or expire`,
    );
  const expectedVersion = current === null ? 0 : current.version + 1;
  if (lease.phase !== "reserving" || lease.version !== expectedVersion)
    throw new Error(`stale lease reservation for task ${lease.taskId}`);
  db.prepare(UPSERT_LEASE_SQL).run(lease.taskId, canonicalJson(lease));
  return lease;
}

export function changeLease(
  db: DatabaseSync,
  expected: LeaseV1,
  phase: "held" | "released",
  expiresAt: string,
  now: string,
): LeaseV1 {
  const current = effectiveLease(db, expected.taskId, now);
  const allowed =
    phase === "released" ? ["reserving", "held"] : expected.phase === "reserving" ? ["reserving"] : ["held"];
  if (
    current === null ||
    current.executionId !== expected.executionId ||
    canonicalJson(current.actor) !== canonicalJson(expected.actor) ||
    canonicalJson(current.source) !== canonicalJson(expected.source) ||
    current.version !== expected.version ||
    !allowed.includes(current.phase)
  ) {
    throw new Error(`stale lease CAS for task ${expected.taskId}`);
  }
  const next = checkedLease({
    ...current,
    phase,
    expiresAt,
    version: current.version + 1,
  });
  runSql(db, "UPDATE lease_cas SET lease_json = ? WHERE task_id = ?", canonicalJson(next), next.taskId);
  return next;
}

export function effectiveLease(db: DatabaseSync, taskId: string, now: string): LeaseV1 | null {
  const current = storedLease(db, taskId);
  if (current === null || current.phase === "released") return current;
  if (current.expiresAt > now) return current;
  return current.phase === "reserving" ? null : checkedLease({ ...current, phase: "orphaned" });
}

export function storedLease(db: DatabaseSync, taskId: string): LeaseV1 | null {
  const row = queryRows(db, "SELECT lease_json FROM lease_cas WHERE task_id = ?", taskId)[0];
  return row === undefined ? null : checkedLease(JSON.parse(String(row.lease_json)) as LeaseV1);
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
export function readRuntimeSessions(db: DatabaseSync): RuntimeSession[] {
  return queryRows(db, "SELECT value_json FROM runtime_session ORDER BY runtime_session_id").map(
    (row) => JSON.parse(String(row.value_json)) as RuntimeSession,
  );
}
export function markRuntimeSessionsUnknown(db: DatabaseSync): number {
  const rows = queryRows(db, "SELECT runtime_session_id, value_json FROM runtime_session");
  let changed = 0;
  for (const row of rows) {
    const current = JSON.parse(String(row.value_json)) as RuntimeSession,
      next = markRuntimeSessionUnknown(current);
    if (next !== current) {
      runSql(
        db,
        "UPDATE runtime_session SET value_json = ? WHERE runtime_session_id = ?",
        canonicalJson(next),
        String(row.runtime_session_id),
      );
      changed += 1;
    }
  }
  return changed;
}
function holder(lease: LeaseV1): LeaseHolder {
  return {
    taskId: lease.taskId,
    executionId: lease.executionId,
    actor: lease.actor,
    source: lease.source,
  };
}
function checkedLease(lease: LeaseV1): LeaseV1 {
  const issues = validateLeaseV1(lease);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
  return lease;
}
