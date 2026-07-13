import {
  canonicalAttributionEventDigestV2,
  decodeAndVerifyAttributionEventV2,
  materializeAttributionProjectionFromEvents,
  physicalChangeSetDigestV2,
  type ActorAxesBindingCoreV2,
  type AttributionEventV2,
  type PhysicalChangeV2
} from "../../../kernel/src/index.ts";
import type { AuthorityCommittedReceipt } from "./types.ts";

export interface CommittedAttributionEventV2Input {
  readonly receipt: AuthorityCommittedReceipt;
  readonly actorAxesBinding: ActorAxesBindingCoreV2;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export function materializeCommittedAttributionEventV2(
  input: CommittedAttributionEventV2Input
): AttributionEventV2 {
  const integrity = input.receipt.authorityIntegrity;
  if (!integrity) throw new Error("COMMITTED_V2_INTEGRITY_REQUIRED");
  if (input.receipt.semanticDigest !== integrity.semanticRequestDigest) {
    throw new Error("RECEIPT_SEMANTIC_REQUEST_DIGEST_MISMATCH");
  }
  const changeSetDigest = attributionBytesToHex(physicalChangeSetDigestV2(input.physicalChanges));
  const withoutEventDigest: Omit<AttributionEventV2, "canonicalEventDigest"> = {
    schema: "attribution-event/v2",
    eventId: `attribution:${input.receipt.opId}`,
    workspaceId: input.receipt.workspaceId,
    opId: input.receipt.opId,
    revision: input.receipt.revision,
    commitSha: input.receipt.commitSha,
    previousCommit: input.receipt.previousCommit,
    outcome: "COMMITTED",
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    actorAxesBinding: input.actorAxesBinding,
    semanticRequestDigest: integrity.semanticRequestDigest,
    mutationSet: integrity.canonicalMutationSet,
    semanticMutationSetDigest: integrity.semanticMutationSetDigest,
    actorAxesBindingDigest: integrity.actorAxesBindingDigest,
    physicalChanges: input.physicalChanges,
    changeSetDigest
  };
  return decodeAndVerifyAttributionEventV2({
    ...withoutEventDigest,
    canonicalEventDigest: attributionBytesToHex(canonicalAttributionEventDigestV2(withoutEventDigest))
  });
}

export function materializeCommittedAttributionProjectionV2(
  projectionPath: string,
  events: ReadonlyArray<AttributionEventV2>
) {
  return materializeAttributionProjectionFromEvents(projectionPath, events);
}

function attributionBytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
