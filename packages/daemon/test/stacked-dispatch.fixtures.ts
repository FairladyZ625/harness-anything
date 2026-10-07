import { reviewDigest, submissionDigest, type ExecutionV1, type TaskLifecycleSnapshot } from "@harness-anything/kernel";

export const stackSha = "a".repeat(40);
export function stackSnapshot(taskId: string, status = "in_review"): TaskLifecycleSnapshot {
  const actor = { principal: { personId: "owner" }, executor: null } as const;
  const execution: ExecutionV1 = {
    schema: "execution/v1",
    executionId: `exe-${taskId}`,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor,
    claimedAt: "2026-10-07T00:00:00Z",
    submittedAt: "2026-10-07T00:01:00Z",
    closedAt: null,
    submission: {
      commitSha: stackSha,
      completionClaim: "delivery",
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: { gates: [] },
    },
  };
  const review = {
    schema: "review/v1",
    reviewId: `review-${taskId}`,
    taskId,
    executionId: execution.executionId,
    verdict: "approved",
    actor,
    capabilityRef: "cap",
    reason: "approved",
    evidenceChecked: ["fixture"],
    commitSha: stackSha,
    iteration: 0,
    contentDigest: `sha256:${"b".repeat(64)}`,
    submissionDigest: submissionDigest(execution.submission!),
    reviewedAt: "2026-10-07T00:02:00Z",
  } as const;
  return {
    revision: 1,
    task: { taskId, status, iteration: 0 } as TaskLifecycleSnapshot["task"],
    executions: [execution],
    reviews: [review],
    consents: [
      {
        schema: "review-consent/v1",
        consentId: `consent-${taskId}`,
        taskId,
        executionId: execution.executionId,
        reviewId: review.reviewId,
        reviewDigest: reviewDigest(review),
        contentDigest: review.contentDigest,
        submissionDigest: review.submissionDigest,
        actor,
        source: "local",
        consentedAt: "2026-10-07T00:03:00Z",
      },
    ],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  };
}
export function stackOn(snapshot: TaskLifecycleSnapshot, upstream: TaskLifecycleSnapshot): TaskLifecycleSnapshot {
  return {
    ...snapshot,
    executions: snapshot.executions.map((execution) => ({
      ...execution,
      deliveryBaseline: {
        kind: "commit",
        commitSha: stackSha,
        stackOn: { taskId: upstream.task!.taskId, executionId: upstream.executions[0]!.executionId },
      },
    })),
  };
}
