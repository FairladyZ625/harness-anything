import type { TaskProjection } from "../../kernel/src/index.ts";
import type { FleetRoster } from "./fleet-center-admission.ts";
import { inspectScheduleProjection } from "./schedule-projection.ts";
import type { RepoInFlightWork } from "./repo-cell-types.ts";

export function readRepoInFlightWork(input: {
  readonly projection: Pick<TaskProjection, "list" | "listEntities" | "readRuntimeSessions">;
  readonly fleetRoster: FleetRoster | null;
  readonly repoId: string;
  readonly queueDepth: number;
}): readonly RepoInFlightWork[] {
  const runtime = input.projection.readRuntimeSessions().flatMap((session) => {
      if (session.liveness === "exited") return [];
      const binding = session.taskBindings.at(-1);
      return [
        {
          kind: "runtime-session" as const,
          id: session.runtimeSessionId,
          ...(binding ? { taskId: binding.taskId, executionId: binding.executionId } : {}),
          nextAction: `ha runtime status ${session.runtimeSessionId}`,
        },
      ];
    }),
    leases = input.projection.list().rows.flatMap((row) => {
      const lease = row.snapshot.lease;
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
    fleet = (input.fleetRoster?.assignments ?? []).flatMap((assignment) =>
      assignment.repoId !== input.repoId
        ? []
        : [
            {
              kind: "fleet-assignment" as const,
              id: assignment.assignmentId,
              assignmentId: assignment.assignmentId,
              nodeId: assignment.nodeId,
              nextAction: `Release fleet assignment ${assignment.assignmentId} before retrying.`,
            },
          ],
    ),
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
  return [...runtime, ...leases, ...publication, ...schedules, ...fleet].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}
