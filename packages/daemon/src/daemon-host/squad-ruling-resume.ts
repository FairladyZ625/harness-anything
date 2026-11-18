import type { SquadRunProjectionRow } from "@harness-anything/kernel";

/**
 * The next command for a ruling a Squad leader raised. The leader turn is the run's parent edge, so
 * the run that must be restarted after the owner answers is the one whose `leaderTurns` name this
 * dispatch — never a task-level guess. A direct worker dispatch has no such run and keeps the
 * task-level next step alone.
 */
export function squadRulingResumeNext(input: {
  readonly runs: readonly SquadRunProjectionRow[];
  readonly dispatchId: string;
  readonly runtimeInstanceId: string | null;
}): { readonly command: string; readonly reason: string } | null {
  for (const { state } of input.runs) {
    const run = state as {
      readonly squadId?: unknown;
      readonly squadRunId?: unknown;
      readonly phase?: unknown;
      readonly subject?: { readonly kind?: unknown; readonly taskId?: unknown };
      readonly leaderTurns?: readonly { readonly dispatchId?: unknown }[];
    };
    if (
      typeof run.squadId !== "string" ||
      typeof run.squadRunId !== "string" ||
      run.phase === "converged" ||
      run.subject?.kind !== "task" ||
      typeof run.subject.taskId !== "string" ||
      !Array.isArray(run.leaderTurns) ||
      !run.leaderTurns.some((turn) => turn.dispatchId === input.dispatchId)
    )
      continue;
    return {
      command:
        `ha squad run ${run.squadId} --instance ${input.runtimeInstanceId ?? "<runtime-instance-id>"} ` +
        `--task ${run.subject.taskId}`,
      reason:
        `restart Squad run ${run.squadRunId}: its leader stopped for this ruling, and an answered task ` +
        "needs a new run under its next execution",
    };
  }
  return null;
}
