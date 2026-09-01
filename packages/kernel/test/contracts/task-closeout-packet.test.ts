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

test("closeout review accepts the optional qualification fields but omits them from the template", () => {
  const template = createTaskCloseoutPacketTemplate({ includeSubmission: false, ci: "not_applicable" });
  // The default scaffold stays the standard shape; the optional qualifiers are documented, not seeded.
  assert.deepEqual(Object.keys(template.review).sort(), ["evidenceChecked", "reason", "verdict"]);

  const base = {
    consent: { approved: true } as const,
    completion: { ci: "not_applicable" as const, codeDocPaths: [] },
  };
  const anchored = validateTaskCloseoutPacket({
    ...base,
    review: {
      verdict: "approved",
      reason: "Delivered and merged.",
      evidenceChecked: ["origin/main ancestry"],
      externalCompletionAnchor: "e63a871c71520ae75a6854c20204aebccb726ef4",
      noDispatchReason: "Delivered through a retired external channel.",
    },
  });
  assert.equal(anchored.ok, true, JSON.stringify(anchored));

  const weaklyMarked = validateTaskCloseoutPacket({
    ...base,
    review: {
      verdict: "approved",
      reason: "Documentation-only delivery.",
      evidenceChecked: ["authored documentation"],
      noIndependentReview: true,
      noIndependentReviewReason: "No independent reviewer was available.",
    },
  });
  assert.equal(weaklyMarked.ok, true, JSON.stringify(weaklyMarked));
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
