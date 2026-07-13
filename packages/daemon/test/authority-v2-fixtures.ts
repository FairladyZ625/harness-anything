import {
  actorAxesBindingDigestV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type ProtocolSchemaTupleV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../../application/src/index.ts";

export function v2Claims(
  workspaceId: string,
  nonce: Uint8Array,
  schemaTuple: ProtocolSchemaTupleV2
): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-v2",
    bindingId: "binding-v2",
    principalPersonId: "person_v2",
    executorAgentId: "agent_v2",
    workspaceId,
    deviceId: "device-v2",
    viewId: "view-v2",
    sessionId: "session-v2",
    allowedEntityKinds: ["task"],
    allowedActions: ["update"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 64n * 1024n,
    maxMutations: 8,
    maxOperations: 8,
    authorityGeneration: 7n,
    channelNonceDigest: nonce,
    schemaTuple,
    issuedAt: 1_000n,
    notBefore: 1_000n,
    expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

export function v2MutationSet(taskId: string): SemanticMutationSetV2 {
  return {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` },
      action: { registryVersion: 1, action: "update" }
    }]
  };
}

export function v2Envelope(
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array,
  taskId: string,
  body: string,
  randomByte: number
): SemanticMutationEnvelopeV2 {
  const payload = Buffer.from(JSON.stringify({ taskId, body }));
  const mutationSet = v2MutationSet(taskId);
  const draft: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: claims.workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: claims.workspaceId,
        deviceId: claims.deviceId,
        authorityGeneration: claims.authorityGeneration,
        namespaceId: "namespace-v2",
        expiresAt: 8_000n,
        issuer: "authority.test",
        keyId: "namespace-key-1",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, randomByte)
    },
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    },
    schemaTuple: claims.schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.update", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: Buffer.alloc(32, 6),
      baseCas: [],
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { ...draft, claimedSemanticRequestDigest: semanticRequestDigestV2(draft) };
}
