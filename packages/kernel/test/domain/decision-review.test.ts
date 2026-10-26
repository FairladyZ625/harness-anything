// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_ACCEPT_REVIEW_CRITERION_REF,
  assertDecisionAcceptReview,
  compileDecisionWrite,
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import { entityActionCriterionFailure, getExecutableEntityAction, type ActorIdentity } from "../../src/index.ts";

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

test("Decision review digest excludes downstream relations but retains claim evidence edges", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    edge = (overrides: Record<string, unknown>) => ({
      relation_id: "rel_edge",
      source: `decision/${current.decisionId}`,
      target: "person/person-owner",
      type: "awaits" as const,
      strength: "strong" as const,
      direction: "directed" as const,
      origin: "authored" as const,
      state: "active" as const,
      rationale: "consent: Review requested changes.",
      ...overrides,
    }),
    awaits = edge({}),
    derives = edge({
      relation_id: "rel_derives",
      source: `decision/${current.decisionId}/CH1`,
      target: "task/task_0123456789ABCDEFGHJKMNPQRS",
      type: "derives" as const,
      rationale: "Implementation spawned from the chosen option.",
    }),
    relates = edge({
      relation_id: "rel_relates",
      target: "decision/dec_0123456789ABCDEFGHJKMNPQRS",
      type: "relates" as const,
      rationale: "Later found related.",
    }),
    evidence = edge({
      relation_id: "rel_evidence",
      target: "fact/F-12345678",
      type: "evidenced-by" as const,
      rationale: "Evidence for the proposal.",
    }),
    refutation = edge({
      relation_id: "rel_refutation",
      target: "fact/F-12345678",
      type: "refuted-by" as const,
      rationale: "The fact contradicts the proposal.",
    });
  assert.equal(
    decisionReviewContentDigest({ ...current, relations: [awaits, derives, relates] }, document()),
    digest,
    "post-dispatch derives/relates/awaits edges must not invalidate a pinned review",
  );
  assert.notEqual(decisionReviewContentDigest({ ...current, relations: [evidence] }, document()), digest);
  assert.notEqual(decisionReviewContentDigest({ ...current, relations: [refutation] }, document()), digest);
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
  assert.doesNotThrow(() => assertDecisionAcceptReview(reviewed, document(), accept("review-1", digest), "off"));
  assert.throws(
    () => assertDecisionAcceptReview(reviewed, document("Changed proposal body"), accept("review-1", digest), "off"),
    (error: unknown) => {
      const failure = entityActionCriterionFailure(error);
      return (
        /content changed/u.test(error instanceof Error ? error.message : "") &&
        failure?.nextActions[0] ===
          `ha decision dispatch-review ${current.decisionId} --expected-digest ${decisionReviewContentDigest(reviewed, document("Changed proposal body"))}`
      );
    },
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
    () => assertDecisionAcceptReview({ ...current, reviews: [review] }, document(), accept(), "off"),
    (error: unknown) => {
      const failure = entityActionCriterionFailure(error);
      return (
        /unresolved/u.test(error instanceof Error ? error.message : "") &&
        failure?.nextActions[0] === `ha decision respond-review ${current.decisionId} --from-file <responses.json>` &&
        failure.nextActions[1]?.includes("<digest-from-amend-receipt>") === true
      );
    },
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
      "off",
    ),
  );
});

test("Decision review requirement applies the declared risk threshold", () => {
  const high = decision(),
    low = { ...high, riskTier: "low" as const },
    medium = { ...high, riskTier: "medium" as const };
  assert.equal(decisionAcceptReviewReadiness(high, document(), "off").ready, true);
  assert.equal(decisionAcceptReviewReadiness(high, document(), "high").blocker?.code, "review_required");
  assert.equal(decisionAcceptReviewReadiness(low, document(), "high").ready, true);
  assert.equal(decisionAcceptReviewReadiness(medium, document(), "medium_and_high").blocker?.code, "review_required");
  assert.equal(decisionAcceptReviewReadiness(low, document(), "all").blocker?.code, "review_required");
  assert.throws(() => assertDecisionAcceptReview(high, document(), accept(), "high"), /requires an approved review/u);
});

test("Decision accept readiness exposes the same current-cut judgment used by writes", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document());
  assert.deepEqual(decisionAcceptReviewReadiness(current, document(), "off"), {
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
  assert.deepEqual(decisionAcceptReviewReadiness(blocked, document(), "off"), {
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
  assert.deepEqual(decisionAcceptReviewReadiness(unanswered, amendedBody, "off").blocker, {
    code: "unanswered_findings",
    findings: [
      { reviewId: review.reviewId, findingId: "F1" },
      { reviewId: review.reviewId, findingId: "F2" },
    ],
    reason: "Historical changes_requested findings require proposer responses before policy-unreviewed acceptance.",
  });
  assert.throws(
    () => assertDecisionAcceptReview(unanswered, amendedBody, accept(), "off"),
    /unanswered review findings/u,
  );
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
  assert.doesNotThrow(() => assertDecisionAcceptReview(answered, amendedBody, accept(), "off"));
});

const consent = {
  approvedBy: "person-owner",
  at: "2026-09-28T00:01:30.000Z",
  channel: "chat" as const,
};

function compileConsentAccept(state: DecisionDocumentState, requirement: "off" | "high") {
  const draft = accept();
  return compileDecisionWrite({
    event: {
      ...draft,
      payload: { ...draft.payload, judgmentOnlyRationale: "Owner judgment recorded alongside the review record." },
    },
    approval: consent,
    currentDecision: state,
    currentRelations: [],
    currentDocument: { blobSha256: "sha256:base", body: document() },
    decisionReviewRequirement: requirement,
  });
}

test("human consent does not exempt a high-risk Decision from the repository review requirement", () => {
  assert.throws(() => compileConsentAccept(decision(), "high"), /requires an approved review/u);
  for (const riskTier of ["medium", "low"] as const)
    assert.doesNotThrow(() => compileConsentAccept({ ...decision(), riskTier }, "high"));
});

test("a review-required rejection names the dispatch-review command as its next action", () => {
  const contract = getExecutableEntityAction("decision-accept");
  assert.ok(contract);
  assert.ok(
    contract.criteria.some(({ ref }) => ref === DECISION_ACCEPT_REVIEW_CRITERION_REF),
    "decision-accept must declare the review criterion its rejections are attributed to",
  );
  assert.throws(
    () => compileConsentAccept(decision(), "high"),
    (error: unknown) => {
      const failure = entityActionCriterionFailure(error);
      return (
        /requires an approved review/u.test(error instanceof Error ? error.message : "") &&
        failure?.actionId === "accept" &&
        failure.criterionRef === DECISION_ACCEPT_REVIEW_CRITERION_REF &&
        failure.nextActions.length === 1 &&
        failure.nextActions[0] ===
          `ha decision dispatch-review ${decision().decisionId} --expected-digest ${decisionReviewContentDigest(decision(), document())}`
      );
    },
    "the review-required rejection must carry the dispatch-review next action",
  );
});

test("human consent accepts a reviewed high-risk Decision once current changes_requested blockers are overridden", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    approved = {
      reviewId: "review-approved",
      reviewContentDigest: digest,
      verdict: "approved" as const,
      reason: "The evidence supports the proposal.",
      findings: [],
      evidenceChecked: ["fact/F-12345678"],
      reportRef: null,
      actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
      reviewedAt: "2026-09-28T00:01:00.000Z",
    },
    blocking = {
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
  const compiled = compileConsentAccept({ ...current, reviews: [approved] }, "high");
  assert.ok(compiled.event.type === "decision_accepted");
  assert.equal(compiled.event.payload.judgmentConsent.basis, "human");
  assert.throws(
    () => compileConsentAccept({ ...current, reviews: [approved, blocking] }, "high"),
    /unresolved changes_requested/u,
  );
  assert.doesNotThrow(() =>
    compileConsentAccept(
      {
        ...current,
        reviews: [approved, blocking],
        reviewOverrides: [
          {
            reviewContentDigest: digest,
            reviewIds: [blocking.reviewId],
            reason: "The owner accepts the documented tradeoff.",
            actor: proposer,
            overriddenAt: "2026-09-28T00:02:00.000Z",
          },
        ],
      },
      "high",
    ),
  );
});

test("a Decision cut with a categorized finding settles per finding, not per approved review", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    triage = (selected: "blocker" | "non_blocking", probability: number) =>
      ({
        schema: "review-finding-triage/v1" as const,
        reviewId: "review-findings",
        findingId: "F1",
        targetDigest: digest,
        selected,
        probabilities: {
          blocker: selected === "blocker" ? probability : 1 - probability,
          non_blocking: selected === "non_blocking" ? probability : 1 - probability,
          nit: 0,
          pre_existing: 0,
          false_positive: 0,
        },
        model: "triage-model",
        bindingDigest: digest,
        decidedAt: "2026-09-29T00:02:00.000Z",
      }) as const,
    review = {
      reviewId: "review-findings",
      reviewContentDigest: digest,
      verdict: "approved" as const,
      reason: "One non-blocking observation.",
      findings: [{ findingId: "F1", text: "Name the evidence.", category: "completeness" as const }],
      evidenceChecked: [],
      reportRef: null,
      actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
      reviewedAt: "2026-09-29T00:01:00.000Z",
    },
    withFinding = { ...current, reviews: [review] };

  // An unresolved triage is unresolved review, even though the review itself says approved.
  assert.equal(
    decisionAcceptReviewReadiness(withFinding, document(), "all").blocker?.code,
    "changes_requested",
    "no triage means the finding is unresolved",
  );
  // A confident non-blocking settlement passes the cut without any separate approved-review predicate.
  assert.equal(
    decisionAcceptReviewReadiness(withFinding, document(), "all", [triage("non_blocking", 0.95)]).ready,
    true,
  );
  assert.equal(
    decisionAcceptReviewReadiness(withFinding, document(), "all", [triage("blocker", 0.95)]).blocker?.code,
    "changes_requested",
  );
});

// dec_6A77D43B8523823ABA1F5E4D3C CH5/C3: the Decision side reads the same per-finding settlement
// as Task closeout. Before this, `decisionAcceptReviewReadiness` accepted a fourth argument it was
// never given, so the journal could be full of answers and accept would still consult only a single
// `approved` review.
test("a Decision cut with a categorized finding reads its triage instead of one approved review", () => {
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    review = (verdict: "approved" | "changes_requested", findings: readonly Record<string, unknown>[]) => ({
      reviewId: "review-1",
      reviewContentDigest: digest,
      verdict,
      reason: "checked",
      findings,
      evidenceChecked: [],
      reportRef: null,
      actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
      reviewedAt: "2026-09-28T00:01:00.000Z",
    }),
    reviewed = {
      ...current,
      reviews: [
        review("approved", [{ findingId: "F1", blocking: false, text: "Stale prose.", category: "correctness" }]),
      ],
    } as unknown as DecisionDocumentState,
    triage = {
      schema: "review-finding-triage/v1" as const,
      reviewId: "review-1",
      findingId: "F1",
      targetDigest: digest,
      selected: "non_blocking" as const,
      probabilities: { blocker: 0.01, non_blocking: 0.96, nit: 0.01, pre_existing: 0.01, false_positive: 0.01 },
      model: "reviewer-model",
      bindingDigest: digest,
      decidedAt: "2026-09-28T00:01:30.000Z",
    };

  assert.equal(
    decisionAcceptReviewReadiness(reviewed, document(), "off", []).next.action,
    "override-review",
    "a categorized finding with no triage record escalates to a person, never to an approval",
  );
  assert.equal(
    decisionAcceptReviewReadiness(reviewed, document(), "off", [triage]).next.action,
    "accept",
    "the journal's answer settles the Decision cut without any approved-review record",
  );
});

test("a finding without a category cannot fall back to the single-approved predicate", () => {
  // C3: the legacy predicate is what the decision deletes. A reviewer that returned findings and
  // never answered the triage question left the cut unresolved; one `approved` record must not pass it.
  const current = decision(),
    digest = decisionReviewContentDigest(current, document()),
    reviewed = {
      ...current,
      reviews: [
        {
          reviewId: "review-1",
          reviewContentDigest: digest,
          verdict: "approved",
          reason: "checked",
          findings: [{ findingId: "F1", blocking: true, text: "No category filed." }],
          evidenceChecked: [],
          reportRef: null,
          actor: { ...proposer, executor: { kind: "agent" as const, id: "reviewer" } },
          reviewedAt: "2026-09-28T00:01:00.000Z",
        },
      ],
    } as unknown as DecisionDocumentState;
  // With review required, the approved verdict alone must not satisfy the cut: the review raised a
  // finding and never filed a category, so the cut still owes a settled finding review.
  assert.equal(
    decisionAcceptReviewReadiness(reviewed, document(), "all", []).next.action,
    "dispatch-review",
    "an unfiled finding keeps a review-required cut at review despite the approved verdict",
  );
});
