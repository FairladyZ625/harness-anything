import {
  decodeAndVerifyAttributionEventV2,
  type ActorAxesBindingCoreV2
} from "../../../kernel/src/index.ts";
import type { VerifiedActorAxesBindingV2 } from "./actor-axes-binding-v2.ts";
import type {
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedReceipt,
  AuthorityIntegrityTupleV2
} from "./types.ts";

export function actorAxesBindingCoreFromVerifiedV2(
  verified: VerifiedActorAxesBindingV2
): ActorAxesBindingCoreV2 {
  const claims = verified.token.claims;
  return {
    bindingId: claims.bindingId,
    principalPersonId: claims.principalPersonId,
    executorAgentId: claims.executorAgentId,
    workspaceId: claims.workspaceId,
    deviceId: claims.deviceId,
    viewId: claims.viewId,
    sessionId: claims.sessionId,
    schemaTuple: claims.schemaTuple
  };
}

export async function completeAuthorityCommittedReceiptV2(input: {
  readonly publisher: AuthorityCommittedEventPublisherV2;
  readonly receipt: AuthorityCommittedReceipt;
  readonly actorAxesBinding: ActorAxesBindingCoreV2;
  readonly occurredAt: string;
}): Promise<AuthorityCommittedReceipt> {
  const event = decodeAndVerifyAttributionEventV2(await input.publisher.publish({
    receipt: input.receipt,
    actorAxesBinding: input.actorAxesBinding,
    occurredAt: input.occurredAt
  }));
  return { ...input.receipt, integrityTuple: integrityTuple(input.receipt, event, input.occurredAt) };
}

export function isCompleteAuthorityCommittedReceiptV2(
  receipt: AuthorityCommittedReceipt
): receipt is AuthorityCommittedReceipt & {
  readonly authorityIntegrity: NonNullable<AuthorityCommittedReceipt["authorityIntegrity"]>;
  readonly integrityTuple: AuthorityIntegrityTupleV2;
} {
  const authority = receipt.authorityIntegrity;
  const tuple = receipt.integrityTuple;
  return Boolean(authority && tuple
    && tuple.schema === "authority-integrity-tuple/v2"
    && authority.semanticRequestDigest === receipt.semanticDigest
    && tuple.semanticMutationSetDigest === authority.semanticMutationSetDigest
    && tuple.actorAxesBindingDigest === authority.actorAxesBindingDigest
    && isHexDigest(tuple.canonicalEventDigest)
    && isHexDigest(tuple.changeSetDigest)
    && isHexDigest(tuple.semanticMutationSetDigest)
    && isHexDigest(tuple.actorAxesBindingDigest));
}

function integrityTuple(
  receipt: AuthorityCommittedReceipt,
  event: ReturnType<typeof decodeAndVerifyAttributionEventV2>,
  occurredAt: string
): AuthorityIntegrityTupleV2 {
  const integrity = receipt.authorityIntegrity;
  if (!integrity) throw new Error("COMMITTED_V2_INTEGRITY_REQUIRED");
  if (event.workspaceId !== receipt.workspaceId
    || event.opId !== receipt.opId
    || event.revision !== receipt.revision
    || event.commitSha !== receipt.commitSha
    || event.previousCommit !== receipt.previousCommit
    || event.eventId !== `attribution:${receipt.opId}`
    || event.occurredAt !== occurredAt
    || event.semanticRequestDigest !== receipt.semanticDigest
    || event.semanticMutationSetDigest !== integrity.semanticMutationSetDigest
    || event.actorAxesBindingDigest !== integrity.actorAxesBindingDigest) {
    throw new Error("COMMITTED_V2_EVENT_RECEIPT_MISMATCH");
  }
  return {
    schema: "authority-integrity-tuple/v2",
    canonicalEventDigest: event.canonicalEventDigest,
    changeSetDigest: event.changeSetDigest,
    semanticMutationSetDigest: event.semanticMutationSetDigest,
    actorAxesBindingDigest: event.actorAxesBindingDigest
  };
}

function isHexDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
