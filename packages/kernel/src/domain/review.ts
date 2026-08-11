import { isNativeCommitSha } from "./execution.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorAxes } from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";

export const reviewVerdicts = ["approved", "changes_requested", "dismissed"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];

export const reviewKinds = ["anti_entropy", "acceptance"] as const;
export type ReviewKind = (typeof reviewKinds)[number];
export const reviewActorRoles = ["anti_entropy", "acceptance"] as const;
export type ReviewActorRole = (typeof reviewActorRoles)[number];
export interface ReviewV1 { readonly schema: "review/v1"; readonly reviewId: string; readonly taskId: string; readonly executionId: string; readonly kind: ReviewKind; readonly verdict: ReviewVerdict; readonly actor: ActorAxes; readonly actorRole: ReviewActorRole; readonly capabilityRef: string; readonly reason: string; readonly evidenceChecked: readonly string[]; readonly commitSha: string; readonly iteration: 0 | 1; readonly archiveWarningsAcknowledged: boolean; readonly reviewedAt: string }
export const REVIEW_V1_SCHEMA = Object.freeze({ id: "Review/v1", required: Object.freeze(["schema", "reviewId", "taskId", "executionId", "kind", "verdict", "actor", "actorRole", "capabilityRef", "reason", "evidenceChecked", "commitSha", "iteration", "archiveWarningsAcknowledged", "reviewedAt"]), kinds: reviewKinds, verdicts: reviewVerdicts });
export function validateReviewV1(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, REVIEW_V1_SCHEMA.required)) return [{ code: "invalid_review", message: "Review/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "review/v1") issues.push({ code: "invalid_schema", message: "Review must use review/v1" });
  if (!isNonEmptyString(value.reviewId) || !isNonEmptyString(value.taskId) || !isNonEmptyString(value.executionId)
    || !isNonEmptyString(value.capabilityRef) || !isNonEmptyString(value.reason) || !isNonEmptyString(value.reviewedAt)) issues.push({ code: "invalid_review", message: "review identity and reason are required" });
  if (!(reviewKinds as readonly unknown[]).includes(value.kind) || !(reviewVerdicts as readonly unknown[]).includes(value.verdict)
    || !(reviewActorRoles as readonly unknown[]).includes(value.actorRole) || value.actorRole !== value.kind) issues.push({ code: "invalid_review", message: "review kind, verdict, or actor role is invalid" });
  if (!Array.isArray(value.evidenceChecked) || value.evidenceChecked.some((item) => !isNonEmptyString(item)) || !isNativeCommitSha(value.commitSha)
    || (value.iteration !== 0 && value.iteration !== 1) || typeof value.archiveWarningsAcknowledged !== "boolean") issues.push({ code: "invalid_review", message: "review evidence, commit, iteration, or acknowledgement is invalid" });
  issues.push(...validateActorAxes(value.actor));
  return issues;
}
