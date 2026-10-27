import type { ReviewV1, ReviewVerdict } from "./review.ts";

export interface ReviewValidityRecord {
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly submissionDigest?: `sha256:${string}`;
}
export interface ReviewDispositionRecord {
  readonly submissionDigest: `sha256:${string}`;
  readonly disposedReviewIds: readonly string[];
  readonly rationale: string;
}
export interface ReviewConsentValidityInput {
  readonly selectedReview: ReviewValidityRecord | undefined;
  readonly allowSelectedChangesRequested?: boolean;
  readonly reviews: readonly ReviewValidityRecord[];
  readonly dispositions: readonly ReviewDispositionRecord[];
  readonly currentSubmissionDigest: `sha256:${string}`;
}
export interface ReviewConsentConflict {
  readonly reviewId: string;
  readonly verdict: ReviewValidityRecord["verdict"];
  readonly reviewSubmissionDigest: `sha256:${string}` | undefined;
  readonly currentSubmissionDigest: `sha256:${string}`;
}
/** Only changes-requested reviews or approved reviews with pre-triage findings can be disposed. */
export function isReviewDispositionEligible(review: Pick<ReviewV1, "verdict" | "findings">): boolean {
  return (
    review.verdict === "changes_requested" ||
    (review.verdict === "approved" && (review.findings ?? []).some((finding) => finding.category === undefined))
  );
}
/** Review ids removed from a cut by its dispositions: bound to the current submission digest and stated with a rationale. */
export function disposedReviewIdsForSubmission(
  dispositions: readonly ReviewDispositionRecord[],
  currentSubmissionDigest: `sha256:${string}`,
): Set<string> {
  return new Set(
    dispositions
      .filter((value) => value.submissionDigest === currentSubmissionDigest && value.rationale.trim().length > 0)
      .flatMap((value) => value.disposedReviewIds),
  );
}
export function reviewConsentConflicts(input: ReviewConsentValidityInput): readonly ReviewConsentConflict[] {
  const selected = input.selectedReview,
    disposed = disposedReviewIdsForSubmission(input.dispositions, input.currentSubmissionDigest);
  if (
    !selected ||
    (selected.verdict !== "approved" &&
      !(
        input.allowSelectedChangesRequested === true &&
        selected.verdict === "changes_requested" &&
        disposed.has(selected.reviewId)
      )) ||
    selected.submissionDigest !== input.currentSubmissionDigest
  )
    return selected
      ? [
          {
            reviewId: selected.reviewId,
            verdict: selected.verdict,
            reviewSubmissionDigest: selected.submissionDigest,
            currentSubmissionDigest: input.currentSubmissionDigest,
          },
        ]
      : [];
  return input.reviews
    .filter(
      (review) =>
        review.verdict === "changes_requested" &&
        review.submissionDigest === input.currentSubmissionDigest &&
        !disposed.has(review.reviewId),
    )
    .map((review) => ({
      reviewId: review.reviewId,
      verdict: review.verdict,
      reviewSubmissionDigest: review.submissionDigest,
      currentSubmissionDigest: input.currentSubmissionDigest,
    }));
}
export function describeReviewConsentConflicts(conflicts: readonly ReviewConsentConflict[]): string {
  return conflicts
    .map(
      (conflict) =>
        `reviewId=${conflict.reviewId} verdict=${conflict.verdict} ` +
        `reviewSubmissionDigest=${conflict.reviewSubmissionDigest ?? "legacy-unpinned"} ` +
        `currentSubmissionDigest=${conflict.currentSubmissionDigest}`,
    )
    .join("; ");
}
