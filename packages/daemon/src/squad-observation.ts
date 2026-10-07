import type { SquadRunObservation } from "@harness-anything/kernel";
import type { SquadState } from "./squad-run-state.ts";

/** Explicit field selection: local control state is never a repository read model. */
export function squadRunObservation(state: SquadState): SquadRunObservation {
  if (!state.stateDispatchId) throw new Error("Squad observation requires its initial dispatch.");
  return {
    squadRunId: state.squadRunId,
    squadId: state.squadId,
    taskId: state.taskId,
    executionId: state.executionId,
    mission: state.mission,
    leaderAgentId: state.leaderAgentId,
    ownerDispatchId: state.stateDispatchId,
    runRevision: state.revision,
    phase: state.phase,
    error: state.error,
    currentLeaderRuntimeSessionId: state.currentLeaderRuntimeSessionId,
    leaderTurns: state.leaderTurns.map((turn) => ({
      turnId: turn.turnId,
      trigger: turn.trigger,
      dispatchId: turn.dispatchId,
      runtimeSessionId: turn.runtimeSessionId,
      decision:
        turn.decision === null
          ? null
          : turn.decision.kind === "converged"
            ? { kind: "converged" }
            : { kind: "plan", dispatchCount: turn.decision.kind === "plan" ? turn.decision.dispatches.length : 0 },
    })),
    workerAttempts: state.workerAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      workerId: attempt.workerId,
      leaderTurnId: attempt.leaderTurnId,
      taskId: attempt.taskId ?? null,
      executionId: attempt.executionId ?? null,
      dispatchId: attempt.dispatchId,
      runtimeSessionId: attempt.runtimeSessionId,
      rejection: attempt.rejection,
      branch: attempt.worktree?.branch ?? null,
      baseSha: attempt.worktree?.baseSha ?? null,
    })),
    workerCallbackCount: state.observedWorkerRuntimeSessionIds.length,
    pendingLeaderCallbackCount: state.pendingLeaderTriggers.length + state.workerWaits.length,
    synthesisReportPath: state.phase === "converged" ? `artifacts/reports/${state.squadRunId}.md` : null,
  };
}
