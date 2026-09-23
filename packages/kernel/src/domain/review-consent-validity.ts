export interface ReviewValidityRecord {
  readonly reviewId: string;
  readonly verdict: "approved" | "changes_requested" | "dismissed";
  readonly submissionDigest?: `sha256:${string}`;
}
export interface ReviewDispositionRecord {
  readonly submissionDigest: `sha256:${string}`;
  readonly disposedReviewIds: readonly string[];
  readonly rationale: string;
}
export interface ReviewConsentValidityInput {
  readonly selectedReview: ReviewValidityRecord | undefined;
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
export function reviewConsentConflicts(input: ReviewConsentValidityInput): readonly ReviewConsentConflict[] {
  const selected = input.selectedReview;
  if (!selected || selected.verdict !== "approved" || selected.submissionDigest !== input.currentSubmissionDigest)
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
  const disposed = new Set(
    input.dispositions
      .filter((value) => value.submissionDigest === input.currentSubmissionDigest && value.rationale.trim().length > 0)
      .flatMap((value) => value.disposedReviewIds),
  );
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
