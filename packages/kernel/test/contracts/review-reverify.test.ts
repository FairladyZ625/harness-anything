// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { emptyCompletionContract } from "../domain/completion.fixtures.ts";
import { implementer, twoRoundLifecycleEvents } from "../store/task-lifecycle-fixture.ts";
import { closeoutReadiness } from "../../src/domain/closeout-readiness.ts";
import { taskCompletionNext } from "../../src/domain/completion-readiness.ts";
import { submissionDigest } from "../../src/domain/execution.ts";
import { reviewDigest, type ReviewFindingV1 } from "../../src/domain/review.ts";
import { reviewReverifyRoute } from "../../src/domain/review-reverify.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  validateTransition,
  type TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";

const owner = { principal: { personId: "person-owner" }, executor: null } as const,
  completionContract = {
    ...emptyCompletionContract,
    closeoutGates: { review: true, consent: true, factDisposition: true },
  },
  readinessGates = { review: true, consent: true, factDisposition: false } as const;

function lifecycleCommand<C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(
  snapshot: TaskLifecycleSnapshot,
  actor: Parameters<typeof normalizeTaskLifecycleCommand>[0]["actor"],
  intent: C,
  minute: number,
) {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: snapshot.revision },
      intent,
    ),
    eventId: `event-reverify-${minute}`,
    workspaceRevision: snapshot.revision + 1,
    occurredAt: `2026-08-11T00:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

/**
 * Round one reviews with `findings`; round two adopts the named findings and resubmits. Returns the
 * resubmitted snapshot (task in_review on iteration 1) and the round-one review id.
 */
function resubmittedAfter(
  findings: readonly ReviewFindingV1[],
  adopt: readonly string[] = findings.filter((finding) => finding.blocking).map((finding) => finding.findingId),
): { readonly snapshot: TaskLifecycleSnapshot; readonly executionId: string } {
  const rounds = twoRoundLifecycleEvents({ firstReviewFindings: findings }),
    second = rounds.snapshot.executions.at(-1)!;
  let snapshot = rounds.snapshot;
  const blocking = findings.filter((finding) => finding.blocking);
  if (blocking.length)
    snapshot = applyTransition(
      snapshot,
      lifecycleCommand(
        snapshot,
        implementer,
        {
          type: "RespondReview",
          taskId: second.taskId,
          executionId: second.executionId,
          responses: blocking.map((finding) => ({
            reviewId: "review-round-one",
            findingId: finding.findingId,
            disposition: adopt.includes(finding.findingId) ? ("adopt" as const) : ("rebut" as const),
            rationale: "Handled in round two.",
          })),
        },
        10,
      ),
      { actorBinding: implementer, capability: "execution-review-response@v1", capabilityRef: "cap-response" },
    ).snapshot;
  snapshot = applyTransition(
    snapshot,
    lifecycleCommand(
      snapshot,
      implementer,
      {
        type: "SubmitExecution",
        taskId: second.taskId,
        executionId: second.executionId,
        submission: {
          completionClaim: "reworked implementation",
          deliverables: [],
          outputs: [],
          verificationNotes: ["tests"],
          knownGaps: [],
          residualRisks: [],
          commitSha: "d".repeat(40),
          completionContract,
          ...(snapshot.reviewResponses?.length ? { reviewResponses: snapshot.reviewResponses } : {}),
        },
      },
      11,
    ),
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  ).snapshot;
  assert.equal(snapshot.task?.status, "in_review");
  return { snapshot, executionId: second.executionId };
}

function ownerVerifyConsent(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  actor: Parameters<typeof normalizeTaskLifecycleCommand>[0]["actor"] = owner,
  reviewId = "review-round-one",
) {
  const review = snapshot.reviews.find((value) => value.reviewId === reviewId)!;
  return lifecycleCommand(
    snapshot,
    actor,
    {
      type: "RecordReviewConsent",
      taskId: snapshot.task!.taskId,
      executionId,
      reviewId,
      consentId: "consent-owner-verify",
      reviewDigest: reviewDigest(review),
      contentDigest: review.contentDigest,
      disposedReviewIds: [reviewId],
      rationale: "Owner verified the closeout count now matches the gate output (767).",
    },
    12,
  );
}

const consentProof = { actorBinding: owner, capability: "execution-consent@v1", capabilityRef: "cap-consent" };
const countFinding: ReviewFindingV1 = {
  findingId: "F-count",
  blocking: true,
  text: "closeout count 766 disagrees with the gate output 767",
  category: "evidence",
  reverify: "owner-verify",
};

test("all owner-verify findings adopted: no reviewer is owed and owner consent citing the prior review completes the review gate", () => {
  const { snapshot, executionId } = resubmittedAfter([countFinding]),
    execution = snapshot.executions.find((value) => value.executionId === executionId)!,
    route = reviewReverifyRoute({ reviews: snapshot.reviews, reviewResponses: snapshot.reviewResponses, execution });
  assert.equal(route.kind, "owner-verify");
  assert.deepEqual(route.kind === "owner-verify" ? route.reviews.map((review) => review.reviewId) : [], [
    "review-round-one",
  ]);
  // Before consent the cut waits on the task owner, not on a reviewer.
  const next = taskCompletionNext(snapshot, {
    closeout: "ready",
    closeoutPath: "tasks/x/closeout.md",
    eligibleDirtyPaths: [],
    closeoutGates: readinessGates,
  });
  assert.equal(next.blocker?.code, "review_pending");
  assert.equal(next.blocker?.gate, "consent");
  assert.equal(next.next?.authority, "person-owner");
  assert.match(next.next?.action ?? "", /--review-id 'review-round-one' --dispose 'review-round-one'/u);

  const consented = applyTransition(snapshot, ownerVerifyConsent(snapshot, executionId), consentProof);
  assert.equal(consented.event.type, "review_consent_overridden");
  assert.equal(consented.snapshot.consents.at(-1)?.submissionDigest, submissionDigest(execution.submission!));
  const readiness = closeoutReadiness(consented.snapshot, undefined, readinessGates);
  assert.equal(readiness.blocker, undefined);
  assert.equal(readiness.readiness, "ready");
});

test("a security finding marked owner-verify is rejected at the review writing boundary", () => {
  assert.throws(
    () =>
      twoRoundLifecycleEvents({
        firstReviewFindings: [
          {
            findingId: "F-auth",
            blocking: true,
            text: "token scope is not checked",
            category: "security-auth",
            reverify: "owner-verify",
          },
        ],
      }),
    /finding F-auth is security-auth; only evidence, wording, test-only, style, diagnostic, cleanup findings may use reverify owner-verify/u,
  );
  // An uncategorized finding is correctness, also load-bearing.
  assert.throws(
    () =>
      twoRoundLifecycleEvents({
        firstReviewFindings: [{ findingId: "F-x", blocking: true, text: "behavior", reverify: "owner-verify" }],
      }),
    /finding F-x is correctness/u,
  );
});

test("a re-review finding scopes the re-review to that finding and refuses the owner-verify consent", () => {
  const behavior: ReviewFindingV1 = {
      findingId: "F-behavior",
      blocking: true,
      text: "submit drops the reviewer seat",
      category: "correctness",
      reverify: "re-review",
    },
    { snapshot, executionId } = resubmittedAfter([countFinding, behavior]),
    execution = snapshot.executions.find((value) => value.executionId === executionId)!,
    route = reviewReverifyRoute({ reviews: snapshot.reviews, reviewResponses: snapshot.reviewResponses, execution });
  assert.equal(route.kind, "re-review");
  assert.deepEqual(
    route.kind === "re-review" ? route.pending.map((item) => `${item.reviewId}/${item.finding.findingId}`) : [],
    ["review-round-one/F-behavior"],
  );
  assert.equal(route.kind === "re-review" ? route.sinceCommit : null, "a".repeat(40));
  const issues = validateTransition(snapshot, ownerVerifyConsent(snapshot, executionId), consentProof);
  assert.ok(
    issues.some((issue) => /belongs to an earlier submission/u.test(issue.message)),
    JSON.stringify(issues),
  );
});

test("an omitted reverify reads as re-review, and a rebutted owner-verify finding needs the reviewer", () => {
  const unsure = resubmittedAfter([{ ...countFinding, reverify: undefined }]);
  const unsureExecution = unsure.snapshot.executions.find((value) => value.executionId === unsure.executionId)!;
  assert.equal(
    reviewReverifyRoute({
      reviews: unsure.snapshot.reviews,
      reviewResponses: unsure.snapshot.reviewResponses,
      execution: unsureExecution,
    }).kind,
    "re-review",
  );
  const rebutted = resubmittedAfter([countFinding], []);
  const rebuttedExecution = rebutted.snapshot.executions.find((value) => value.executionId === rebutted.executionId)!;
  assert.equal(
    reviewReverifyRoute({
      reviews: rebutted.snapshot.reviews,
      reviewResponses: rebutted.snapshot.reviewResponses,
      execution: rebuttedExecution,
    }).kind,
    "re-review",
  );
});

test("non-blocking notes never trigger a re-review", () => {
  const { snapshot, executionId } = resubmittedAfter([
      countFinding,
      { findingId: "N-1", blocking: false, text: "consider renaming the helper", category: "correctness" },
    ]),
    execution = snapshot.executions.find((value) => value.executionId === executionId)!,
    route = reviewReverifyRoute({ reviews: snapshot.reviews, reviewResponses: snapshot.reviewResponses, execution });
  assert.equal(route.kind, "owner-verify");
  assert.deepEqual(route.kind === "owner-verify" ? route.findings.map((item) => item.finding.findingId) : [], [
    "F-count",
  ]);
});

test("a cut without a previous changes_requested round owes one full review", () => {
  const rounds = twoRoundLifecycleEvents(),
    first = rounds.snapshot.executions[0]!;
  assert.equal(reviewReverifyRoute({ reviews: [], reviewResponses: [], execution: first }).kind, "full");
  // A non-owner cannot release the cut through owner verification.
  const { snapshot, executionId } = resubmittedAfter([countFinding]),
    stranger = { principal: { personId: "person-reviewer" }, executor: null } as const,
    command = ownerVerifyConsent(snapshot, executionId, stranger),
    issues = validateTransition(snapshot, command, { ...consentProof, actorBinding: stranger });
  assert.ok(
    issues.some((issue) => /task owner's principal/u.test(issue.message)),
    JSON.stringify(issues),
  );
});
