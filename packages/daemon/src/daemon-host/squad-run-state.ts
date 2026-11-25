import { isTerminalStatus, type SquadRunSubjectV1, type TaskProjection, type TaskV2 } from "@harness-anything/kernel";
import { normalizeHistoricalSquadRunIdentity } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events";
import {
  applySquadCancellation,
  readSquadRecoveryStateFromControl,
  rejectedSquadAttemptChildren,
  squadScheduleSubject,
  squadState,
  squadTaskRef,
  terminal,
  validSquadRunId,
  type RejectedSquadChild as ApplicationRejectedSquadChild,
} from "@harness-anything/application/internal/queries/squad-run-state.ts";
import { dispatchStreamPath, parseRecord, readDispatchStreamHeader } from "./dispatch-stream.ts";
import { visitDispatchStreamLines } from "./dispatch-stream-lines.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { LeaderTrigger, LeaderTurn, WorkerAttempt, WorkerWaitTrigger } from "./squad-leader-decision.ts";
import type { SquadRunPhase } from "./squad-run-contract.ts";

export { rejectedSquadAttemptChildren, squadScheduleSubject, squadState, squadTaskRef, terminal, validSquadRunId };

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

/** Inspect only projection-owned Squad streams; unrelated dispatch archives are never enumerated. */
export function readSquadRecoveryState(
  rootDir: string,
  projection: Pick<TaskProjection, "readSquadRuns" | "getEntity" | "read">,
): {
  readonly states: ReadonlyMap<string, SquadState>;
  readonly publicationAcks: ReadonlyMap<string, number>;
  readonly protectedDispatchIds: ReadonlySet<string>;
} {
  return readSquadRecoveryStateFromControl<SquadState>(projection, (ownerDispatchId, squadRunId) =>
    readSquadControlState(rootDir, ownerDispatchId, squadRunId),
  );
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
        const candidate = squadState<SquadState>(normalizeHistoricalSquadRunIdentity(record.state));
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
      return /^\s*[^\s{]/u.test(prefix) ? false : undefined;
    },
  );
  return control;
}

/** A child task a rejected attempt left behind, with the run's binding — the authority that created it. */
export type RejectedSquadChild = ApplicationRejectedSquadChild<RuntimeBinding>;

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
 * Cancels the children rejected Squad attempts left unfinished, each with the binding of the run that created it.
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
