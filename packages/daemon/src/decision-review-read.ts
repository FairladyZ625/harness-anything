import {
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  type DecisionAcceptReviewReadiness,
  type DecisionProjectionRow,
  type TaskProjection,
} from "@harness-anything/kernel";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { DaemonDecisionReviewDispatchRow } from "./protocol/daemon-protocol-gui-types.ts";

/**
 * The review cut and accept readiness a reader sees. Computed only on read surfaces: the accept write
 * path runs the same kernel judgment itself, and other writes never need it.
 */
export function decisionReviewState(row: DecisionProjectionRow): {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
} {
  if (row.body === null) return { currentReviewContentDigest: null, acceptReviewReadiness: null };
  return {
    currentReviewContentDigest: decisionReviewContentDigest(row, row.body.body),
    acceptReviewReadiness: row.state === "proposed" ? decisionAcceptReviewReadiness(row, row.body.body) : null,
  };
}

/**
 * The question of the awaits edge that tells a proposal owner about unresolved review changes. The
 * edge carrying exactly this question is the one the Decision's review state maintains.
 */
export function decisionReviewAwaitRationale(decisionId: string): string {
  return `consent: Decision ${decisionId} has review changes to resolve.`;
}

export function decisionReviewSummaryRow(row: DecisionProjectionRow) {
  const { decisionId, title, state, riskTier, urgency, proposedAt } = row;
  return { decisionId, title, state, riskTier, urgency, proposedAt };
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
