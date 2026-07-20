// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritySubmissionWriteError,
  gateAuthoritySubmissionForRecovery
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
