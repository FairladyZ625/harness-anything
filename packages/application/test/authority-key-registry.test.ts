// harness-test-tier: contract
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  authorityKeyId,
  authoritySigningPurpose,
  createAuthorityKeyRegistryResolverV1,
  createAuthorityKeyRegistryV1,
  type AuthorityKeyRegistryEntryV1
} from "../src/index.ts";

test("authority key registry resolves only the canonical Ed25519 tuple", () => {
  const entry = keyEntry("ACTIVE_SIGNING");
  const registry = createAuthorityKeyRegistryV1({
    authorityId: entry.authorityId,
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [entry]
  });
  const resolver = createAuthorityKeyRegistryResolverV1({
    registry,
    authorityId: "authority-main",
    issuer: "authority.local",
    purpose: authoritySigningPurpose,
    generation: 1,
    nowMs: () => 2_000
  });

  assert.equal(
    resolver.resolve({ algorithm: "Ed25519", issuer: "authority.local", keyId: entry.keyId })?.algorithm,
    "Ed25519"
  );
  assert.equal(
    resolver.resolve({ algorithm: "Ed25519", issuer: "client-reported", keyId: entry.keyId }),
    undefined,
    "the client-reported issuer must be ignored as a trust source"
  );
  assert.equal(
    resolver.resolve({ algorithm: "HMAC-SHA-256", issuer: "authority.local", keyId: entry.keyId }),
    undefined,
    "the client cannot select a different algorithm"
  );
});

test("authority key registry enforces lifecycle windows and manifest integrity", () => {
  const verifyOnly = keyEntry("VERIFY_ONLY", { notAfterMs: 2_000, verifyUntilMs: 331_000 });
  const registry = createAuthorityKeyRegistryV1({
    authorityId: verifyOnly.authorityId,
    generation: 1,
    globalRevocationEpoch: 1,
    revision: 1,
    entries: [verifyOnly]
  });
  const resolverAt = (nowMs: number) => createAuthorityKeyRegistryResolverV1({
    registry,
    authorityId: "authority-main",
    issuer: "authority.local",
    purpose: authoritySigningPurpose,
    generation: 1,
    nowMs: () => nowMs
  });

  assert.equal(
    resolverAt(331_000).resolve({ algorithm: "Ed25519", issuer: "authority.local", keyId: verifyOnly.keyId })?.algorithm,
    "Ed25519"
  );
  assert.equal(
    resolverAt(331_001).resolve({ algorithm: "Ed25519", issuer: "authority.local", keyId: verifyOnly.keyId }),
    undefined
  );
  assert.throws(
    () => createAuthorityKeyRegistryResolverV1({
      registry: { ...registry, manifestDigest: "sha256:client-reported" },
      authorityId: "authority-main",
      issuer: "authority.local",
      purpose: authoritySigningPurpose,
      generation: 1,
      nowMs: () => 2_000
    }),
    /AUTHORITY_KEY_REGISTRY_MANIFEST_DIGEST_MISMATCH/u
  );
});

function keyEntry(
  state: AuthorityKeyRegistryEntryV1["state"],
  overrides: Partial<AuthorityKeyRegistryEntryV1> = {}
): AuthorityKeyRegistryEntryV1 {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
  return {
    authorityId: "authority-main",
    issuer: "authority.local",
    algorithm: "Ed25519",
    keyId: authorityKeyId(publicKeySpki),
    purpose: authoritySigningPurpose,
    publicKeySpki: publicKeySpki.toString("base64url"),
    state,
    generation: 1,
    notBeforeMs: 1_000,
    notAfterMs: null,
    verifyUntilMs: null,
    predecessorKeyId: null,
    predecessorProof: null,
    activationEvidence: state === "PREPUBLISHED" ? null : {
      kind: "FIRST_PIN",
      pinEvidence: "test-out-of-band-pin",
      verifierAcknowledgement: "test-verifier-ack",
      activatedAtMs: 1_000
    },
    ...overrides
  };
}
