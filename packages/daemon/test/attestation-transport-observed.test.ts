// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  answerAttestationChallenge,
  channelDigest32,
  connectionGeneration,
  createAttestationChallenge,
  createTransportObservedAttestationAdapter,
  verifyAttestationAssertion,
  type AuthorityConnectionContext
} from "../src/index.ts";
import { attestSubmissionService } from "../src/authority/production/transport-attested-submission-service.ts";

const context: AuthorityConnectionContext = {
  schema: "authority-connection-context/v1",
  connectionId: "connection-transport-observed",
  connectionGeneration: connectionGeneration("generation-transport-observed"),
  actor: {
    personId: "person_local",
    displayName: "Local Person",
    providerId: "transport-derived/v1",
    resolvedCredential: {
      kind: "unix-socket-owner-boundary",
      issuer: "host:fixture",
      subject: "501"
    }
  },
  repoId: "canonical",
  channelBinding: {
    digest: channelDigest32(Buffer.alloc(32, 0x61)),
    source: "transport-observed"
  },
  peerCredential: {
    schema: "os-observed-peer-credential/v1",
    platform: "darwin",
    source: "getpeereid",
    uid: 501,
    gid: 20
  }
};

test("transport observed adapter proves only the exact accepted connection tuple", async () => {
  const adapter = createTransportObservedAttestationAdapter(context);
  const challenge = createAttestationChallenge({
    verifierRole: "broker",
    channelBinding: Buffer.from(context.channelBinding.digest).toString("hex"),
    nonce: () => Buffer.alloc(32, 0x31)
  });
  const assertion = await answerAttestationChallenge(
    challenge,
    context.actor.resolvedCredential,
    adapter.proofProvider
  );
  await verifyAttestationAssertion({
    challenge,
    assertion,
    observedCredential: context.actor.resolvedCredential,
    verifier: adapter.proofVerifier
  });

  const other = createTransportObservedAttestationAdapter({
    ...context,
    connectionGeneration: connectionGeneration("generation-other")
  });
  await assert.rejects(() => verifyAttestationAssertion({
    challenge,
    assertion,
    observedCredential: context.actor.resolvedCredential,
    verifier: other.proofVerifier
  }), /attestation proof/u);
});

test("client-reported credential and channel data are ignored", async () => {
  const adapter = createTransportObservedAttestationAdapter(context);
  const wrongChannel = createAttestationChallenge({
    verifierRole: "broker",
    channelBinding: "client-reported-channel",
    nonce: () => Buffer.alloc(32, 0x32)
  });
  assert.equal(await adapter.proofProvider.issue({
    challenge: wrongChannel,
    credential: context.actor.resolvedCredential,
    canonicalTranscript: "client-reported-transcript"
  }), "");
  assert.equal(await adapter.proofVerifier.verify({
    challenge: createAttestationChallenge({
      verifierRole: "broker",
      channelBinding: Buffer.from(context.channelBinding.digest).toString("hex"),
      nonce: () => Buffer.alloc(32, 0x33)
    }),
    credential: { ...context.actor.resolvedCredential, subject: "502" },
    canonicalTranscript: "client-reported-transcript",
    proof: "client-reported-proof"
  }), false);
});

test("transport attestation preserves V2 recovery admission", async () => {
  let resumed = 0;
  const service = attestSubmissionService({
    submit: async () => { throw new Error("unused"); },
    resumeV2: async () => {
      resumed += 1;
      return {
        tag: "INDETERMINATE",
        workspaceId: "workspace-attested-recovery",
        opId: "op-attested-recovery",
        semanticDigest: "a".repeat(64),
        reason: "fixture"
      };
    },
    getOperation: async () => undefined
  }, context);

  assert.equal(typeof service.resumeV2, "function");
  await service.resumeV2!({} as Parameters<NonNullable<typeof service.resumeV2>>[0]);
  assert.equal(resumed, 1);
});
