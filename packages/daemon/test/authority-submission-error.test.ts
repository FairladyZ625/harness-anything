// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritySubmissionWriteError,
  gateAuthoritySubmissionForRecovery
} from "../src/index.ts";
import { receiptToFlushReport } from "../src/authority/authority-command-submission.ts";
import { waitForProductionRecovery } from "../src/authority/production/production-recovery-admission.ts";
import {
  encodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  type ProtocolSchemaTupleV2
} from "@harness-anything/application";
import { v2Claims, v2Envelope } from "./authority-v2-fixtures.ts";

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

test("recovery gate waits before admitting both legacy and V2 authority ingress", async () => {
  let submissions = 0;
  let releaseRecovery!: () => void;
  let recovering = true;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = () => {
      recovering = false;
      resolve();
    };
  });
  const service = gateAuthoritySubmissionForRecovery({
    submit: async (envelope) => {
      submissions += 1;
      return {
        tag: "COMMITTED",
        workspaceId: envelope.workspaceId,
        opId: envelope.opId,
        semanticDigest: envelope.claimedDigest,
        commitSha: "c".repeat(40),
        receiptId: "receipt-legacy"
      };
    },
    submitV2: async (attempt) => {
      submissions += 1;
      const envelope = authorityCommandAttemptFixture().envelope;
      return {
        tag: "COMMITTED",
        workspaceId: "workspace-command-service",
        opId: operationIdDiagnosticV2(envelope.operationId),
        semanticDigest: "d".repeat(64),
        commitSha: "e".repeat(40),
        receiptId: Buffer.from(attempt.requestId).toString("hex")
      };
    },
    getOperation: async () => undefined
  }, async () => {
    if (!recovering) return undefined;
    await recovery;
    return undefined;
  });
  const legacyPromise = service.submit({
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
  const v2Promise = service.submitV2!(fixture.attempt);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
  releaseRecovery();
  const [legacy, v2] = await Promise.all([legacyPromise, v2Promise]);

  assert.equal(legacy.tag, "COMMITTED");
  assert.equal(v2.tag, "COMMITTED");
  assert.equal(v2.opId, fixture.expectedOpId);
  assert.equal(submissions, 2);
});

test("production recovery admission times out with a reachable service-daemon next step", async () => {
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
  assert.match(receipt.reason, /^AUTHORITY_RECOVERY_WAIT_TIMEOUT:repoId=canonical;waitedMs=5;/u);
  assert.match(receipt.reason, /ha daemon start --service/u);
  assert.equal(submissions, 0);
});

test("stale daemon generation receipts expose a stable retryable write error code", () => {
  const failure = (() => {
    try {
      receiptToFlushReport({
        tag: "RETRYABLE_NOT_COMMITTED",
        workspaceId: "workspace-generation-fence",
        opId: "op-generation-fence",
        semanticDigest: "a".repeat(64),
        reason: "The daemon generation is stale.",
        errorCode: "DAEMON_GENERATION_FENCED",
        errorContext: {
          schema: "daemon-generation-write-rejection/v1",
          machineId: "machine-generation",
          attemptedDaemonGeneration: 1,
          currentDaemonGeneration: 2,
          workspaceId: "workspace-generation-fence",
          opId: "op-generation-fence",
          stage: "before-terminal-journal"
        }
      }, "explicit");
    } catch (error) {
      return error;
    }
    throw new Error("receiptToFlushReport must reject a retryable fenced receipt");
  })();

  assert.deepEqual(failure, {
    _tag: "WriteRejected",
    code: "DAEMON_GENERATION_FENCED",
    context: {
      schema: "daemon-generation-write-rejection/v1",
      machineId: "machine-generation",
      attemptedDaemonGeneration: 1,
      currentDaemonGeneration: 2,
      workspaceId: "workspace-generation-fence",
      opId: "op-generation-fence",
      stage: "before-terminal-journal"
    },
    reason: "The daemon generation is stale.",
    retryable: true
  });
});

test("post-publish generation loss preserves code and context without claiming retryability", () => {
  const failure = (() => {
    try {
      receiptToFlushReport({
        tag: "INDETERMINATE",
        workspaceId: "workspace-generation-fence",
        opId: "op-generation-indeterminate",
        semanticDigest: "b".repeat(64),
        commitSha: "c".repeat(40),
        reason: "Canonical outcome requires current-generation reconciliation.",
        errorCode: "DAEMON_GENERATION_FENCED",
        errorContext: {
          schema: "daemon-generation-write-rejection/v1",
          machineId: "machine-generation",
          attemptedDaemonGeneration: 1,
          currentDaemonGeneration: 2,
          workspaceId: "workspace-generation-fence",
          opId: "op-generation-indeterminate",
          stage: "before-terminal-visibility"
        }
      }, "explicit");
    } catch (error) {
      return error;
    }
    throw new Error("receiptToFlushReport must reject a fenced indeterminate receipt");
  })() as { _tag?: string; code?: string; retryable?: boolean; context?: { stage?: string } };

  assert.equal(failure._tag, "WriteRejected");
  assert.equal(failure.code, "DAEMON_GENERATION_FENCED");
  assert.equal(failure.retryable, undefined);
  assert.equal(failure.context?.stage, "before-terminal-visibility");
});

function authorityCommandAttemptFixture() {
  const schemaTuple: ProtocolSchemaTupleV2 = {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
    localState: 1, applyJournal: 1
  };
  const claims = v2Claims("workspace-command-service", Buffer.alloc(32, 12), schemaTuple);
  const envelope = v2Envelope(claims, Buffer.alloc(32, 6), "task-command-service", "command service\n", 4);
  return {
    envelope,
    attempt: {
      requestId: "command-service-v2",
      presentationToken: Buffer.from("server-bound-token"),
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    },
    expectedOpId: operationIdDiagnosticV2(envelope.operationId)
  };
}
