import type { ProjectedExecution } from "./execution.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type { TaskClass } from "./task.ts";

/**
 * Default execution work-in-progress limit. This is a default, not the truth:
 * the effective limit is resolved per workspace from HARNESS_TASK_WIP_LIMIT or
 * settings.tasks.wipLimit before every admission check.
 */
export const DEFAULT_TASK_WIP_LIMIT = 30;

export const taskWipOccupyingStatuses = ["active", "blocked", "in_review"] as const satisfies ReadonlyArray<DomainStatus>;
export type TaskWipOccupyingStatus = (typeof taskWipOccupyingStatuses)[number];

export interface TaskWipSnapshotEntryV1 {
  readonly taskId: string;
  readonly title: string;
  readonly status: DomainStatus;
  readonly taskClass: TaskClass;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  /**
   * Canonical delivery evidence already recorded on the task (a submitted
   * native execution, or a migrated archived execution carrying outputs or an
   * archived submission). Existing delivery evidence makes a planned task a
   * closeout backfill: activating it writes existing work off instead of
   * adding parallel work, so it never enters the WIP count.
   */
  readonly hasCloseoutEvidence: boolean;
}

export function hasCloseoutEvidence(executions: readonly ProjectedExecution[]): boolean {
  return executions.some((execution) => execution.schema === "execution/v1"
    ? execution.submission !== null
    : execution.archivedSubmission !== null || execution.outputs.length > 0);
}

export function isExecutionWipTask(entry: TaskWipSnapshotEntryV1): boolean {
  return entry.packageDisposition === "active"
    && entry.taskClass === "standard"
    && (taskWipOccupyingStatuses as readonly string[]).includes(entry.status);
}

export interface TaskWipAdmissionInput {
  readonly limit: number;
  /** Names the setting that produced the limit, e.g. settings.tasks.wipLimit or HARNESS_TASK_WIP_LIMIT. */
  readonly limitLabel: string;
  readonly tasks: readonly TaskWipSnapshotEntryV1[];
  readonly activatingTaskId: string;
  readonly nextStatus: DomainStatus;
}

export type TaskWipAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "TASK_WIP_LIMIT_REACHED"; readonly message: string };

export function admitTaskExecutionWip(input: TaskWipAdmissionInput): TaskWipAdmission {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    return { ok: false, code: "TASK_WIP_LIMIT_REACHED", message: `TASK_WIP_POLICY_INVALID: ${input.limitLabel} must be a positive integer.` };
  }
  const activating = input.tasks.find((task) => task.taskId === input.activatingTaskId);
  // Unknown task: the task surface owns the not-found error. Already occupying:
  // re-entering the same worktable slot (rejoin, resume) adds nothing.
  if (!activating || !enteringExecutionWip(activating, input.nextStatus)) return { ok: true };
  // Closeout backfill: activating recorded delivery evidence writes existing work off.
  // This is part of the counting rule, not an exemption layer on top of it.
  if (activating.hasCloseoutEvidence) return { ok: true };
  const occupying = input.tasks.filter(isExecutionWipTask).sort(compareTaskWipSuggestions);
  if (occupying.length < input.limit) return { ok: true };
  const suggestions = occupying.slice(0, 3)
    .map((task) => `${task.taskId} ${JSON.stringify(task.title)} (${task.status})`).join(", ");
  return {
    ok: false,
    code: "TASK_WIP_LIMIT_REACHED",
    message: `TASK_WIP_LIMIT_REACHED: Execution worktable is full (${occupying.length}/${input.limit}; ${input.limitLabel}=${input.limit}). ` +
      `Before starting ${input.activatingTaskId}, close one existing task. Suggested: ${suggestions}. ` +
      `Next: complete, cancel (\`ha task transition <task-id> cancelled --force --reason <reason>\`), or archive one of those tasks, then retry \`ha task start ${input.activatingTaskId}\`. ` +
      "Planned tasks stay in the idea backlog and are never counted or removed."
  };
}

/** True when the move takes the task from a non-occupying state into an occupying one. */
export function enteringExecutionWip(current: TaskWipSnapshotEntryV1, nextStatus: DomainStatus): boolean {
  return !isExecutionWipTask(current) && isExecutionWipTask({ ...current, status: nextStatus });
}

export function parseTaskWipLimit(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function compareTaskWipSuggestions(left: TaskWipSnapshotEntryV1, right: TaskWipSnapshotEntryV1): number {
  const rank = { blocked: 0, active: 1, in_review: 2 } as const;
  const leftRank = left.status in rank ? rank[left.status as keyof typeof rank] : 3;
  const rightRank = right.status in rank ? rank[right.status as keyof typeof rank] : 3;
  return leftRank - rightRank || left.taskId.localeCompare(right.taskId);
}
