import {
  isTerminalStatus,
  validSquadRunSubject,
  type SquadRunProjectionRow,
  type SquadRunSubjectV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import type { SquadRunPhase } from "./squad-run-types.ts";

export interface SquadScheduleRuntimeLike {
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly claimFence: string;
  readonly mode: "detect" | "remediate";
  readonly worktree?: {
    readonly cwd: string;
    readonly branch: string;
    readonly baseRef: string;
  };
}

export interface SquadWorkerAttemptLike {
  readonly workerId: string;
  readonly taskId?: string | null;
  readonly runtimeSessionId: string | null;
  readonly rejection: string | null;
}

export interface SquadStateLike<Binding = unknown> {
  readonly schema: "squad-run/v1";
  readonly squadRunId: string;
  readonly stateDispatchId: string | null;
  readonly squadId: string;
  readonly subject: SquadRunSubjectV1;
  readonly scheduleRuntime: SquadScheduleRuntimeLike | null;
  readonly baseSha: string | null;
  readonly publicMission: string;
  readonly leaderTurnBudget: number;
  readonly binding: Binding;
  readonly leaderTurns: readonly unknown[];
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly workerAttempts: readonly SquadWorkerAttemptLike[];
  readonly observedWorkerRuntimeSessionIds: readonly string[];
  readonly workerWaits: readonly unknown[];
  readonly pendingLeaderTriggers: readonly unknown[];
  readonly phase: SquadRunPhase;
  readonly revision: number;
  readonly error: string | null;
}

/** The task execution this run was admitted under; null when the run rides a Schedule occurrence claim. */
export function squadTaskRef(
  state: Pick<SquadStateLike, "subject">,
): { readonly taskId: string; readonly executionId: string } | null {
  return state.subject.kind === "task"
    ? { taskId: state.subject.taskId, executionId: state.subject.executionId }
    : null;
}

/** The schedule-occurrence subject this run rides; null on task-subject runs. */
export function squadScheduleSubject(
  state: Pick<SquadStateLike, "subject">,
): Extract<SquadRunSubjectV1, { readonly kind: "schedule-occurrence" }> | null {
  return state.subject.kind === "schedule-occurrence" ? state.subject : null;
}

/** The phases a run stops moving in; everything else still has work in flight. */
export function terminal(state: Pick<SquadStateLike, "phase">): boolean {
  return state.phase === "cancelled" || state.phase === "converged" || state.phase === "failed";
}

export function validSquadRunId(value: unknown): value is string {
  return typeof value === "string" && /^squad_[a-f0-9]{24}$/u.test(value);
}

export function squadState<State extends SquadStateLike = SquadStateLike>(value: unknown): State | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SquadStateLike>;
  return row.schema === "squad-run/v1" &&
    typeof row.squadRunId === "string" &&
    (row.baseSha === undefined || row.baseSha === null || typeof row.baseSha === "string") &&
    validSquadRunId(row.squadRunId) &&
    validSquadRunSubject(row.subject) &&
    (row.scheduleRuntime === undefined || row.scheduleRuntime === null || validScheduleRuntime(row.scheduleRuntime)) &&
    typeof row.stateDispatchId === "string" &&
    typeof row.publicMission === "string" &&
    Array.isArray(row.leaderTurns) &&
    Array.isArray(row.workerAttempts) &&
    Array.isArray(row.observedWorkerRuntimeSessionIds) &&
    Array.isArray(row.workerWaits) &&
    Array.isArray(row.pendingLeaderTriggers) &&
    Number.isSafeInteger(row.leaderTurnBudget) &&
    Number(row.leaderTurnBudget) >= 1 &&
    typeof row.revision === "number"
    ? ({ ...value, baseSha: row.baseSha ?? null, scheduleRuntime: row.scheduleRuntime ?? null } as State)
    : null;
}

function validScheduleRuntime(value: unknown): value is SquadScheduleRuntimeLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>,
    worktree = runtime.worktree;
  return (
    typeof runtime.scheduleId === "string" &&
    typeof runtime.occurrenceId === "string" &&
    typeof runtime.claimFence === "string" &&
    (runtime.mode === "detect" || runtime.mode === "remediate") &&
    (worktree === undefined ||
      (worktree !== null &&
        typeof worktree === "object" &&
        !Array.isArray(worktree) &&
        typeof (worktree as Record<string, unknown>).cwd === "string" &&
        typeof (worktree as Record<string, unknown>).branch === "string" &&
        typeof (worktree as Record<string, unknown>).baseRef === "string"))
  );
}

export function applySquadCancellation<State extends SquadStateLike>(
  state: State | null,
  revision: unknown,
): State | null {
  if (!state || !Number.isSafeInteger(revision) || state.revision >= Number(revision)) return state;
  return {
    ...state,
    currentLeaderRuntimeSessionId: null,
    workerWaits: [],
    pendingLeaderTriggers: [],
    phase: "cancelled",
    revision: Number(revision),
    error: null,
  };
}

export function squadRecoveryRows(
  projection: Pick<TaskProjectionQueries, "readSquadRuns">,
): readonly { readonly row: SquadRunProjectionRow; readonly ownerDispatchId: string }[] {
  const rows: { readonly row: SquadRunProjectionRow; readonly ownerDispatchId: string }[] = [];
  for (const row of projection.readSquadRuns()) {
    const state = row.state as { readonly ownerDispatchId?: unknown },
      ownerDispatchId = state.ownerDispatchId;
    if (typeof ownerDispatchId !== "string" || !/^dispatch_[a-f0-9]{24}$/u.test(ownerDispatchId)) continue;
    rows.push({ row, ownerDispatchId });
  }
  return rows;
}

export function activeScheduleClaimMatches(
  projection: Pick<TaskProjectionQueries, "getEntity">,
  scheduleId: string,
  claimFence: string,
): boolean {
  const status = projection.getEntity("schedule", scheduleId)?.value.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  const activeRun = (status as { readonly activeRun?: unknown }).activeRun;
  return (
    activeRun !== null &&
    typeof activeRun === "object" &&
    !Array.isArray(activeRun) &&
    (activeRun as { readonly claimFence?: unknown }).claimFence === claimFence
  );
}

/** A child task a rejected attempt left behind, with the run's binding — the authority that created it. */
export interface RejectedSquadChild<Binding = unknown> {
  readonly squadRunId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly rejection: string;
  readonly binding: Binding;
}

export function rejectedSquadAttemptChildren<Binding>(
  states: Iterable<SquadStateLike<Binding>>,
): readonly RejectedSquadChild<Binding>[] {
  const byTask = new Map<string, RejectedSquadChild<Binding>>();
  for (const state of states) {
    if (!terminal(state)) continue;
    for (const attempt of state.workerAttempts) {
      if (
        attempt.rejection === null ||
        attempt.taskId === null ||
        attempt.taskId === undefined ||
        attempt.runtimeSessionId !== null
      )
        continue;
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

export interface SquadControlStateSnapshot<State extends SquadStateLike> {
  readonly state: State | null;
  readonly ackRevision: number;
}

/** Pure projection-driven recovery fold. Host callers inject their local dispatch-stream reader. */
export function readSquadRecoveryStateFromControl<State extends SquadStateLike>(
  projection: Pick<TaskProjectionQueries, "readSquadRuns" | "getEntity" | "read">,
  readControl: (ownerDispatchId: string, squadRunId: string) => SquadControlStateSnapshot<State> | null,
): {
  readonly states: ReadonlyMap<string, State>;
  readonly publicationAcks: ReadonlyMap<string, number>;
  readonly protectedDispatchIds: ReadonlySet<string>;
} {
  const states = new Map<string, State>(),
    publicationAcks = new Map<string, number>(),
    recoveryRows = squadRecoveryRows(projection),
    protectedDispatchIds = new Set<string>();
  for (const { row, ownerDispatchId } of recoveryRows) {
    const control = readControl(ownerDispatchId, row.squadRunId);
    if (!control) continue;
    const { state: localState, ackRevision } = control;
    if (!localState) continue;
    if (localState.squadRunId !== row.squadRunId)
      throw new Error(`Squad owner stream ${ownerDispatchId} points to an unexpected run.`);
    const restoredActive = !terminal(localState),
      scheduleRuntime = localState.scheduleRuntime,
      scheduleSettlementPending =
        !restoredActive &&
        scheduleRuntime !== null &&
        activeScheduleClaimMatches(projection, scheduleRuntime.scheduleId, scheduleRuntime.claimFence),
      rejectedChildPending =
        !restoredActive &&
        rejectedSquadAttemptChildren([localState]).some((child) => {
          const task = projection.read(child.taskId).snapshot.task;
          return task !== null && !isTerminalStatus(task.status);
        }),
      publicationPending = ackRevision < localState.revision;
    if (!restoredActive && !scheduleSettlementPending && !rejectedChildPending && !publicationPending) continue;
    states.set(localState.squadRunId, localState);
    if (ackRevision >= 0) publicationAcks.set(localState.squadRunId, ackRevision);
    protectedDispatchIds.add(ownerDispatchId);
  }
  return { states, publicationAcks, protectedDispatchIds };
}
