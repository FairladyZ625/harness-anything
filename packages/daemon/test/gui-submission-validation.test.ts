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
});

test("#1546: a valid submission has no issues", () => {
  assert.deepEqual(validateGuiSubmission(valid), []);
});

test("#1546: a wrong-shape field is named with its expected shape, not a generic sentence", () => {
  const wrongDeliverables = validateGuiSubmission({ ...valid, deliverables: [{ kind: "text" }] });
  assert.deepEqual(wrongDeliverables, [
    "entity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' field=deliverables must be an array of non-empty strings; actual=[ { kind: 'text' } ]",
  ]);
  const wrongCommitSha = validateGuiSubmission({ ...valid, commitSha: "not-a-sha" });
  assert.deepEqual(wrongCommitSha, [
    "entity='not-a-sha' field=commitSha must be a native 40-character commit SHA; actual='not-a-sha'",
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
    "entity='bad' field=commitSha must be a native 40-character commit SHA; actual='bad'",
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
