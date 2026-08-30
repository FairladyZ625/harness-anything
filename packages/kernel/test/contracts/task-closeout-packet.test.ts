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
    "packet.review.verdict",
    "packet.review.reason",
    "packet.review.evidenceChecked",
    "packet.consent.approved",
    "packet.completion.ci",
    "packet.completion.codeDocPaths[0]",
    "packet.completion.codeDocPaths[1]",
  ])
    assert.equal(report.includes(field), true, report);
  assert.equal(invalid.issues.length, 14, report);
});
