// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  taskCompletionAction,
  taskCompletionNext,
  type TaskRiskTierAssessmentV1,
} from "../../src/index.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

const fixture = lifecycleFixture(),
  reviewed = fixture.events.slice(0, 4).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
  context = {
    closeout: "ready" as const,
    closeoutPath: "tasks/task-1/closeout.md",
    eligibleDirtyPaths: [],
    projectionStatus: "ready" as const,
    closeoutGates: { review: true, consent: true, factDisposition: true },
  };

function assessment(
  declaredTier: TaskRiskTierAssessmentV1["declaredTier"],
  effectiveTier: TaskRiskTierAssessmentV1["effectiveTier"],
  reasons: readonly string[],
): TaskRiskTierAssessmentV1 {
  return {
    schema: "task-risk-tier-assessment/v1",
    declaredTier,
    effectiveTier,
    deliveryBaseSha: null,
    deliveryHeadSha: null,
    matchedPathReviewers: [],
    reasons,
  };
}

/** Attach the frozen assessment the submit path records; the review digest is recomputed by the projection. */
function snapshotWith(
  riskTierAssessment: TaskRiskTierAssessmentV1 | undefined,
  taskPatch: Partial<NonNullable<typeof reviewed.task>> = {},
) {
  return {
    ...reviewed,
    task: { ...reviewed.task!, ...taskPatch },
    executions: reviewed.executions.map((execution) =>
      execution.submission
        ? {
            ...execution,
            submission: {
              ...execution.submission,
              ...(riskTierAssessment === undefined ? {} : { riskTierAssessment }),
            },
          }
        : execution,
    ),
    reviews: reviewed.reviews.map(({ submissionDigest: _digest, ...review }) => review),
  };
}

function consentReason(
  riskTierAssessment: TaskRiskTierAssessmentV1 | undefined,
  taskPatch: Partial<NonNullable<typeof reviewed.task>> = {},
  closeoutGates = context.closeoutGates,
): string {
  const result = taskCompletionNext(snapshotWith(riskTierAssessment, taskPatch), {
    ...context,
    closeoutGates,
  });
  assert.equal(result.blocker?.code, "consent_missing");
  assert.ok(result.next);
  return result.next.reason;
}

test("consent reason names a declared high risk tier", () => {
  assert.match(
    consentReason(assessment("high", "high", [])),
    /^Owner consent is required because the effective risk tier is high \(declared high\)\./u,
  );
});

test("consent reason names the protected surface that raised the effective tier", () => {
  const reason = consentReason(
    assessment("medium", "high", [
      "repository-risk-floor: protected surface tools/gate-allowlists/**, tools/gate-allowlists/check-fallback-boundaries.json: tools/gate-allowlists/check-fallback-boundaries.json",
    ]),
  );
  assert.match(reason, /the effective risk tier is high \(declared medium;/u);
  assert.match(reason, /protected surface tools\/gate-allowlists\/\*\*/u);
});

test("consent reason names a matched review.pathReviewers rule", () => {
  const reason = consentReason(
    assessment("medium", "high", ["matched review.pathReviewers lane data-migration: packages/daemon/src"]),
  );
  assert.match(reason, /matched review\.pathReviewers lane data-migration: packages\/daemon\/src/u);
});

test("consent reason names the configured closeout gate below high risk", () => {
  const reason = consentReason(assessment("medium", "medium", []));
  assert.match(reason, /^Owner consent is required because the configured closeout gate requires owner consent\./u);
  assert.doesNotMatch(reason, /risk tier/u);
});

test("consent reason names a task closeout override", () => {
  const reason = consentReason(
    assessment("medium", "medium", []),
    { closeoutOverrides: { consent: true } },
    {
      review: true,
      consent: false,
      factDisposition: true,
    },
  );
  assert.match(reason, /^Owner consent is required because the task's closeout override requires owner consent\./u);
});

test("a cut that does not owe consent keeps its unchanged next step", () => {
  const snapshot = snapshotWith(undefined),
    liftedContext = { ...context, closeoutGates: { review: true, consent: false, factDisposition: true } },
    next = taskCompletionAction(snapshot, liftedContext);
  assert.equal(taskCompletionNext(snapshot, liftedContext).blocker, null);
  assert.equal(next?.action, "ha task complete task-1");
  assert.doesNotMatch(next?.reason ?? "", /Owner consent is required/u);
});

test("a non-consent blocker keeps its existing reason text", () => {
  const submitted = fixture.events.slice(0, 3).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    result = taskCompletionNext(submitted, context);
  assert.equal(result.blocker?.code, "review_pending");
  assert.equal(
    result.next?.reason,
    "The submitted cut has no recorded review; wait for the dispatched reviewer's verdict or dispatch one.",
  );
});
