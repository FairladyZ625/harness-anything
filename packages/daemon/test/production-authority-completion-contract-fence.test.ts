// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  canonicalPayloadDigestV2,
  encodeTaskLifecycleTransitionCommandPayloadV2,
  makeTaskLifecycleTransitionSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  taskAuthorityCompletionPrerequisites,
  TaskLifecycleTransitionService,
  type CanonicalTaskMutationPlan,
  type HostedDocumentSnapshotV2,
  type ProductionAuthorityCommand,
  type SemanticMutationEnvelopeV2,
  type TaskCompleteTransitionCommand,
  type TaskCompletionEvidence,
  type VerifiedTaskCompleteDocumentPublicationWitness
} from "@harness-anything/application";
import { sha256Text } from "@harness-anything/kernel";
import { makeDaemonAuthorityWriteCoordinator } from "../src/authority/authority-command-submission.ts";
import { productionTaskCompletionPrerequisiteIds } from "../src/authority/production/production-authority-task-completion-prerequisites.ts";

const taskId = "task_01KXD8H2QFMMA4T203PJZ77AQ5";
const executionId = "exe_01KXD8H2QFMMA4T203PJZ77AQ6";
const commitRef = "a".repeat(40);
const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "codex" },
  responsibleHuman: "person:person_zeyu"
};
const witness: VerifiedTaskCompleteDocumentPublicationWitness = {
  kind: "document-publication",
  ref: "ha-prepublish-witness-v1.contract-fence",
  repositoryCommit: "b".repeat(40),
  publicationOperationIds: ["op_contract_fence"],
  coveredTaskRelativePaths: ["closeout.md"],
  coveredPathSetDigest: `sha256:${"c".repeat(64)}`
};

test("production completion authority consumes the catalog-derived task-authority set", () => {
  assert.deepEqual(
    productionTaskCompletionPrerequisiteIds,
    taskAuthorityCompletionPrerequisites.map((entry) => entry.id)
  );
});

test("canonical lifecycle plan fences the daemon-evaluated task-contract snapshot against TOCTOU", async () => {
  const evaluatedContract = "{\"schema\":\"task-contract-snapshot/v1\",\"completionGates\":[]}\n";
  const changedContract = "{\"schema\":\"task-contract-snapshot/v1\",\"completionGates\":[\"ci\"]}\n";
  const plan = TaskLifecycleTransitionService.plan({
    taskId,
    taskStatus: "in_review",
    currentRound: { kind: "manual-disposition", category: "no-current-round", candidateExecutionIds: [] },
    holder: { taskId, holder: null, effectiveHolder: null, leaseExpiresAt: null, orphan: false },
    sessionBinding: { sessionId: "session-contract-fence", actor },
    verifiedExternalWitnesses: [witness],
    completionContractBodySha256: sha256Text(evaluatedContract),
    commitEvidence: completionEvidence()
  }, completeCommand());

  assert.equal(plan.kind, "commit-anchor");
  assert.equal(plan.completionContractBodySha256, sha256Text(evaluatedContract));

  const compiler = makeTaskLifecycleTransitionSemanticCompilerV2({
    rootInput: "/unused",
    state: {
      readEntityBase: async () => null,
      readHostedDocument: async (logicalPath) => {
        if (logicalPath === `tasks/${taskId}/INDEX.md`) {
          return hostedSnapshot("---\ntask:\n  status: in_review\n---\n");
        }
        if (logicalPath === `tasks/${taskId}/task-contract.json`) {
          return hostedSnapshot(changedContract);
        }
        return null;
      }
    }
  });
  await assert.rejects(
    compiler.compile(envelope(plan), {
      actor,
      sessionId: "session-contract-fence",
      nowMs: BigInt(Date.parse("2026-08-03T00:00:00.000Z"))
    }),
    /TASK_LIFECYCLE_COMPLETION_CONTRACT_CHANGED/u
  );
});

test("daemon authority coordinator does not derive canonical completion fields from a client write", async () => {
  const evaluatedDigest = sha256Text("client-side contract precondition");
  let captured: ProductionAuthorityCommand | null = null;
  const command = { rootDir: "/unused", json: true, action: completeCommand() } satisfies ProductionAuthorityCommand;
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async (input) => {
      captured = input.command;
      throw new Error("capture only");
    }
  }, {
    command,
    attribution: {} as never,
    currentSession: {} as never
  });
  await runEffect(coordinator.enqueue({
    opId: "op-contract-fence",
    entityId: `entity/execution/${executionId}`,
    kind: "doc_write",
    payload: {
      preconditions: [{ taskId, path: "task-contract.json", bodySha256: evaluatedDigest }]
    }
  }));
  await assert.rejects(runEffect(coordinator.flush("explicit")), /capture only/u);
  const capturedAction = captured?.action;
  assert.equal(capturedAction?.kind, "task-complete");
  if (capturedAction?.kind === "task-complete") {
    assert.equal(Object.hasOwn(capturedAction, "completionContractBodySha256"), false);
    assert.equal(Object.hasOwn(capturedAction, "completionApplicableGates"), false);
    assert.deepEqual(capturedAction, command.action);
  }
});

test("daemon authority coordinator submits a typed completion without a client-authored trigger write", async () => {
  let capturedIngress: string | null = null;
  let capturedEntityId: string | null = null;
  const command = { rootDir: "/unused", json: true, action: completeCommand() } satisfies ProductionAuthorityCommand;
  const coordinator = makeDaemonAuthorityWriteCoordinator({
    submit: async (input) => {
      capturedIngress = input.ingress;
      capturedEntityId = input.ingress === "generic" ? input.canonicalEntityId : null;
      return {
        tag: "COMMITTED",
        workspaceId: "workspace-contract-fence",
        opId: "op-contract-fence-command-only",
        semanticDigest: "f".repeat(64),
        revision: 1,
        commitSha: "1".repeat(40),
        previousCommit: null
      };
    }
  }, {
    command,
    attribution: {} as never,
    currentSession: {} as never
  });

  const report = await runEffect(coordinator.flush("explicit"));

  assert.equal(capturedIngress, "generic");
  assert.equal(capturedEntityId, `task/${taskId}`);
  assert.equal(report.committed, true);
  assert.equal(report.watermark, "op-contract-fence-command-only");
});

function completeCommand(): TaskCompleteTransitionCommand {
  return {
    kind: "task-complete",
    taskId,
    executionId: null,
    ciGate: "not-applicable",
    reviewerId: "person_zeyu",
    evidenceMode: "commit-anchor",
    commitRef,
    judgment: "The immutable commit completes this contract-fence fixture.",
    approval: null,
    externalCheckpointRefs: [{ kind: witness.kind, ref: witness.ref }],
    callerIdempotencyKey: `task-complete-${"d".repeat(64)}`,
    dryRun: false
  };
}

function completionEvidence(): TaskCompletionEvidence {
  return {
    schema: "task-completion-evidence/v1",
    taskId,
    mode: "commit-anchor",
    anchor: {
      sha: commitRef,
      repository: "workspace",
      codeDocRecordIds: [],
      codeDocDocumentSha256: `sha256:${"e".repeat(64)}`
    },
    judgment: {
      actor: {
        principal: { kind: "person", personId: "person_zeyu" },
        executor: { kind: "agent", id: "codex" }
      },
      sessionRef: "session-contract-fence",
      rationale: "The immutable commit completes this contract-fence fixture.",
      judgedAt: "2026-08-03T00:00:00.000Z"
    },
    gateReceipt: {
      applicableGates: [],
      ci: "not-applicable",
      closeout: "passed",
      codeDoc: "passed"
    }
  };
}

function envelope(plan: CanonicalTaskMutationPlan): SemanticMutationEnvelopeV2 {
  const bytes = encodeTaskLifecycleTransitionCommandPayloadV2({
    schema: "task.lifecycle-complete/v1",
    plan
  });
  return {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-contract-fence",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-contract-fence",
        deviceId: "device-contract-fence",
        authorityGeneration: 1n,
        namespaceId: "namespace-contract-fence",
        expiresAt: 9_999n,
        issuer: "test",
        keyId: "test",
        proof: Buffer.alloc(32)
      },
      clientRandom128: Buffer.alloc(16)
    },
    binding: {
      bindingId: "binding-contract-fence",
      actorAxesBindingDigest: Buffer.alloc(32),
      deviceId: "device-contract-fence",
      viewId: "view-contract-fence",
      sessionId: "session-contract-fence",
      admissionTokenRef: { tokenId: "token-contract-fence", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple: {
      schema: "protocol-schema-tuple/v1",
      entityRegistryVersion: 1,
      commandRegistryVersion: 1,
      mutationRegistryVersion: 1
    } as SemanticMutationEnvelopeV2["schemaTuple"],
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.lifecycle-complete", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(bytes.length), bytes },
      canonicalPayloadDigest: canonicalPayloadDigestV2(bytes),
      baseCas: [],
      declaredPathCas: []
    },
    claimedMutationSet: { registryVersion: 1, mutations: [] },
    claimedSemanticMutationSetDigest: Buffer.alloc(32),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
}

function hostedSnapshot(body: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(body);
  return { body, epoch: digest, revision: 1n, blobDigest: Buffer.from(digest, "hex") };
}

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}
