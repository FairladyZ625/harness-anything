// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import {
  DispatchLifecycleError,
  emptyDispatchLifecycleProjection,
  readDispatchLifecycle,
  reduceDispatchLifecycle,
  type DispatchLifecycleEvent,
  type DispatchLifecycleGroup,
  type DispatchLifecycleProjection,
  type DispatchLifecycleQuery,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import type { DispatchLifecycleRead } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

export const DISPATCH_LIFECYCLE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS dispatch_lifecycle_group (
    attempt_group_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    current_dispatch_id TEXT NOT NULL,
    group_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dispatch_lifecycle_active_page
    ON dispatch_lifecycle_group(attempt_group_id) WHERE phase <> 'closed';
  CREATE INDEX IF NOT EXISTS dispatch_lifecycle_active_instance_page
    ON dispatch_lifecycle_group(json_extract(group_json, '$.attempts[#-1].instanceId'), attempt_group_id)
    WHERE phase <> 'closed';
  CREATE TABLE IF NOT EXISTS dispatch_lifecycle_attempt (
    dispatch_id TEXT PRIMARY KEY,
    runtime_session_id TEXT NOT NULL UNIQUE,
    attempt_group_id TEXT NOT NULL,
    attempt_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dispatch_lifecycle_attempt_group
    ON dispatch_lifecycle_attempt(attempt_group_id, dispatch_id);
  CREATE TABLE IF NOT EXISTS dispatch_lifecycle_reservation (
    instance_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL UNIQUE,
    attempt_group_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    PRIMARY KEY(instance_id, reservation_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS dispatch_lifecycle_reservation_group
    ON dispatch_lifecycle_reservation(attempt_group_id, dispatch_id);
  CREATE TABLE IF NOT EXISTS dispatch_lifecycle_event (
    event_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
  );`;

export function projectDispatchLifecycleEvent(db: DatabaseSync, event: DispatchLifecycleEvent): void {
  const fingerprint = stableStringify(event),
    prior = queryRows<{ fingerprint: string }>(
      db,
      "SELECT fingerprint FROM dispatch_lifecycle_event WHERE event_id = ?",
      event.eventId,
    )[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new DispatchLifecycleError("duplicate_event_conflict", `event ${event.eventId} changed after acceptance`);
    return;
  }
  const row = queryRows<{ group_json: string }>(
      db,
      "SELECT group_json FROM dispatch_lifecycle_group WHERE attempt_group_id = ?",
      event.attemptGroupId,
    )[0],
    previous = row ? (JSON.parse(row.group_json) as DispatchLifecycleGroup) : null,
    candidateInstance = event.type === "dispatch_admitted" ? event.instanceId : null,
    reservationRows = candidateInstance
      ? queryRows<{ reservation_id: string; attempt_group_id: string }>(
          db,
          "SELECT reservation_id, attempt_group_id FROM dispatch_lifecycle_reservation WHERE instance_id = ?",
          candidateInstance,
        )
      : [],
    projection = reducerProjection(previous, reservationRows, candidateInstance),
    receipt = reduceDispatchLifecycle(projection, event, event.expectedGroupVersion + 1);
  if (!receipt.accepted) return;
  const group = receipt.group;
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_event(event_id, fingerprint) VALUES (?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
    event.eventId,
    fingerprint,
  );
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_group(attempt_group_id, repo_id, phase, current_dispatch_id, group_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attempt_group_id) DO UPDATE SET repo_id=excluded.repo_id, phase=excluded.phase,
       current_dispatch_id=excluded.current_dispatch_id, group_json=excluded.group_json`,
    group.attemptGroupId,
    group.repoId,
    group.phase,
    group.currentDispatchId,
    JSON.stringify(group),
  );
  for (const attempt of group.attempts) {
    runSql(
      db,
      `INSERT INTO dispatch_lifecycle_attempt(dispatch_id, runtime_session_id, attempt_group_id, attempt_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET runtime_session_id=excluded.runtime_session_id,
         attempt_group_id=excluded.attempt_group_id, attempt_json=excluded.attempt_json`,
      attempt.dispatchId,
      attempt.runtimeSessionId,
      group.attemptGroupId,
      JSON.stringify(attempt),
    );
    if (attempt.capacity === "released")
      runSql(db, "DELETE FROM dispatch_lifecycle_reservation WHERE reservation_id = ?", attempt.reservationId);
    else
      runSql(
        db,
        `INSERT INTO dispatch_lifecycle_reservation(instance_id, reservation_id, attempt_group_id, dispatch_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(reservation_id) DO UPDATE SET instance_id=excluded.instance_id,
           attempt_group_id=excluded.attempt_group_id, dispatch_id=excluded.dispatch_id`,
        attempt.instanceId,
        attempt.reservationId,
        group.attemptGroupId,
        attempt.dispatchId,
      );
  }
}

export function readDispatchLifecycleProjection(
  db: DatabaseSync,
  query: DispatchLifecycleQuery,
  watermark: number,
  sourceRevision: number,
): DispatchLifecycleRead {
  const groups = queryGroups(db, query),
    projection = projectionForGroups(groups);
  return readDispatchLifecycle({ ...projection, watermark, sourceRevision }, query);
}

function queryGroups(db: DatabaseSync, query: DispatchLifecycleQuery): readonly DispatchLifecycleGroup[] {
  if (query.by === "group") {
    const row = queryRows<{ group_json: string }>(
      db,
      "SELECT group_json FROM dispatch_lifecycle_group WHERE attempt_group_id = ?",
      query.attemptGroupId,
    )[0];
    return row ? [JSON.parse(row.group_json) as DispatchLifecycleGroup] : [];
  }
  if (query.by === "dispatch" || query.by === "session") {
    const values = query.by === "dispatch" ? query.dispatchIds : [query.runtimeSessionId];
    if (values.length === 0) return [];
    const column = query.by === "dispatch" ? "dispatch_id" : "runtime_session_id",
      placeholders = values.map(() => "?").join(","),
      rows = queryRows<{ group_json: string }>(
        db,
        `SELECT DISTINCT g.group_json FROM dispatch_lifecycle_attempt a
         JOIN dispatch_lifecycle_group g USING(attempt_group_id) WHERE a.${column} IN (${placeholders})`,
        ...values,
      );
    return rows.map(({ group_json }) => JSON.parse(group_json) as DispatchLifecycleGroup);
  }
  const clauses = ["phase <> 'closed'"],
    parameters: (string | number)[] = [];
  if (query.instanceId !== undefined) {
    clauses.push("json_extract(group_json, '$.attempts[#-1].instanceId') = ?");
    parameters.push(query.instanceId);
  }
  if (query.afterGroupId !== undefined) {
    clauses.push("attempt_group_id > ?");
    parameters.push(query.afterGroupId);
  }
  parameters.push(query.limit + 1);
  return queryRows<{ group_json: string }>(
    db,
    `SELECT group_json FROM dispatch_lifecycle_group WHERE ${clauses.join(" AND ")}
     ORDER BY attempt_group_id LIMIT ?`,
    ...parameters,
  ).map(({ group_json }) => JSON.parse(group_json) as DispatchLifecycleGroup);
}

function projectionForGroups(groups: readonly DispatchLifecycleGroup[]): DispatchLifecycleProjection {
  const byId = Object.fromEntries(groups.map((group) => [group.attemptGroupId, group])),
    projection = emptyDispatchLifecycleProjection(),
    groupByDispatchId: Record<string, string> = {},
    groupBySessionId: Record<string, string> = {},
    reservations: Record<string, string[]> = {};
  for (const group of groups)
    for (const attempt of group.attempts) {
      groupByDispatchId[attempt.dispatchId] = group.attemptGroupId;
      groupBySessionId[attempt.runtimeSessionId] = group.attemptGroupId;
      if (attempt.capacity !== "released") (reservations[attempt.instanceId] ??= []).push(attempt.reservationId);
    }
  return {
    ...projection,
    groups: byId,
    groupByDispatchId,
    groupBySessionId,
    activeGroupIds: groups.filter(({ phase }) => phase !== "closed").map(({ attemptGroupId }) => attemptGroupId),
    activeReservationsByInstance: reservations,
  };
}

function reducerProjection(
  previous: DispatchLifecycleGroup | null,
  reservationRows: readonly { readonly reservation_id: string; readonly attempt_group_id: string }[],
  candidateInstance: string | null,
): DispatchLifecycleProjection {
  const activeReservationsByInstance: Record<string, string[]> = {};
  if (candidateInstance)
    activeReservationsByInstance[candidateInstance] = reservationRows.map(({ reservation_id }) => reservation_id);
  if (previous)
    for (const attempt of previous.attempts)
      if (attempt.capacity !== "released") {
        const values = activeReservationsByInstance[attempt.instanceId] ?? [];
        if (!values.includes(attempt.reservationId)) values.push(attempt.reservationId);
        activeReservationsByInstance[attempt.instanceId] = values;
      }
  if (previous === null) {
    return {
      ...emptyDispatchLifecycleProjection(),
      activeReservationsByInstance,
    };
  }
  return { ...projectionForGroups([previous]), activeReservationsByInstance };
}
