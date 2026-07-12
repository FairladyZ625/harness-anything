import type { CredentialRef } from "../identity/types.ts";

export const localIpcAttestationProtocol = "local-ipc-attestation/v1" as const;

export type AttestationRole = "broker" | "client";

export interface AttestationChallenge {
  readonly protocol: typeof localIpcAttestationProtocol;
  readonly verifierRole: AttestationRole;
  readonly proverRole: AttestationRole;
  readonly nonce: string;
  readonly channelBindingDigest: string;
}

export interface AttestationAssertion extends AttestationChallenge {
  readonly credentialFingerprint: string;
  readonly proof: string;
}

export interface AttestationProofInput {
  readonly challenge: AttestationChallenge;
  readonly credential: CredentialRef;
  readonly canonicalTranscript: string;
}

/**
 * The transport adapter implements this interface with evidence from its
 * existing OS credential chain. A serialized CredentialRef is never proof.
 */
export interface AttestationProofProvider {
  readonly issue: (input: AttestationProofInput) => Promise<string>;
}

export interface AttestationProofVerifier {
  readonly verify: (input: AttestationProofInput & { readonly proof: string }) => Promise<boolean>;
}

export type LocalIpcAttestationFailureCode =
  | "invalid_challenge"
  | "protocol_mismatch"
  | "role_mismatch"
  | "channel_mismatch"
  | "credential_mismatch"
  | "proof_rejected";

export class LocalIpcAttestationError extends Error {
  readonly code: LocalIpcAttestationFailureCode;

  constructor(code: LocalIpcAttestationFailureCode) {
    super(attestationFailureMessage(code));
    this.name = "LocalIpcAttestationError";
    this.code = code;
  }
}

function attestationFailureMessage(code: LocalIpcAttestationFailureCode): string {
  switch (code) {
    case "invalid_challenge": return "Local IPC attestation challenge is invalid.";
    case "protocol_mismatch": return "Local IPC attestation protocol was rejected.";
    case "role_mismatch": return "Local IPC attestation peer role was rejected.";
    case "channel_mismatch": return "Local IPC attestation channel binding was rejected.";
    case "credential_mismatch": return "Local IPC attestation transport credential was rejected.";
    case "proof_rejected": return "Local IPC attestation proof was rejected.";
  }
}
