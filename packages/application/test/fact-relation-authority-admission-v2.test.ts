// harness-test-tier: contract
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
  encodeFactRelationCommandPayloadV2,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  makeFactRelationSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type SemanticBaseCasV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  deriveRelationId,
  encodeCanonicalCbor,
  entityRegistry,
  semanticMutationWireV2,
  type RegistryEntityRefV2
} from "../../kernel/src/index.ts";

test("six W2 negative controls are REJECTED before PREPARED, enqueue, or token consumption", async () => {
  const target = ref("fact", "fact/task_T/F-DEADBEEF");
  const source = ref("fact", "fact/task_T/F-CAFEBABE");
  const relationRef = ref("relation", `relation/${invalidationRelationId()}`);
  const correctBase = [present(target, "fact-v1"), present(source, "fact-v2"), absent(relationRef)];
  const state = new Map([
    [key(target), { semanticVersion: "fact-v1", stateDigest: stateDigest }],
    [key(source), { semanticVersion: "fact-v2", stateDigest: stateDigest }]
  ]);
  const semanticCompiler = makeFactRelationSemanticCompilerV2({
    state: {
      readEntityBase: async (entityRef) => state.get(key(entityRef)) ?? null,
      readHostedDocument: async () => null
    }
  });
  const draft = requestEnvelope(1, correctBase, emptySet());
  const authorityCompilation = await semanticCompiler.compile(draft);
  const exact = compileRegistryMutationPlan(
    createWritableEntityRegistry([entityRegistry.fact, entityRegistry.relation]),
    authorityCompilation.mutationPlan
  ).mutationSet;
  const claims = actorClaims();
  const secret = Buffer.alloc(32, 0x5a);
  const token = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256",
    issuer: "authority.test",
    keyId: "key-w2",
    secret
  });
  const tokenDigest = actorAxesBindingTokenDigestV2(token);
  const operationRegistry = createInMemoryAuthorityOperationRegistry();
  let enqueued = 0;
  let consumed = 0;
  const service = createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: () => ({
        enqueue: (operation) => Effect.sync(() => {
          enqueued += 1;
          return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
        }),
        flush: () => Effect.die("negative control must not flush"),
        recover: Effect.succeed({ replayedOps: 0 })
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("v1 verifier must not run"); } },
    operationRegistry,
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => null,
      inspectPublishedHead: async () => { throw new Error("negative control must not publish"); }
    },
    fenceWitness: { assertHeld: async () => undefined },
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: {
        proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
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
              providerId: "authority.test",
              credentialFingerprint: "sha256:redacted"
            },
            executorSource: "client-asserted"
          }
        }),
        currentAuthorityGeneration: () => claims.authorityGeneration,
        currentRevocationEpochs: async () => claims.revocationEpochs,
        nowMs: () => 2_000n,
        consumeOperation: async () => {
          consumed += 1;
          return true;
        },
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
          && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [entityRegistry.fact, entityRegistry.relation],
      semanticCompiler,
      operationNamespaceVerifier: { verify: async () => undefined }
    }
  });
  const omission = { ...exact, mutations: exact.mutations.slice(0, 1) };
  const addition = canonicalSet([...exact.mutations, {
    entity: ref("fact", "fact/task_T/F-ABCD1234"),
    action: { registryVersion: 1, action: "create" }
  }]);
  const relabel = canonicalSet(exact.mutations.map((mutation) => mutation.entity.entityKind === "fact"
    ? { ...mutation, action: { registryVersion: 1, action: "create" } }
    : mutation));
  const wrongBase = correctBase.map((entry, index) => index === 0
    ? { ...entry, expectedStateDigest: Buffer.alloc(32, 0xee) }
    : entry);
  const cases = [
    { name: "omission", envelope: requestEnvelope(2, correctBase, omission), reason: "SEMANTIC_MUTATION_MISMATCH" },
    { name: "addition", envelope: requestEnvelope(3, correctBase, addition), reason: "SEMANTIC_MUTATION_MISMATCH" },
    { name: "relabel", envelope: requestEnvelope(4, correctBase, relabel), reason: "SEMANTIC_MUTATION_MISMATCH" },
    {
      name: "digest",
      envelope: requestEnvelope(5, correctBase, exact, Buffer.alloc(32, 0xdd)),
      reason: "SEMANTIC_MUTATION_DIGEST_MISMATCH"
    },
    { name: "scope", envelope: requestEnvelope(6, correctBase, exact), reason: "TOKEN_ENTITY_KIND_SCOPE_DENIED" },
    { name: "base-CAS", envelope: requestEnvelope(7, wrongBase, exact), reason: "BASE_CAS_CONFLICT" }
  ];

  for (const fixture of cases) {
    const envelope = bindEnvelope(fixture.envelope, claims, tokenDigest);
    const receipt = await service.submitV2!({
      requestId: `negative-${fixture.name}`,
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    });
    assert.equal(receipt.tag, "REJECTED", fixture.name);
    assert.equal(receipt.tag === "REJECTED" ? receipt.reason : "", fixture.reason, fixture.name);
    const stored = await operationRegistry.get(claims.workspaceId, receipt.opId);
    assert.equal(stored?.state, "REJECTED", `${fixture.name} must never reach PREPARED`);
  }
  assert.equal(enqueued, 0);
  assert.equal(consumed, 0);
});

function requestEnvelope(
  randomByte: number,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  mutationSet: SemanticMutationSetV2,
  mutationDigest = semanticMutationSetDigestV2(mutationSet)
): SemanticMutationEnvelopeV2 {
  const payload = encodeFactRelationCommandPayloadV2({
    schema: "fact.invalidate/v1",
    ownerTaskId: "task_T",
    factId: "F-DEADBEEF",
    invalidatedByFactId: "F-CAFEBABE",
    rationale: "New evidence supersedes the old fact."
  });
  const draft: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w2",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-w2",
        deviceId: "device-w2",
        authorityGeneration: 1n,
        namespaceId: "namespace-w2",
        expiresAt: 8_000n,
        issuer: "authority.test",
        keyId: "namespace-key",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, randomByte)
    },
    binding: {
      bindingId: "binding-w2",
      actorAxesBindingDigest: Buffer.alloc(32),
      deviceId: "device-w2",
      viewId: "view-w2",
      sessionId: "session-w2",
      admissionTokenRef: { tokenId: "token-w2", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "fact.invalidate", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas,
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: mutationDigest,
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return finalize(draft);
}

function bindEnvelope(
  envelope: SemanticMutationEnvelopeV2,
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array
): SemanticMutationEnvelopeV2 {
  return finalize({
    ...envelope,
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    }
  });
}

function finalize(envelope: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...envelope, claimedSemanticRequestDigest: semanticRequestDigestV2(envelope) };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-w2",
    bindingId: "binding-w2",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent_w2",
    workspaceId: "workspace-w2",
    deviceId: "device-w2",
    viewId: "view-w2",
    sessionId: "session-w2",
    allowedEntityKinds: ["fact"],
    allowedActions: ["create", "invalidate"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 64n * 1024n,
    maxMutations: 8,
    maxOperations: 8,
    authorityGeneration: 1n,
    channelNonceDigest,
    schemaTuple,
    issuedAt: 1_000n,
    notBefore: 1_000n,
    expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

function canonicalSet(mutations: SemanticMutationSetV2["mutations"]): SemanticMutationSetV2 {
  return {
    registryVersion: 1,
    mutations: [...mutations].sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
    ))
  };
}

function emptySet(): SemanticMutationSetV2 {
  return { registryVersion: 1, mutations: [] };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: stateDigest };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function invalidationRelationId(): string {
  return deriveRelationId({
    source: "fact/task_T/F-CAFEBABE",
    target: "fact/task_T/F-DEADBEEF",
    type: "supersedes-fact",
    direction: "directed"
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const stateDigest = Buffer.alloc(32, 0x11);
const channelNonceDigest = Buffer.alloc(32, 0x22);
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
