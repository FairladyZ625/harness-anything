import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (rootDir, relative) => import(pathToFileURL(path.join(rootDir, relative)).href);

function counted(values, countOrCounts, metric) {
  const count = typeof countOrCounts === "function" ? countOrCounts : () => (countOrCounts[metric] += 1);
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) count();
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function measureTaskReviewResponses(rootDir, size) {
  const { respondReview } = await load(rootDir, "packages/kernel/src/domain/task-lifecycle-review-transitions.ts"),
    actor = { principal: { personId: "cost-worker" }, executor: null },
    executionId = "execution-cost",
    findings = Array.from({ length: size }, (_, index) => ({ findingId: `finding-${index}`, blocking: true })),
    priorResponses = Array.from({ length: size }, (_, index) => ({
      reviewId: "review-prior",
      findingId: `prior-${index}`,
    })),
    responses = Array.from({ length: size }, (_, index) => ({
      reviewId: "review-current",
      findingId: `finding-${index}`,
      disposition: "rebut",
      rationale: "Measured response.",
    })),
    counts = { priorResponsesExamined: 0, findingsExamined: 0 },
    snapshot = {
      revision: 7,
      task: { status: "active", currentNode: "implementation", iteration: 1 },
      executions: [{ schema: "execution/v1", executionId, iteration: 1, state: "active" }],
      reviewResponses: counted(priorResponses, counts, "priorResponsesExamined"),
      reviews: [
        {
          reviewId: "review-current",
          verdict: "changes_requested",
          findings: counted(findings, counts, "findingsExamined"),
        },
      ],
    },
    command = {
      type: "RespondReview",
      taskId: "task-cost",
      expectedRevision: 7,
      executionId,
      responses,
      actor,
      occurredAt: "2026-11-02T00:00:00.000Z",
      workspaceRevision: 8,
    },
    proof = {
      actorBinding: actor,
      capability: "execution-review-response@v1",
      capabilityRef: "cost-probe",
    },
    issues = respondReview.validate(snapshot, command, proof);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  assert.equal(counts.priorResponsesExamined, size);
  assert.equal(counts.findingsExamined, size);
  return { size, counts };
}

// Exercise the production review transition for every collection it validates or freezes. Each
// probe isolates one field so a future per-member rescan of any part of the review packet is visible.
export async function measureTaskReviewExecution(rootDir, size, dimension) {
  const [{ review }, { submissionDigest }] = await Promise.all([
      load(rootDir, "packages/kernel/src/domain/task-lifecycle-review-transitions.ts"),
      load(rootDir, "packages/kernel/src/domain/execution.ts"),
    ]),
    actor = { principal: { personId: "cost-reviewer" }, executor: { kind: "agent", id: "reviewer-cost" } },
    taskId = "task-review-cost",
    executionId = "execution-review-cost",
    submission = {
      commitSha: "a".repeat(40),
      completionClaim: "Measured review transition.",
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: { gates: [] },
    },
    execution = {
      schema: "execution/v1",
      taskId,
      executionId,
      iteration: 1,
      state: "submitted",
      actor,
      claimedAt: "2026-11-02T00:00:00.000Z",
      submittedAt: "2026-11-02T00:01:00.000Z",
      closedAt: null,
      submission,
    },
    arrays = {
      findings: Array.from({ length: size }, (_, index) => ({
        findingId: `finding-${index}`,
        blocking: false,
        text: `Measured finding ${index}.`,
      })),
      evidenceChecked: Array.from({ length: size }, (_, index) => `evidence-${index}`),
      resolutions: Array.from({ length: size }, (_, index) => ({
        reviewId: "review-prior",
        findingId: `finding-${index}`,
        resolution: "upheld",
      })),
    },
    counts = { itemsExamined: 0 },
    measuredArrays = Object.fromEntries(
      Object.entries(arrays).map(([name, values]) => [
        name,
        name === dimension ? counted(values, () => (counts.itemsExamined += 1)) : values,
      ]),
    ),
    command = {
      type: "RecordReview",
      taskId,
      expectedRevision: 7,
      executionId,
      reviewId: "review-cost",
      verdict: "approved",
      reason: "Measure the production review writer.",
      evidenceChecked: measuredArrays.evidenceChecked,
      commitSha: submission.commitSha,
      iteration: execution.iteration,
      contentDigest: `sha256:${"b".repeat(64)}`,
      submissionDigest: submissionDigest(submission),
      findings: measuredArrays.findings,
      resolutions: measuredArrays.resolutions,
      actor,
      occurredAt: "2026-11-02T00:02:00.000Z",
      workspaceRevision: 8,
    },
    proof = {
      actorBinding: actor,
      capability: "execution-review@v1",
      capabilityRef: "g38-review-cost",
      reworkBudget: 1,
    },
    snapshot = {
      revision: 7,
      task: { taskId, status: "in_review", currentNode: "review", iteration: 1 },
      executions: [execution],
      reviews: [],
    },
    issues = review.validate(snapshot, command, proof);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  const result = review.reduce(snapshot, command, proof);
  assert.equal(result.event.payload.review.findings.length, size);
  assert.equal(result.event.payload.review.evidenceChecked.length, size);
  assert.equal(result.event.payload.review.resolutions.length, size);
  assert.ok(counts.itemsExamined >= size, `${dimension} must be processed by the review writer`);
  return { size, counts };
}

// Consent validation joins the selected Review against all current reviews, prior consents and
// dispositions. These are separate declared dimensions because each is an independent collection.
export async function measureTaskReviewConsent(rootDir, size, dimension) {
  const [{ consent }, { submissionDigest }, { reviewDigest }] = await Promise.all([
      load(rootDir, "packages/kernel/src/domain/task-lifecycle-review-transitions.ts"),
      load(rootDir, "packages/kernel/src/domain/execution.ts"),
      load(rootDir, "packages/kernel/src/domain/review.ts"),
    ]),
    actor = { principal: { personId: "cost-owner" }, executor: null },
    taskId = "task-consent-cost",
    executionId = "execution-consent-cost",
    submission = {
      commitSha: "c".repeat(40),
      completionClaim: "Measured review consent.",
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: { gates: [] },
    },
    digest = submissionDigest(submission),
    currentExecution = {
      schema: "execution/v1",
      taskId,
      executionId,
      iteration: 1,
      state: "submitted",
      actor,
      claimedAt: "2026-11-02T00:00:00.000Z",
      submittedAt: "2026-11-02T00:01:00.000Z",
      closedAt: null,
      submission,
    },
    selectedReview = {
      schema: "review/v1",
      reviewId: "review-selected",
      taskId,
      executionId,
      verdict: "approved",
      actor,
      capabilityRef: "g38-consent-cost",
      reason: "Measured selected review.",
      evidenceChecked: [],
      commitSha: submission.commitSha,
      iteration: 1,
      contentDigest: `sha256:${"d".repeat(64)}`,
      submissionDigest: digest,
      reviewedAt: "2026-11-02T00:02:00.000Z",
      findings: [],
      resolutions: [],
    },
    reviews = [
      selectedReview,
      ...Array.from({ length: Math.max(0, size - 1) }, (_, index) => ({
        ...selectedReview,
        reviewId: `review-prior-${index}`,
      })),
    ],
    consents = Array.from({ length: size }, (_, index) => ({
      reviewId: `review-prior-${index}`,
      executionId,
      submissionDigest: digest,
      consentedAt: "2026-11-02T00:03:00.000Z",
    })),
    dispositions = Array.from({ length: size }, (_, index) => ({
      schema: "review-disposition/v1",
      dispositionId: `disposition-${index}`,
      taskId,
      executionId,
      iteration: 1,
      submissionDigest: digest,
      disposedReviewIds: [],
      rationale: "Measured existing disposition.",
      actor,
      source: { kind: "node" },
      disposedAt: "2026-11-02T00:03:00.000Z",
    })),
    counts = { itemsExamined: 0 },
    measured = (name, values) => (name === dimension ? counted(values, () => (counts.itemsExamined += 1)) : values),
    snapshot = {
      revision: 7,
      task: { taskId, status: "in_review", currentNode: "review", iteration: 1 },
      executions: [currentExecution],
      reviews: measured("reviews", reviews),
      consents: measured("consents", consents),
      reviewDispositions: measured("dispositions", dispositions),
    },
    command = {
      type: "RecordReviewConsent",
      taskId,
      expectedRevision: 7,
      executionId,
      reviewId: selectedReview.reviewId,
      consentId: "consent-cost",
      reviewDigest: reviewDigest(selectedReview),
      contentDigest: selectedReview.contentDigest,
      actor,
      source: { kind: "node" },
      occurredAt: "2026-11-02T00:04:00.000Z",
      workspaceRevision: 8,
    },
    proof = { actorBinding: actor, capability: "execution-consent@v1", capabilityRef: "g38-consent-cost" },
    issues = consent.validate(snapshot, command, proof);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  const result = consent.reduce(snapshot, command, proof);
  assert.equal(result.snapshot.consents.length, size + 1);
  assert.ok(counts.itemsExamined >= size, `${dimension} must be processed by the consent writer`);
  return { size, counts };
}
