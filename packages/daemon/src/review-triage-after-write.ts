import { reviewsForExecution, type ExecutionV1, type ReviewV1 } from "@harness-anything/kernel";
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
