// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDecisionReckonGate,
  evaluateCompletionGate,
  evaluateReviewGate,
  isCloseoutPlaceholderMarkdown,
  isReviewPlaceholderMarkdown,
  parseReviewMarkdown,
  validatePhaseRows
} from "../src/task-lifecycle-gates.ts";

test("review gate blocks open release-blocking P0-P3 findings", () => {
  const result = evaluateReviewGate({
    taskId: "task-1",
    reviewerId: "reviewer-a",
    submittedAt: "2026-06-13T00:00:00.000Z",
    findings: [{
      id: "F-001",
      severity: "P2",
      finding: "Missing closeout evidence.",
      open: true,
      blocksRelease: true
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.issues[0]?.code, "release_blocking_finding");
  assert.equal(result.issues[0]?.findingId, "F-001");
});

test("review gate emits verifier-backed contract when no blocking finding is open", () => {
  const result = evaluateReviewGate({
    taskId: "task-1",
    reviewerId: "reviewer-a",
    submittedAt: "2026-06-13T00:00:00.000Z",
    findings: [{
      id: "F-001",
      severity: "P3",
      finding: "Minor note.",
      open: false,
      blocksRelease: true
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  if (!result.ok) throw new Error("expected review gate to pass");
  assert.equal(result.contract.schema, "verifier-backed-review/v1");
  assert.equal(result.contract.findingSummary.total, 1);
  assert.equal(result.contract.findingSummary.openBlocking, 0);
});

test("review markdown parser reads material findings table and fails malformed gates closed", () => {
  const parsed = parseReviewMarkdown([
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| F-001 | P1 | Missing review. | diff | Add review. | yes | open | yes | none |",
    "| F-002 | P3 | Typo. | docs | Fix typo. | no | closed | no | none |",
    ""
  ].join("\n"));

  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0]?.open, true);
  assert.equal(parsed.findings[0]?.blocksRelease, true);
});

test("task document placeholder detection distinguishes scaffold text from real closeout and review", () => {
  assert.equal(isCloseoutPlaceholderMarkdown([
    "# Closeout",
    "",
    "## Summary",
    "",
    "Summarize the completed behavior change.",
    ""
  ].join("\n"), ["Summarize the completed behavior change."]), true);
  assert.equal(isCloseoutPlaceholderMarkdown([
    "# Closeout",
    "",
    "## Summary",
    "",
    "Implemented the document gate.",
    ""
  ].join("\n"), ["Summarize the completed behavior change."]), false);

  assert.equal(isReviewPlaceholderMarkdown([
    "# Review",
    "",
    "Status: not-started",
    "",
    "## Findings",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n")), true);
  assert.equal(isReviewPlaceholderMarkdown([
    "# Review",
    "",
    "Status: complete",
    "",
    "## Findings",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n")), false);
});

test("phase validation rejects agent-owned human gate and missing exit commands", () => {
  const result = validatePhaseRows([{
    phaseId: "GATE-02",
    kind: "gate",
    actor: "agent",
    exitCommand: "",
    evidenceStatus: "missing",
    humanGate: true
  }]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["missing_exit_command", "agent_claims_human_gate"]);
});

test("completion gate reports readiness without mutating lifecycle axes", () => {
  const result = evaluateCompletionGate({
    taskId: "task-1",
    coordinationStatus: "in_review",
    packageDisposition: "active",
    closeoutReadiness: "ready",
    reviewGate: "passed",
    ciGate: "passed"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.axes, {
    coordinationStatus: "in_review",
    packageDisposition: "active",
    closeoutReadiness: "ready"
  });

  const failed = evaluateCompletionGate({
    taskId: "task-1",
    coordinationStatus: "in_review",
    packageDisposition: "active",
    closeoutReadiness: "missing",
    reviewGate: "failed",
    ciGate: "passed"
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.issues.map((issue) => issue.code), ["review_not_passed", "closeout_not_ready"]);
});

test("non-coding contract can complete without CI while coding contract still requires it", () => {
  const base = {
    taskId: "task-writing",
    coordinationStatus: "in_review",
    packageDisposition: "active",
    closeoutReadiness: "ready" as const,
    reviewGate: "passed" as const
  };
  assert.equal(evaluateCompletionGate({ ...base, applicableGates: [] }).ok, true);
  const coding = evaluateCompletionGate({ ...base, applicableGates: ["ci", "code-doc-reconciliation"] });
  assert.equal(coding.ok, false);
  assert.deepEqual(coding.issues.map((issue) => issue.code), ["missing_ci_gate"]);
  assert.equal(evaluateCompletionGate({ ...base, applicableGates: ["ci"], ciGate: "passed" }).ok, true);
});

test("decision reckon gate fails closed on uncovered load-bearing claims", () => {
  const result = evaluateDecisionReckonGate({
    decisionId: "dec_RECKON",
    claims: [
      { id: "C1", text: "Covered claim" },
      { id: "C2", text: "Uncovered claim" }
    ],
    coverageRows: [
      { decisionRef: "decision/dec_RECKON", claimRef: "decision/dec_RECKON/C1", status: "covered", coveringFactRef: "fact/task-a/F-11111111", relationPath: ["rel_1"] },
      { decisionRef: "decision/dec_RECKON", claimRef: "decision/dec_RECKON/C2", status: "uncovered", relationPath: [] }
    ],
    reckonedAt: "2026-07-05T00:00:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.uncoveredClaimRefs, ["decision/dec_RECKON/C2"]);
});

test("decision reckon gate passes covered load-bearing claims and ignores non-load-bearing claims", () => {
  const result = evaluateDecisionReckonGate({
    decisionId: "dec_RECKON",
    claims: [
      { id: "C1", text: "Covered claim" },
      { id: "C2", text: "Non-load-bearing claim", load_bearing: false }
    ],
    coverageRows: [
      { decisionRef: "decision/dec_RECKON", claimRef: "decision/dec_RECKON/C1", status: "covered", coveringFactRef: "fact/task-a/F-11111111", relationPath: ["rel_1"] },
      { decisionRef: "decision/dec_RECKON", claimRef: "decision/dec_RECKON/C2", status: "uncovered", relationPath: [] }
    ],
    reckonedAt: "2026-07-05T00:00:00.000Z"
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.loadBearingClaimRefs, ["decision/dec_RECKON/C1"]);
});
