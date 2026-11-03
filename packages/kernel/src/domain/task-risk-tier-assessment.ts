import { isNonEmptyString, isRecord, hasOnlyFields } from "./contract-validation.ts";
import { isNativeCommitSha } from "./submission-digest.ts";
import type { TaskRiskTierAssessmentV1 } from "./execution.ts";

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function isTaskRiskTierAssessmentV1(value: unknown): value is TaskRiskTierAssessmentV1 {
  return (
    isRecord(value) &&
    hasOnlyFields(value, [
      "schema",
      "declaredTier",
      "effectiveTier",
      "deliveryBaseSha",
      "deliveryHeadSha",
      "matchedPathReviewers",
      "reasons",
      ...(Object.hasOwn(value, "guiAcceptanceRequired") ? ["guiAcceptanceRequired"] : []),
    ]) &&
    value.schema === "task-risk-tier-assessment/v1" &&
    ["low", "medium", "high"].includes(String(value.declaredTier)) &&
    ["low", "medium", "high"].includes(String(value.effectiveTier)) &&
    (value.deliveryBaseSha === null || isNativeCommitSha(value.deliveryBaseSha)) &&
    (value.deliveryHeadSha === null || isNativeCommitSha(value.deliveryHeadSha)) &&
    Array.isArray(value.matchedPathReviewers) &&
    value.matchedPathReviewers.every(
      (lane) =>
        isRecord(lane) &&
        hasOnlyFields(lane, ["agentId", "paths"]) &&
        isNonEmptyString(lane.agentId) &&
        stringArray(lane.paths),
    ) &&
    stringArray(value.reasons) &&
    (value.guiAcceptanceRequired === undefined || typeof value.guiAcceptanceRequired === "boolean")
  );
}

export function isTaskRiskTierAssessmentNonDecreasing(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const declared = riskTierRank(value.declaredTier),
    effective = riskTierRank(value.effectiveTier);
  return declared >= 0 && effective >= declared;
}

function riskTierRank(value: unknown): number {
  return value === "high" ? 2 : value === "medium" ? 1 : value === "low" ? 0 : -1;
}
