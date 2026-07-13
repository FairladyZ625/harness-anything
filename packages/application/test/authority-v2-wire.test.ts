// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  assertMutationClaimMatchesV2,
  decodeActorAxesBindingV2,
  decodeCanonicalCbor,
  decodeSemanticMutationEnvelopeV2,
  encodeActorAxesBindingV2,
  encodeCanonicalCbor,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  validateActorAxesBindingPresentationV2,
  validateEnvelopeBindingV2,
  type ActorAxesBindingClaimsV2,
  type ActorAxesBindingRuntimeV2,
  type ProtocolSchemaTupleV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../src/index.ts";

const secret = Buffer.from("authority-v2-contract-secret");
const schemaTuple: ProtocolSchemaTupleV2 = {
  wire: 2,
  event: 2,
  receipt: 2,
  digest: 2,
  policy: 2,
  commandRegistry: 1,
  entityRegistry: 1,
  mutationRegistry: 1,
  localState: 1,
  applyJournal: 1
};
const channelNonceDigest = Buffer.alloc(32, 7);

test("ActorAxesBindingV2 is strict canonical CBOR and verifies the protected dual axes", async () => {
  const claims = tokenClaims("token-1");
  const tokenBytes = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256",
    issuer: "authority.test",
    keyId: "key-1",
    secret
  });
  const runtime = bindingRuntime();
  const verified = await validateActorAxesBindingPresentationV2(tokenBytes, runtime, {
    workspaceId: claims.workspaceId,
    channelNonceDigest,
    schemaTuple
  });

  assert.equal(verified.token.claims.principalPersonId, "person-1");
  assert.equal(verified.token.claims.executorAgentId, "agent-1");
  assert.equal(actorAxesBindingTokenDigestV2(tokenBytes).length, 32);

  const decoded = decodeActorAxesBindingV2(tokenBytes);
  const forged = encodeActorAxesBindingV2({
    ...decoded,
    claims: { ...decoded.claims, principalPersonId: "person-relabeled" }
  });
  await assert.rejects(
    validateActorAxesBindingPresentationV2(forged, runtime, {
      workspaceId: claims.workspaceId,
      channelNonceDigest,
      schemaTuple
    }),
    /TOKEN_PROOF_INVALID/u
  );

  const wire = decodeCanonicalCbor(tokenBytes) as Record<string, unknown>;
  assert.throws(
    () => decodeActorAxesBindingV2(encodeCanonicalCbor({ ...wire, unrecognized: true })),
    /unknown or missing fields/u
  );
});

test("a reconnect token may rotate while the envelope retains its first admission token ref", async () => {
  const firstClaims = tokenClaims("token-first");
  const nextClaims = tokenClaims("token-next");
  const firstToken = issueActorAxesBindingV2(firstClaims, {
    algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-1", secret
  });
  const nextToken = issueActorAxesBindingV2(nextClaims, {
    algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-1", secret
  });
  const runtime = bindingRuntime({
    firstTokenId: firstClaims.tokenId,
    firstTokenDigest: actorAxesBindingTokenDigestV2(firstToken)
  });
  const current = await validateActorAxesBindingPresentationV2(nextToken, runtime, {
    workspaceId: nextClaims.workspaceId, channelNonceDigest, schemaTuple
  });
  const envelope = operationEnvelope(firstClaims, actorAxesBindingTokenDigestV2(firstToken));

  validateEnvelopeBindingV2(envelope, current.token.claims);
  assert.equal(await runtime.validateAdmissionTokenRef({
    bindingId: envelope.binding.bindingId,
    tokenId: envelope.binding.admissionTokenRef.tokenId,
    tokenDigest: envelope.binding.admissionTokenRef.tokenDigest
  }), true);
});

test("SemanticMutationEnvelopeV2 round-trips and claimed mutations are only an integrity assertion", () => {
  const claims = tokenClaims("token-1");
  const envelope = operationEnvelope(claims, Buffer.alloc(32, 9));
  const bytes = encodeSemanticMutationEnvelopeV2(envelope);
  const decoded = decodeSemanticMutationEnvelopeV2(bytes);

  assert.deepEqual(decoded.claimedMutationSet, envelope.claimedMutationSet);
  assert.doesNotThrow(() => assertMutationClaimMatchesV2(decoded, envelope.claimedMutationSet));
  const authorityRecomputed: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/other" },
      action: { registryVersion: 1, action: "update" }
    }]
  };
  assert.throws(
    () => assertMutationClaimMatchesV2(decoded, authorityRecomputed),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SEMANTIC_MUTATION_MISMATCH"
  );
});

function tokenClaims(tokenId: string): ActorAxesBindingClaimsV2 {
  return {
    tokenId,
    bindingId: "binding-1",
    principalPersonId: "person-1",
    executorAgentId: "agent-1",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    allowedEntityKinds: ["task"],
    allowedActions: ["update"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 4096n,
    maxMutations: 4,
    maxOperations: 8,
    authorityGeneration: 3n,
    channelNonceDigest,
    schemaTuple,
    issuedAt: 1_000n,
    notBefore: 1_000n,
    expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 2n, device: 3n, view: 4n, principal: 5n, executor: 6n }
  };
}

function bindingRuntime(admission?: { readonly firstTokenId: string; readonly firstTokenDigest: Uint8Array }): ActorAxesBindingRuntimeV2 {
  return {
    proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
    validatePresentationToken: async () => true,
    getBinding: async () => ({
      bindingId: "binding-1",
      principalPersonId: "person-1",
      executorAgentId: "agent-1",
      workspaceId: "workspace-1",
      deviceId: "device-1",
      viewId: "view-1",
      sessionId: "session-1",
      active: true,
      attribution: {
        actor: {
          principal: { kind: "person", personId: "person-1" },
          executor: { kind: "agent", id: "agent-1" }
        },
        principalSource: { kind: "daemon-authenticated", providerId: "test", credentialFingerprint: "sha256:redacted" },
        executorSource: "client-asserted"
      }
    }),
    currentAuthorityGeneration: () => 3n,
    currentRevocationEpochs: async () => ({ global: 1n, workspace: 2n, device: 3n, view: 4n, principal: 5n, executor: 6n }),
    nowMs: () => 2_000n,
    consumeOperation: async () => true,
    validateAdmissionTokenRef: async (input) => Boolean(admission)
      && input.bindingId === "binding-1"
      && input.tokenId === admission.firstTokenId
      && Buffer.from(input.tokenDigest).equals(Buffer.from(admission.firstTokenDigest))
  };
}

function operationEnvelope(claims: ActorAxesBindingClaimsV2, admissionTokenDigest: Uint8Array): SemanticMutationEnvelopeV2 {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/one" },
      action: { registryVersion: 1, action: "update" }
    }]
  };
  const withoutRequestDigest: SemanticMutationEnvelopeV2 = {
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
        proof: Buffer.alloc(32, 4)
      },
      clientRandom128: Buffer.alloc(16, 5)
    },
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: "token-first", tokenDigest: admissionTokenDigest }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.update", version: 1 },
      canonicalPayload: { kind: "inline", size: 2n, bytes: Buffer.from("{}") },
      canonicalPayloadDigest: Buffer.alloc(32, 8),
      baseCas: [],
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return {
    ...withoutRequestDigest,
    claimedSemanticRequestDigest: semanticRequestDigestV2(withoutRequestDigest)
  };
}
