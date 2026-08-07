// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritySubmissionWriteError,
  AuthorityPublicationOutcomeIndeterminateError,
  receiptToFlushReport
} from "../src/authority/authority-command-submission.ts";

test("authority publication indeterminate remains typed and carries proof evidence to an inspect-first rejection", () => {
  const reason = [
    "PUBLICATION_PROOF_FAILED:AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
    "expectedPreviousHead=old-head",
    "actualParents=advanced-head,session-head",
    "actualSessionParents=advanced-head",
    "mergeMessageMatchesSession=true",
    "semanticSubjectShape=true",
    "mergeTreeMatchesSession=true"
  ].join(";");
  let failure: unknown;
  try {
    receiptToFlushReport({
      tag: "INDETERMINATE",
      workspaceId: "workspace-production",
      opId: "namespace-production:receipt-honesty",
      semanticDigest: "a".repeat(64),
      reason
    }, "explicit");
  } catch (error) {
    failure = error;
  }

  assert.equal(failure instanceof AuthorityPublicationOutcomeIndeterminateError, true);
  assert.deepEqual(authoritySubmissionWriteError(failure), {
    _tag: "WriteRejected",
    code: "write_rejected",
    reason: [
      "Authority publication outcome is indeterminate; the canonical mutation may already be committed.",
      reason,
      "Inspect canonical state for operation namespace-production:receipt-honesty before retrying; do not retry this exact command blindly."
    ].join(" "),
    context: {
      schema: "authority-publication-outcome-indeterminate/v1",
      authorityState: "INDETERMINATE",
      workspaceId: "workspace-production",
      opId: "namespace-production:receipt-honesty",
      evidence: reason
    }
  });
});
