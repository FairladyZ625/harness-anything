import type {
  AuthorityOperationEnvelope,
  AuthorityProtocolTuple,
  AuthorityRejectedReceipt,
  DelegationTokenVerification
} from "./types.ts";

export function validateLegacyAuthorityIngress(
  envelope: AuthorityOperationEnvelope,
  digest: string,
  workspaceId: string
): AuthorityRejectedReceipt | undefined {
  if (!envelope.workspaceId || envelope.workspaceId !== workspaceId) return legacyRejected(envelope, digest, "WORKSPACE_MISMATCH");
  if (!envelope.opId || envelope.operation.opId !== envelope.opId) return legacyRejected(envelope, digest, "OP_ID_MISMATCH");
  if (envelope.claimedDigest !== digest) return legacyRejected(envelope, digest, "REQUEST_DIGEST_MISMATCH");
  if (!envelope.channelNonceDigest) return legacyRejected(envelope, digest, "CHANNEL_BINDING_REQUIRED");
  return undefined;
}

export function validateLegacyTokenEnvelopeClaims(
  envelope: AuthorityOperationEnvelope,
  verification: DelegationTokenVerification
): AuthorityRejectedReceipt | undefined {
  const claims = verification.claims;
  if (claims.workspaceId !== envelope.workspaceId) return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_WORKSPACE_MISMATCH");
  if (claims.channelNonceDigest !== envelope.channelNonceDigest) return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_CHANNEL_MISMATCH");
  if (claims.actorId !== verification.attribution.actor.principal.personId
    || claims.executorId !== (verification.attribution.actor.executor?.id ?? null)) {
    return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_ATTRIBUTION_MISMATCH");
  }
  if (!sameProtocol(claims.protocol, envelope.protocol)) return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_SCHEMA_MISMATCH");
  if (!claims.commandScopes.includes(envelope.command)) return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_COMMAND_SCOPE_DENIED");
  if (claims.maxOps < 1 || claims.maxBytes < Buffer.byteLength(JSON.stringify(envelope.operation), "utf8")) {
    return legacyRejected(envelope, envelope.claimedDigest, "TOKEN_LIMIT_EXCEEDED");
  }
  return undefined;
}

function sameProtocol(left: AuthorityProtocolTuple, right: AuthorityProtocolTuple): boolean {
  return left.wire === right.wire
    && left.event === right.event
    && left.receipt === right.receipt
    && left.digest === right.digest
    && left.commandRegistry === right.commandRegistry;
}

function legacyRejected(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  reason: string
): AuthorityRejectedReceipt {
  return { tag: "REJECTED", workspaceId: envelope.workspaceId, opId: envelope.opId, semanticDigest: digest, reason };
}
