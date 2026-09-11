// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCloseoutPacketTemplate, validateTaskCloseoutPacket } from "../../src/index.ts";

test("closeout packet templates are derived from the authoritative schema", () => {
  const initial = createTaskCloseoutPacketTemplate({ includeSubmission: true, ci: "passed" }),
    resumed = createTaskCloseoutPacketTemplate({ includeSubmission: false, ci: "not_applicable" });
  assert.equal(validateTaskCloseoutPacket(initial).ok, true);
  assert.equal(validateTaskCloseoutPacket(resumed).ok, true);
  assert.equal(Object.hasOwn(resumed, "submission"), false);
  assert.equal(resumed.completion.ci, "not_applicable");
});

test("closeout rejects author-supplied review and consent and omits their forms", () => {
  const template = createTaskCloseoutPacketTemplate({ includeSubmission: false, ci: "not_applicable" });
  assert.deepEqual(Object.keys(template), ["completion"]);
  for (const field of ["review", "consent"]) {
    const result = validateTaskCloseoutPacket({ ...template, [field]: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.issues, [`packet.${field} is not allowed.`]);
  }
});

test("closeout packet validation reports every independent field error at once", () => {
  const invalid = validateTaskCloseoutPacket({
    unexpected: true,
    submission: {
      completionClaim: "",
      deliverables: "README.md",
      outputs: [1],
      verificationNotes: [""],
      knownGaps: {},
      residualRisks: [],
      commitSha: "short",
    },
    review: { verdict: "PASS", reason: "", evidenceChecked: "tests" },
    consent: { approved: false },
    completion: { ci: "green", codeDocPaths: ["../escape", "C:\\native"] },
  });
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  const report = invalid.issues.join("\n");
  for (const field of [
    "packet.unexpected",
    "packet.submission.completionClaim",
    "packet.submission.deliverables",
    "packet.submission.outputs[0]",
    "packet.submission.verificationNotes[0]",
    "packet.submission.knownGaps",
    "packet.submission.commitSha",
    "packet.review",
    "packet.consent",
    "packet.completion.ci",
    "packet.completion.codeDocPaths[0]",
    "packet.completion.codeDocPaths[1]",
  ])
    assert.equal(report.includes(field), true, report);
  assert.equal(invalid.issues.length, 12, report);
});
