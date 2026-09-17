import { reviewReturnBudgetSpent, type TaskProjection } from "../../kernel/src/index.ts";
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
