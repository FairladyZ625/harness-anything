import type {
  AuthorityAlreadySatisfiedReceipt,
  AuthorityIndeterminateReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt
} from "./types.ts";
import type { AuthorityAlreadySatisfiedStateProofV1 } from "./semantic-mutation-envelope-v2.ts";
import type {
  AuthorityAdmission,
  PreparedAuthoritySubmission,
  TerminalAuthoritySubmission
} from "./service-admission-types.ts";

export function terminal(receipt: AuthorityOperationReceipt): TerminalAuthoritySubmission {
  return { kind: "terminal", receipt };
}

export function batchReceipts(
  admissions: ReadonlyArray<AuthorityAdmission>,
  receipts: ReadonlyMap<PreparedAuthoritySubmission, AuthorityOperationReceipt>
): ReadonlyArray<AuthorityOperationReceipt> {
  return admissions.map((admission) => {
    if (admission.kind === "terminal") return admission.receipt;
    const receipt = receipts.get(admission);
    if (!receipt) throw new Error(`authority batch did not settle operation ${admission.opId}`);
    return receipt;
  });
}

export function rejected(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  reason: string
): AuthorityRejectedReceipt {
  return { tag: "REJECTED", workspaceId: envelope.workspaceId, opId: envelope.opId, semanticDigest: digest, reason };
}

export function alreadySatisfied(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  stateProof: AuthorityAlreadySatisfiedStateProofV1,
  authorityIntegrity: AuthorityAlreadySatisfiedReceipt["authorityIntegrity"]
): AuthorityAlreadySatisfiedReceipt {
  return {
    tag: "ALREADY_SATISFIED",
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    semanticDigest: digest,
    message: "目标状态已满足,本次无变更",
    stateProof,
    authorityIntegrity
  };
}

export function retryable(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  reason: string
): AuthorityRetryableReceipt {
  return { tag: "RETRYABLE_NOT_COMMITTED", workspaceId: envelope.workspaceId, opId: envelope.opId, semanticDigest: digest, reason };
}

export function indeterminate(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  reason: string,
  commitSha?: string
): AuthorityIndeterminateReceipt {
  return {
    tag: "INDETERMINATE",
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    semanticDigest: digest,
    reason,
    ...(commitSha ? { commitSha } : {})
  };
}
