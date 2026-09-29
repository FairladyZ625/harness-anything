import { isTerminalStatus, type TaskV2 } from "@harness-anything/kernel";
import { readDispatchStreamSummaries } from "./dispatch-stream.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { LeaderTrigger, LeaderTurn, WorkerAttempt, WorkerWaitTrigger } from "./squad-leader-decision.ts";
import type { SquadRunPhase } from "./squad-run-contract.ts";

/** The durable shape a Squad run's state takes inside its dispatch stream; the coordinator revises it as the run goes. */
export type SquadState = {
  readonly schema: "squad-run/v1";
  readonly squadRunId: string;
  readonly stateDispatchId: string | null;
  readonly squadId: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly cwd: string;
  readonly baseSha: string | null;
  readonly mission: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode?: string | null;
  readonly leaderAgentId: string;
  readonly roster: string;
  readonly workers: readonly string[];
  readonly leaderTurnBudget: number;
  readonly binding: RuntimeBinding;
  readonly leaderTurns: readonly LeaderTurn[];
  readonly leaderProviderSessionId: string | null;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly workerAttempts: readonly WorkerAttempt[];
  readonly observedWorkerRuntimeSessionIds: readonly string[];
  readonly workerWaits: readonly WorkerWaitTrigger[];
  readonly pendingLeaderTriggers: readonly LeaderTrigger[];
  readonly phase: SquadRunPhase;
  readonly revision: number;
  readonly error: string | null;
};

/** The phases a run stops moving in; everything else still has work in flight. */
export function terminal(state: SquadState): boolean {
  return state.phase === "cancelled" || state.phase === "converged" || state.phase === "failed";
}

export function validSquadRunId(value: unknown): value is string {
  return typeof value === "string" && /^squad_[a-f0-9]{24}$/u.test(value);
}

export function squadState(value: unknown): SquadState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SquadState>;
  return row.schema === "squad-run/v1" &&
    typeof row.squadRunId === "string" &&
    (row.baseSha === undefined || row.baseSha === null || typeof row.baseSha === "string") &&
    validSquadRunId(row.squadRunId) &&
    typeof row.stateDispatchId === "string" &&
    Array.isArray(row.leaderTurns) &&
    Array.isArray(row.workerAttempts) &&
    Array.isArray(row.observedWorkerRuntimeSessionIds) &&
    Array.isArray(row.workerWaits) &&
    Array.isArray(row.pendingLeaderTriggers) &&
    Number.isSafeInteger(row.leaderTurnBudget) &&
    Number(row.leaderTurnBudget) >= 1 &&
    typeof row.revision === "number"
    ? ({ ...value, baseSha: row.baseSha ?? null } as SquadState)
    : null;
}

/** The dispatch streams are the squad runs' ledger: the latest state per run, cancellation records applied on top. */
export function latestSquadStates(rootDir: string): ReadonlyMap<string, SquadState> {
  const states = new Map<string, SquadState>();
  for (const stream of readDispatchStreamSummaries(rootDir)) {
    for (const record of stream.records) {
      if (record.kind === "squad_run_cancelled") {
        const squadRunId = record.squadRunId,
          revision = record.revision;
        if (typeof squadRunId !== "string" || !Number.isSafeInteger(revision)) continue;
        const current = states.get(squadRunId);
        if (current && current.revision < Number(revision))
          states.set(squadRunId, {
            ...current,
            currentLeaderRuntimeSessionId: null,
            workerWaits: [],
            pendingLeaderTriggers: [],
            phase: "cancelled",
            revision: Number(revision),
            error: null,
          });
        continue;
      }
      if (record.kind !== "squad_run_state") continue;
      const state = squadState(record.state);
      if (!state) continue;
      const current = states.get(state.squadRunId);
      if (!current || current.revision < state.revision) states.set(state.squadRunId, state);
    }
  }
  return states;
}

/** A child task a rejected attempt left behind, with the run's binding — the authority that created it. */
export interface RejectedSquadChild {
  readonly squadRunId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly rejection: string;
  readonly binding: RuntimeBinding;
}

/**
 * Child tasks an ended Squad run will never run: an attempt the coordinator rejected after creating its task, before
 * any dispatch landed (no runtime session). The worktree reconciliation cancels them, so they do not sit in planned
 * or active forever. Attempts of runs that are still going stay out — their leader is still working through triggers.
 */
export function rejectedSquadAttemptChildren(rootDir: string): readonly RejectedSquadChild[] {
  const byTask = new Map<string, RejectedSquadChild>();
  for (const state of latestSquadStates(rootDir).values()) {
    if (!terminal(state)) continue;
    for (const attempt of state.workerAttempts) {
      if (attempt.rejection === null || attempt.taskId === null || attempt.runtimeSessionId !== null) continue;
      byTask.set(attempt.taskId, {
        squadRunId: state.squadRunId,
        taskId: attempt.taskId,
        workerId: attempt.workerId,
        rejection: attempt.rejection,
        binding: state.binding,
      });
    }
  }
  return [...byTask.values()];
}

/** How a caller with the cell's write surface cancels one orphan: the action to apply, with its run's own binding. */
export interface SquadOrphanCancellation {
  readonly rootDir: string;
  readonly readTask: (taskId: string) => TaskV2 | null | undefined;
  readonly cancel: (
    action: RepoTaskAction,
    binding: RuntimeBinding,
    actionId: string,
  ) => { readonly outcome: string; readonly code?: string };
}

/**
 * Cancels the children rejected Squad attempts left unfinished, each with the binding of the run that created it. A
 * rejection here is reported and retried by the next reconciliation (every daemon start), never thrown: the pass runs
 * unattended at attach, and one child's failure must not strand the rest or the worktree sweep behind it.
 */
export async function cancelRejectedSquadChildren(input: SquadOrphanCancellation): Promise<void> {
  for (const child of rejectedSquadAttemptChildren(input.rootDir)) {
    const task = input.readTask(child.taskId);
    if (!task || isTerminalStatus(task.status)) continue;
    const action: RepoTaskAction = {
      kind: "task-transition",
      taskId: child.taskId,
      status: "cancelled",
      reason: `Squad run ${child.squadRunId} ended; worker ${child.workerId} was rejected before dispatch.`,
    };
    const receipt = input.cancel(action, child.binding, `squad-rejected-child:${child.taskId}`);
    if (receipt.outcome !== "applied")
      console.warn(
        `[task-worktree] cancelling rejected Squad child ${child.taskId} was ${receipt.outcome}` +
          `${receipt.code ? ` (${receipt.code})` : ""}; retrying on the next reconciliation.`,
      );
  }
}
