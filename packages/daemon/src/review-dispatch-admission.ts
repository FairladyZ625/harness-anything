import {
  currentSubmittedExecutions,
  reviewReturnBudgetSpent,
  type ExecutionV1,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import type { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { readEffectiveReviewReturnBudget } from "./repo-cell-settings-state.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";

/** Keep dispatch admission on the same effective-budget judgment as RecordReview. */
export function assertReviewReturnBudgetAvailable(
  projection: Pick<TaskProjection, "getEntity">,
  taskId: string,
  task: { readonly iteration: number; readonly reviewReturnBudget?: number },
): void {
  const returnBudget = readEffectiveReviewReturnBudget(projection, task).value;
  if (!reviewReturnBudgetSpent(task.iteration, returnBudget)) return;
  throw runtimeSpawnError(
    "review_return_budget_exhausted",
    `Return budget ${String(returnBudget)} is spent at iteration ${String(task.iteration)}: a new review ` +
      `dispatch for task ${taskId} is refused because a changes_requested RecordReview can no longer land. ` +
      "Ask the task owner or escalate to the dispatching principal to explicitly raise " +
      `the review return budget — for this task with \`ha task amend ${taskId} ` +
      "--set reviewReturnBudget:<n>`, or repository-wide with `ha settings update --review-return-budget <n>`.",
  );
}

/** A reviewer dispatch binds to the task's submitted cut; anything else is a dispatch error, never a fallback to an implementation execution. */
export function selectReviewTarget(
  taskId: string | null,
  requestedExecutionId: string | undefined,
  taskSnapshot: ReturnType<typeof requireCurrentTaskProjection>["snapshot"] | null,
  remote: boolean,
): ExecutionV1 | null {
  if (taskId === null || remote || taskSnapshot === null) return null;
  const candidates = currentSubmittedExecutions(taskSnapshot);
  if (requestedExecutionId !== undefined) {
    const match = candidates.find((candidate) => candidate.executionId === requestedExecutionId);
    if (!match)
      throw runtimeSpawnError(
        "review_target_missing",
        `Execution ${requestedExecutionId} is not a submitted cut on task ${taskId}'s current iteration.`,
      );
    return match;
  }
  if (candidates.length === 0)
    throw runtimeSpawnError(
      "review_target_missing",
      `Task ${taskId} has no submitted execution to review; a reviewer dispatch binds to a submitted ` +
        "cut, never to the active implementation execution. Submit the implementation first.",
    );
  if (candidates.length > 1)
    throw runtimeSpawnError(
      "invalid_runtime_spawn",
      `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration ` +
        `(${candidates.map((candidate) => candidate.executionId).join(", ")}); ` +
        "dispatch each review with an explicit executionId.",
    );
  return candidates[0]!;
}
