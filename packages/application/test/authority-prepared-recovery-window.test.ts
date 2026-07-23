// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  createAuthoritySubmissionService,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type AuthorityOperationRegistry,
  type AuthorityStoredOperationRecord,
  type SemanticMutationEnvelopeV2
} from "../src/index.ts";
import { taskEntityId } from "../../kernel/src/index.ts";

const workspaceId = "workspace-prepared-recovery-window";
const channelNonceDigest = Buffer.alloc(32, 0x22);
const tokenSecret = Buffer.alloc(32, 0x5a);
const schemaTuple = {
  wire: 2,
  event: 2,
  receipt: 2,
  digest: 2,
  policy: 1,
  commandRegistry: 1,
  entityRegistry: 1,
  mutationRegistry: 1,
  localState: 1,
  applyJournal: 1
} as const;

test("V2 durable journal enqueue observes a recoverable outcome marker instead of RECEIVED", async () => {
  const fixture = authorityFixture();
  const receipt = await fixture.submit();

  assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED", JSON.stringify(receipt));
  assert.equal(fixture.recordAtDurableEnqueue()?.state, "INDETERMINATE");
  assert.equal(fixture.recordAtDurableEnqueue()?.receipt?.tag, "INDETERMINATE");
  assert.match(
    fixture.recordAtDurableEnqueue()?.receipt?.tag === "INDETERMINATE"
      ? fixture.recordAtDurableEnqueue()!.receipt!.reason
      : "",
    /JOURNAL_ENQUEUE_OUTCOME_UNKNOWN/u
  );
  assert.equal(fixture.recordAtDurableEnqueue()?.recordedProtocol?.kind, "semantic-mutation-envelope/v2");
  assert.ok(fixture.recordAtDurableEnqueue()?.authorityIntegrity);
  assert.ok(fixture.recordAtDurableEnqueue()?.canonicalRequestEnvelope);
  assert.deepEqual(
    fixture.persistedStates,
    ["RECEIVED", "INDETERMINATE", "PREPARED", "RETRYABLE_NOT_COMMITTED"],
    "PREPARED must be persisted only after enqueue succeeds"
  );
});

test("V2 enqueue failure after the durable boundary remains INDETERMINATE without replay", async () => {
  const fixture = authorityFixture({ failAfterDurableEnqueue: true });
  const receipt = await fixture.submit();
  const replayAttempt = await fixture.submit();

  assert.equal(receipt.tag, "INDETERMINATE", JSON.stringify(receipt));
  assert.equal(replayAttempt.tag, "INDETERMINATE", JSON.stringify(replayAttempt));
  assert.match(receipt.tag === "INDETERMINATE" ? receipt.reason : "", /JOURNAL_ENQUEUE_OUTCOME_UNKNOWN/u);
  assert.equal(fixture.stored()?.state, "INDETERMINATE");
  assert.equal(fixture.stored()?.receipt?.tag, "INDETERMINATE");
  assert.deepEqual(fixture.persistedStates, ["RECEIVED", "INDETERMINATE"]);
  assert.equal(fixture.enqueueCalls(), 1);
  assert.equal(fixture.flushCalls(), 0, "an unknown enqueue outcome must not be retried or flushed in-process");
});

function authorityFixture(options: { readonly failAfterDurableEnqueue?: boolean } = {}) {
  const claims = actorClaims();
  const presentationToken = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256",
    issuer: "authority.test",
    keyId: "key-prepared-recovery",
    secret: tokenSecret
  });
  const tokenDigest = actorAxesBindingTokenDigestV2(presentationToken);
  const request = semanticEnvelope(claims, tokenDigest);
  let stored: AuthorityStoredOperationRecord | undefined;
  let authorityRecordAtDurableEnqueue: AuthorityStoredOperationRecord | undefined;
  let enqueueCalls = 0;
  let flushCalls = 0;
  const persistedStates: AuthorityStoredOperationRecord["state"][] = [];
  const operationRegistry: AuthorityOperationRegistry = {
    get: async () => stored ? structuredClone(stored) : undefined,
    put: async (record) => {
      stored = structuredClone({ ...stored, ...record });
      persistedStates.push(stored.state);
    },
    list: async () => stored ? [structuredClone(stored)] : []
  };
  const service = createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: () => ({
        enqueue: (operation) => Effect.try({
          try: () => {
            enqueueCalls += 1;
            authorityRecordAtDurableEnqueue = stored ? structuredClone(stored) : undefined;
            if (options.failAfterDurableEnqueue) throw new Error("simulated disconnect after durable journal append");
            return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
          },
          catch: (cause) => ({ _tag: "JournalUnavailable" as const, cause })
        }),
        flush: (reason) => Effect.sync(() => {
          flushCalls += 1;
          return { reason, opCount: 1, committed: false };
        }),
        recover: Effect.succeed({ replayedOps: 0 })
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("V1 verifier must not run"); } },
    operationRegistry,
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => null,
      inspectPublishedHead: async () => { throw new Error("uncommitted fixture must not inspect publication"); }
    },
    fenceWitness: { assertHeld: async () => undefined },
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: {
        proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret: tokenSecret }) },
        validatePresentationToken: async (input) => bytesEqual(input.tokenDigest, tokenDigest),
        getBinding: async () => ({
          bindingId: claims.bindingId,
          principalPersonId: claims.principalPersonId,
          executorAgentId: claims.executorAgentId,
          workspaceId: claims.workspaceId,
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          active: true,
          attribution: {
            actor: {
              principal: { kind: "person", personId: claims.principalPersonId },
              executor: { kind: "agent", id: claims.executorAgentId! }
            },
            principalSource: {
              kind: "daemon-authenticated",
              providerId: "prepared-recovery-test",
              credentialFingerprint: "sha256:redacted"
            },
            executorSource: "client-asserted"
          }
        }),
        currentAuthorityGeneration: () => claims.authorityGeneration,
        currentRevocationEpochs: async () => claims.revocationEpochs,
        nowMs: () => 2_000n,
        consumeOperation: async () => true,
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
          && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [],
      semanticCompiler: {
        compile: async () => ({
          mutationPlan: { registryVersion: 1, mutations: [] },
          operation: {
            opId: "compiler-op-id-is-replaced",
            entityId: taskEntityId("task-prepared-recovery-window"),
            kind: "doc_write",
            payload: { path: "notes.md", body: "prepared recovery window\n" }
          },
          decodedBytes: 0n
        })
      },
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: {
        publish: async () => { throw new Error("uncommitted fixture must not publish an event"); }
      }
    }
  });
  return {
    persistedStates,
    submit: () => service.submitV2!({
      requestId: "request-prepared-recovery-window",
      presentationToken,
      envelope: encodeSemanticMutationEnvelopeV2(request)
    }),
    recordAtDurableEnqueue: () => authorityRecordAtDurableEnqueue,
    stored: () => stored,
    enqueueCalls: () => enqueueCalls,
    flushCalls: () => flushCalls
  };
}

function semanticEnvelope(
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array
): SemanticMutationEnvelopeV2 {
  const payload = Buffer.from("prepared recovery window", "utf8");
  const mutationSet = { registryVersion: 1, mutations: [] } as const;
  const draft: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId,
        deviceId: claims.deviceId,
        authorityGeneration: claims.authorityGeneration,
        namespaceId: "namespace-prepared-recovery",
        expiresAt: 8_000n,
        issuer: "authority.test",
        keyId: "namespace-key",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
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
      command: { registryVersion: 1, name: "test.prepared-recovery", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas: [],
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { ...draft, claimedSemanticRequestDigest: semanticRequestDigestV2(draft) };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-prepared-recovery",
    bindingId: "binding-prepared-recovery",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent_prepared_recovery",
    workspaceId,
    deviceId: "device-prepared-recovery",
    viewId: "view-prepared-recovery",
    sessionId: "session-prepared-recovery",
    allowedEntityKinds: ["task"],
    allowedActions: ["append"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 64n * 1024n,
    maxMutations: 1,
    maxOperations: 1,
    authorityGeneration: 1n,
    channelNonceDigest,
    schemaTuple,
    issuedAt: 1_000n,
    notBefore: 1_000n,
    expiresAt: 9_000n,
    revocationEpochs: {
      global: 1n,
      workspace: 1n,
      device: 1n,
      view: 1n,
      principal: 1n,
      executor: 1n
    }
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
