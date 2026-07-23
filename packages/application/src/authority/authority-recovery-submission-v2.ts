import { daemonAdmissionBytes, type DaemonAdmissionBudget } from "@harness-anything/kernel";
import {
  consumeActorAxesBindingOperationV2,
  consumeRecoveredActorAxesBindingOperationV2,
  type VerifiedActorAxesBindingV2
} from "./actor-axes-binding-v2.ts";
import {
  operationIdDiagnosticV2,
  SemanticAdmissionErrorV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import type { AuthoritySubmissionV2Options } from "./service-options.ts";
import type {
  AuthorityOperationReceipt,
  AuthorityRecoveryAttemptV2
} from "./types.ts";
import {
  validateAuthorityRecoveryAttemptV2,
  validateAuthorityRecoveryWitnessShape
} from "./authority-recovery-admission-v2.ts";
import { runWithAuthorityAdmission } from "./admission.ts";

export type AuthorityV2AdmissionMode =
  | "new-admission"
  | "outer-proceeding-recovery";

export function resumeAuthorityAttemptV2(input: {
  readonly workspaceId: string;
  readonly recovery: AuthorityRecoveryAttemptV2;
  readonly options: AuthoritySubmissionV2Options;
  readonly admissionBudget?: DaemonAdmissionBudget;
  readonly submitPrepared: (validated: {
    readonly envelope: SemanticMutationEnvelopeV2;
    readonly verified: VerifiedActorAxesBindingV2;
    readonly canonicalRequestEnvelope: string;
  }) => Promise<AuthorityOperationReceipt>;
}): Promise<AuthorityOperationReceipt> {
  const runAuthorized = input.options.runAuthorizedRecoveryAttempt;
  if (!runAuthorized) {
    throw new Error("AUTHORITY_RECOVERY_AUTHORIZATION_UNAVAILABLE");
  }
  validateAuthorityRecoveryWitnessShape(input.recovery);
  return runAuthorized(input.recovery, async () => {
    const validated = await validateAuthorityRecoveryAttemptV2({
      workspaceId: input.workspaceId,
      recovery: input.recovery,
      options: input.options
    });
    const opId = operationIdDiagnosticV2(validated.envelope.operationId);
    return runWithAuthorityAdmission({
      budget: input.admissionBudget,
      identity: { workspaceId: validated.envelope.workspaceId, opId },
      semanticDigest: input.recovery.witness.semanticDigest,
      bytes: daemonAdmissionBytes(input.recovery.attempt),
      work: () => input.submitPrepared(validated)
    });
  });
}

export function createAuthorityRecoverySubmitterV2(input: {
  readonly workspaceId: string;
  readonly options: AuthoritySubmissionV2Options;
  readonly admissionBudget?: DaemonAdmissionBudget;
  readonly submitPrepared: Parameters<typeof resumeAuthorityAttemptV2>[0]["submitPrepared"];
}): (recovery: AuthorityRecoveryAttemptV2) => Promise<AuthorityOperationReceipt> {
  return (recovery) => resumeAuthorityAttemptV2({ ...input, recovery });
}

export async function validateAuthorityTokenRefAndNamespaceV2(input: {
  readonly mode: AuthorityV2AdmissionMode;
  readonly options: AuthoritySubmissionV2Options;
  readonly envelope: SemanticMutationEnvelopeV2;
}): Promise<void> {
  const tokenRef = {
    bindingId: input.envelope.binding.bindingId,
    tokenId: input.envelope.binding.admissionTokenRef.tokenId,
    tokenDigest: input.envelope.binding.admissionTokenRef.tokenDigest
  };
  const valid = input.mode === "outer-proceeding-recovery"
    ? await input.options.bindingRuntime.validateRecoveryAdmissionTokenRef?.(tokenRef)
    : await input.options.bindingRuntime.validateAdmissionTokenRef(tokenRef);
  if (!valid) throw new SemanticAdmissionErrorV2("ADMISSION_TOKEN_REF_MISMATCH");
  if (input.mode === "outer-proceeding-recovery") {
    if (!input.options.operationNamespaceVerifier.verifyRecovery) {
      throw new SemanticAdmissionErrorV2("OP_NAMESPACE_RECOVERY_UNAVAILABLE");
    }
    await input.options.operationNamespaceVerifier.verifyRecovery(input.envelope.operationId);
  } else {
    await input.options.operationNamespaceVerifier.verify(input.envelope.operationId);
  }
}

export function consumeAuthorityOperationForModeV2(input: {
  readonly mode: AuthorityV2AdmissionMode;
  readonly verified: VerifiedActorAxesBindingV2;
  readonly opId: string;
  readonly options: AuthoritySubmissionV2Options;
}): Promise<void> {
  return input.mode === "outer-proceeding-recovery"
    ? consumeRecoveredActorAxesBindingOperationV2(
      input.verified,
      input.opId,
      input.options.bindingRuntime
    )
    : consumeActorAxesBindingOperationV2(
      input.verified,
      input.opId,
      input.options.bindingRuntime
    );
}
