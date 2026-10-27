import {
  decisionCutReviewFindings,
  reviewsForExecution,
  type ExecutionV1,
  type ReviewV1,
} from "@harness-anything/kernel";
import type { DecisionProviderRecord } from "@harness-anything/kernel";
import type { DecisionPort } from "./decision-provider.ts";
import {
  makeReviewTriageProducer,
  reviewFindingThresholdsFromSettings,
  type ReviewTriageProducerInput,
} from "./review-triage-producer.ts";

/**
 * Produce the triage records for a review that just landed (dec_6A77D43B8523823ABA1F5E4D3C CH3/CH5).
 *
 * The review is already durable when this runs, so a failure here must never fail the review: the
 * review is a fact, and the missing triage is the thing a person has to resolve. The journal stays
 * unwritten in that case, which is exactly what keeps `settleReviewFindings` escalating the cut
 * instead of passing it.
 *
 * Only a review that actually carried a categorized finding can enter settlement, so that gate is
 * checked before the provider is asked anything.
 */
export async function settleReviewedCutAfterWrite(input: {
  readonly rootDir: string;
  readonly readSnapshot: (taskId: string) => Promise<{
    readonly executions?: readonly ExecutionV1[];
    readonly reviews?: readonly ReviewV1[];
  }>;
  readonly receipt: object;
  readonly decisionProviders: {
    readonly list: () => readonly DecisionProviderRecord[];
    readonly port: DecisionPort;
  };
  readonly now: () => string;
  /** The repository Settings for this write, so a repository's higher floors are honored. */
  readonly settings?: Parameters<typeof reviewFindingThresholdsFromSettings>[0];
}): Promise<void> {
  const receipt = input.receipt as { readonly taskId?: unknown; readonly executionId?: unknown },
    taskId = typeof receipt.taskId === "string" ? receipt.taskId : undefined,
    executionId = typeof receipt.executionId === "string" ? receipt.executionId : undefined;
  if (taskId === undefined || executionId === undefined) return;
  const snapshot = await input.readSnapshot(taskId),
    execution = snapshot.executions?.find((value) => value.executionId === executionId),
    reviews = snapshot.reviews ?? [];
  if (!execution) return;
  // The cut's own reviews, pinned the same way the closeout judgment pins them.
  const cutReviews = reviewsForExecution(reviews, execution);
  if (!cutReviews.some((review) => (review.findings ?? []).some((finding) => finding.category !== undefined))) return;
  await makeReviewTriageProducer({
    rootDir: input.rootDir,
    providers: input.decisionProviders,
    now: input.now,
    rulesVersion: "review-rules/v1",
  } satisfies ReviewTriageProducerInput).settleReviewCut({
    taskId,
    execution,
    reviews: cutReviews,
    thresholds: reviewFindingThresholdsFromSettings(input.settings ?? null),
  });
}

/**
 * Produce the triage records for a Decision review that just landed (B-1).
 *
 * The Task side has had this since the first rework; the Decision side never did, while the same
 * change started asking Decision reviewers for a `category`. A categorized Decision finding
 * therefore had no record: it could never settle, and the owner's override could not clear it either
 * because an override disposes reviews, not unfiled findings.
 *
 * Like the Task path, the review is already durable here, so a failure must not fail the write. An
 * unwritten journal is what keeps the accept judgment escalating instead of passing.
 */
export async function settleReviewedDecisionAfterWrite(input: {
  readonly rootDir: string;
  readonly readDecision: (decisionId: string) => Promise<
    | {
        readonly decision: Parameters<typeof decisionCutReviewFindings>[0];
        /** The Decision's current content digest, as the review read surfaces compute it. */
        readonly digest: `sha256:${string}`;
      }
    | undefined
  >;
  readonly receipt: object;
  readonly decisionProviders: {
    readonly list: () => readonly DecisionProviderRecord[];
    readonly port: DecisionPort;
  };
  readonly now: () => string;
  readonly settings?: Parameters<typeof reviewFindingThresholdsFromSettings>[0];
}): Promise<void> {
  const receipt = input.receipt as { readonly decisionId?: unknown },
    decisionId = typeof receipt.decisionId === "string" ? receipt.decisionId : undefined;
  if (decisionId === undefined) return;
  const read = await input.readDecision(decisionId);
  if (read === undefined) return;
  // Cheap scan first: an uncategorized Decision cut settles to null whatever the digest says, and
  // the digest hashes the whole body (G38 measured this exact call on the agenda read).
  if (!read.decision.reviews.some((review) => review.findings.some((finding) => finding.category !== undefined)))
    return;
  await makeReviewTriageProducer({
    rootDir: input.rootDir,
    providers: input.decisionProviders,
    now: input.now,
    rulesVersion: "review-rules/v1",
  } satisfies ReviewTriageProducerInput).settleDecisionCut({
    decision: read.decision,
    digest: read.digest,
    thresholds: reviewFindingThresholdsFromSettings(input.settings ?? null),
  });
}
