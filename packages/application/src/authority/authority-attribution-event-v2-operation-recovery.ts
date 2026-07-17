import type { VerifiedActorAxesBindingV2 } from "./actor-axes-binding-v2.ts";
import { actorAxesBindingDigestV2 } from "./actor-axes-binding-v2.ts";
import { isCompleteAuthorityCommittedReceiptV2 } from "./committed-event-publication-v2.ts";
import type {
  AuthorityCommittedReceipt,
  AuthorityStoredOperationRecord
} from "./types.ts";

export async function recoverKnownAuthorityOperationV2(input: {
  readonly known: AuthorityStoredOperationRecord;
  readonly semanticDigest: string;
  readonly canonicalRequestEnvelope: string;
  readonly verified: VerifiedActorAxesBindingV2;
  readonly recover: (record: AuthorityStoredOperationRecord) => Promise<AuthorityCommittedReceipt>;
  readonly persist: (receipt: AuthorityCommittedReceipt) => Promise<void>;
}): Promise<AuthorityCommittedReceipt | undefined> {
  try {
    const bindingDigest = actorBindingDigestHex(actorAxesBindingDigestV2(input.verified.token.claims));
    const integrity = input.known.authorityIntegrity;
    if (!integrity
      || integrity.semanticRequestDigest !== input.semanticDigest
      || integrity.actorAxesBindingDigest !== bindingDigest
      || input.known.canonicalRequestEnvelope !== input.canonicalRequestEnvelope
      || !input.known.commitSha) throw new Error("AUTHORITY_V2_RECOVERY_RECORD_INCOMPLETE");
    const recovered = await input.recover(input.known);
    if (!isCompleteAuthorityCommittedReceiptV2(recovered)
      || recovered.workspaceId !== input.known.workspaceId
      || recovered.opId !== input.known.opId
      || recovered.commitSha !== input.known.commitSha
      || recovered.semanticDigest !== input.known.semanticDigest
      || recovered.authorityIntegrity.semanticMutationSetDigest !== integrity.semanticMutationSetDigest
      || recovered.authorityIntegrity.actorAxesBindingDigest !== integrity.actorAxesBindingDigest) {
      throw new Error("AUTHORITY_V2_RECOVERY_RECEIPT_MISMATCH");
    }
    await input.persist(recovered);
    return recovered;
  } catch {
    // Fail closed: an unverifiable recovery never upgrades durable state.
    return undefined;
  }
}

function actorBindingDigestHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
