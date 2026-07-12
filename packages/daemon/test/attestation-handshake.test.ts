// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";
import {
  answerAttestationChallenge,
  createAttestationChallenge,
  LocalIpcAttestationError,
  performMutualAttestation,
  verifyAttestationAssertion,
  type AttestationProofProvider,
  type AttestationProofVerifier,
  type CredentialRef
} from "../src/index.ts";

const clientCredential: CredentialRef = {
  kind: "unix-socket-owner-boundary",
  issuer: "host:fixture",
  subject: "501"
};
const brokerCredential: CredentialRef = {
  kind: "unix-socket-owner-boundary",
  issuer: "host:fixture",
  subject: "502"
};

test("broker and client attest each other over one channel binding", async () => {
  let counter = 0;
  const clientProof = hmacProof("client-proof-key");
  const brokerProof = hmacProof("broker-proof-key");
  const result = await performMutualAttestation({
    channelBinding: "fixture-channel-7",
    client: {
      credential: clientCredential,
      proofProvider: clientProof,
      peerVerifier: brokerProof
    },
    broker: {
      credential: brokerCredential,
      proofProvider: brokerProof,
      peerVerifier: clientProof
    },
    nonce: () => Buffer.alloc(32, ++counter)
  });

  assert.deepEqual(result, {
    protocol: "local-ipc-attestation/v1",
    clientVerifiedBroker: true,
    brokerVerifiedClient: true
  });
});

test("positive attack control rejects a forged peer credential before accepting proof", async () => {
  const proof = hmacProof("client-proof-key");
  const challenge = createAttestationChallenge({
    verifierRole: "broker",
    channelBinding: "fixture-channel-7",
    nonce: () => Buffer.alloc(32, 7)
  });
  const forgedCredential: CredentialRef = {
    kind: "unix-socket-owner-boundary",
    issuer: "host:attacker",
    subject: "999"
  };
  const assertion = await answerAttestationChallenge(challenge, forgedCredential, proof);

  await assert.rejects(
    verifyAttestationAssertion({
      challenge,
      assertion,
      observedCredential: clientCredential,
      verifier: proof
    }),
    (error) => error instanceof LocalIpcAttestationError && error.code === "credential_mismatch"
  );
});

test("attestation diagnostics do not disclose credentials, tokens, or proofs", async () => {
  const credentialSecret = "credential-subject-MUST-NOT-LOG";
  const proofSecret = "token-proof-MUST-NOT-LOG";
  const challenge = createAttestationChallenge({
    verifierRole: "client",
    channelBinding: "fixture-channel",
    nonce: () => Buffer.alloc(32, 3)
  });
  const assertion = await answerAttestationChallenge(challenge, {
    ...brokerCredential,
    subject: credentialSecret
  }, {
    issue: async () => proofSecret
  });

  let caught: unknown;
  try {
    await verifyAttestationAssertion({
      challenge,
      assertion: { ...assertion, proof: proofSecret },
      observedCredential: brokerCredential,
      verifier: { verify: async () => false }
    });
  } catch (error) {
    caught = error;
  }
  const diagnostic = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
  assert.doesNotMatch(diagnostic, new RegExp(credentialSecret, "u"));
  assert.doesNotMatch(diagnostic, new RegExp(proofSecret, "u"));
  assert.match(diagnostic, /credential_mismatch/u);
});

function hmacProof(key: string): AttestationProofProvider & AttestationProofVerifier {
  const make = (transcript: string) => createHmac("sha256", key).update(transcript, "utf8").digest();
  return {
    issue: async ({ canonicalTranscript }) => make(canonicalTranscript).toString("base64url"),
    verify: async ({ canonicalTranscript, proof }) => {
      const expected = make(canonicalTranscript);
      const observed = Buffer.from(proof, "base64url");
      return expected.byteLength === observed.byteLength && timingSafeEqual(expected, observed);
    }
  };
}
