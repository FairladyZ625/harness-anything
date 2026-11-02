import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const load = (rootDir, relative) => import(pathToFileURL(`${rootDir}/${relative}`).href);

function counted(values, counts, metric) {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) counts[metric] += 1;
      return Reflect.get(target, key, receiver);
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
  assert.equal(counts.priorResponsesExamined, size * size);
  assert.equal(counts.findingsExamined, (size * (size + 1)) / 2);
  return { size, counts };
}
