// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  authoritySubmissionWriteError,
  gateAuthoritySubmissionForRecovery,
  makeDaemonAuthorityWriteCoordinator
} from "../src/index.ts";
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

test("stale daemon generation receipts expose a stable retryable write error code", async () => {
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async () => ({
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
    })
  }, {
    command: {
      action: {
        kind: "progress-append",
        taskId: "task_GENERATION_FENCE",
        text: "must not commit",
        dryRun: false
      }
    },
    attribution: {},
    currentSession: {}
  } as Parameters<typeof makeDaemonAuthorityWriteCoordinator>[1]);
  await Effect.runPromise(coordinator.enqueue({
    opId: "op-generation-fence",
    entityId: "task/task_GENERATION_FENCE",
    kind: "progress_append",
    payload: { path: "progress.md", append: "must not commit\n" }
  }));

  const failure = await Effect.runPromise(Effect.flip(coordinator.flush("explicit")));

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

test("post-publish generation loss preserves code and context without claiming retryability", async () => {
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async () => ({
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
    })
  }, {
    command: { action: { kind: "progress-append", taskId: "task_GENERATION_FENCE", text: "unknown", dryRun: false } },
    attribution: {},
    currentSession: {}
  } as Parameters<typeof makeDaemonAuthorityWriteCoordinator>[1]);
  await Effect.runPromise(coordinator.enqueue({
    opId: "op-generation-indeterminate",
    entityId: "task/task_GENERATION_FENCE",
    kind: "progress_append",
    payload: { path: "progress.md", append: "unknown\n" }
  }));

  const failure = await Effect.runPromise(Effect.flip(coordinator.flush("explicit")));

  assert.equal(failure._tag, "WriteRejected");
  if (failure._tag !== "WriteRejected") return;
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
    attempt: {
      requestId: "command-service-v2",
      presentationToken: Buffer.from("server-bound-token"),
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    },
    expectedOpId: operationIdDiagnosticV2(envelope.operationId)
  };
}
