// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritySubmissionWriteError,
  gateAuthoritySubmissionForRecovery
} from "../src/daemon/authority-command-submission.ts";
import { authorityCommandAttemptFixture } from "./helpers/authority-command-adapter-v2.ts";

test("authority JournalUnavailable errors serialize diagnostic fields without stacks", () => {
  const failure = new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH") as Error & { code: string };
  failure.code = "EOBSERVE";
  const writeError = authoritySubmissionWriteError(failure);
  assert.deepEqual(writeError, {
    _tag: "JournalUnavailable",
    cause: {
      name: "Error",
      message: "AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH",
      code: "EOBSERVE"
    }
  });
  assert.doesNotMatch(JSON.stringify(writeError), /stack/u);
});

test("recovery gate returns retryable receipts on both legacy and V2 authority ingress", async () => {
  let submissions = 0;
  const service = gateAuthoritySubmissionForRecovery({
    submit: async () => {
      submissions += 1;
      throw new Error("legacy submission must stay gated");
    },
    submitV2: async () => {
      submissions += 1;
      throw new Error("V2 submission must stay gated");
    },
    getOperation: async () => undefined
  }, () => "AUTHORITY_RECOVERY_IN_PROGRESS:retry");
  const legacy = await service.submit({
    workspaceId: "workspace-recovery",
    opId: "op-recovery",
    claimedDigest: "a".repeat(64),
    command: "task.append",
    operation: { opId: "op-recovery", entityId: "task/task_RECOVERY", kind: "progress_append", payload: { path: "progress.md", append: "x" } },
    delegationToken: "token",
    channelNonceDigest: "b".repeat(64),
    protocol: { wire: 1, event: 1, receipt: 1, digest: 1, commandRegistry: 1 }
  });
  const fixture = authorityCommandAttemptFixture();
  const v2 = await service.submitV2!(fixture.attempt);

  assert.equal(legacy.tag, "RETRYABLE_NOT_COMMITTED");
  assert.equal(v2.tag, "RETRYABLE_NOT_COMMITTED");
  assert.equal(v2.opId, fixture.expectedOpId);
  assert.equal(submissions, 0);
});
