import {
  currentSubmittedExecutions,
  settledApprovedReviewsForExecution,
  consentedApprovedReviewForExecution,
  localGitObjectRefStore,
} from "@harness-anything/kernel";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";
import { githubActionsWitnessEvidence } from "./repo-cell-ci-evidence.ts";
import { projectionReady } from "./repo-cell-settlement.ts";

/** Select delivered leaves; completion itself retains authority over every gate and transition. */
export function mergedCloseoutCandidates(cell: Pick<TaskQueryCell, "rootDir" | "projection" | "cellCodedError">) {
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
        submission = execution.submission!,
        approved = settledApprovedReviewsForExecution(snapshot.reviews, execution, snapshot.reviewDispositions),
        requirement = submission.completionContract?.gates.find((gate) => gate.witness.adapterId === "github-actions");
      if (
        !requirement ||
        requirement.witness.adapterId !== "github-actions" ||
        !submission.commitSha ||
        !localGitObjectRefStore.isAncestor(
          cell.rootDir,
          submission.commitSha,
          `refs/remotes/origin/${requirement.witness.adapterOptions.branch}`,
        ) ||
        approved.length === 0
      )
        return [];
      const consented =
          consentedApprovedReviewForExecution(
            snapshot.reviews,
            snapshot.consents,
            execution,
            snapshot.reviewDispositions,
          ) !== undefined,
        ci = githubActionsWitnessEvidence({ ...cell, projectionReady }, requirement, execution)?.result ?? "missing";
      return [
        {
          taskId,
          executionId: execution.executionId,
          consented,
          ci,
          commands: [
            ...(consented
              ? []
              : approved.map((review) => `ha task review-consent ${taskId} --review-id ${review.reviewId}`)),
            ...(ci === "pass" ? [] : [`ha ci observe pull --task ${taskId}`]),
            `ha task complete ${taskId}`,
          ],
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.ci === "pass" && right.consented) - Number(left.ci === "pass" && left.consented) ||
        left.taskId.localeCompare(right.taskId),
    );
}
