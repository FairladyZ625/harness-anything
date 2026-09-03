import { currentSubmittedExecutions, type CloseoutReadiness } from "./closeout-readiness.ts";
import { isTerminalStatus, type DomainStatus } from "./lifecycle-status.ts";
import type { BlockingAssessmentState } from "./task-blocking.ts";
import { canStartExecution } from "./task-lifecycle-command-transitions.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle-contract-internal-types.ts";
import type { TaskPackageDisposition } from "./task.ts";
import { workspaceTaskStatus } from "./workspace-summary.ts";

/**
 * The `task-board-rows` use-case projection of dec_5B135F46 CH4 layer two: the three judgments a
 * task board, list or control panel needs from a `repo.tasks.list` row — which column the row sits
 * in, whether it is archived noise, and which actions it affords. They live here so the daemon
 * serves them and the renderer paints them; a second copy in either place is the drift CH4 exists
 * to remove (dec_8DCD52E9 froze 67 renderer-side judgments for exactly that reason).
 *
 * Every function is pure over one row: same snapshot cut in, same fields out, no daemon state and
 * no caller identity. Identity-bound admissibility (who holds the lease, who may review whom) stays
 * on `entity.actions.explain`, which is actor-scoped; these fields answer the row-shaped question
 * "what can be done to this task at all", which is what a list of 500 rows can afford to carry.
 */

/** Board columns, in display order. `unknown` is deliberately absent — see `taskBoardColumnOf`. */
export const taskBoardColumnIds = ["open", "blocked", "in_review", "terminal"] as const;
export type TaskBoardColumnId = (typeof taskBoardColumnIds)[number];

/**
 * Sort weight by coordination status: what needs attention first. Statuses outside this list
 * (`cancelled`, and rows with no projected task) rank last.
 */
const boardRankOrder = ["blocked", "active", "in_review", "planned", "done"] as const satisfies readonly DomainStatus[];

export interface TaskBoardPlacement {
  /** `null` when the row has no projected task: it belongs to no column and is not displayed. */
  readonly columnId: TaskBoardColumnId | null;
  readonly rank: number;
}

export interface TaskVisibility {
  readonly archived: boolean;
  /** Archived or cancelled rows are board noise: history, not work in flight. */
  readonly noise: boolean;
}

export const taskPhaseSteps = ["planned", "active", "in_review", "done"] as const satisfies readonly DomainStatus[];
export const taskPhaseReasons = ["blocked_overlay", "terminal_cancelled", "phase_unresolved"] as const;
export type TaskPhaseReason = (typeof taskPhaseReasons)[number];

export interface TaskPhase {
  readonly index: number | null;
  readonly reason: TaskPhaseReason | null;
  readonly steps: typeof taskPhaseSteps;
}

export interface TaskRisk {
  readonly flagged: boolean;
}

/**
 * Actions a board row gates today. `start` / `submit` / `review` / `complete` are Task Action
 * catalog ids; `progress` is the `task-progress-append` policy action the control panel gates
 * alongside submit. The catalog's remaining ids (release, amend, archive, supersede, delete,
 * reopen, contract-migrate) are not board affordances and are not projected onto every row.
 */
export const taskCapabilityIds = ["start", "progress", "submit", "review", "complete"] as const;
export type TaskCapabilityId = (typeof taskCapabilityIds)[number];

/**
 * Why an action is unavailable. Every word is either a Task Action contract failure code or a
 * registered status word — never prose, because the renderer must be able to map it to its own
 * wording without parsing a sentence.
 */
export const taskCapabilityReasons = [
  "invalid_disposition",
  "invalid_transition",
  "lease_required",
  "lease_conflict",
  "completion_blocked",
  "blocked",
  "unknown",
] as const;
export type TaskCapabilityReason = (typeof taskCapabilityReasons)[number];

export interface TaskCapability {
  readonly id: TaskCapabilityId;
  readonly available: boolean;
  readonly reason: TaskCapabilityReason | null;
}

/** One projected task row plus the assessments the daemon already derived for it. */
export interface TaskBoardRowInput {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly blockingState: BlockingAssessmentState;
  readonly packageDisposition: TaskPackageDisposition;
  readonly origin: "native" | "archival" | "external";
  readonly closeoutReadiness: CloseoutReadiness;
}

/**
 * The coordination status a column is chosen from. `unknown` has no column: a row the projection
 * could not resolve is not evidence that the task is anywhere, so it is left out of the board
 * rather than parked in a bucket that invites being counted as real work.
 */
export function taskBoardColumnOf(coordinationStatus: DomainStatus | "unknown"): TaskBoardColumnId | null {
  if (coordinationStatus === "unknown") return null;
  if (coordinationStatus === "blocked") return "blocked";
  if (coordinationStatus === "in_review") return "in_review";
  return isTerminalStatus(coordinationStatus) ? "terminal" : "open";
}

export function taskBoardRankOf(coordinationStatus: DomainStatus | "unknown"): number {
  const rank = (boardRankOrder as readonly string[]).indexOf(coordinationStatus);
  return rank < 0 ? boardRankOrder.length : rank;
}

export function taskBoardPlacement(row: TaskBoardRowInput): TaskBoardPlacement {
  const status = coordinationStatusOf(row);
  return Object.freeze({ columnId: taskBoardColumnOf(status), rank: taskBoardRankOf(status) });
}

/** Archived and tombstoned packages are history, not work in flight. */
export function taskVisibility(row: TaskBoardRowInput): TaskVisibility {
  const status = coordinationStatusOf(row);
  return Object.freeze({
    archived: row.packageDisposition !== "active",
    noise: row.packageDisposition !== "active" || status === "cancelled",
  });
}

/** The canonical lifecycle's main delivery path plus an explicit reason for statuses off that path. */
export function taskPhase(row: TaskBoardRowInput): TaskPhase {
  const status = coordinationStatusOf(row),
    index = (taskPhaseSteps as readonly string[]).indexOf(status);
  return Object.freeze({
    index: index < 0 ? null : index,
    reason:
      status === "blocked"
        ? "blocked_overlay"
        : status === "cancelled"
          ? "terminal_cancelled"
          : status === "unknown"
            ? "phase_unresolved"
            : null,
    steps: taskPhaseSteps,
  });
}

/** Missing closeout evidence and an explicitly failed closeout are the row's two risk signals. */
export function taskRisk(row: TaskBoardRowInput): TaskRisk {
  return Object.freeze({
    flagged: row.closeoutReadiness === "missing" || row.closeoutReadiness === "failed",
  });
}

export function taskCapabilities(row: TaskBoardRowInput): readonly TaskCapability[] {
  return Object.freeze(
    taskCapabilityIds.map((id) => {
      const reason = capabilityReason(id, row);
      return Object.freeze({ id, available: reason === null, reason });
    }),
  );
}

function coordinationStatusOf(row: TaskBoardRowInput): DomainStatus | "unknown" {
  const task = row.snapshot.task;
  if (task === null) return "unknown";
  return workspaceTaskStatus({ status: task.status, blockingState: row.blockingState });
}

function capabilityReason(id: TaskCapabilityId, row: TaskBoardRowInput): TaskCapabilityReason | null {
  const task = row.snapshot.task;
  if (task === null) return "unknown";
  // A package that is not active, or a task this workspace does not own, affords nothing at all.
  if (row.packageDisposition !== "active" || row.origin !== "native") return "invalid_disposition";
  if (id === "start") return startReason(row, task.status);
  if (id === "progress" || id === "submit") return leaseHolderReason(row, task.status);
  if (id === "review") return reviewReason(row);
  return row.snapshot.lease !== null ? "lease_conflict" : completeReason(row);
}

/**
 * Start reuses the lifecycle's own admissibility (`canStartExecution`) and adds the three
 * preconditions it does not carry: disposition and origin above, and an unblocked task here.
 */
function startReason(row: TaskBoardRowInput, status: DomainStatus): TaskCapabilityReason | null {
  if (row.blockingState === "blocked") return "blocked";
  if (row.blockingState === "unknown") return "unknown";
  if (status !== "planned") return "invalid_transition";
  if (row.snapshot.lease !== null) return "lease_conflict";
  return canStartExecution(row.snapshot, "task-board-projection") ? null : "invalid_transition";
}

/** Appending progress and submitting both require holding this task's active execution. */
function leaseHolderReason(row: TaskBoardRowInput, status: DomainStatus): TaskCapabilityReason | null {
  if (status !== "active") return "invalid_transition";
  return row.snapshot.lease === null ? "lease_required" : null;
}

function reviewReason(row: TaskBoardRowInput): TaskCapabilityReason | null {
  if (row.snapshot.lease !== null) return "lease_conflict";
  return currentSubmittedExecutions(row.snapshot).length > 0 ? null : "invalid_transition";
}

function completeReason(row: TaskBoardRowInput): TaskCapabilityReason | null {
  return row.closeoutReadiness === "ready" ? null : "completion_blocked";
}
