// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { gateAuthoritySubmissionForRecovery } from "../src/index.ts";
import { waitForProductionRecovery } from "../src/authority/production/production-recovery-admission.ts";

test("production recovery admission timeout preserves the active recovery and offers only a read-only check", async () => {
  let submissions = 0;
  const service = gateAuthoritySubmissionForRecovery({
    submit: async () => {
      submissions += 1;
      throw new Error("timed-out recovery must stay gated");
    },
    getOperation: async () => undefined
  }, () => waitForProductionRecovery({
    repoId: "canonical",
    recovery: { status: "recovering", promise: new Promise<void>(() => undefined) }
  }, 5));
  const receipt = await service.submit({
    workspaceId: "workspace-recovery-timeout",
    opId: "op-recovery-timeout",
    claimedDigest: "a".repeat(64),
    command: "task.append",
    operation: { opId: "op-recovery-timeout", entityId: "task/task_RECOVERY", kind: "progress_append", payload: { path: "progress.md", append: "x" } },
    delegationToken: "token",
    channelNonceDigest: "b".repeat(64),
    protocol: { wire: 1, event: 1, receipt: 1, digest: 1, commandRegistry: 1 }
  });

  assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED");
  assert.equal(
    receipt.reason,
    "AUTHORITY_RECOVERY_WAIT_TIMEOUT:repoId=canonical;waitedMs=5; recovery is still running. Do not start, stop, or restart any daemon and do not replay the write. Wait for the current recovery to finish, then run `ha --repo canonical daemon status --json`; retry the original command only after the repo is no longer recovering."
  );
  assert.equal(submissions, 0);
});
