import { samePrincipal } from "@harness-anything/kernel";
import {
  dispatchPrerequisitesOf,
  isSameExecution,
  type ActorIdentity,
  type TaskProjection,
} from "@harness-anything/kernel";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";

/** Refuse task-bound dispatch while machine-readable prerequisites are unresolved. */
export function assertTaskDispatchPrerequisites(projection: TaskProjection, taskId: string): void {
  const taskRef = `task/${taskId}`,
    derives = projection.readTaskRelationsByTargets([taskRef], "derives"),
    dependencies = projection.readTaskDependencyClosure([taskRef]),
    dependencyIds = dependencies.rows.flatMap(({ sourceRef, targetRef }) =>
      [sourceRef, targetRef].flatMap((ref) => /^task\/([^/]+)$/u.exec(ref)?.[1] ?? []),
    ),
    statuses = projection.readTaskStatuses([taskId, ...dependencyIds]),
    decisionIds = derives.rows.flatMap(({ sourceRef }) => /^decision\/([^/]+)\/[^/]+$/u.exec(sourceRef)?.[1] ?? []),
    decisions = projection.readDecisions(decisionIds),
    snapshots = [...new Set([taskId, ...dependencyIds])].map((id) => projection.read(id)),
    reads = [derives, dependencies, statuses, decisions, ...snapshots],
    cuts = new Set(reads.map(({ watermark, sourceRevision }) => `${watermark}/${sourceRevision}`)),
    projectionReady = reads.every(({ status }) => status === "ready") && cuts.size === 1,
    statusById = new Map(statuses.rows.map((row) => [row.taskId, row.status] as const)),
    assessment = dispatchPrerequisitesOf(
      taskId,
      statuses.rows.flatMap((row) => (row.status === null ? [] : [{ taskId: row.taskId, status: row.status }])),
      [...derives.rows, ...dependencies.rows],
      decisions.decisions.map(({ decisionId, state }) => ({ decisionId, state })),
      projectionReady ? {} : { hardFailWarnings: ["dispatch prerequisite projection cut unavailable"] },
      snapshots.map(({ snapshot }) => snapshot),
    );
  if (assessment.state === "clear") return;
  const guidance = [
    ...assessment.proposedDecisionIds.map((id) => `ha decision accept ${id}`),
    ...assessment.unfinishedDependencyIds.map((id) => `${id} (${statusById.get(id) ?? "missing"})`),
    ...assessment.warnings,
  ];
  throw runtimeSpawnError(
    "task_dispatch_prerequisite_unmet",
    `Task ${taskId} has unresolved dispatch prerequisites: ${guidance.join("; ")}.`,
  );
}

/** The implementation dispatch may continue its holder or an explicitly trusted runtime handoff. */
export function taskDispatchLeaseQualifies(
  lease: ReturnType<TaskProjection["currentLease"]>,
  actor: ActorIdentity,
  runtimeSessionId: string,
  trustedHandoffSource: string | null,
  canHandoff: boolean,
): boolean {
  if (lease === null || lease.phase === "released" || lease.phase === "orphaned") return canHandoff;
  const leaseExecutorId = lease.actor.executor?.id ?? null,
    leaseHeldByRuntime = leaseExecutorId?.startsWith("runtime-session:") === true,
    dispatchLeaseExecutor = `runtime-session:${runtimeSessionId}`,
    trustedSourceExecutor = trustedHandoffSource ? `runtime-session:${trustedHandoffSource}` : null;
  return (
    lease.phase === "held" &&
    samePrincipal(lease.actor.principal, actor.principal) &&
    (isSameExecution(lease.actor, actor) ||
      leaseExecutorId === dispatchLeaseExecutor ||
      leaseExecutorId === trustedSourceExecutor ||
      (actor.executor === null && !leaseHeldByRuntime))
  );
}
