// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDecisionAcceptReview,
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import type { ActorIdentity } from "../../src/index.ts";

const proposer: ActorIdentity = {
  principal: { personId: "person-owner" },
  executor: { kind: "agent", id: "proposer" },
};

function decision(): DecisionDocumentState {
  return {
    decisionId: "dec_0123456789ABCDEFGHJKMNPQRS",
    state: "proposed",
    title: "Review a Decision",
    question: "Should this cut be accepted?",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "standard-task",
    decisionClass: "ordinary",
    appliesTo: { modules: ["kernel"], productLines: [] },
    proposer,
    arbiter: null,
    proposedAt: "2026-09-28T00:00:00.000Z",
    decidedAt: null,
    workspaceRevision: 1,
    chosen: [{ id: "CH1", text: "Use the shared review rule." }],
    rejected: [],
    claims: [],
    relations: [],
    provenance: [],
    judgmentConsents: [],
    reviews: [],
    reviewResponses: [],
    reviewOverrides: [],
  };
}

function document(body = "Proposal body"): string {
  return `---\nschema: decision-package/v1\n---\n\n${body}\n`;
}

function accept(reviewId?: string, expectedDigest?: `sha256:${string}`): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: "evt_accept",
    workspaceRevision: 3,
    opId: "op_accept",
    decisionId: decision().decisionId,
    type: "decision_accepted",
    actor: proposer,
    source: "local",
    occurredAt: "2026-09-28T00:02:00.000Z",
    payload: {
      rationale: "The current reviewed cut is accepted.",
      judgmentOnlyRationale: null,
      ...(reviewId ? { reviewId } : {}),
      ...(expectedDigest ? { expectedDigest } : {}),
    },
  };
}

test("Decision review digest includes accepted prose but excludes review history", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document());
  assert.equal(decisionReviewContentDigest({ ...current, reviews: [] }, document()), digest);
  assert.notEqual(decisionReviewContentDigest(current, document("Changed proposal body")), digest);
});

test("approved review must match the current Decision content", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    reviewed = {
      ...current,
      reviews: [
        {
          reviewId: "review-1",
          reviewContentDigest: digest,
          verdict: "approved" as const,
          reason: "The evidence supports the proposal.",
          findings: [],
          evidenceChecked: ["fact/F-12345678"],
          reportRef: null,
          actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
          reviewedAt: "2026-09-28T00:01:00.000Z",
        },
      ],
    };
  assert.doesNotThrow(() => assertDecisionAcceptReview(reviewed, document(), accept("review-1", digest)));
  assert.throws(
    () => assertDecisionAcceptReview(reviewed, document("Changed proposal body"), accept("review-1", digest)),
    /content changed/u,
  );
});

test("changes_requested remains blocking until a named override with a reason", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    review = {
      reviewId: "review-blocking",
      reviewContentDigest: digest,
      verdict: "changes_requested" as const,
      reason: "The claim lacks evidence.",
      findings: [{ findingId: "F1", text: "Add evidence." }],
      evidenceChecked: [],
      reportRef: null,
      actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
      reviewedAt: "2026-09-28T00:01:00.000Z",
    };
  assert.throws(
    () => assertDecisionAcceptReview({ ...current, reviews: [review] }, document(), accept()),
    /unresolved/u,
  );
  assert.doesNotThrow(() =>
    assertDecisionAcceptReview(
      {
        ...current,
        reviews: [review],
        reviewOverrides: [
          {
            reviewContentDigest: digest,
            reviewIds: [review.reviewId],
            reason: "The owner accepts the documented tradeoff.",
            actor: proposer,
            overriddenAt: "2026-09-28T00:02:00.000Z",
          },
        ],
        reviewResponses: [
          {
            reviewId: review.reviewId,
            findingId: "F1",
            disposition: "rebut" as const,
            rationale: "The proposer documented why the tradeoff is accepted.",
            amendmentRef: null,
            actor: proposer,
            respondedAt: "2026-09-28T00:02:00.000Z",
          },
        ],
      },
      document(),
      accept(),
    ),
  );
});

test("Decision accept readiness exposes the same current-cut judgment used by writes", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document());
  assert.deepEqual(decisionAcceptReviewReadiness(current, document()), {
    ready: true,
    currentDigest: digest,
    basis: "policy_unreviewed",
    blocker: null,
    next: { action: "accept", actor: "proposer", reason: "No current-content review blocks acceptance." },
  });
  const blocked = {
    ...current,
    reviews: [
      {
        reviewId: "review-blocked",
        reviewContentDigest: digest,
        verdict: "changes_requested" as const,
        reason: "Needs work.",
        findings: [{ findingId: "F1", text: "Fix it." }],
        evidenceChecked: [],
        reportRef: null,
        actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
        reviewedAt: "2026-09-29T00:00:00.000Z",
      },
    ],
  };
  assert.deepEqual(decisionAcceptReviewReadiness(blocked, document()), {
    ready: false,
    currentDigest: digest,
    basis: null,
    blocker: {
      code: "changes_requested",
      reviewIds: ["review-blocked"],
      reason: "Current content has unresolved changes_requested reviews.",
    },
    next: {
      action: "override-review",
      actor: "owner",
      reason:
        "The owner must override the named reviews, or the proposer must amend the content and seek review again.",
    },
  });
});

test("policy-unreviewed acceptance requires a proposer response to every historical finding", () => {
  const current = decision(),
    oldDigest = decisionReviewContentDigest(current, document()),
    review = {
      reviewId: "review-old-cut",
      reviewContentDigest: oldDigest,
      verdict: "changes_requested" as const,
      reason: "The old cut needs a correction.",
      findings: [
        { findingId: "F1", text: "Explain the tradeoff." },
        { findingId: "F2", text: "Name the evidence." },
      ],
      evidenceChecked: [],
      reportRef: null,
      actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
      reviewedAt: "2026-09-29T00:00:00.000Z",
    },
    amendedBody = document("Changed proposal body"),
    unanswered = { ...current, reviews: [review] };
  assert.deepEqual(decisionAcceptReviewReadiness(unanswered, amendedBody).blocker, {
    code: "unanswered_findings",
    findings: [
      { reviewId: review.reviewId, findingId: "F1" },
      { reviewId: review.reviewId, findingId: "F2" },
    ],
    reason: "Historical changes_requested findings require proposer responses before policy-unreviewed acceptance.",
  });
  assert.throws(() => assertDecisionAcceptReview(unanswered, amendedBody, accept()), /unanswered review findings/u);
  const answered = {
    ...unanswered,
    reviewResponses: review.findings.map(({ findingId }) => ({
      reviewId: review.reviewId,
      findingId,
      disposition: "rebut" as const,
      rationale: "The amended proposal addresses the concern explicitly.",
      amendmentRef: null,
      actor: proposer,
      respondedAt: "2026-09-29T00:02:00.000Z",
    })),
  };
  assert.doesNotThrow(() => assertDecisionAcceptReview(answered, amendedBody, accept()));
});
