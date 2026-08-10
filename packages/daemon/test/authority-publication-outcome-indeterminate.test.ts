// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { receiptToFlushReport } from "../src/authority/authority-command-submission.ts";

test("authority publication indeterminate remains typed and carries proof evidence without becoming a rejection", () => {
  const reason = [
    "PUBLICATION_PROOF_FAILED:AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
    "expectedPreviousHead=old-head",
    "actualParents=advanced-head,session-head",
    "actualSessionParents=advanced-head",
    "mergeMessageMatchesSession=true",
    "semanticSubjectShape=true",
    "mergeTreeMatchesSession=true"
  ].join(";");
  const report = receiptToFlushReport({
    tag: "INDETERMINATE",
    workspaceId: "workspace-production",
    opId: "namespace-production:receipt-honesty",
    semanticDigest: "a".repeat(64),
    reason
  }, "explicit");

  assert.equal("status" in report && report.status, "indeterminate");
  if (!("status" in report)) assert.fail("expected indeterminate authority report");
  assert.deepEqual(report.operationIds, ["namespace-production:receipt-honesty"]);
  assert.deepEqual(report.cause, {
    kind: "authority",
    workspaceId: "workspace-production",
    semanticDigest: "a".repeat(64),
    evidence: reason
  });
  assert.equal("committed" in report, false);
});
