import {
  isTerminalStatus,
  validSquadRunSubject,
  type SquadRunSubjectV1,
  type SquadRunProjectionRow,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import { normalizeHistoricalSquadRunIdentity } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events";
import { dispatchStreamPath, parseRecord, readDispatchStreamHeader } from "./dispatch-stream.ts";
import { visitDispatchStreamLines } from "./dispatch-stream-lines.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
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
  readonly subject: SquadRunSubjectV1;
  /** The Schedule admission context and occurrence worktree, if this run owns a Schedule claim. */
  readonly scheduleRuntime: TrustedScheduleRuntime | null;
  /** The instance a task run explicitly selected; a schedule run leaves it to the leader declaration. */
  readonly runtimeInstanceId: string | null;
  readonly cwd: string;
  readonly baseSha: string | null;
  readonly mission: string;
  /** User-authored prompt or canonical task title; excludes generated local execution instructions. */
  readonly publicMission: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode?: string | null;
  readonly mcpPolicy?: string | null;
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

/** The task execution this run was admitted under; null when the run rides a Schedule occurrence claim. */
export function squadTaskRef(
  state: Pick<SquadState, "subject">,
): { readonly taskId: string; readonly executionId: string } | null {
  return state.subject.kind === "task"
    ? { taskId: state.subject.taskId, executionId: state.subject.executionId }
    : null;
}

/** The schedule-occurrence subject this run rides; null on task-subject runs. */
export function squadScheduleSubject(
  state: Pick<SquadState, "subject">,
): Extract<SquadRunSubjectV1, { readonly kind: "schedule-occurrence" }> | null {
  return state.subject.kind === "schedule-occurrence" ? state.subject : null;
}

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
    ? ({ ...value, baseSha: row.baseSha ?? null, scheduleRuntime: row.scheduleRuntime ?? null } as SquadState)
    : null;
}

function validScheduleRuntime(value: unknown): value is TrustedScheduleRuntime {
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

/** Inspect only projection-owned Squad streams; unrelated dispatch archives are never enumerated. */
export function readSquadRecoveryState(
  rootDir: string,
  projection: Pick<TaskProjection, "readSquadRuns" | "getEntity" | "read">,
): {
  readonly states: ReadonlyMap<string, SquadState>;
  readonly publicationAcks: ReadonlyMap<string, number>;
  readonly protectedDispatchIds: ReadonlySet<string>;
} {
  const states = new Map<string, SquadState>(),
    publicationAcks = new Map<string, number>(),
    recoveryRows = squadRecoveryRows(projection),
    protectedDispatchIds = new Set<string>();
  for (const { row, ownerDispatchId } of recoveryRows) {
    const control = readSquadControlState(rootDir, ownerDispatchId, row.squadRunId);
    // Only the owning node has the local control stream; the projection is shared.
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

/** Recovery folds every control record, including records outside diagnostic head/tail windows.
 * Only projection-owned streams are visited. Memory holds one line and the latest control cut;
 * provider records are skipped before decoding, regardless of transcript or ledger size. */
function readSquadControlState(rootDir: string, ownerDispatchId: string, squadRunId: string) {
  if (!readDispatchStreamHeader(rootDir, ownerDispatchId)) return null;
  const control: { state: SquadState | null; ackRevision: number } = { state: null, ackRevision: -1 };
  visitDispatchStreamLines(
    dispatchStreamPath(rootDir, ownerDispatchId),
    (line) => {
      const record = parseRecord(line);
      if (record?.kind === "squad_run_state") {
        const candidate = squadState(normalizeHistoricalSquadRunIdentity(record.state));
        if (candidate && (!control.state || control.state.revision < candidate.revision)) control.state = candidate;
      } else if (record?.kind === "squad_run_cancelled") {
        control.state = applySquadCancellation(control.state, record.revision);
      } else if (
        record?.kind === "squad_run_publication_ack" &&
        record.squadRunId === squadRunId &&
        Number.isSafeInteger(record.revision)
      )
        control.ackRevision = Math.max(control.ackRevision, Number(record.revision));
      return true;
    },
    (prefix) => {
      const kind = /"kind"\s*:\s*"([^"\\]+)"/u.exec(prefix)?.[1];
      if (kind)
        return kind === "squad_run_state" || kind === "squad_run_cancelled" || kind === "squad_run_publication_ack";
      // Non-object data cannot be a control record (e.g. a sparse/truncated transcript line).
      return /^\s*[^\s{]/u.test(prefix) ? false : undefined;
    },
  );
  return control;
}

function squadRecoveryRows(
  projection: Pick<TaskProjection, "readSquadRuns" | "getEntity" | "read">,
): readonly { readonly row: SquadRunProjectionRow; readonly ownerDispatchId: string }[] {
  const rows: { readonly row: SquadRunProjectionRow; readonly ownerDispatchId: string }[] = [];
  for (const row of projection.readSquadRuns()) {
    const state = row.state as { readonly ownerDispatchId?: unknown },
      ownerDispatchId = state.ownerDispatchId;
    if (typeof ownerDispatchId !== "string" || !/^dispatch_[a-f0-9]{24}$/u.test(ownerDispatchId)) continue;
    // Projection rows identify the bounded set of Squad owner streams. Keep terminal rows in this
    // set too: a local terminal revision can be newer than the shared projection after a crash
    // between recording it and publishing the observation.
    rows.push({ row, ownerDispatchId });
  }
  return rows;
}

function applySquadCancellation(state: SquadState | null, revision: unknown): SquadState | null {
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

function activeScheduleClaimMatches(
  projection: Pick<TaskProjection, "getEntity">,
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
export function rejectedSquadAttemptChildren(states: Iterable<SquadState>): readonly RejectedSquadChild[] {
  const byTask = new Map<string, RejectedSquadChild>();
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

/** How a caller with the cell's write surface cancels one orphan: the action to apply, with its run's own binding. */
export interface SquadOrphanCancellation {
  readonly states: Iterable<SquadState>;
  readonly readTask: (taskId: string) => TaskV2 | null | undefined;
  readonly cancel: (
    action: RepoTaskAction,
    binding: RuntimeBinding,
    actionId: string,
  ) => Promise<{ readonly outcome: string; readonly code?: string }>;
}

/**
 * Cancels the children rejected Squad attempts left unfinished, each with the binding of the run that created it. A
 * rejection here is reported and retried by the next reconciliation (every daemon start), never thrown: the pass runs
 * unattended at attach, and one child's failure must not strand the rest or the worktree sweep behind it.
 */
export async function cancelRejectedSquadChildren(input: SquadOrphanCancellation): Promise<void> {
  for (const child of rejectedSquadAttemptChildren(input.states)) {
    const task = input.readTask(child.taskId);
    if (!task || isTerminalStatus(task.status)) continue;
    const action: RepoTaskAction = {
      kind: "task-transition",
      taskId: child.taskId,
      status: "cancelled",
      reason: `Squad run ${child.squadRunId} ended; worker ${child.workerId} was rejected before dispatch.`,
    };
    const [settled] = await Promise.allSettled([
      input.cancel(action, child.binding, `squad-rejected-child:${child.taskId}`),
    ]);
    if (settled?.status === "fulfilled") {
      if (settled.value.outcome === "applied") continue;
      console.warn(
        `[task-worktree] cancelling rejected Squad child ${child.taskId} was ${settled.value.outcome}` +
          `${settled.value.code ? ` (${settled.value.code})` : ""}; retrying on the next reconciliation.`,
      );
    } else if (settled) {
      console.warn(
        `[task-worktree] cancelling rejected Squad child ${child.taskId} failed: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}; ` +
          "retrying on the next reconciliation.",
      );
    }
  }
}
