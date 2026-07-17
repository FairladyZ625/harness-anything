// harness-test-tier: contract
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  authorityKeyId,
  authoritySigningPurpose,
  authorityKeyRotationProofBytesV1,
  createAuthorityKeyLifecycleServiceV1,
  createAuthorityKeyRegistryV1,
  firstPinAuthorityKeyV1,
  prepublishAuthorityKeyV1,
  revokeAuthorityKeyV1,
  rotateAuthorityKeyV1,
  type AuthorityKeyRegistryEntryV1
} from "../src/index.ts";

test("first pin activates only the out-of-band-pinned key and persists verifier acknowledgement", () => {
  const entry = keyEntry();
  const registry = createAuthorityKeyRegistryV1({
    authorityId: entry.authorityId,
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [entry]
  });

  const activated = firstPinAuthorityKeyV1({
    registry,
    keyId: entry.keyId,
    expectedPinnedKeyId: entry.keyId,
    pinEvidence: "ssh-host-key-channel:ceremony-17",
    verifierAcknowledgement: "verifier-east:ack-42",
    activatedAtMs: 1_100
  });

  assert.equal(activated.revision, 2);
  assert.deepEqual(activated.entries[0], {
    ...entry,
    state: "ACTIVE_SIGNING",
    activationEvidence: {
      kind: "FIRST_PIN",
      pinEvidence: "ssh-host-key-channel:ceremony-17",
      verifierAcknowledgement: "verifier-east:ack-42",
      activatedAtMs: 1_100
    }
  });
});

test("first pin rejects a key that does not match the out-of-band fingerprint", () => {
  const entry = keyEntry();
  const registry = createAuthorityKeyRegistryV1({
    authorityId: entry.authorityId,
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [entry]
  });

  assert.throws(() => firstPinAuthorityKeyV1({
    registry,
    keyId: entry.keyId,
    expectedPinnedKeyId: "ed25519:sha256:not-the-pinned-key",
    pinEvidence: "ssh-host-key-channel:ceremony-17",
    verifierAcknowledgement: "verifier-east:ack-42",
    activatedAtMs: 1_100
  }), /AUTHORITY_KEY_FIRST_PIN_KEY_MISMATCH/u);
});

test("rotation verifies the predecessor signature before cutting over with an overlap window", () => {
  const predecessor = keyMaterial();
  const firstRegistry = createAuthorityKeyRegistryV1({
    authorityId: predecessor.entry.authorityId,
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [predecessor.entry]
  });
  const activeRegistry = firstPinAuthorityKeyV1({
    registry: firstRegistry,
    keyId: predecessor.entry.keyId,
    expectedPinnedKeyId: predecessor.entry.keyId,
    pinEvidence: "ssh-host-key-channel:ceremony-17",
    verifierAcknowledgement: "verifier-east:ack-42",
    activatedAtMs: 1_100
  });
  const successor = keyEntry({ predecessorKeyId: predecessor.entry.keyId });
  const proof = sign(
    null,
    authorityKeyRotationProofBytesV1({ registry: activeRegistry, successor }),
    predecessor.privateKey
  ).toString("base64url");
  const prepublishedRegistry = prepublishAuthorityKeyV1({
    registry: activeRegistry,
    successor,
    predecessorProof: proof
  });

  const forgedProof = `${proof[0] === "A" ? "B" : "A"}${proof.slice(1)}`;
  const forgedRegistry = prepublishAuthorityKeyV1({
    registry: activeRegistry,
    successor,
    predecessorProof: forgedProof
  });
  assert.throws(() => rotateAuthorityKeyV1({
    registry: forgedRegistry,
    successorKeyId: successor.keyId,
    verifierAcknowledgement: "verifier-west:ack-73",
    cutoverAtMs: 2_000
  }), /AUTHORITY_KEY_ROTATION_PROOF_INVALID/u);

  const rotated = rotateAuthorityKeyV1({
    registry: prepublishedRegistry,
    successorKeyId: successor.keyId,
    verifierAcknowledgement: "verifier-west:ack-73",
    cutoverAtMs: 2_000
  });

  assert.equal(rotated.generation, 1, "planned rotation must not advance authority generation");
  assert.equal(rotated.globalRevocationEpoch, 1);
  assert.equal(rotated.revision, 4);
  assert.equal(rotated.entries.find((entry) => entry.keyId === predecessor.entry.keyId)?.state, "VERIFY_ONLY");
  assert.equal(rotated.entries.find((entry) => entry.keyId === predecessor.entry.keyId)?.verifyUntilMs, 332_000);
  assert.deepEqual(rotated.entries.find((entry) => entry.keyId === successor.keyId)?.activationEvidence, {
    kind: "PREDECESSOR_PROOF",
    pinEvidence: null,
    verifierAcknowledgement: "verifier-west:ack-73",
    activatedAtMs: 2_000
  });
});

test("one lifecycle service executes first-pin through planned rotation and emergency revoke", () => {
  const predecessor = keyMaterial();
  const lifecycle = createAuthorityKeyLifecycleServiceV1({
    registry: createAuthorityKeyRegistryV1({
      authorityId: predecessor.entry.authorityId,
      generation: 1,
      globalRevocationEpoch: 1,
      revision: 1,
      entries: [predecessor.entry]
    }),
    revocationEpochs: {
      global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n
    }
  });
  lifecycle.firstPin({
    keyId: predecessor.entry.keyId,
    expectedPinnedKeyId: predecessor.entry.keyId,
    pinEvidence: "ssh-host-key-channel:ceremony-21",
    verifierAcknowledgement: "verifier-east:ack-80",
    activatedAtMs: 1_100
  });
  const successor = keyEntry({ predecessorKeyId: predecessor.entry.keyId });
  const predecessorProof = sign(
    null,
    authorityKeyRotationProofBytesV1({ registry: lifecycle.snapshot().registry, successor }),
    predecessor.privateKey
  ).toString("base64url");
  lifecycle.prepublish({ successor, predecessorProof });
  lifecycle.rotate({
    successorKeyId: successor.keyId,
    verifierAcknowledgement: "verifier-west:ack-81",
    cutoverAtMs: 2_000
  });
  const revoked = lifecycle.revoke({ keyId: successor.keyId });

  assert.equal(revoked.registry.generation, 2);
  assert.equal(revoked.registry.globalRevocationEpoch, 2);
  assert.equal(revoked.revocationEpochs.global, 2n);
  assert.equal(revoked.registry.entries.some((entry) =>
    entry.generation === 1 && (entry.state === "ACTIVE_SIGNING" || entry.state === "VERIFY_ONLY")), false);
});

test("revoke advances the registry and token runtime generation and global epoch together", () => {
  const entry = keyEntry();
  const activeRegistry = firstPinAuthorityKeyV1({
    registry: createAuthorityKeyRegistryV1({
      authorityId: entry.authorityId,
      generation: 4,
      globalRevocationEpoch: 7,
      revision: 1,
      entries: [{ ...entry, generation: 4 }]
    }),
    keyId: entry.keyId,
    expectedPinnedKeyId: entry.keyId,
    pinEvidence: "ssh-host-key-channel:ceremony-19",
    verifierAcknowledgement: "verifier-east:ack-51",
    activatedAtMs: 1_100
  });

  const revoked = revokeAuthorityKeyV1({
    registry: activeRegistry,
    keyId: entry.keyId,
    revocationEpochs: {
      global: 7n,
      workspace: 3n,
      device: 2n,
      view: 5n,
      principal: 11n,
      executor: 13n
    }
  });

  assert.equal(revoked.registry.generation, 5);
  assert.equal(revoked.registry.globalRevocationEpoch, 8);
  assert.equal(revoked.registry.entries[0]?.state, "REVOKED");
  assert.equal(revoked.authorityGeneration, 5n);
  assert.deepEqual(revoked.revocationEpochs, {
    global: 8n,
    workspace: 3n,
    device: 2n,
    view: 5n,
    principal: 11n,
    executor: 13n
  });
  assert.throws(() => revokeAuthorityKeyV1({
    registry: activeRegistry,
    keyId: entry.keyId,
    revocationEpochs: { ...revoked.revocationEpochs, global: 6n }
  }), /AUTHORITY_KEY_REVOKE_EPOCH_MISMATCH/u);
});

function keyEntry(overrides: Partial<AuthorityKeyRegistryEntryV1> = {}): AuthorityKeyRegistryEntryV1 {
  return keyMaterial(overrides).entry;
}

function keyMaterial(overrides: Partial<AuthorityKeyRegistryEntryV1> = {}): {
  readonly entry: AuthorityKeyRegistryEntryV1;
  readonly privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
  const entry: AuthorityKeyRegistryEntryV1 = {
    authorityId: "authority-main",
    issuer: "authority.local",
    algorithm: "Ed25519",
    keyId: authorityKeyId(publicKeySpki),
    purpose: authoritySigningPurpose,
    publicKeySpki: publicKeySpki.toString("base64url"),
    state: "PREPUBLISHED",
    generation: 1,
    notBeforeMs: 1_000,
    notAfterMs: null,
    verifyUntilMs: null,
    predecessorKeyId: null,
    predecessorProof: null,
    activationEvidence: null,
    ...overrides
  };
  return { entry, privateKey };
}
