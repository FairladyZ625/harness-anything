import type { DecisionProjectionRow, TaskProjection } from "@harness-anything/kernel";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { DaemonDecisionReviewDispatchRow } from "./protocol/daemon-protocol-gui-types.ts";

export function decisionReviewSummaryRow(row: DecisionProjectionRow) {
  const { decisionId, title, state, riskTier, urgency, proposedAt, currentReviewContentDigest } = row;
  return { decisionId, title, state, riskTier, urgency, proposedAt, currentReviewContentDigest };
}

export function readDecisionReviewDispatches(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decision: DecisionProjectionRow;
}): readonly DaemonDecisionReviewDispatchRow[] {
  return readDispatchStreamHeaders(input.rootDir).flatMap((header) => {
    if (header.reviewTarget?.kind !== "decision" || header.reviewTarget.decisionId !== input.decision.decisionId)
      return [];
    const stream = readDispatchStreamSummary(input.rootDir, header.dispatchId),
      outcome = input.projection.readRuntimeSession(header.runtimeSessionId)?.outcome,
      status =
        stream?.process?.exited === false
          ? ("running" as const)
          : outcome === "succeeded" || outcome === "failed"
            ? outcome
            : ("unknown" as const),
      review = input.decision.reviews.find(({ reviewId }) => reviewId === `review-${header.dispatchId}`);
    return [
      {
        dispatchId: header.dispatchId,
        runtimeSessionId: header.runtimeSessionId,
        status,
        reviewContentDigest: header.reviewTarget.digest,
        reportRef: review?.reportRef ?? null,
      },
    ];
  });
}
