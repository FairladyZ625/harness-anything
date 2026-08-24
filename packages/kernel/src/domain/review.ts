import { isNativeCommitSha } from "./execution.ts";
import { digest } from "./digest.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorAxes } from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { hasRequiredFields, validateWriteSource } from "./write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
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
  readonly commitSha: string;
  readonly iteration: 0 | 1;
  readonly contentDigest: `sha256:${string}`;
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
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly consentedAt: string;
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
    "reviewedAt",
  ]),
  verdicts: reviewVerdicts,
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
    "actor",
    "source",
    "consentedAt",
  ]),
});
export function validateReviewV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, REVIEW_V1_SCHEMA.required))
    return [invalidReviewIssue("Review/v1 fields are incomplete or unknown")];
  const issues: ContractValidationIssue[] = [];
  if (
    value.schema !== "review/v1" ||
    !isNonEmptyString(value.reviewId) ||
    !isNonEmptyString(value.taskId) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.capabilityRef) ||
    !isNonEmptyString(value.reason) ||
    !isNonEmptyString(value.reviewedAt) ||
    !reviewVerdicts.includes(value.verdict as ReviewVerdict)
  )
    issues.push(invalidReviewIssue("review identity, verdict, and reason are required"));
  if (
    !Array.isArray(value.evidenceChecked) ||
    value.evidenceChecked.some((item) => !isNonEmptyString(item)) ||
    !isNativeCommitSha(value.commitSha) ||
    (value.iteration !== 0 && value.iteration !== 1) ||
    !digest(value.contentDigest)
  )
    issues.push(invalidReviewIssue("review content cut, evidence, commit, or iteration is invalid"));
  issues.push(...validateActorAxes(value.actor, allowUnknownFields));
  return issues;
}
export function validateReviewConsentV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, REVIEW_CONSENT_V1_SCHEMA.required)
  )
    return [invalidReviewIssue("ReviewConsent/v1 fields are incomplete or unknown")];
  const valid =
    value.schema === "review-consent/v1" &&
    [value.consentId, value.taskId, value.executionId, value.reviewId, value.consentedAt].every(isNonEmptyString) &&
    digest(value.reviewDigest) &&
    digest(value.contentDigest) &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0;
  return valid ? [] : [invalidReviewIssue("consent must bind review/content digests, execution, actor, and source")];
}
export function approvedReviewsForCut(
  reviews: readonly ReviewV1[],
  executionId: string,
  commitSha: string,
  iteration: number,
): readonly ReviewV1[] {
  return reviews.filter(
    (review) =>
      review.executionId === executionId &&
      review.verdict === "approved" &&
      review.commitSha === commitSha &&
      review.iteration === iteration,
  );
}
export function consentedApprovedReview(
  reviews: readonly ReviewV1[],
  consents: readonly ReviewConsentV1[],
  executionId: string,
  commitSha: string,
  iteration: number,
): ConsentedApprovedReview | undefined {
  const approved = new Map(
    approvedReviewsForCut(reviews, executionId, commitSha, iteration).map((review) => [review.reviewId, review]),
  );
  for (let index = consents.length - 1; index >= 0; index -= 1) {
    const consent = consents[index]!;
    if (consent.executionId !== executionId) continue;
    const review = approved.get(consent.reviewId);
    if (review && consent.reviewDigest === reviewDigest(review) && consent.contentDigest === review.contentDigest)
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
