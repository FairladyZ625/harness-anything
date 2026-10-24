import {
  currentSubmittedExecutions,
  settledApprovedReviewsForExecution,
  consentedApprovedReviewForExecution,
} from "@harness-anything/kernel";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";
import { readCompletionDeliveryStatus } from "./task-completion-read.ts";

/** Select delivered leaves; completion itself retains authority over every gate and transition. */
export function mergedCloseoutCandidates(cell: Pick<TaskQueryCell, "rootDir" | "projection">) {
  const rows = cell.projection.list({ status: "in_review" }).rows,
    children = cell.projection.readTaskChildCounts(rows.map((row) => row.taskId));
  return rows
    .flatMap(({ taskId, snapshot }) => {
      if (
        snapshot.task?.taskClass !== "standard" ||
        snapshot.task.packageDisposition !== "active" ||
        (children[taskId] ?? 0) > 0 ||
        snapshot.lease !== null ||
        snapshot.executions.some((execution) => execution.state === "active")
      )
        return [];
      const cuts = currentSubmittedExecutions(snapshot);
      if (cuts.length !== 1) return [];
      const execution = cuts[0]!,
        approved = settledApprovedReviewsForExecution(snapshot.reviews, execution, snapshot.reviewDispositions),
        delivery = readCompletionDeliveryStatus(cell.projection, snapshot, cell.rootDir);
      if (!delivery.required || delivery.merged !== true || approved.length === 0) return [];
      const consented =
        consentedApprovedReviewForExecution(
          snapshot.reviews,
          snapshot.consents,
          execution,
          snapshot.reviewDispositions,
        ) !== undefined;
      return [
        {
          taskId,
          executionId: execution.executionId,
          consented,
          commands: [
            ...(consented
              ? []
              : approved.map(
                  (review) =>
                    `ha task review-consent ${taskId} --execution-id ${execution.executionId} --review-id ${review.reviewId}`,
                )),
            `ha task complete ${taskId}`,
          ],
        },
      ];
    })
    .sort((left, right) => Number(right.consented) - Number(left.consented) || left.taskId.localeCompare(right.taskId));
}
