// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import {
  changeLease,
  effectiveLease,
  readIntervals,
  readRuntimeInstallation,
  readRuntimeInstallations,
  readRuntimeSession,
  readRuntimeSessions,
  reserve,
} from "./rebuildable-task-projection-runtime.ts";
import { refreshStateDigestAtSourceCut, transaction } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

// Runtime-state and lease-control API.
export function runtimeLeaseApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "readRuntimeInstallation"
  | "readRuntimeInstallations"
  | "readRuntimeSession"
  | "readRuntimeSessions"
  | "readRuntimeSessionsForTask"
  | "readLeaseIntervals"
  | "currentLease"
  | "currentLeaseForExecution"
  | "reserveLease"
  | "activateLease"
  | "renewLease"
  | "releaseLease"
> {
  const { now, projectionPath, readHead } = context;
  return {
    readRuntimeInstallation: (installationId) =>
      withDatabase(projectionPath, readHead, (db) => readRuntimeInstallation(db, installationId)),
    readRuntimeInstallations: () => withDatabase(projectionPath, readHead, readRuntimeInstallations),
    readRuntimeSession: (runtimeSessionIdValue) =>
      withDatabase(projectionPath, readHead, (db) => readRuntimeSession(db, runtimeSessionIdValue)),
    readRuntimeSessions: () => withDatabase(projectionPath, readHead, readRuntimeSessions),
    readRuntimeSessionsForTask: (taskId) =>
      withDatabase(projectionPath, readHead, (db) =>
        readRuntimeSessions(db).filter((session) => session.taskBindings.some((binding) => binding.taskId === taskId)),
      ),
    readLeaseIntervals: (taskId) => withDatabase(projectionPath, readHead, (db) => readIntervals(db, taskId)),
    currentLease: (taskId, at) =>
      withDatabase(projectionPath, readHead, (db) => effectiveLease(db, taskId, at ?? now())),
    currentLeaseForExecution: (executionId, at) =>
      withDatabase(projectionPath, readHead, (db: DatabaseSync) => {
        const row =
          /* @gate-identity check-bypass-write-boundary/bypass-write-016 */
          db
          .prepare("SELECT task_id FROM lease_cas WHERE json_extract(lease_json, '$.executionId') = ?")
          .get(executionId) as { readonly task_id: string } | undefined;
        return row ? effectiveLease(db, row.task_id, at ?? now()) : null;
      }),
    reserveLease: (lease, now) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const reserved = reserve(db, lease, now);
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return reserved;
        }),
      ),
    activateLease: (lease) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const active = changeLease(db, lease, "held", lease.expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return active;
        }),
      ),
    renewLease: (lease, expiresAt) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const renewed = changeLease(db, lease, "held", expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return renewed;
        }),
      ),
    releaseLease: (lease) =>
      withDatabase(projectionPath, readHead, (db) =>
        transaction(db, () => {
          const released = changeLease(db, lease, "released", lease.expiresAt, now());
          refreshStateDigestAtSourceCut(db, readHead()?.revision ?? 0);
          return released;
        }),
      ),
  };
}
