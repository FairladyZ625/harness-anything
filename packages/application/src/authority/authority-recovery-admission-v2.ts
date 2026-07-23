import {
  actorAxesBindingTokenDigestV2,
  sameProtocolSchemaTupleV2,
  verifyActorAxesBindingV2,
  type VerifiedActorAxesBindingV2
} from "./actor-axes-binding-v2.ts";
import {
  assertMutationClaimMatchesV2,
  decodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  validateEnvelopeBindingV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import type { AuthoritySubmissionV2Options } from "./service-options.ts";
import type { AuthorityRecoveryAttemptV2 } from "./types.ts";

export async function validateAuthorityRecoveryAttemptV2(input: {
  readonly workspaceId: string;
  readonly recovery: AuthorityRecoveryAttemptV2;
  readonly options: AuthoritySubmissionV2Options;
}): Promise<{
  readonly envelope: SemanticMutationEnvelopeV2;
  readonly verified: VerifiedActorAxesBindingV2;
  readonly canonicalRequestEnvelope: string;
}> {
  const { recovery, options } = input;
  validateAuthorityRecoveryWitnessShape(recovery);
  const canonicalRequestEnvelope = Buffer.from(
    recovery.attempt.envelope
  ).toString("base64url");
  if (canonicalRequestEnvelope !== recovery.witness.canonicalRequestEnvelope) {
    throw new Error("AUTHORITY_RECOVERY_ENVELOPE_WITNESS_MISMATCH");
  }
  const envelope = decodeSemanticMutationEnvelopeV2(recovery.attempt.envelope);
  const opId = operationIdDiagnosticV2(envelope.operationId);
  const semanticDigest = Buffer.from(
    semanticRequestDigestV2(envelope)
  ).toString("hex");
  if (recovery.witness.workspaceId !== input.workspaceId
    || envelope.workspaceId !== input.workspaceId
    || recovery.witness.opId !== opId
    || recovery.witness.semanticDigest !== semanticDigest) {
    throw new Error("AUTHORITY_RECOVERY_INNER_IDENTITY_MISMATCH");
  }
  const token = verifyActorAxesBindingV2(
    recovery.attempt.presentationToken,
    options.bindingRuntime.proofKeys
  );
  const admittedAt = decimalBigInt(recovery.witness.admittedAtMs);
  if (token.claims.issuedAt !== admittedAt
    || admittedAt < token.claims.notBefore
    || admittedAt > token.claims.expiresAt
    || token.claims.workspaceId !== input.workspaceId
    || token.claims.authorityGeneration !== BigInt(recovery.witness.outerGeneration)
    || token.claims.authorityGeneration !== options.bindingRuntime.currentAuthorityGeneration()
    || !sameProtocolSchemaTupleV2(token.claims.schemaTuple, options.schemaTuple)) {
    throw new Error("AUTHORITY_RECOVERY_ADMISSION_WITNESS_MISMATCH");
  }
  validateEnvelopeBindingV2(envelope, token.claims);
  assertMutationClaimMatchesV2(envelope, envelope.claimedMutationSet);
  if (envelope.binding.admissionTokenRef.tokenId !== token.claims.tokenId
    || !Buffer.from(envelope.binding.admissionTokenRef.tokenDigest).equals(
      Buffer.from(actorAxesBindingTokenDigestV2(recovery.attempt.presentationToken))
    )) {
    throw new Error("AUTHORITY_RECOVERY_TOKEN_REF_MISMATCH");
  }
  if (!options.bindingRuntime.validateRecoveryAdmissionTokenRef
    || !await options.bindingRuntime.validateRecoveryAdmissionTokenRef({
      bindingId: token.claims.bindingId,
      tokenId: token.claims.tokenId,
      tokenDigest: actorAxesBindingTokenDigestV2(recovery.attempt.presentationToken)
    })) {
    throw new Error("AUTHORITY_RECOVERY_TOKEN_REGISTRATION_MISMATCH");
  }
  if (!options.operationNamespaceVerifier.verifyRecovery) {
    throw new Error("AUTHORITY_RECOVERY_NAMESPACE_VERIFIER_UNAVAILABLE");
  }
  await options.operationNamespaceVerifier.verifyRecovery(envelope.operationId);
  const attribution = recovery.witness.attribution;
  if (attribution.actor.principal.personId !== token.claims.principalPersonId
    || (attribution.actor.executor?.id ?? null) !== token.claims.executorAgentId) {
    throw new Error("AUTHORITY_RECOVERY_ATTRIBUTION_MISMATCH");
  }
  return { envelope, verified: { token, attribution }, canonicalRequestEnvelope };
}

export function validateAuthorityRecoveryWitnessShape(
  recovery: AuthorityRecoveryAttemptV2
): void {
  if (!recovery || typeof recovery !== "object"
    || !exactKeys(recovery, ["schema", "attempt", "witness"])
    || recovery.schema !== "authority-recovery-attempt/v1"
    || !recovery.attempt || typeof recovery.attempt !== "object"
    || !exactKeys(recovery.attempt, ["requestId", "presentationToken", "envelope"])
    || !recovery.witness || typeof recovery.witness !== "object"
    || !exactKeys(recovery.witness, [
      "outerOpId", "outerRequestDigest", "outerGeneration", "requestId",
      "workspaceId", "opId", "semanticDigest", "admittedAtMs",
      "canonicalRequestEnvelope", "attribution"
    ])
    || !boundedText(recovery.witness.outerOpId, 512)
    || !hex64(recovery.witness.outerRequestDigest)
    || !Number.isSafeInteger(recovery.witness.outerGeneration)
    || recovery.witness.outerGeneration < 1
    || !boundedText(recovery.witness.requestId, 512)
    || !boundedText(recovery.witness.workspaceId, 512)
    || !boundedText(recovery.witness.opId, 1024)
    || !hex64(recovery.witness.semanticDigest)
    || !/^(?:0|[1-9][0-9]*)$/u.test(recovery.witness.admittedAtMs)
    || !boundedText(recovery.witness.canonicalRequestEnvelope, 16 * 1024 * 1024)
    || !boundedText(recovery.attempt.requestId, 512)
    || !(recovery.attempt.presentationToken instanceof Uint8Array)
    || !(recovery.attempt.envelope instanceof Uint8Array)
    || recovery.attempt.requestId !== recovery.witness.requestId) {
    throw new Error("AUTHORITY_RECOVERY_WITNESS_INVALID");
  }
}

function decimalBigInt(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("AUTHORITY_RECOVERY_ADMITTED_AT_INVALID");
  }
  return BigInt(value);
}

function boundedText(value: string, maximum: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !value.includes("\0");
}

function hex64(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function exactKeys(
  value: object,
  expected: ReadonlyArray<string>
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}
