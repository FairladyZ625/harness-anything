import { isNativeCommitSha, submissionDigest } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution, SubmissionDigest } from "./execution.ts";
import { digest } from "./digest.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorAxes } from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { hasRequiredFields, validateWriteSource } from "./write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { timestamp } from "./timestamp.ts";
import { reviewConsentConflicts } from "./review-consent-validity.ts";
export const reviewVerdicts = ["approved", "changes_requested", "dismissed"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];
export interface ReviewV1 {
  readonly schema: "review/v1";
  readonly reviewId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly verdict: ReviewVerdict;
  readonly actor: ActorAxes;
  readonly capabilityRef: string;
  readonly reason: string;
  readonly evidenceChecked: readonly string[];
  readonly commitSha: string | null;
  readonly iteration: number;
  readonly contentDigest: `sha256:${string}`;
  readonly submissionDigest: SubmissionDigest;
  readonly reviewedAt: string;
}
export interface ReviewConsentV1 {
  readonly schema: "review-consent/v1";
  readonly consentId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly reviewId: string;
  readonly reviewDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
  readonly submissionDigest?: SubmissionDigest;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly consentedAt: string;
}
export interface ReviewDispositionV1 {
  readonly schema: "review-disposition/v1";
  readonly dispositionId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly iteration: number;
  readonly submissionDigest: SubmissionDigest;
  readonly disposedReviewIds: readonly string[];
  readonly rationale: string;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly disposedAt: string;
}
export function validateReviewDispositionV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const fields = [
    "schema",
    "dispositionId",
    "taskId",
    "executionId",
    "iteration",
    "submissionDigest",
    "disposedReviewIds",
    "rationale",
    "actor",
    "source",
    "disposedAt",
  ] as const;
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields(value, fields) : hasOnlyFields(value, fields)))
    return [invalidReviewIssue("ReviewDisposition/v1 fields are incomplete or unknown")];
  const valid =
    value.schema === "review-disposition/v1" &&
    [value.dispositionId, value.taskId, value.executionId, value.rationale].every(isNonEmptyString) &&
    Number.isSafeInteger(value.iteration) &&
    Number(value.iteration) >= 0 &&
    digest(value.submissionDigest) &&
    Array.isArray(value.disposedReviewIds) &&
    value.disposedReviewIds.length > 0 &&
    new Set(value.disposedReviewIds).size === value.disposedReviewIds.length &&
    value.disposedReviewIds.every(isNonEmptyString) &&
    timestamp(value.disposedAt) &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0;
  return valid
    ? []
    : [invalidReviewIssue("review disposition must bind named reviews, rationale, content cut, actor, and source")];
}
export interface ConsentedApprovedReview {
  readonly review: ReviewV1;
  readonly consent: ReviewConsentV1;
}
export const REVIEW_V1_SCHEMA = Object.freeze({
  id: "Review/v1",
  required: Object.freeze([
    "schema",
    "reviewId",
    "taskId",
    "executionId",
    "verdict",
    "actor",
    "capabilityRef",
    "reason",
    "evidenceChecked",
    "commitSha",
    "iteration",
    "contentDigest",
    "submissionDigest",
    "reviewedAt",
  ]),
  verdicts: reviewVerdicts,
  inputRequired: Object.freeze(["verdict", "reason", "evidenceChecked"] as const),
});
export const REVIEW_CONSENT_V1_SCHEMA = Object.freeze({
  id: "ReviewConsent/v1",
  required: Object.freeze([
    "schema",
    "consentId",
    "taskId",
    "executionId",
    "reviewId",
    "reviewDigest",
    "contentDigest",
    "submissionDigest",
    "actor",
    "source",
    "consentedAt",
  ]),
});
export function validateReviewV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  const historicalFields = REVIEW_V1_SCHEMA.required.filter((field) => field !== "submissionDigest");
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields(value, historicalFields) : hasOnlyFields(value, REVIEW_V1_SCHEMA.required))
  )
    return [invalidReviewIssue("Review/v1 fields are incomplete or unknown")];
  const issues: ContractValidationIssue[] = [];
  if (
    value.schema !== "review/v1" ||
    !isNonEmptyString(value.reviewId) ||
    !isNonEmptyString(value.taskId) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.capabilityRef) ||
    !isNonEmptyString(value.reason) ||
    !timestamp(value.reviewedAt) ||
    !reviewVerdicts.includes(value.verdict as ReviewVerdict)
  )
    issues.push(invalidReviewIssue("review identity, verdict, and reason are required"));
  if (
    !Array.isArray(value.evidenceChecked) ||
    value.evidenceChecked.some((item) => !isNonEmptyString(item)) ||
    (value.commitSha === null ? !digest(value.submissionDigest) : !isNativeCommitSha(value.commitSha)) ||
    !Number.isSafeInteger(value.iteration) ||
    Number(value.iteration) < 0 ||
    !digest(value.contentDigest) ||
    (value.submissionDigest !== undefined && !digest(value.submissionDigest))
  )
    issues.push(invalidReviewIssue("review content cut, evidence, commit, or iteration is invalid"));
  issues.push(...validateActorAxes(value.actor, allowUnknownFields));
  return issues;
}
export function validateReviewConsentV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const historicalFields = REVIEW_CONSENT_V1_SCHEMA.required.filter((field) => field !== "submissionDigest");
  if (
    !isRecord(value) ||
    !(allowUnknownFields
      ? hasRequiredFields(value, historicalFields)
      : hasOnlyFields(value, REVIEW_CONSENT_V1_SCHEMA.required))
  )
    return [invalidReviewIssue("ReviewConsent/v1 fields are incomplete or unknown")];
  const valid =
    value.schema === "review-consent/v1" &&
    [value.consentId, value.taskId, value.executionId, value.reviewId].every(isNonEmptyString) &&
    timestamp(value.consentedAt) &&
    digest(value.reviewDigest) &&
    digest(value.contentDigest) &&
    (value.submissionDigest === undefined || digest(value.submissionDigest)) &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0;
  return valid ? [] : [invalidReviewIssue("consent must bind review/content digests, execution, actor, and source")];
}
export function approvedReviewHistoryForExecution(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
): readonly ReviewV1[] {
  return reviews.filter(
    (review) =>
      review.executionId === execution.executionId &&
      review.verdict === "approved" &&
      review.iteration === execution.iteration,
  );
}

export function approvedReviewsForExecution(reviews: readonly ReviewV1[], execution: ExecutionV1): readonly ReviewV1[] {
  return reviewsForExecution(reviews, execution).filter((review) => review.verdict === "approved");
}

export function reviewsForExecution(reviews: readonly ReviewV1[], execution: ExecutionV1): readonly ReviewV1[] {
  if (!execution.submission || !execution.submittedAt) return [];
  const pinned = submissionDigest(execution.submission),
    submittedAt = Date.parse(execution.submittedAt);
  return reviews.filter(
    (review) =>
      review.executionId === execution.executionId &&
      review.iteration === execution.iteration &&
      review.commitSha === execution.submission?.commitSha &&
      Date.parse(review.reviewedAt) >= submittedAt &&
      (review.submissionDigest === undefined || review.submissionDigest === pinned),
  );
}

/** Approved Reviews of the current submission that no undisposed changes_requested on that cut contradicts. */
export function settledApprovedReviewsForExecution(
  reviews: readonly ReviewV1[],
  execution: ProjectedExecution,
  dispositions: readonly ReviewDispositionV1[] = [],
): readonly ReviewV1[] {
  if (execution.schema !== "execution/v1" || !execution.submission) return [];
  const current = reviewsForExecution(reviews, execution),
    currentSubmissionDigest = submissionDigest(execution.submission);
  return current.filter(
    (review) =>
      review.verdict === "approved" &&
      reviewConsentConflicts({ selectedReview: review, reviews: current, dispositions, currentSubmissionDigest })
        .length === 0,
  );
}

export function consentedApprovedReviewForExecution(
  reviews: readonly ReviewV1[],
  consents: readonly ReviewConsentV1[],
  execution: ExecutionV1,
  dispositions: readonly ReviewDispositionV1[] = [],
): ConsentedApprovedReview | undefined {
  if (!execution.submission || !execution.submittedAt) return undefined;
  const approved = new Map(
      settledApprovedReviewsForExecution(reviews, execution, dispositions).map((review) => [review.reviewId, review]),
    ),
    currentSubmissionDigest = submissionDigest(execution.submission),
    submittedAt = Date.parse(execution.submittedAt);
  for (let index = consents.length - 1; index >= 0; index -= 1) {
    const consent = consents[index]!;
    if (consent.executionId !== execution.executionId || Date.parse(consent.consentedAt) < submittedAt) continue;
    const review = approved.get(consent.reviewId);
    if (
      review &&
      (consent.submissionDigest === currentSubmissionDigest || consent.submissionDigest === undefined) &&
      consent.reviewDigest === reviewDigest(review) &&
      consent.contentDigest === review.contentDigest
    )
      return { review, consent };
  }
  return undefined;
}
export function reviewDigest(review: ReviewV1): `sha256:${string}` {
  return `sha256:${sha256Text(stableStringify(review))}`;
}

function invalidReviewIssue(message: string): ContractValidationIssue {
  return { code: "invalid_review", message };
}
