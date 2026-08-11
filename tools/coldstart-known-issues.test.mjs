// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildColdstartConclusionMatrix,
  classifyColdstartOperation,
  coldstartReportFails,
  validateColdstartKnownIssue
} from "./coldstart-known-issues.mjs";

const marker = {
  schema: "coldstart-known-issue/v1",
  issue: "task_01KZG7FWTKXMPH3SS8SZRESYR2",
  owner: "team:platform-quality",
  expiry: "2026-09-30",
  symptom: "The operation has a tracked product defect.",
  fingerprint: {
    action: {
      operationId: "task.supersede",
      description: "supersede a freshly created task",
      argvPrefix: ["task", "supersede"]
    },
    failure: {
      errorCode: "authority_ingress_rejected",
      errorHintIncludes: "TOKEN_PATH_SCOPE_DENIED"
    }
  }
};

const failure = {
  id: "task.supersede",
  argv: ["task", "supersede", "task_1"],
  exitCode: 1,
  receiptOk: false,
  errorCode: "authority_ingress_rejected",
  errorHint: "TOKEN_PATH_SCOPE_DENIED"
};

test("known-issue validation rejects ownerless, expired, and single-factor markers", () => {
  assert.deepEqual(validateColdstartKnownIssue(marker, "task.supersede", new Date("2026-08-10T00:00:00Z")), []);
  assert.match(validateColdstartKnownIssue({ ...marker, owner: "" }, "task.supersede")[0], /owner/u);
  assert.match(validateColdstartKnownIssue({ ...marker, expiry: "2026-01-01" }, "task.supersede", new Date("2026-08-10T00:00:00Z"))[0], /passed/u);
  assert.equal(validateColdstartKnownIssue({
    ...marker,
    fingerprint: { ...marker.fingerprint, failure: { errorCode: "authority_ingress_rejected" } }
  }, "task.supersede").some((error) => error.includes("errorHintIncludes")), true);
});

test("failure attribution matrix keeps product, infra, known, drift, and fixed conclusions independent", () => {
  const cases = [
    classifyColdstartOperation({ ...failure, id: "task.create", argv: ["task", "create"] }),
    classifyColdstartOperation(failure, marker),
    classifyColdstartOperation({ ...failure, errorCode: "third_failure", errorHint: "different" }, marker),
    classifyColdstartOperation({ ...failure, exitCode: 0, receiptOk: true }, marker),
    classifyColdstartOperation(failure, undefined, { errors: ["owner is required"] })
  ].map((result, index) => ({ id: `op-${index}`, ...result }));
  const matrix = buildColdstartConclusionMatrix({ results: cases });

  assert.equal(matrix.product_failure.count, 1);
  assert.equal(matrix.known_issue.count, 1);
  assert.equal(matrix.known_issue_drift.count, 1);
  assert.equal(matrix.fixed_candidate.count, 1);
  assert.equal(matrix.infrastructure_invalid.count, 1);
});

test("positive mutation: a forged known fingerprint drifts and keeps the report red", () => {
  const forged = {
    ...marker,
    fingerprint: {
      ...marker.fingerprint,
      failure: { ...marker.fingerprint.failure, errorHintIncludes: "SOME_OTHER_FAILURE" }
    }
  };
  const classified = { id: failure.id, ...classifyColdstartOperation(failure, forged) };
  const report = { conclusions: buildColdstartConclusionMatrix({ results: [classified] }), cleanup: { errors: [] } };

  assert.equal(classified.conclusion, "known_issue_drift");
  assert.equal(coldstartReportFails(report), true);
});

test("setup and advertised capability failures invalidate infrastructure and fail closed", () => {
  const conclusions = buildColdstartConclusionMatrix({
    results: [],
    setupResults: [{ label: "create task", exitCode: 1, receiptOk: false }],
    advertisedFailures: [{ kind: "task" }]
  });
  const report = { conclusions, cleanup: { errors: [] } };

  assert.deepEqual(conclusions.infrastructure_invalid.ids, ["setup:create task", "capabilities:task"]);
  assert.equal(coldstartReportFails(report), true);
});
