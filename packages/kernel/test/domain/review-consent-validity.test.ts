// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReviewConsentConflicts,
  reviewConsentConflicts,
  type ReviewDispositionRecord,
  type ReviewValidityRecord,
} from "../../src/domain/review-consent-validity.ts";

const digestX = `sha256:${"a".repeat(64)}` as const;
const digestY = `sha256:${"b".repeat(64)}` as const;
const approved = (submissionDigest = digestX): ReviewValidityRecord => ({
  reviewId: "review-approved",
  verdict: "approved",
  submissionDigest,
});
const rejected = (reviewId: string): ReviewValidityRecord => ({
  reviewId,
  verdict: "changes_requested",
  submissionDigest: digestX,
});
const disposition = (...disposedReviewIds: string[]): ReviewDispositionRecord => ({
  submissionDigest: digestX,
  disposedReviewIds,
  rationale: "owner reviewed the disagreement",
});

test("content drift rejects the selected approval and identifies both digests", () => {
  const conflicts = reviewConsentConflicts({
    selectedReview: approved(digestY),
    reviews: [approved(digestY)],
    dispositions: [],
    currentSubmissionDigest: digestX,
  });
  assert.equal(conflicts[0]?.reviewId, "review-approved");
  assert.match(describeReviewConsentConflicts(conflicts), new RegExp(`${digestY}.*${digestX}`, "u"));
});

test("an undisposed changes_requested review blocks consent and complete evaluation", () => {
  const changes = rejected("review-changes");
  const conflicts = reviewConsentConflicts({
    selectedReview: approved(),
    reviews: [approved(), changes],
    dispositions: [],
    currentSubmissionDigest: digestX,
  });
  assert.deepEqual(
    conflicts.map((value) => value.reviewId),
    ["review-changes"],
  );
  assert.match(describeReviewConsentConflicts(conflicts), /verdict=changes_requested/u);
});

test("the current approval without disagreement remains valid", () => {
  assert.deepEqual(
    reviewConsentConflicts({
      selectedReview: approved(),
      reviews: [approved()],
      dispositions: [],
      currentSubmissionDigest: digestX,
    }),
    [],
  );
});

test("override is scoped to named reviews, a non-empty rationale, and the current digest", () => {
  const reviews = [approved(), rejected("review-a"), rejected("review-b")];
  const evaluate = (dispositions: readonly ReviewDispositionRecord[]) =>
    reviewConsentConflicts({ selectedReview: reviews[0], reviews, dispositions, currentSubmissionDigest: digestX });
  assert.deepEqual(evaluate([disposition("review-a", "review-b")]), []);
  assert.deepEqual(evaluate([{ ...disposition("review-a", "review-b"), rationale: " " }]).length, 2);
  assert.deepEqual(
    evaluate([disposition("review-a")]).map((value) => value.reviewId),
    ["review-b"],
  );
  assert.deepEqual(evaluate([{ ...disposition("review-a", "review-b"), submissionDigest: digestY }]).length, 2);
});

test("a changes_requested review arriving after an override remains blocking", () => {
  const conflicts = reviewConsentConflicts({
    selectedReview: approved(),
    reviews: [approved(), rejected("review-before"), rejected("review-after")],
    dispositions: [disposition("review-before")],
    currentSubmissionDigest: digestX,
  });
  assert.deepEqual(
    conflicts.map((value) => value.reviewId),
    ["review-after"],
  );
});
