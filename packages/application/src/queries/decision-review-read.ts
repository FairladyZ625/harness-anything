import {
  decisionReviewAwaitRationale,
  decisionReviewState,
  dispatchLifecycleSummary,
  type DecisionReviewRequirement,
  type DecisionProjectionRow,
  type TaskProjection,
} from "@harness-anything/kernel";
export { decisionReviewAwaitRationale, decisionReviewState };
import type { DecisionFullListRow, DecisionReviewDispatchSummaryRow } from "./query-ports.ts";

export function decisionReviewSummaryRow(row: DecisionProjectionRow) {
  const { decisionId, title, state, riskTier, urgency, proposedAt } = row;
  return { decisionId, title, state, riskTier, urgency, proposedAt };
}

/** Full list rows use one body-bearing projection read; authored bodies stay on the server. */
export function decisionFullListRows(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decisions: readonly DecisionProjectionRow[];
  readonly readiness: readonly NonNullable<DecisionProjectionRow["readiness"]>[];
  readonly requirement: DecisionReviewRequirement;
}): readonly DecisionFullListRow[] {
  return input.decisions.map((decision, index) => ({
    ...decision,
    body: null,
    ...decisionReviewState(decision, input.requirement),
    readiness: input.readiness[index]!,
    reviewDispatches: readDecisionReviewDispatches({ rootDir: input.rootDir, projection: input.projection, decision }),
  }));
}

export function readDecisionReviewDispatches(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decision: DecisionProjectionRow;
}): readonly DecisionReviewDispatchSummaryRow[] {
  return input.projection.readRuntimeDispatchesByDecision(input.decision.decisionId).flatMap((row) => {
    const target = row.event.payload.reviewTarget;
    if (target?.kind !== "decision" || target.decisionId !== input.decision.decisionId) return [];
    const header = row.event.payload,
      lifecycle = dispatchLifecycleSummary(
        input.projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [header.dispatchId] }),
      ),
      status =
        lifecycle.displayStatus === "running" ||
        lifecycle.displayStatus === "succeeded" ||
        lifecycle.displayStatus === "failed"
          ? lifecycle.displayStatus
          : "unknown",
      review = input.decision.reviews.find(({ reviewId }) => reviewId === `review-${header.dispatchId}`);
    return [
      {
        dispatchId: header.dispatchId,
        runtimeSessionId: header.runtimeSessionId,
        status,
        reviewContentDigest: target.digest,
        reportRef: review?.reportRef ?? null,
        reviewer: header.agentName ?? header.agentId ?? null,
        findingCount: review ? review.findings.length : null,
      },
    ];
  });
}
