import type { TaskProjection } from "@harness-anything/kernel";
import { readActiveDispatchLifecycleSync } from "./runtime-dispatch-admission.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { inspectScheduleProjection } from "./schedule-projection.ts";
import type { RepoInFlightWork } from "./repo-cell-types.ts";

export function readRepoInFlightWork(input: {
  readonly projection: Pick<TaskProjection, "read" | "readTaskIndex" | "listEntities" | "readDispatchLifecycle">;
  readonly repoId: string;
  readonly queueDepth: number;
}): readonly RepoInFlightWork[] {
  const runtime = readActiveDispatchLifecycleSync(
      (query) => input.projection.readDispatchLifecycle(query),
      runtimeSpawnError,
    )
      .filter(({ policy }) => policy.capacity !== "released")
      .map(({ attempt }) => ({
        kind: "runtime-session" as const,
        id: attempt.runtimeSessionId,
        ...(attempt.task
          ? {
              taskId: attempt.task.taskId,
              ...(attempt.task.executionId ? { executionId: attempt.task.executionId } : {}),
            }
          : {}),
        nextAction: `ha runtime status ${attempt.runtimeSessionId}`,
      })),
    leases = input.projection.readTaskIndex({ leaseOnly: true, presentationStatus: false }).rows.flatMap((row) => {
      // The scalar index finds live leases without hydrating unrelated snapshots. Each
      // selected id is then a bounded point read for the lease payload itself.
      const lease = input.projection.read(row.taskId, false, false).snapshot.lease;
      if (!lease || lease.phase === "released") return [];
      const executor = lease.actor.executor,
        holder = executor ? `${executor.kind}:${executor.id}` : lease.actor.principal.personId;
      return [
        {
          kind: "task-lease" as const,
          id: `${row.taskId}:${lease.executionId}`,
          taskId: row.taskId,
          executionId: lease.executionId,
          phase: lease.phase,
          holder,
          nextAction: `ha task release ${row.taskId}`,
        },
      ];
    }),
    schedules = input.projection.listEntities("schedule").flatMap((row) => {
      const inspected = inspectScheduleProjection(row);
      if (!inspected.valid || !inspected.schedule.status.activeRun) return [];
      const active = inspected.schedule.status.activeRun;
      return [
        {
          kind: "schedule-occurrence" as const,
          id: active.occurrenceId,
          scheduleId: inspected.schedule.scheduleId,
          ...(active.runtimeSessionId ? { runtimeSessionId: active.runtimeSessionId } : {}),
          nextAction: active.runtimeSessionId
            ? `ha runtime status ${active.runtimeSessionId}`
            : `ha schedule runs ${inspected.schedule.scheduleId}`,
        },
      ];
    }),
    publication =
      input.queueDepth === 0
        ? []
        : [
            {
              kind: "publication" as const,
              id: `queue:${input.repoId}`,
              queueDepth: input.queueDepth,
              nextAction: "Wait for the daemon publication queue to drain, then retry.",
            },
          ];
  return [...runtime, ...leases, ...publication, ...schedules].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}
