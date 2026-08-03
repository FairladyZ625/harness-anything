import type { DomainStatus } from "@harness-anything/kernel";
import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";

export interface TaskWipSnapshotEntryV1 {
  readonly taskId: string;
  readonly title: string;
  readonly status: DomainStatus;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly isContainer: boolean;
  /** Existing delivery evidence makes a planned task a closeout backfill. */
  readonly hasCloseoutEvidence?: boolean;
}

export interface TaskWipSnapshotV1 {
  readonly limit: number;
  readonly tasks: ReadonlyArray<TaskWipSnapshotEntryV1>;
}

export type ReadTaskWipSnapshotV1 = () => Promise<TaskWipSnapshotV1>;

export function taskWipPublicationRevalidation(
  readSnapshot: ReadTaskWipSnapshotV1 | undefined,
  activatingTaskId: string
): () => Promise<void> {
  return async () => {
    if (!readSnapshot) throw admission("TASK_WIP_POLICY_UNAVAILABLE");
    const snapshot = await readSnapshot();
    if (!Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1) {
      throw admission("TASK_WIP_POLICY_INVALID: settings.tasks.wipLimit must be a positive integer.");
    }
    if (snapshot.tasks.some((task) => task.taskId === activatingTaskId
      && (task.isContainer || task.hasCloseoutEvidence === true))) return;
    const occupying = snapshot.tasks
      .filter((task) => !task.isContainer && isExecutionWipTask(task.status, task.packageDisposition))
      .sort(compareTaskWipSuggestions);
    if (occupying.length < snapshot.limit) return;
    const suggestions = occupying.slice(0, 3);
    const suggestedText = suggestions.length > 0
      ? suggestions.map((task) => `${task.taskId} ${JSON.stringify(task.title)} (${task.status})`).join(", ")
      : "none available";
    const directlyReturnable = suggestions.find((task) => task.status === "active" || task.status === "blocked");
    const next = directlyReturnable
      ? `Next: run \`ha task transition ${directlyReturnable.taskId} planned\`, or complete/archive one of those tasks, then retry \`ha task transition ${activatingTaskId} active\`.`
      : `Next: complete or review one of those tasks, then retry \`ha task transition ${activatingTaskId} active\`.`;
    throw admission(
      `TASK_WIP_LIMIT_REACHED: Execution worktable is full (${occupying.length}/${snapshot.limit}; settings.tasks.wipLimit=${snapshot.limit}). ` +
      `Before activating ${activatingTaskId}, return or close one existing task. Suggested: ${suggestedText}. ${next} ` +
      "Planned tasks remain in the idea inbox and are not counted or removed."
    );
  };
}

export function enteringExecutionWip(
  currentStatus: DomainStatus,
  currentDisposition: TaskWipSnapshotEntryV1["packageDisposition"],
  nextStatus: DomainStatus,
  nextDisposition: TaskWipSnapshotEntryV1["packageDisposition"]
): boolean {
  return !isExecutionWipTask(currentStatus, currentDisposition)
    && isExecutionWipTask(nextStatus, nextDisposition);
}

function isExecutionWipTask(
  status: DomainStatus,
  packageDisposition: TaskWipSnapshotEntryV1["packageDisposition"]
): boolean {
  return packageDisposition === "active"
    && (status === "active" || status === "blocked" || status === "in_review");
}

function compareTaskWipSuggestions(left: TaskWipSnapshotEntryV1, right: TaskWipSnapshotEntryV1): number {
  const rank = { blocked: 0, active: 1, in_review: 2 } as const;
  const leftRank = left.status in rank ? rank[left.status as keyof typeof rank] : 3;
  const rightRank = right.status in rank ? rank[right.status as keyof typeof rank] : 3;
  return leftRank - rightRank || left.taskId.localeCompare(right.taskId);
}
