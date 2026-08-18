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
  commitSha: "a".repeat(40)
});

test("#1546: a valid submission has no issues", () => {
  assert.deepEqual(validateGuiSubmission(valid), []);
});

test("#1546: a wrong-shape field is named with its expected shape, not a generic sentence", () => {
  const wrongDeliverables = validateGuiSubmission({ ...valid, deliverables: [{ kind: "text" }] });
  assert.deepEqual(wrongDeliverables, ["deliverables must be an array of non-empty strings"]);
  const wrongCommitSha = validateGuiSubmission({ ...valid, commitSha: "not-a-sha" });
  assert.deepEqual(wrongCommitSha, ["commitSha must be a native 40-character commit SHA"]);
  const emptyClaim = validateGuiSubmission({ ...valid, completionClaim: "" });
  assert.deepEqual(emptyClaim, ["completionClaim must be a non-empty string"]);
});

test("#1546: multiple simultaneously wrong fields are all named, not just the first", () => {
  const issues = validateGuiSubmission({ ...valid, deliverables: [1], commitSha: "bad" });
  assert.deepEqual(issues, ["deliverables must be an array of non-empty strings", "commitSha must be a native 40-character commit SHA"]);
});

test("#1546: a wrong field SET still fails closed with one message naming the exact contract", () => {
  const { knownGaps: _knownGaps, ...missingField } = valid;
  assert.deepEqual(validateGuiSubmission(missingField), ["SubmissionV1 requires exactly: completionClaim, deliverables, outputs, verificationNotes, knownGaps, residualRisks, commitSha"]);
  assert.deepEqual(validateGuiSubmission({ ...valid, extra: "unexpected" }), ["SubmissionV1 requires exactly: completionClaim, deliverables, outputs, verificationNotes, knownGaps, residualRisks, commitSha"]);
});
