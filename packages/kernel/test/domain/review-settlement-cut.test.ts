// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  closeoutReadiness,
  type CloseoutSnapshot,
  type ExecutionV1,
  type ReviewV1,
  submissionDigest,
} from "@harness-anything/kernel";
import { currentCutSettlement } from "../../src/domain/closeout-readiness.ts";
import type { ReviewFindingTriageV1 } from "../../src/domain/review-settlement.ts";

const digest = `sha256:${"b".repeat(64)}` as const,
  commit = "c".repeat(40);

const execution = (reviews: readonly ReviewV1[]): ExecutionV1 =>
  ({
    schema: "execution/v1",
    executionId: "exec-categorized",
    taskId: "task-categorized",
    iteration: 1,
    state: "submitted",
    actor: { principal: { personId: "person_zeyu" }, executor: null },
    deliveryBaseline: { kind: "commit", commitSha: "a".repeat(40) },
    submission: {
      commitSha: commit,
      deliverables: ["README.md"],
      outputs: [],
      completionClaim: "done",
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: {
        presetSnapshotDigest: digest,
        gates: [],
        closeoutGates: { review: true, consent: false, factDisposition: false, codeDoc: false },
      },
    },
    submittedAt: "2026-10-26T00:00:00.000Z",
    gateRuns: [],
    reviews,
  }) as unknown as ExecutionV1;

const review = (findings: ReviewV1["findings"], verdict: ReviewV1["verdict"] = "approved"): ReviewV1 =>
  ({
    schema: "review/v1",
    reviewId: "review-cut-1",
    taskId: "task-categorized",
    executionId: "exec-categorized",
    verdict,
    actor: { principal: { personId: "person_zeyu" }, executor: { kind: "agent", id: "reviewer" } },
    capabilityRef: "execution-review@v1",
    reason: "checked",
    evidenceChecked: ["README.md"],
    commitSha: commit,
    iteration: 1,
    contentDigest: digest,
    submissionDigest: submissionDigest(execution([]).submission!),
    reviewedAt: "2026-10-27T00:01:00.000Z",
    findings,
    resolutions: [],
  }) as unknown as ReviewV1;

/** The cut's own submission digest; B-3 made settlement compare this, so a preset digest no longer matches. */
const cutDigest = (): `sha256:${string}` => submissionDigest(execution([]).submission!);

const triage = (
  findingId: string,
  selected: ReviewFindingTriageV1["selected"],
  probability = 0.95,
): ReviewFindingTriageV1 => ({
  schema: "review-finding-triage/v1",
  reviewId: "review-cut-1",
  findingId,
  targetDigest: cutDigest(),
  selected,
  probabilities: {
    blocker: 0,
    non_blocking: 0,
    nit: 0,
    pre_existing: 0,
    false_positive: 0,
    [selected]: probability,
  } as ReviewFindingTriageV1["probabilities"],
  model: "triage-model",
  bindingDigest: digest,
  decidedAt: "2026-10-26T00:02:00.000Z",
});

const snapshot = (reviews: readonly ReviewV1[], triages: readonly ReviewFindingTriageV1[] = []): CloseoutSnapshot => {
  const cut = execution(reviews);
  return {
    task: {
      status: "in_review",
      iteration: 1,
      completionGateIds: [],
      taskId: "task-categorized",
      taskClass: "standard",
    },
    executions: [cut],
    reviews,
    consents: [],
    reviewFindingTriages: triages,
    gateWitnesses: [],
  } as unknown as CloseoutSnapshot;
};

test("a cut carrying a categorized finding passes only after its triage disposes it", () => {
  const pending = review([{ findingId: "F1", blocking: true, text: "Drops the fence.", category: "correctness" }]);
  assert.equal(closeoutReadiness(snapshot([pending])).blocker, "review", "missing triage is unresolved review");

  // The reviewer claimed a blocker, so one triage pass is not enough: an independent Critic must
  // agree before the finding can be downgraded (CH4). Its agreement unlocks the review gate.
  const confirmed = {
    ...triage("F1", "non_blocking", 0.6),
    critic: {
      selected: "non_blocking" as const,
      probabilities: {
        blocker: 0.05,
        non_blocking: 0.9,
        nit: 0.02,
        pre_existing: 0.02,
        false_positive: 0.01,
      },
      model: "critic-model",
      bindingDigest: digest,
      decidedAt: "2026-10-26T00:03:00.000Z",
    },
  };
  const passed = closeoutReadiness(snapshot([pending], [confirmed]));
  assert.notEqual(passed.blocker, "review", "a Critic-confirmed non-blocking finding unlocks the review gate");

  const blocked = closeoutReadiness(snapshot([pending], [triage("F1", "blocker")]));
  assert.equal(blocked.blocker, "review", "a blocker keeps the cut at review");
});

test("a cut with no categorized finding keeps the per-review approval path", () => {
  const plain = review([]);
  assert.equal(currentCutSettlement([plain], execution([plain]), []), null);
  assert.notEqual(closeoutReadiness(snapshot([plain])).blocker, "review");
});

test("only findings bound to this execution and iteration enter the cut's settlement", () => {
  const priorCut = {
      ...review([{ findingId: "F1", blocking: true, text: "old", category: "correctness" }]),
      executionId: "exec-old",
    },
    current = execution([review([])]);
  assert.equal(currentCutSettlement([priorCut], current, [triage("F1", "blocker")]), null);
});

test("discarded findings never gate a cut, so formatting cannot block completion", () => {
  const onlyStyle = review([{ findingId: "S1", blocking: true, text: "two spaces", category: "style" }]);
  const settlement = currentCutSettlement([onlyStyle], execution([onlyStyle]), []);
  assert.equal(settlement?.outcome, "passed");
  assert.deepEqual(
    settlement?.discarded.map(({ findingId }) => findingId),
    ["S1"],
  );
  assert.notEqual(closeoutReadiness(snapshot([onlyStyle])).blocker, "review");
});

test("a historical finding with no category is stranded until the owner disposes that review", () => {
  // B-2: `category` did not exist when historical reviews were written, so every one of those
  // findings reads as `category: undefined`. Without an exit the new predicate retroactively turns
  // them into open review on cuts that already passed, and nothing the owner can do clears it.
  const historical = review([{ findingId: "F1", blocking: false, text: "Old finding, no category." }]),
    cut = execution([historical]),
    submission = submissionDigest(cut.submission!),
    stranded = snapshot([historical]);
  assert.equal(closeoutReadiness(stranded).blocker, "review", "an unfiled finding is unresolved review");

  const disposed = snapshot([historical]);
  (disposed as unknown as { reviewDispositions: unknown[] }).reviewDispositions = [
    {
      schema: "review-disposition/v1",
      dispositionId: "disposition-1",
      taskId: "task-categorized",
      executionId: "exec-categorized",
      iteration: 1,
      submissionDigest: submission,
      disposedReviewIds: ["review-cut-1"],
      rationale: "Reviewed and accepted at the time; the category field did not exist then.",
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      source: "local",
      disposedAt: "2026-10-27T00:05:00.000Z",
    },
  ];
  assert.notEqual(
    closeoutReadiness(disposed).blocker,
    "review",
    "the owner's disposition is the exit for a review filed before categories existed",
  );

  // A disposition pinned to another submission digest is not a disposition of this cut.
  const otherCut = snapshot([historical]);
  (otherCut as unknown as { reviewDispositions: unknown[] }).reviewDispositions = [
    {
      schema: "review-disposition/v1",
      dispositionId: "disposition-2",
      taskId: "task-categorized",
      executionId: "exec-categorized",
      iteration: 1,
      submissionDigest: `sha256:${"9".repeat(64)}`,
      disposedReviewIds: ["review-cut-1"],
      rationale: "An earlier cut's disposition.",
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      source: "local",
      disposedAt: "2026-10-27T00:05:00.000Z",
    },
  ];
  assert.equal(closeoutReadiness(otherCut).blocker, "review", "another cut's disposition cannot release this one");
});
