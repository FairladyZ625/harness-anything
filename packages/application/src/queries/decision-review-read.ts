import {
  decisionReviewAwaitRationale,
  decisionReviewState,
  dispatchLifecycleSummary,
  type DecisionReviewRequirement,
  type DecisionProjectionRow,
  type TaskProjection,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
export { decisionReviewAwaitRationale, decisionReviewState };
import type { DecisionFullListRow, DecisionReviewDispatchSummaryRow } from "./query-ports.ts";

export function decisionReviewSummaryRow(row: DecisionProjectionRow) {
  const { decisionId, title, state, riskTier, urgency, proposedAt } = row;
  return { decisionId, title, state, riskTier, urgency, proposedAt };
}

/** Full list rows include the review cut prepared by the projection writer. */
export function decisionFullListRows(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decisions: readonly DecisionProjectionRow[];
  readonly readiness: readonly NonNullable<DecisionProjectionRow["readiness"]>[];
  readonly requirement: DecisionReviewRequirement;
}): readonly DecisionFullListRow[] {
  const dispatches = decisionReviewDispatches(input.projection, input.decisions);
  return input.decisions.map((decision, index) => {
    const { listReview: _listReview, ...row } = decision;
    return {
      ...row,
      body: null,
      ...decisionReviewState(decision, input.requirement),
      readiness: input.readiness[index]!,
      reviewDispatches: dispatches.get(decision.decisionId) ?? [],
    };
  });
}

export function readDecisionReviewDispatches(input: {
  readonly rootDir: string;
  readonly projection: TaskProjectionQueries;
  readonly decision: DecisionProjectionRow;
}): readonly DecisionReviewDispatchSummaryRow[] {
  return decisionReviewDispatches(input.projection, [input.decision]).get(input.decision.decisionId) ?? [];
}

function decisionReviewDispatches(projection: TaskProjectionQueries, decisions: readonly DecisionProjectionRow[]) {
  const summaries = new Map<string, DecisionReviewDispatchSummaryRow[]>();
  if (decisions.length === 0) return summaries;
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision])),
    dispatches = projection.readRuntimeDispatchesByDecisions([...byId.keys()]);
  if (dispatches.length === 0) return summaries;

  const dispatchIds = [...new Set(dispatches.map(({ payload }) => payload.dispatchId))],
    lifecycle = projection.readDispatchLifecycle({ by: "dispatch-batch", dispatchIds }),
    views = new Map(lifecycle.status === "ready" ? lifecycle.rows.map((row) => [row.attempt.dispatchId, row]) : []),
    reviews = new Map<string, Map<string, DecisionProjectionRow["reviews"][number]>>();
  for (const { payload: header } of dispatches) {
    const target = header.reviewTarget;
    if (target?.kind !== "decision" || target.decisionId === undefined) continue;
    const decision = byId.get(target.decisionId);
    if (!decision) continue;
    let decisionReviews = reviews.get(decision.decisionId);
    if (!decisionReviews) {
      decisionReviews = new Map();
      for (const review of decision.reviews) {
        if (!decisionReviews.has(review.reviewId)) decisionReviews.set(review.reviewId, review);
      }
      reviews.set(decision.decisionId, decisionReviews);
    }
    const review = decisionReviews.get(`review-${header.dispatchId}`),
      view = views.get(header.dispatchId),
      displayStatus =
        view && lifecycle.status === "ready"
          ? dispatchLifecycleSummary({ ...lifecycle, rows: [view] }).displayStatus
          : "unknown",
      status =
        displayStatus === "running" || displayStatus === "succeeded" || displayStatus === "failed"
          ? displayStatus
          : "unknown";
    const rows = summaries.get(decision.decisionId) ?? [];
    rows.push({
      dispatchId: header.dispatchId,
      runtimeSessionId: header.runtimeSessionId,
      status,
      reviewContentDigest: target.digest,
      reportRef: review?.reportRef ?? null,
      reviewer: header.agentName ?? header.agentId ?? null,
      findingCount: review ? review.findings.length : null,
    });
    summaries.set(decision.decisionId, rows);
  }
  return summaries;
}
