// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  materializeCommittedAttributionEventV2,
  operationIdDiagnosticV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  validateActorAxesBindingPresentationV2,
  type ActorAxesBindingClaimsV2,
  type ActorAxesBindingRuntimeV2,
  type AuthorityRecoveryAttemptV2,
  type AuthoritySubmissionV2Options,
  type SemanticMutationEnvelopeV2
} from "../src/index.ts";
import { stablePayloadHash, taskEntityId } from "../../kernel/src/index.ts";
import {
  validateAuthorityRecoveryAttemptV2,
  validateAuthorityRecoveryWitnessShape
} from "../src/authority/authority-recovery-admission-v2.ts";

const secret = Buffer.alloc(32, 0x31);
const channelNonceDigest = Buffer.alloc(32, 0x42);
const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
  localState: 1, applyJournal: 1
} as const;

test("exact outer recovery accepts elapsed temporal/revocation/disable axes but keeps generation strict", async () => {
  const claims = actorClaims();
  const token = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256",
    issuer: "authority.test",
    keyId: "key-1",
    secret
  });
  const envelope = operationEnvelope(claims, actorAxesBindingTokenDigestV2(token));
  const attempt = {
    requestId: "request-fixed",
    presentationToken: token,
    envelope: encodeSemanticMutationEnvelopeV2(envelope)
  };
  const attribution = {
    actor: {
      principal: { kind: "person" as const, personId: claims.principalPersonId },
      executor: { kind: "agent" as const, id: claims.executorAgentId! }
    },
    principalSource: {
      kind: "daemon-authenticated" as const,
      providerId: "test",
      credentialFingerprint: "sha256:test"
    },
    executorSource: "client-asserted" as const
  };
  const recovery: AuthorityRecoveryAttemptV2 = {
    schema: "authority-recovery-attempt/v1",
    attempt,
    witness: {
      repoId: "repo-1",
      outerOpId: "outer-op-1",
      outerRequestDigest: "a".repeat(64),
      outerGeneration: 4,
      authorityGeneration: 3,
      requestId: attempt.requestId,
      workspaceId: claims.workspaceId,
      opId: operationIdDiagnosticV2(envelope.operationId),
      semanticDigest: Buffer.from(semanticRequestDigestV2(envelope)).toString("hex"),
      admittedAtMs: claims.issuedAt.toString(),
      canonicalRequestEnvelope: Buffer.from(attempt.envelope).toString("base64url"),
      attribution
    }
  };
  const runtime = bindingRuntime(claims.authorityGeneration);
  await assert.rejects(
    validateActorAxesBindingPresentationV2(token, runtime, {
      workspaceId: claims.workspaceId,
      channelNonceDigest,
      schemaTuple
    }),
    /TOKEN_EXPIRED/u
  );

  const validated = await validateAuthorityRecoveryAttemptV2({
    workspaceId: claims.workspaceId,
    recovery,
    options: recoveryOptions(runtime)
  });
  assert.equal(operationIdDiagnosticV2(validated.envelope.operationId), recovery.witness.opId);
  assert.deepEqual(validated.verified.attribution, attribution);

  await assert.rejects(
    validateAuthorityRecoveryAttemptV2({
      workspaceId: claims.workspaceId,
      recovery,
      options: recoveryOptions(bindingRuntime(claims.authorityGeneration + 1n))
    }),
    /AUTHORITY_RECOVERY_ADMISSION_WITNESS_MISMATCH/u
  );
  await assert.rejects(
    validateAuthorityRecoveryAttemptV2({
      workspaceId: claims.workspaceId,
      recovery,
      options: recoveryOptions(runtime, 5)
    }),
    /AUTHORITY_RECOVERY_OUTER_SCOPE_MISMATCH/u
  );
  await assert.rejects(
    validateAuthorityRecoveryAttemptV2({
      workspaceId: claims.workspaceId,
      recovery: {
        ...recovery,
        witness: { ...recovery.witness, authorityGeneration: 2 }
      },
      options: recoveryOptions(runtime)
    }),
    /AUTHORITY_RECOVERY_ADMISSION_WITNESS_MISMATCH/u
  );
  assert.throws(
    () => validateAuthorityRecoveryWitnessShape({
      ...recovery,
      witness: { ...recovery.witness, outerOpId: ` ${recovery.witness.outerOpId}` }
    }),
    /AUTHORITY_RECOVERY_WITNESS_INVALID/u
  );
});

const recoveryCases = [
  { name: "RECEIVED", crashState: "RECEIVED", spliceOperation: false, watermarked: false },
  { name: "PREPARED", crashState: "PREPARED", spliceOperation: false, watermarked: false },
  { name: "spliced fixed WriteOp", crashState: "RECEIVED", spliceOperation: true, watermarked: false },
  { name: "watermarked PREPARED", crashState: "PREPARED", spliceOperation: false, watermarked: true }
] as const;

for (const recoveryCase of recoveryCases) {
  test(`${recoveryCase.name} same-op recovery binds the signed attempt to one exact WriteOp`, async () => {
    const claims = actorClaims();
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256",
      issuer: "authority.test",
      keyId: "key-1",
      secret
    });
    const envelope = operationEnvelope(claims, actorAxesBindingTokenDigestV2(token));
    const attempt = {
      requestId: "request-fixed",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    };
    const attribution = {
      actor: {
        principal: { kind: "person" as const, personId: claims.principalPersonId },
        executor: { kind: "agent" as const, id: claims.executorAgentId! }
      },
      principalSource: {
        kind: "daemon-authenticated" as const,
        providerId: "test",
        credentialFingerprint: "sha256:test"
      },
      executorSource: "client-asserted" as const
    };
    const opId = operationIdDiagnosticV2(envelope.operationId);
    const semanticDigest = Buffer.from(semanticRequestDigestV2(envelope)).toString("hex");
    const canonicalRequestEnvelope = Buffer.from(attempt.envelope).toString("base64url");
    const authorityIntegrity = {
      schema: "authority-operation-integrity/v2" as const,
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest: Buffer.from(
        semanticMutationSetDigestV2(envelope.claimedMutationSet)
      ).toString("hex"),
      mutationRegistryVersion: envelope.claimedMutationSet.registryVersion,
      actorAxesBindingDigest: Buffer.from(actorAxesBindingDigestV2(claims)).toString("hex"),
      canonicalMutationSet: envelope.claimedMutationSet
    };
    const canonicalOperation = {
      opId,
      entityId: taskEntityId("task-A"),
      kind: "progress_append" as const,
      payload: { taskId: "task-A", text: "fixed\n" },
      authorityIntegrity
    };
    const canonicalRequestEnvelopeDigest = stablePayloadHash(canonicalRequestEnvelope);
    const fixedOperationBinding = {
      schema: "authority-fixed-operation-binding/v1" as const,
      repoId: "repo-1",
      workspaceId: claims.workspaceId,
      writerGeneration: 4,
      authorityGeneration: 3,
      opId,
      semanticDigest,
      canonicalRequestEnvelopeDigest,
      recordDigest: stablePayloadHash({
        schema: "authority-fixed-operation-record/v1",
        repoId: "repo-1",
        workspaceId: claims.workspaceId,
        writerGeneration: 4,
        authorityGeneration: 3,
        opId,
        semanticDigest,
        canonicalRequestEnvelopeDigest,
        operation: canonicalOperation
      })
    };
    const storedOperation = recoveryCase.spliceOperation
      ? { ...canonicalOperation, payload: { taskId: "task-A", text: "spliced\n" } }
      : canonicalOperation;
    const recovery: AuthorityRecoveryAttemptV2 = {
      schema: "authority-recovery-attempt/v1",
      attempt,
      witness: {
        repoId: "repo-1",
        outerOpId: "outer-op-1",
        outerRequestDigest: "a".repeat(64),
        outerGeneration: 4,
        authorityGeneration: 3,
        requestId: attempt.requestId,
        workspaceId: claims.workspaceId,
        opId,
        semanticDigest,
        admittedAtMs: claims.issuedAt.toString(),
        canonicalRequestEnvelope,
        attribution
      }
    };
    const registry = createInMemoryAuthorityOperationRegistry();
    await registry.put({
      workspaceId: claims.workspaceId,
      opId,
      semanticDigest,
      state: recoveryCase.crashState,
      authorityIntegrity,
      canonicalOperation: storedOperation,
      fixedOperationBinding,
      canonicalRequestEnvelope,
      recoveryPublicationPolicy: "EXACT_FIXED_OPERATION",
      recordedProtocol: {
        kind: "semantic-mutation-envelope/v2",
        schemaTuple: envelope.schemaTuple
      }
    });
    let compilerCalls = 0;
    let ordinaryFlushes = 0;
    let exactFlushes = 0;
    const ordering: string[] = [];
    const runtime = {
      ...bindingRuntime(claims.authorityGeneration),
      consumeRecoveryOperation: async () => {
        ordering.push("consume-recovery");
        return "already-consumed-by-same-op" as const;
      }
    };
    const service = createAuthoritySubmissionService({
      workspaceId: claims.workspaceId,
      coordinatorFactory: {
        create: () => ({
          enqueue: (operation) => Effect.succeed({
            opId: operation.opId,
            entityId: operation.entityId,
            accepted: true as const,
            ...(recoveryCase.watermarked ? {} : { journalWitness: {
              schema: "write-journal-record-witness/v1" as const,
              opId: operation.opId,
              recordDigest: "b".repeat(64)
            } })
          }),
          flush: () => Effect.sync(() => {
            ordinaryFlushes += 1;
            return { reason: "explicit" as const, opCount: 1, committed: true };
          }),
          flushExactJournalRecord: (_reason, witness) => Effect.sync(() => {
            exactFlushes += 1;
            assert.equal(witness.opId, opId);
            return { reason: "recovery" as const, opCount: 1, committed: true };
          }),
          recover: Effect.succeed({ replayedOps: 0 })
        })
      },
      tokenVerifier: { verify: async () => { throw new Error("legacy path"); } },
      operationRegistry: registry,
      replicaChangeLog: createInMemoryReplicaChangeLog(),
      publicationInspector: {
        currentHead: async () => "1".repeat(40),
        inspectPublishedHead: async () => ({
          commitSha: "2".repeat(40),
          parentCommits: ["1".repeat(40)]
        })
      },
      fenceWitness: {
        assertHeld: async (stage) => {
          ordering.push(`fence:${stage ?? "unspecified"}`);
        }
      },
      now: () => "2026-07-23T00:00:00.000Z",
      v2: {
        ...recoveryOptions(runtime),
        semanticCompiler: {
          compile: async () => {
            compilerCalls += 1;
            throw new Error("semantic compiler must not rerun");
          }
        },
        runAuthorizedRecoveryAttempt: async (_candidate, resume) => resume(),
        committedEventPublisher: {
          publish: async (input) => materializeCommittedAttributionEventV2({
            ...input,
            physicalChanges: [{
              path: `authority/${input.receipt.opId}`,
              beforeDigest: null,
              afterDigest: "c".repeat(64)
            }],
            recordedAt: input.occurredAt
          })
        }
      }
    });

    const receipt = await service.resumeV2!(recovery);

    assert.equal(
      receipt.tag,
      recoveryCase.spliceOperation || recoveryCase.watermarked
        ? "INDETERMINATE"
        : "COMMITTED"
    );
    assert.equal(compilerCalls, 0);
    assert.equal(ordinaryFlushes, 0);
    assert.equal(
      exactFlushes,
      recoveryCase.spliceOperation || recoveryCase.watermarked ? 0 : 1
    );
    if (!recoveryCase.spliceOperation && !recoveryCase.watermarked) {
      assert.ok(ordering.indexOf("fence:before-prepare") < ordering.indexOf("consume-recovery"));
    }
    assert.deepEqual((await registry.get(claims.workspaceId, opId))?.canonicalOperation, storedOperation);
    const publicRecord = (await service.getOperation(claims.workspaceId, opId))!;
    assert.equal("canonicalOperation" in publicRecord, false);
    assert.equal("fixedOperationBinding" in publicRecord, false);
  });
}

function recoveryOptions(
  runtime: ActorAxesBindingRuntimeV2,
  writerGeneration = 4
): AuthoritySubmissionV2Options {
  return {
    recoveryScope: { repoId: "repo-1", writerGeneration },
    schemaTuple,
    channelNonceDigest: Buffer.alloc(32, 0x99),
    bindingRuntime: runtime,
    entityRegistrations: [],
    semanticCompiler: { compile: async () => { throw new Error("not used"); } },
    operationNamespaceVerifier: {
      verify: async () => { throw new Error("new admission verifier must not run"); },
      verifyRecovery: async () => undefined
    },
    committedEventPublisher: { publish: async () => { throw new Error("not used"); } }
  };
}

function bindingRuntime(generation: bigint): ActorAxesBindingRuntimeV2 {
  return {
    proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
    validatePresentationToken: async () => false,
    getBinding: async () => ({
      bindingId: "binding-1",
      principalPersonId: "person-1",
      executorAgentId: "agent-1",
      workspaceId: "workspace-1",
      deviceId: "device-1",
      viewId: "view-1",
      sessionId: "session-1",
      active: false,
      attribution: {
        actor: {
          principal: { kind: "person", personId: "person-1" },
          executor: { kind: "agent", id: "agent-1" }
        },
        principalSource: {
          kind: "daemon-authenticated",
          providerId: "test",
          credentialFingerprint: "sha256:test"
        },
        executorSource: "client-asserted"
      }
    }),
    currentAuthorityGeneration: () => generation,
    currentRevocationEpochs: async () => ({
      global: 99n, workspace: 99n, device: 99n,
      view: 99n, principal: 99n, executor: 99n
    }),
    nowMs: () => 20_000n,
    consumeOperation: async () => "denied",
    consumeRecoveryOperation: async () => "already-consumed-by-same-op",
    validateAdmissionTokenRef: async () => false,
    validateRecoveryAdmissionTokenRef: async () => true
  };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-1",
    bindingId: "binding-1",
    principalPersonId: "person-1",
    executorAgentId: "agent-1",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    allowedEntityKinds: ["task"],
    allowedActions: ["append"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 4096n,
    maxMutations: 1,
    maxOperations: 1,
    authorityGeneration: 3n,
    channelNonceDigest,
    schemaTuple,
    issuedAt: 1_000n,
    notBefore: 1_000n,
    expiresAt: 9_000n,
    revocationEpochs: {
      global: 1n, workspace: 1n, device: 1n,
      view: 1n, principal: 1n, executor: 1n
    }
  };
}

function operationEnvelope(
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array
): SemanticMutationEnvelopeV2 {
  const mutationSet = {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_A" },
      action: { registryVersion: 1, action: "append" }
    }]
  } as const;
  const payload = Buffer.from("{}");
  const base: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: claims.workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: claims.workspaceId,
        deviceId: claims.deviceId,
        authorityGeneration: claims.authorityGeneration,
        namespaceId: "namespace-1",
        expiresAt: 8_000n,
        issuer: "authority.test",
        keyId: "namespace-key-1",
        proof: Buffer.alloc(64, 0x51)
      },
      clientRandom128: Buffer.alloc(16, 0x61)
    },
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.append", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.byteLength), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas: [],
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { ...base, claimedSemanticRequestDigest: semanticRequestDigestV2(base) };
}
