// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  settleReviewFindings,
  validateReviewFindingTriageV1,
  type ReviewFindingDisposition,
  type ReviewFindingTriageV1,
  type SettleableReviewFinding,
} from "../../src/domain/review-settlement.ts";

const digest = `sha256:${"a".repeat(64)}` as const;

const finding = (overrides: Partial<SettleableReviewFinding> = {}): SettleableReviewFinding => ({
  reviewId: "review-1",
  findingId: "F1",
  category: "correctness",
  label: "Important",
  text: "The retry path drops the claim fence.",
  reviewerBlocking: true,
  evidence: { anchor: "packages/daemon/src/x.ts:12", evidenceDigest: digest },
  ...overrides,
});

const triage = (
  selected: ReviewFindingDisposition,
  probabilities: Partial<Record<ReviewFindingDisposition, number>> = {},
  overrides: Partial<ReviewFindingTriageV1> = {},
): ReviewFindingTriageV1 => ({
  schema: "review-finding-triage/v1",
  reviewId: "review-1",
  findingId: "F1",
  targetDigest: digest,
  selected,
  probabilities: {
    blocker: 0,
    non_blocking: 0,
    nit: 0,
    pre_existing: 0,
    false_positive: 0,
    ...probabilities,
  },
  model: "triage-model",
  bindingDigest: digest,
  decidedAt: "2026-10-26T00:00:00.000Z",
  ...overrides,
});

test("a cut with no finding passes without inventing one", () => {
  const settlement = settleReviewFindings({ findings: [], triages: [] });
  assert.equal(settlement.outcome, "passed");
  assert.deepEqual(settlement.findings, []);
  assert.match(settlement.reason, /No finding entered settlement/u);
});

test("style, diagnostic, and cleanup notes are discarded before settlement", () => {
  const settlement = settleReviewFindings({
    findings: [
      finding({ findingId: "S1", category: "style" }),
      finding({ findingId: "D1", category: "diagnostic" }),
      finding({ findingId: "C1", category: "cleanup" }),
    ],
    triages: [triage("blocker", { blocker: 1 })],
  });
  assert.equal(settlement.outcome, "passed");
  assert.deepEqual(
    settlement.discarded.map(({ findingId, category }) => `${findingId}:${category}`),
    ["S1:style", "D1:diagnostic", "C1:cleanup"],
  );
  assert.deepEqual(settlement.findings, []);
});

test("a confident blocker returns the cut; a confident nit closes it", () => {
  const blocker = settleReviewFindings({
    findings: [finding()],
    triages: [triage("blocker", { blocker: 0.93, non_blocking: 0.07 })],
  });
  assert.equal(blocker.outcome, "changes_requested");
  assert.equal(blocker.findings[0]!.disposition, "blocker");
  assert.deepEqual(
    blocker.blockers.map(({ findingId }) => findingId),
    ["F1"],
  );

  // The reviewer claimed a blocker; the API must not wave it through on one pass (CH4).
  const nitConflict = settleReviewFindings({
    findings: [finding({ category: "completeness", evidence: undefined })],
    triages: [triage("nit", { nit: 0.9, non_blocking: 0.1 })],
  });
  assert.equal(nitConflict.outcome, "escalated");

  const nit = settleReviewFindings({
    findings: [finding({ category: "completeness", evidence: undefined, label: "Nit", reviewerBlocking: false })],
    triages: [triage("nit", { nit: 0.9, non_blocking: 0.1 })],
  });
  assert.equal(nit.outcome, "passed");
  assert.equal(nit.findings[0]!.outcome, "closed");
});

test("non_blocking and pre_existing become follow-up-owned, not blockers", () => {
  for (const disposition of ["non_blocking", "pre_existing"] as const) {
    const settlement = settleReviewFindings({
      findings: [finding({ category: "completeness", evidence: undefined, reviewerBlocking: false })],
      triages: [triage(disposition, { [disposition]: 0.9 })],
    });
    assert.equal(settlement.outcome, "passed");
    assert.equal(settlement.findings[0]!.outcome, "follow_up_owned");
  }
});

test("a low-confidence triage escalates instead of guessing a pass", () => {
  const settlement = settleReviewFindings({
    findings: [finding()],
    triages: [triage("blocker", { blocker: 0.5, non_blocking: 0.5 })],
  });
  assert.equal(settlement.outcome, "escalated");
  assert.match(settlement.escalated[0]!.reason, /below the correctness floor/u);
});

test("the category floor decides confidence, not a single global number", () => {
  const findingInput = finding({ category: "data-loss", evidence: undefined }),
    probabilities = { blocker: 0.85, non_blocking: 0.15 };
  assert.equal(
    settleReviewFindings({ findings: [findingInput], triages: [triage("blocker", probabilities)] }).outcome,
    "escalated",
    "0.85 is below the data-loss floor of 0.90",
  );
  assert.equal(
    settleReviewFindings({
      findings: [findingInput],
      triages: [triage("blocker", { blocker: 0.91 })],
    }).outcome,
    "changes_requested",
  );
});

test("a hard-rule finding with complete evidence is a blocker no matter the label or probabilities", () => {
  const settlement = settleReviewFindings({
    findings: [finding({ category: "security-auth", label: "Nit" })],
    triages: [triage("false_positive", { false_positive: 0.99 })],
  });
  assert.equal(settlement.outcome, "changes_requested");
  assert.equal(settlement.findings[0]!.hardRule, true);
  assert.equal(settlement.findings[0]!.disposition, "blocker");
});

test("a hard-rule finding without evidence cannot resolve itself or be downgraded", () => {
  const missing = settleReviewFindings({
    findings: [finding({ category: "data-loss", evidence: undefined })],
    triages: [],
  });
  assert.equal(missing.outcome, "escalated");

  const downgraded = settleReviewFindings({
    findings: [finding({ category: "data-loss", evidence: undefined })],
    triages: [triage("non_blocking", { non_blocking: 0.97 })],
  });
  assert.equal(downgraded.outcome, "escalated");
  assert.match(downgraded.escalated[0]!.reason, /Critic must confirm/u);
});

test("a Critic that agrees settles the finding; a Critic that disagrees escalates", () => {
  const agreeing = settleReviewFindings({
    findings: [finding({ evidence: undefined })],
    triages: [
      triage(
        "non_blocking",
        { non_blocking: 0.6 },
        {
          critic: {
            selected: "non_blocking",
            probabilities: { blocker: 0.05, non_blocking: 0.9, nit: 0.02, pre_existing: 0.02, false_positive: 0.01 },
            model: "critic-model",
            bindingDigest: digest,
            decidedAt: "2026-10-26T00:01:00.000Z",
          },
        },
      ),
    ],
  });
  assert.equal(agreeing.outcome, "passed");
  assert.equal(agreeing.findings[0]!.outcome, "follow_up_owned");

  const disagreeing = settleReviewFindings({
    findings: [finding({ evidence: undefined })],
    triages: [
      triage(
        "blocker",
        { blocker: 0.86 },
        {
          critic: {
            selected: "false_positive",
            probabilities: { blocker: 0.05, non_blocking: 0.05, nit: 0.02, pre_existing: 0.02, false_positive: 0.86 },
            model: "critic-model",
            bindingDigest: digest,
            decidedAt: "2026-10-26T00:01:00.000Z",
          },
        },
      ),
    ],
  });
  assert.equal(disagreeing.outcome, "escalated");
  assert.match(disagreeing.escalated[0]!.reason, /only a person can settle that conflict/u);
});

test("a triage record that disagrees with its own distribution is not a classification", () => {
  const settlement = settleReviewFindings({
    findings: [finding({ evidence: undefined })],
    triages: [triage("blocker", { blocker: 0.2, false_positive: 0.9 })],
  });
  assert.equal(settlement.outcome, "escalated");
});

test("a per-cut threshold override narrows without being able to lower a hard rule", () => {
  const highBar = settleReviewFindings({
    findings: [finding({ evidence: undefined })],
    triages: [triage("blocker", { blocker: 0.86 })],
    thresholds: { correctness: 0.95 },
  });
  assert.equal(highBar.outcome, "escalated", "the cut's own floor is honored");

  const lowered = settleReviewFindings({
    findings: [finding({ category: "security-auth" })],
    triages: [triage("non_blocking", { non_blocking: 0.99 })],
    thresholds: { "security-auth": 0.1 },
  });
  assert.equal(lowered.outcome, "changes_requested", "complete hard-rule evidence stays a blocker");
});

test("triage validation rejects an unknown disposition and an uncovered distribution", () => {
  assert.deepEqual(validateReviewFindingTriageV1(triage("blocker", { blocker: 1 })), []);
  assert.match(
    String(validateReviewFindingTriageV1({ ...triage("blocker", { blocker: 1 }), selected: "maybe" })[0]?.message),
    /unknown disposition/u,
  );
  assert.match(
    String(
      validateReviewFindingTriageV1({
        ...triage("blocker", { blocker: 1 }),
        probabilities: { blocker: 1 },
      })[0]?.message,
    ),
    /cover all five dispositions/u,
  );
});
