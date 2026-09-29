import {
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  type DecisionAcceptReviewReadiness,
  type DecisionReviewRequirement,
  type DecisionProjectionRow,
  type TaskProjection,
} from "@harness-anything/kernel";
import { readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { DaemonDecisionFullRow, DaemonDecisionReviewDispatchRow } from "./protocol/daemon-protocol-gui-types.ts";

/**
 * The review cut and accept readiness a reader sees. Computed only on read surfaces: the accept write
 * path runs the same kernel judgment itself, and other writes never need it.
 */
export function decisionReviewState(
  row: DecisionProjectionRow,
  requirement: DecisionReviewRequirement,
): {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
} {
  if (row.body === null) return { currentReviewContentDigest: null, acceptReviewReadiness: null };
  return {
    currentReviewContentDigest: decisionReviewContentDigest(row, row.body.body),
    acceptReviewReadiness:
      row.state === "proposed" ? decisionAcceptReviewReadiness(row, row.body.body, requirement) : null,
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

/**
 * Full list rows. List reads leave the document body out, so the review state is computed from the
 * same Decisions read with their bodies; the body itself stays on the server.
 */
export function decisionFullListRows(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decisions: readonly DecisionProjectionRow[];
  readonly readiness: readonly NonNullable<DecisionProjectionRow["readiness"]>[];
  readonly requirement: DecisionReviewRequirement;
}): readonly DaemonDecisionFullRow[] {
  const withBodies = new Map(
    input.projection
      .readDecisions(input.decisions.map(({ decisionId }) => decisionId))
      .decisions.map((decision) => [decision.decisionId, decision]),
  );
  return input.decisions.map((decision, index) => ({
    ...decision,
    ...decisionReviewState(withBodies.get(decision.decisionId) ?? decision, input.requirement),
    readiness: input.readiness[index]!,
    reviewDispatches: readDecisionReviewDispatches({ rootDir: input.rootDir, projection: input.projection, decision }),
  }));
}

export function readDecisionReviewDispatches(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly decision: DecisionProjectionRow;
}): readonly DaemonDecisionReviewDispatchRow[] {
  return input.projection.readRuntimeDispatchesByDecision(input.decision.decisionId).flatMap((row) => {
    const target = row.event.payload.reviewTarget;
    if (target?.kind !== "decision" || target.decisionId !== input.decision.decisionId) return [];
    const header = row.event.payload,
      stream = readDispatchStreamSummary(input.rootDir, header.dispatchId),
      outcome = row.outcome ?? input.projection.readRuntimeSession(header.runtimeSessionId)?.outcome,
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
        reviewContentDigest: target.digest,
        reportRef: review?.reportRef ?? null,
        reviewer: header.agentName ?? header.agentId ?? null,
        findingCount: review ? review.findings.length : null,
      },
    ];
  });
}
