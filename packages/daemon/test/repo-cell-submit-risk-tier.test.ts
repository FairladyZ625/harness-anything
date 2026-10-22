// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { submissionDigest, type SubmissionV1 } from "@harness-anything/kernel";
import type { PresetSnapshotV1 } from "@harness-anything/preset";
import {
  riskTierCompletionContract,
  sameFrozenSubmissionCut,
  submissionForRiskTierRetry,
} from "../src/repo-cell-submit.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import type { Snapshot } from "../src/repo-cell-types.ts";
import { readDefaultVerticalDefinition } from "../src/vertical-declaration-action.ts";

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
      guiAcceptanceRequired: false,
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
    { riskTierAssessment: _assessment, ...legacyFrozen } = frozenWithAssessment,
    frozen = legacyFrozen as SubmissionV1;
  assert.equal(sameFrozenSubmissionCut(derived, frozenWithAssessment), true);
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

test("GUI acceptance resolves from the current vertical when the task froze an older preset", () => {
  const vertical = readDefaultVerticalDefinition(),
    oldPreset: PresetSnapshotV1 = {
      schema: "preset-snapshot/v1",
      identity: { id: "standard-task", version: "1.0.0", verticalId: vertical.id, layer: "bundled" },
      completion: {
        sources: vertical.completion.sources,
        gates: Object.fromEntries(
          Object.entries(vertical.completion.gates).filter(([gateId]) => gateId !== "gui-acceptance"),
        ),
        closeoutDefaults: vertical.completion.closeoutDefaults,
      },
      completionPackages: {},
      profile: { id: "baseline", outputShape: "repository-diff", completionGateIds: [] },
      guidance: { description: "", whenToUse: "", bodySha256: "" },
      scaffold: { baseVersion: "software-coding/v1", overlayDigest: null, resolvedSelectionDigest: digest },
      templates: [],
    },
    taskSnapshot = {
      task: { metadata: { verticalId: vertical.id }, presetSnapshotDigest: digest },
    } as unknown as Snapshot,
    contract: SubmissionV1["completionContract"] = {
      presetSnapshotDigest: digest,
      gates: [],
      closeoutGates: { review: false, consent: false, factDisposition: false, codeDoc: true },
    },
    assessment: NonNullable<SubmissionV1["riskTierAssessment"]> = {
      schema: "task-risk-tier-assessment/v1",
      declaredTier: "low",
      effectiveTier: "low",
      deliveryBaseSha: "b".repeat(40),
      deliveryHeadSha: "c".repeat(40),
      matchedPathReviewers: [],
      reasons: [],
      guiAcceptanceRequired: true,
    },
    projection = {
      readPresetSnapshot: () => ({ status: "ready" as const, snapshot: oldPreset, watermark: 1, sourceRevision: 1 }),
      readDocument: () => ({
        document: {
          body: JSON.stringify({ schema: "repository-vertical-declaration/v1", revision: 1, definition: vertical }),
        },
      }),
    },
    cell = {
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      settings: { readRepository: () => ({ gates: [] }) },
      projection,
    } as unknown as Pick<RepoCellOperationalContext, "cellCodedError" | "settings" | "projection">;

  assert.equal(oldPreset.completion.gates["gui-acceptance"], undefined);
  const resolved = riskTierCompletionContract(cell, taskSnapshot, contract, assessment),
    gate = resolved.gates.find((candidate) => candidate.gateId === "gui-acceptance");
  assert.equal(gate?.appliesTo, "code");
  assert.equal(gate?.witness.adapterId, "manual-attest");
  assert.equal(resolved.presetSnapshotDigest, digest);
});
