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
import {
  reduceTaskEvent,
  applyTransition,
  normalizeTaskLifecycleCommand,
  reviewDigest,
  type ReviewConsentProof,
} from "../../src/domain/task-lifecycle.contract.ts";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

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

test("the task owner can adjudicate one escalated finding through review consent", () => {
  const { snapshot: original } = lifecycleFixture({ complete: false }),
    recorded = original.reviews[0]!,
    escalated = {
      ...recorded,
      findings: [
        {
          findingId: "F-escalated",
          blocking: false,
          text: "The triage could not classify this.",
          category: "correctness" as const,
        },
      ],
    },
    before = { ...original, reviews: [escalated], consents: [], reviewFindingTriages: [] },
    command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: before.revision,
        },
        {
          type: "RecordReviewConsent" as const,
          taskId: escalated.taskId,
          executionId: escalated.executionId,
          reviewId: escalated.reviewId,
          consentId: "consent-owner-finding-ruling",
          reviewDigest: reviewDigest(escalated),
          contentDigest: escalated.contentDigest,
          findingId: "F-escalated",
          findingDisposition: "false_positive" as const,
          rationale: "The anchored code path proves this finding is not reproducible.",
        },
      ),
      eventId: "event-owner-finding-ruling",
      workspaceRevision: before.revision + 1,
      occurredAt: "2026-10-27T01:00:00.000Z",
    };

  assert.equal(
    closeoutReadiness(before).blocker,
    "review",
    "an approved review with an escalated finding remains unresolved before the owner writes",
  );
  const result = applyTransition(before, command, {
    actorBinding: implementer,
    capability: "execution-consent@v1",
    capabilityRef: "cap-consent-owner-finding-ruling",
    reviewFindingTriages: [],
  } satisfies ReviewConsentProof);
  const stored = result.snapshot.reviewDispositions?.[0];
  assert.deepEqual(
    {
      targetDigest: stored?.submissionDigest,
      reviewId: stored?.findingRuling?.reviewId,
      findingId: stored?.findingRuling?.findingId,
      disposition: stored?.findingRuling?.disposition,
      rationale: stored?.rationale,
    },
    {
      targetDigest: submissionDigest(result.snapshot.executions[0]!.submission!),
      reviewId: escalated.reviewId,
      findingId: "F-escalated",
      disposition: "false_positive",
      rationale: "The anchored code path proves this finding is not reproducible.",
    },
  );
  assert.notEqual(closeoutReadiness(result.snapshot).blocker, "review");
  assert.equal(result.snapshot.reviewDispositions?.[0]?.disposedReviewIds.length, 0);
  assert.equal(
    reduceTaskEvent(before, result.event).reviewDispositions?.[0]?.findingRuling?.findingId,
    "F-escalated",
    "the owner ruling survives replay of the admitted event",
  );
  const secondRuling = normalizeTaskLifecycleCommand(
    {
      workspaceId: "workspace-1",
      actor: implementer,
      source: "local",
      expectedRevision: result.snapshot.revision,
    },
    {
      type: "RecordReviewConsent" as const,
      taskId: escalated.taskId,
      executionId: escalated.executionId,
      reviewId: escalated.reviewId,
      consentId: "consent-owner-finding-ruling-twice",
      reviewDigest: reviewDigest(escalated),
      contentDigest: escalated.contentDigest,
      findingId: "F-escalated",
      findingDisposition: "nit" as const,
      rationale: "A second answer must not replace the first.",
    },
  );
  assert.throws(
    () =>
      applyTransition(result.snapshot, secondRuling, {
        actorBinding: implementer,
        capability: "execution-consent@v1",
        capabilityRef: "cap-consent-owner-finding-ruling-twice",
        reviewFindingTriages: [],
      } satisfies ReviewConsentProof),
    /this finding already has an owner ruling for the current submission/u,
  );
});

test("a ruling on a settled finding names the escalated findings the owner must dispose", () => {
  const { snapshot: original } = lifecycleFixture({ complete: false }),
    recorded = original.reviews[0]!,
    targetDigest = submissionDigest(original.executions[0]!.submission!),
    escalated = {
      ...recorded,
      findings: [
        {
          findingId: "F-escalated",
          blocking: false,
          text: "Automated triage could not classify this finding.",
          category: "correctness" as const,
        },
        {
          findingId: "F-settled",
          blocking: false,
          text: "A confident nit that never blocked.",
          category: "correctness" as const,
        },
      ],
    },
    settledTriage: ReviewFindingTriageV1 = {
      schema: "review-finding-triage/v1",
      reviewId: escalated.reviewId,
      findingId: "F-settled",
      targetDigest,
      selected: "nit",
      probabilities: { blocker: 0, non_blocking: 0.01, nit: 0.98, pre_existing: 0.005, false_positive: 0.005 },
      model: "triage-model",
      bindingDigest: digest,
      decidedAt: "2026-10-26T00:02:00.000Z",
    },
    before = { ...original, reviews: [escalated], consents: [], reviewFindingTriages: [settledTriage] },
    command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: before.revision,
        },
        {
          type: "RecordReviewConsent" as const,
          taskId: escalated.taskId,
          executionId: escalated.executionId,
          reviewId: escalated.reviewId,
          consentId: "consent-settled-finding-ruling",
          reviewDigest: reviewDigest(escalated),
          contentDigest: escalated.contentDigest,
          findingId: "F-settled",
          findingDisposition: "nit" as const,
          rationale: "This finding is a nit; the reviewer already classified it.",
        },
      ),
      eventId: "event-settled-finding-ruling",
      workspaceRevision: before.revision + 1,
      occurredAt: "2026-10-27T01:00:00.000Z",
    };
  assert.throws(
    () =>
      applyTransition(before, command, {
        actorBinding: implementer,
        capability: "execution-consent@v1",
        capabilityRef: "cap-consent-settled-finding-ruling",
        reviewFindingTriages: [settledTriage],
      } satisfies ReviewConsentProof),
    /escalated findings awaiting disposition: review-execution\/F-escalated -> ha task review-consent task-1 --execution-id execution-1 --review-id 'review-execution' --finding-id 'F-escalated'/u,
  );
});

test("an owner ruling of blocker returns the submitted cut to its worker", () => {
  const { snapshot: original } = lifecycleFixture({ complete: false }),
    recorded = original.reviews[0]!,
    escalated = {
      ...recorded,
      findings: [
        {
          findingId: "F-owner-blocker",
          blocking: false,
          text: "The triage could not classify this.",
          category: "correctness" as const,
        },
      ],
    },
    before = { ...original, reviews: [escalated], consents: [], reviewFindingTriages: [] },
    rulingCommand = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: before.revision,
        },
        {
          type: "RecordReviewConsent" as const,
          taskId: escalated.taskId,
          executionId: escalated.executionId,
          reviewId: escalated.reviewId,
          consentId: "consent-owner-blocker-ruling",
          reviewDigest: reviewDigest(escalated),
          contentDigest: escalated.contentDigest,
          findingId: "F-owner-blocker",
          findingDisposition: "blocker" as const,
          rationale: "This finding is a reproducible correctness defect and must be fixed before completion.",
        },
      ),
      eventId: "event-owner-blocker-ruling",
      workspaceRevision: before.revision + 1,
      occurredAt: "2026-10-27T01:00:00.000Z",
    },
    ruled = applyTransition(before, rulingCommand, {
      actorBinding: implementer,
      capability: "execution-consent@v1",
      capabilityRef: "cap-consent-owner-blocker-ruling",
      reviewFindingTriages: [],
    } satisfies ReviewConsentProof),
    reworkCommand = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: ruled.snapshot.revision,
        },
        {
          type: "ReworkTask" as const,
          taskId: escalated.taskId,
          executionId: escalated.executionId,
          reviewId: escalated.reviewId,
          reason: "The owner confirmed this blocker and returns the cut to implementation.",
        },
      ),
      eventId: "event-owner-blocker-rework",
      workspaceRevision: ruled.snapshot.revision + 1,
      occurredAt: "2026-10-27T01:01:00.000Z",
    },
    returned = applyTransition(ruled.snapshot, reworkCommand, {
      actorBinding: implementer,
      capability: "task-rework@v1",
      capabilityRef: "cap-rework-owner-blocker-ruling",
      reworkBudget: 3,
    });

  assert.equal(ruled.snapshot.reviewDispositions?.[0]?.findingRuling?.disposition, "blocker");
  assert.equal(returned.snapshot.task?.status, "active");
  assert.equal(returned.snapshot.task?.iteration, ruled.snapshot.task!.iteration + 1);
  assert.equal(
    returned.snapshot.executions.find(({ executionId }) => executionId === escalated.executionId)?.state,
    "changes_requested",
  );
});

test("a finding ruling is digest-bound and leaves every other finding in the review unresolved", () => {
  const findings = review([
      { findingId: "F-ruled", blocking: false, text: "First unclear finding.", category: "correctness" },
      { findingId: "F-still-open", blocking: false, text: "Second unclear finding.", category: "completeness" },
    ]),
    cut = execution([findings]),
    ruling = {
      targetDigest: cutDigest(),
      reviewId: findings.reviewId,
      findingId: "F-ruled",
      disposition: "false_positive" as const,
      rationale: "The reviewed evidence shows this concern cannot occur.",
    },
    disposition = {
      schema: "review-disposition/v1" as const,
      dispositionId: "disposition-finding-ruling",
      taskId: findings.taskId,
      executionId: findings.executionId,
      iteration: findings.iteration,
      submissionDigest: cutDigest(),
      disposedReviewIds: [],
      rationale: ruling.rationale,
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      source: "local" as const,
      disposedAt: "2026-10-27T01:00:00.000Z",
      findingRuling: ruling,
    },
    settled = currentCutSettlement([findings], cut, [], [disposition]),
    stale = currentCutSettlement(
      [findings],
      cut,
      [],
      [{ ...disposition, findingRuling: { ...ruling, targetDigest: `sha256:${"9".repeat(64)}` } }],
    );

  assert.equal(settled?.findings.find(({ findingId }) => findingId === "F-ruled")?.outcome, "closed");
  assert.equal(settled?.findings.find(({ findingId }) => findingId === "F-still-open")?.outcome, "escalated");
  assert.equal(settled?.outcome, "escalated");
  assert.equal(stale?.findings.find(({ findingId }) => findingId === "F-ruled")?.outcome, "escalated");
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

test("the owner can write a digest-bound disposition for an approved historical review", () => {
  const { snapshot: original } = lifecycleFixture({ complete: false }),
    recorded = original.reviews[0]!,
    historical = {
      ...recorded,
      findings: [{ findingId: "legacy", blocking: false, text: "Filed before categories existed." }],
    },
    snapshot = { ...original, reviews: [historical], consents: [] },
    command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: snapshot.revision,
        },
        {
          type: "RecordReviewConsent" as const,
          taskId: historical.taskId,
          executionId: historical.executionId,
          reviewId: historical.reviewId,
          consentId: "consent-dispose-legacy",
          reviewDigest: reviewDigest(historical),
          contentDigest: historical.contentDigest,
          disposedReviewIds: [historical.reviewId],
          rationale: "The finding predates per-finding categories and was reviewed on this cut.",
        },
      ),
      eventId: "event-dispose-legacy",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-10-27T01:00:00.000Z",
    },
    result = applyTransition(snapshot, command, {
      actorBinding: implementer,
      capability: "execution-consent@v1",
      capabilityRef: "cap-consent-dispose-legacy",
    } satisfies ReviewConsentProof);

  assert.equal(result.event.type, "review_consent_overridden");
  assert.deepEqual(result.snapshot.reviewDispositions?.[0]?.disposedReviewIds, [historical.reviewId]);
  assert.deepEqual(
    reduceTaskEvent(snapshot, result.event).reviewDispositions?.[0]?.disposedReviewIds,
    [historical.reviewId],
    "the center replay path must admit the same approved historical disposition as the write path",
  );
  const cleanApproved = { ...historical, reviewId: "review-clean-approved", findings: [] },
    cleanSnapshot = { ...snapshot, reviews: [historical, cleanApproved] },
    cleanCommand = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: cleanSnapshot.revision,
        },
        {
          type: "RecordReviewConsent" as const,
          taskId: historical.taskId,
          executionId: historical.executionId,
          reviewId: historical.reviewId,
          consentId: "consent-dispose-clean-approved",
          reviewDigest: reviewDigest(historical),
          contentDigest: historical.contentDigest,
          disposedReviewIds: [cleanApproved.reviewId],
          rationale: "A clean approved review is not an old finding to dispose.",
        },
      ),
      eventId: "event-dispose-clean-approved",
      workspaceRevision: cleanSnapshot.revision + 1,
      occurredAt: "2026-10-27T01:01:00.000Z",
    };
  assert.throws(
    () =>
      applyTransition(cleanSnapshot, cleanCommand, {
        actorBinding: implementer,
        capability: "execution-consent@v1",
        capabilityRef: "cap-consent-dispose-clean",
      } satisfies ReviewConsentProof),
    { code: "invalid_proof" },
    "a current approved review with no unclassified finding is not a disposition target",
  );
  assert.equal(
    result.snapshot.reviewDispositions?.[0]?.submissionDigest,
    submissionDigest(result.snapshot.executions[0]!.submission!),
  );
  assert.notEqual(closeoutReadiness(result.snapshot).blocker, "review");
});

test("a categorized nit cannot hide an unanswered historical blocker", () => {
  const mixed = review([
      { findingId: "F1", blocking: false, text: "A small correctness nit.", category: "correctness" },
      { findingId: "legacy-blocker", blocking: true, text: "An unanswered historical blocker." },
    ]),
    settled = currentCutSettlement([mixed], execution([mixed]), [triage("F1", "nit")]);

  assert.equal(settled?.outcome, "passed", "the categorized nit itself has a finalized non-blocking triage");
  assert.equal(
    closeoutReadiness(snapshot([mixed], [triage("F1", "nit")])).blocker,
    "review",
    "the same cut still has a finding nobody categorized or answered",
  );
});

// task_2f5b047f21ac5ab30f027ebd10: after an approved review is consented, a pre-merge failure (CI
// red) has no review to return and no finding to rule on. The owner returns the same frozen cut
// with a reason; the consent stays recorded and unrevoked, only the cut reopens.
test("an owner returns a consented approved cut to implementation before merge", () => {
  const { snapshot: before } = lifecycleFixture({ complete: false }),
    recorded = before.reviews[0]!;
  assert.equal(before.task?.status, "in_review");
  assert.equal(recorded.verdict, "approved");
  assert.equal(before.consents.length, 1);

  const command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: before.revision,
        },
        {
          type: "ReworkTask" as const,
          taskId: recorded.taskId,
          executionId: recorded.executionId,
          reviewId: recorded.reviewId,
          reason: "Pre-merge CI run 40701875942 is red on this approved cut.",
        },
      ),
      eventId: "event-consented-rework",
      workspaceRevision: before.revision + 1,
      occurredAt: "2026-10-28T02:00:00.000Z",
    },
    returned = applyTransition(before, command, {
      actorBinding: implementer,
      capability: "task-rework@v1",
      capabilityRef: "cap-rework-consented",
      reworkBudget: 3,
    }),
    returnedExecution = returned.snapshot.executions.find(({ executionId }) => executionId === recorded.executionId);

  assert.equal(returned.event.type, "submission_returned");
  assert.equal(returned.snapshot.task?.status, "active");
  assert.equal(returned.snapshot.task?.currentNode, "implementation");
  assert.equal(returned.snapshot.task?.iteration, (before.task?.iteration ?? 0) + 1);
  assert.equal(returnedExecution?.state, "changes_requested");
  assert.equal(
    returned.snapshot.consents.length,
    before.consents.length,
    "the owner's consent is not revoked by the return",
  );
});

test("an approved cut without consent is still not returnable as rework", () => {
  const { snapshot: approved } = lifecycleFixture({ complete: false }),
    recorded = approved.reviews[0]!,
    withoutConsent = { ...approved, consents: [] },
    command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: withoutConsent.revision,
        },
        {
          type: "ReworkTask" as const,
          taskId: recorded.taskId,
          executionId: recorded.executionId,
          reviewId: recorded.reviewId,
          reason: "Return this approved cut.",
        },
      ),
      eventId: "event-unconsented-rework",
      workspaceRevision: withoutConsent.revision + 1,
      occurredAt: "2026-10-28T02:00:00.000Z",
    };

  assert.throws(
    () =>
      applyTransition(withoutConsent, command, {
        actorBinding: implementer,
        capability: "task-rework@v1",
        capabilityRef: "cap-rework-unconsented",
        reworkBudget: 3,
      }),
    /Task rework requires a current changes_requested review, an owner-confirmed blocker finding, or an owner-consented approved cut/u,
  );
});
