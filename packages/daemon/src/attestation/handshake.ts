import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { credentialKey, type CredentialRef } from "../identity/types.ts";
import {
  localIpcAttestationProtocol,
  LocalIpcAttestationError,
  type AttestationAssertion,
  type AttestationChallenge,
  type AttestationProofProvider,
  type AttestationProofVerifier,
  type AttestationRole
} from "./types.ts";

export interface CreateAttestationChallengeInput {
  readonly verifierRole: AttestationRole;
  readonly channelBinding: string;
  readonly nonce?: () => Uint8Array;
}

export interface VerifyAttestationAssertionInput {
  readonly challenge: AttestationChallenge;
  readonly assertion: AttestationAssertion;
  /** Credential observed by the transport, never supplied by the peer. */
  readonly observedCredential: CredentialRef;
  readonly verifier: AttestationProofVerifier;
}

export interface MutualAttestationInput {
  readonly channelBinding: string;
  readonly client: {
    readonly credential: CredentialRef;
    readonly proofProvider: AttestationProofProvider;
    readonly peerVerifier: AttestationProofVerifier;
  };
  readonly broker: {
    readonly credential: CredentialRef;
    readonly proofProvider: AttestationProofProvider;
    readonly peerVerifier: AttestationProofVerifier;
  };
  readonly nonce?: () => Uint8Array;
}

export interface MutualAttestationResult {
  readonly protocol: typeof localIpcAttestationProtocol;
  readonly clientVerifiedBroker: true;
  readonly brokerVerifiedClient: true;
}

export function createAttestationChallenge(input: CreateAttestationChallengeInput): AttestationChallenge {
  const nonce = input.nonce?.() ?? randomBytes(32);
  if (nonce.byteLength < 16) throw new LocalIpcAttestationError("invalid_challenge");
  return {
    protocol: localIpcAttestationProtocol,
    verifierRole: input.verifierRole,
    proverRole: oppositeRole(input.verifierRole),
    nonce: Buffer.from(nonce).toString("base64url"),
    channelBindingDigest: digest(input.channelBinding)
  };
}

export async function answerAttestationChallenge(
  challenge: AttestationChallenge,
  credential: CredentialRef,
  provider: AttestationProofProvider
): Promise<AttestationAssertion> {
  validateChallenge(challenge);
  const credentialFingerprint = fingerprintCredential(credential);
  const canonicalTranscript = canonicalAttestationTranscript(challenge, credentialFingerprint);
  const proof = await provider.issue({ challenge, credential, canonicalTranscript });
  if (!proof) throw new LocalIpcAttestationError("proof_rejected");
  return { ...challenge, credentialFingerprint, proof };
}

export async function verifyAttestationAssertion(input: VerifyAttestationAssertionInput): Promise<void> {
  validateChallenge(input.challenge);
  const { assertion, challenge } = input;
  if (assertion.protocol !== localIpcAttestationProtocol || assertion.protocol !== challenge.protocol) {
    throw new LocalIpcAttestationError("protocol_mismatch");
  }
  if (assertion.proverRole !== challenge.proverRole || assertion.verifierRole !== challenge.verifierRole) {
    throw new LocalIpcAttestationError("role_mismatch");
  }
  if (!constantEqual(assertion.nonce, challenge.nonce)
    || !constantEqual(assertion.channelBindingDigest, challenge.channelBindingDigest)) {
    throw new LocalIpcAttestationError("channel_mismatch");
  }

  const observedFingerprint = fingerprintCredential(input.observedCredential);
  if (!constantEqual(assertion.credentialFingerprint, observedFingerprint)) {
    throw new LocalIpcAttestationError("credential_mismatch");
  }
  const canonicalTranscript = canonicalAttestationTranscript(challenge, observedFingerprint);
  const verified = await input.verifier.verify({
    challenge,
    credential: input.observedCredential,
    canonicalTranscript,
    proof: assertion.proof
  });
  if (!verified) throw new LocalIpcAttestationError("proof_rejected");
}

export async function performMutualAttestation(input: MutualAttestationInput): Promise<MutualAttestationResult> {
  const brokerChallenge = createAttestationChallenge({
    verifierRole: "broker",
    channelBinding: input.channelBinding,
    ...(input.nonce ? { nonce: input.nonce } : {})
  });
  const clientChallenge = createAttestationChallenge({
    verifierRole: "client",
    channelBinding: input.channelBinding,
    ...(input.nonce ? { nonce: input.nonce } : {})
  });
  if (constantEqual(brokerChallenge.nonce, clientChallenge.nonce)) {
    throw new LocalIpcAttestationError("invalid_challenge");
  }

  const clientAssertion = await answerAttestationChallenge(
    brokerChallenge,
    input.client.credential,
    input.client.proofProvider
  );
  const brokerAssertion = await answerAttestationChallenge(
    clientChallenge,
    input.broker.credential,
    input.broker.proofProvider
  );
  await verifyAttestationAssertion({
    challenge: brokerChallenge,
    assertion: clientAssertion,
    observedCredential: input.client.credential,
    verifier: input.broker.peerVerifier
  });
  await verifyAttestationAssertion({
    challenge: clientChallenge,
    assertion: brokerAssertion,
    observedCredential: input.broker.credential,
    verifier: input.client.peerVerifier
  });
  return {
    protocol: localIpcAttestationProtocol,
    clientVerifiedBroker: true,
    brokerVerifiedClient: true
  };
}

export function canonicalAttestationTranscript(
  challenge: AttestationChallenge,
  credentialFingerprint: string
): string {
  return [
    challenge.protocol,
    challenge.verifierRole,
    challenge.proverRole,
    challenge.nonce,
    challenge.channelBindingDigest,
    credentialFingerprint
  ].join("\0");
}

export function fingerprintCredential(credential: CredentialRef): string {
  return `sha256:${digest(credentialKey(credential))}`;
}

function validateChallenge(challenge: AttestationChallenge): void {
  if (challenge.protocol !== localIpcAttestationProtocol) {
    throw new LocalIpcAttestationError("protocol_mismatch");
  }
  if (challenge.proverRole !== oppositeRole(challenge.verifierRole)) {
    throw new LocalIpcAttestationError("role_mismatch");
  }
  if (!challenge.nonce || !challenge.channelBindingDigest) {
    throw new LocalIpcAttestationError("invalid_challenge");
  }
}

function oppositeRole(role: AttestationRole): AttestationRole {
  return role === "broker" ? "client" : "broker";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}
