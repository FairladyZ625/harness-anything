// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateGuiSubmission } from "../src/protocol/daemon-protocol.contract.ts";

const valid = Object.freeze({
  completionClaim: "Done",
  deliverables: ["a.ts"],
  outputs: ["ran tests"],
  verificationNotes: ["npm test green"],
  knownGaps: [],
  residualRisks: [],
  commitSha: "a".repeat(40),
  completionContract: { gates: [] },
});
const validRiskTierAssessment = Object.freeze({
  schema: "task-risk-tier-assessment/v1",
  declaredTier: "medium",
  effectiveTier: "medium",
  deliveryBaseSha: "b".repeat(40),
  deliveryHeadSha: "c".repeat(40),
  matchedPathReviewers: [],
  reasons: ["repository floor"],
});

test("#1546: a valid submission has no issues", () => {
  assert.deepEqual(validateGuiSubmission(valid), []);
  assert.deepEqual(validateGuiSubmission({ ...valid, riskTierAssessment: validRiskTierAssessment }), []);
});

test("submission machine facts are accepted by the wire contract", () => {
  assert.deepEqual(
    validateGuiSubmission({
      ...valid,
      changedFiles: ["packages/kernel/src/domain/execution.ts", "docs/retired.md"],
      productionDelta: {
        baseSha: "b".repeat(40),
        added: 5,
        deleted: 2,
        changed: [{ filePath: "packages/kernel/src/domain/execution.ts", module: "kernel", added: 5, deleted: 2 }],
        unclassified: [],
      },
    }),
    [],
  );
  assert.match(
    validateGuiSubmission({ ...valid, changedFiles: [""] })[0]!,
    /field=changedFiles must be an array of non-empty strings/u,
  );
  assert.match(
    validateGuiSubmission({ ...valid, productionDelta: {} })[0]!,
    /field=productionDelta requires a code commit and changedFiles/u,
  );
});

test("a submission frozen before the completion contract stays valid on the wire", () => {
  const { completionContract: _frozen, ...preFreeze } = valid;
  assert.deepEqual(validateGuiSubmission(preFreeze), []);
  assert.deepEqual(validateGuiSubmission({ ...valid, completionContract: { gates: "ci" } }), [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=completionContract must be an object with a gates array; actual={ gates: 'ci' }",
  ]);
});

test("#1546: a wrong-shape field is named with its expected shape, not a generic sentence", () => {
  const wrongDeliverables = validateGuiSubmission({ ...valid, deliverables: [{ kind: "text" }] });
  assert.deepEqual(wrongDeliverables, [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=deliverables must be an array of non-empty strings; actual=[ { kind: 'text' } ]",
  ]);
  const wrongCommitSha = validateGuiSubmission({ ...valid, commitSha: "not-a-sha" });
  assert.deepEqual(wrongCommitSha, [
    "entity='not-a-sha' field=commitSha must identify a commit or accepted artifact revisions; actual='not-a-sha'",
  ]);
  const emptyClaim = validateGuiSubmission({ ...valid, completionClaim: "" });
  assert.deepEqual(emptyClaim, [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=completionClaim must be a non-empty string; actual=''",
  ]);
});

test("#1546: multiple simultaneously wrong fields are all named, not just the first", () => {
  const issues = validateGuiSubmission({ ...valid, deliverables: [1], commitSha: "bad" });
  assert.deepEqual(issues, [
    "entity='bad' field=deliverables must be an array of non-empty strings; actual=[ 1 ]",
    "entity='bad' field=commitSha must identify a commit or accepted artifact revisions; actual='bad'",
  ]);
});

test("#1546: a wrong field SET still fails closed with one message naming the exact contract", () => {
  const { knownGaps: _knownGaps, ...missingField } = valid;
  assert.deepEqual(validateGuiSubmission(missingField), [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=knownGaps field is required; actual=undefined",
  ]);
  assert.deepEqual(validateGuiSubmission({ ...valid, extra: "unexpected" }), [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=extra field is not declared; actual='unexpected'",
  ]);
});

test("risk tier assessment is declared and validated on the GUI submission envelope", () => {
  assert.notDeepEqual(
    validateGuiSubmission({ ...valid, riskTierAssessment: { ...validRiskTierAssessment, deliveryHeadSha: "bad" } }),
    [],
  );
  assert.deepEqual(validateGuiSubmission({ ...valid, riskTierAssessment: { unexpected: true } }), [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=riskTierAssessment must be a task-risk-tier-assessment/v1 object; actual={ unexpected: true }",
  ]);
  assert.notDeepEqual(
    validateGuiSubmission({
      ...valid,
      riskTierAssessment: { ...validRiskTierAssessment, guiAcceptanceRequired: true },
    }),
    [],
    "the daemon write boundary rejects the retired history-only key",
  );
});
