// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  completionEvidenceBasis,
  judgeCompletionEvidence,
  type CompletionEvidenceV1,
  type ExecutionV1,
} from "../../src/index.ts";

const execution = {
  schema: "execution/v1",
  executionId: "exe-current",
  taskId: "task-current",
  nodeId: "implementation",
  iteration: 0,
  state: "submitted",
  actor: { principal: { personId: "person" }, executor: null },
  claimedAt: "2026-09-09T00:00:00.000Z",
  submittedAt: "2026-09-09T00:01:00.000Z",
  closedAt: null,
  submission: {
    completionClaim: "done",
    deliverables: [],
    outputs: [],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
} as const satisfies ExecutionV1;

function evidence(result: CompletionEvidenceV1["result"] = "pass"): CompletionEvidenceV1 {
  return {
    schema: "completion-evidence/v1",
    evidenceId: "receipt-1",
    checkerId: "ci",
    gateId: "ci",
    result,
    observed: true,
    basis: completionEvidenceBasis(execution),
    provenance: { source: "runner", runId: "run-1", rawResult: "event:receipt-1" },
  };
}

test("a receipt bound to the current execution and submission supports pass", () => {
  assert.deepEqual(judgeCompletionEvidence(evidence(), { execution, gateId: "ci" }), {
    accepted: true,
    result: "pass",
  });
});

test("advisory is observed but cannot satisfy a completion gate", () => {
  const judgment = judgeCompletionEvidence(evidence("advisory"), { execution, gateId: "ci" });
  assert.equal(judgment.accepted, false);
  assert.equal(judgment.result, "advisory");
  assert.match(judgment.reason ?? "", /cannot satisfy/u);
});

test("a self-reported pass without an evidence basis is rejected", () => {
  const judgment = judgeCompletionEvidence(
    { ...evidence(), basis: undefined, provenance: undefined } as unknown as CompletionEvidenceV1,
    { execution, gateId: "ci" },
  );
  assert.equal(judgment.accepted, false);
  assert.match(judgment.reason ?? "", /basis|executionId|submissionDigest|provenance/u);
});

test("a receipt for another submission is rejected with an explicit reason", () => {
  const judgment = judgeCompletionEvidence(
    { ...evidence(), basis: { ...completionEvidenceBasis(execution), submissionDigest: "sha256:" + "f".repeat(64) } },
    { execution, gateId: "ci" },
  );
  assert.equal(judgment.accepted, false);
  assert.match(judgment.reason ?? "", /submissionDigest/u);
});

test("a receipt with an unsupported provenance source cannot become a verified fact", () => {
  const judgment = judgeCompletionEvidence(
    {
      ...evidence(),
      provenance: { source: "client", runId: "run-1", rawResult: "event:receipt-1" },
    } as unknown as CompletionEvidenceV1,
    { execution, gateId: "ci" },
  );
  assert.equal(judgment.accepted, false);
  assert.match(judgment.reason ?? "", /provenance source/u);
});

test("artifact evidence binds ledger revisions and never passes code gates", async () => {
  const { gateResults } = await import("../../src/domain/closeout-readiness.ts");
  const { validateSubmissionV1 } = await import("../../src/domain/execution.ts");
  const artifactExecution: ExecutionV1 = {
    ...execution,
    submission: {
      ...execution.submission,
      commitSha: null,
      artifacts: [{ path: "tasks/t/artifacts/report.md", revision: 7, blobSha256: "a".repeat(64) }],
    },
  };
  assert.deepEqual(validateSubmissionV1(artifactExecution.submission), []);
  assert.ok(validateSubmissionV1({ ...artifactExecution.submission, commitSha: "a".repeat(40) }).length);
  const basis = completionEvidenceBasis(artifactExecution);
  assert.equal(basis.codeCommit, undefined);
  assert.equal(basis.ledgerCut, 7);
  const snapshot = {
    task: { completionGateIds: ["ci", "code-doc-reconciliation"] },
    gateWitnesses: [],
    codeDocWitnesses: [],
  } as unknown as Parameters<typeof gateResults>[0];
  const results = gateResults(snapshot, undefined, artifactExecution.executionId, null, 0);
  assert.equal(results.length, 2);
  assert.ok(results.every((gate) => gate.status !== "passed"));
});
