// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { currentSubmission, submissionDigest, type SubmissionV1 } from "@harness-anything/kernel";
import {
  riskTierCompletionContract,
  sameFrozenSubmissionCut,
  submissionForRiskTierRetry,
} from "../src/repo-cell-submit.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("a legacy cut keeps its bytes only when the caller explicitly resumes it", () => {
  const assessment: NonNullable<SubmissionV1["riskTierAssessment"]> = {
      schema: "task-risk-tier-assessment/v1",
      declaredTier: "low",
      effectiveTier: "medium",
      deliveryBaseSha: "b".repeat(40),
      deliveryHeadSha: "c".repeat(40),
      matchedPathReviewers: [],
      reasons: [],
    },
    derived = {
      commitSha: "c".repeat(40),
      deliverables: ["README.md"],
      outputs: [],
      completionClaim: "Verified delivery.",
      verificationNotes: ["README checked."],
      knownGaps: [],
      residualRisks: [],
      completionContract: {
        presetSnapshotDigest: digest,
        gates: [],
        closeoutGates: { review: false, consent: false, factDisposition: false, codeDoc: true },
      },
    } as SubmissionV1,
    frozenWithAssessment = { ...derived, riskTierAssessment: assessment },
    historicalFrozen = {
      ...frozenWithAssessment,
      riskTierAssessment: { ...assessment, guiAcceptanceRequired: true },
    } as SubmissionV1,
    { riskTierAssessment: _assessment, ...legacyFrozen } = frozenWithAssessment,
    frozen = legacyFrozen as SubmissionV1;
  assert.equal(sameFrozenSubmissionCut(derived, frozenWithAssessment), true);
  assert.equal(sameFrozenSubmissionCut(derived, historicalFrozen), true);
  let rebuiltContract = false;
  const retry = submissionForRiskTierRetry(
    derived,
    frozen,
    assessment,
    () => {
      rebuiltContract = true;
      return derived.completionContract;
    },
    true,
  );
  assert.equal(rebuiltContract, false);
  assert.equal(retry.riskTierAssessment, undefined);
  assert.equal(submissionDigest(retry), submissionDigest(frozen));
  const restoredHistorical = submissionForRiskTierRetry(
    derived,
    historicalFrozen,
    assessment,
    () => derived.completionContract,
  );
  assert.equal(
    submissionDigest(currentSubmission(restoredHistorical)),
    submissionDigest(currentSubmission(historicalFrozen)),
    "same-cut resume compares the historical frozen bytes and restored current shape consistently",
  );
  rebuiltContract = false;
  const submission = submissionForRiskTierRetry(derived, frozen, assessment, () => {
    rebuiltContract = true;
    return derived.completionContract;
  });
  assert.equal(rebuiltContract, true);
  assert.equal(submission.riskTierAssessment, assessment);
  assert.notEqual(submissionDigest(submission), submissionDigest(frozen));
  assert.equal(
    sameFrozenSubmissionCut({ ...derived, deliverables: ["different-artifact"] }, frozenWithAssessment),
    false,
    "artifact-only cuts with a null commit SHA still require an exact frozen submission match",
  );
  const changedClaim = { ...derived, completionClaim: "Updated delivery claim." };
  assert.equal(sameFrozenSubmissionCut(changedClaim, frozen), false);
  let rebuiltChangedCutContract = false;
  const changedCut = submissionForRiskTierRetry(changedClaim, frozen, assessment, () => {
    rebuiltChangedCutContract = true;
    return derived.completionContract;
  });
  assert.equal(rebuiltChangedCutContract, true);
  assert.equal(changedCut.riskTierAssessment, assessment);
});

test("risk-floor escalation changes the reviewer route without adding consent", () => {
  const contract: SubmissionV1["completionContract"] = {
      presetSnapshotDigest: digest,
      gates: [],
      closeoutGates: { review: false, consent: true, factDisposition: false, codeDoc: true },
    },
    assessment: NonNullable<SubmissionV1["riskTierAssessment"]> = {
      schema: "task-risk-tier-assessment/v1",
      declaredTier: "low",
      effectiveTier: "high",
      deliveryBaseSha: "b".repeat(40),
      deliveryHeadSha: "c".repeat(40),
      matchedPathReviewers: [],
      reasons: ["repository risk floor"],
    },
    escalated = riskTierCompletionContract(contract, assessment),
    medium = riskTierCompletionContract(contract, {
      ...assessment,
      declaredTier: "medium",
      effectiveTier: "medium",
    }),
    mediumEscalated = riskTierCompletionContract(contract, {
      ...assessment,
      declaredTier: "medium",
      effectiveTier: "high",
    }),
    low = riskTierCompletionContract(contract, {
      ...assessment,
      declaredTier: "low",
      effectiveTier: "low",
    }),
    high = riskTierCompletionContract(contract, {
      ...assessment,
      declaredTier: "high",
      effectiveTier: "high",
    });

  assert.equal(escalated.closeoutGates.review, true);
  assert.equal(escalated.closeoutGates.consent, false);
  assert.equal(medium.closeoutGates.review, true);
  assert.equal(medium.closeoutGates.consent, true, "medium keeps its repository-resolved consent gate");
  assert.equal(mediumEscalated.closeoutGates.review, true);
  assert.equal(mediumEscalated.closeoutGates.consent, true, "raising review tier leaves medium consent unchanged");
  assert.equal(low.closeoutGates.review, false);
  assert.equal(low.closeoutGates.consent, false);
  assert.equal(high.closeoutGates.review, true);
  assert.equal(high.closeoutGates.consent, true);
});
