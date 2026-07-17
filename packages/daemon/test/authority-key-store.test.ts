// harness-test-tier: fast
import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authoritySigningPurpose,
  createAuthorityKeyRegistryV1,
  firstPinAuthorityKeyV1,
  type AuthorityKeyRegistryEntryV1,
  type AuthorityKeyRegistryV1
} from "../../application/src/index.ts";
import { openLocalAuthorityKeyStore } from "../src/authority/local-key-store.ts";

const authorityId = "authority-local-test";
const issuer = "host:test";

// POSIX-only: on win32 the store intentionally fails closed (AUTHORITY_KEY_STORE_DIRECTORY_UNSAFE) because 0700/uid privacy cannot be verified.
test("local authority key store keeps private material external and requires canonical lifecycle activation", { skip: process.platform === "win32" }, () => {
  withStoreLayout(({ workspaceRoot, serviceRoot, stateDirectory }) => {
    const store = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    });
    const prepublished = store.createPrepublishedKey({ generation: 1, nowMs: 1_000 });
    assert.deepEqual(store.keyIds(), [prepublished.keyId]);

    const prepublishedRegistry = createAuthorityKeyRegistryV1({
      authorityId,
      generation: 1,
      globalRevocationEpoch: 1,
      revision: 1,
      entries: [prepublished]
    });
    assert.throws(() => store.signingProfile(prepublishedRegistry, 1_000), /ACTIVE_SIGNER_REQUIRED/u);

    const activeRegistry = activateKey(prepublishedRegistry, prepublished);
    const profile = store.signingProfile(activeRegistry, 1_001);
    const message = Buffer.from("canonical-registry-gated-signing", "utf8");
    const signature = sign(null, message, profile.privateKey);
    const resolved = store.proofKeyResolver(activeRegistry, 1_001).resolve({
      algorithm: "Ed25519",
      issuer,
      keyId: prepublished.keyId
    });
    assert.equal(resolved?.algorithm, "Ed25519");
    assert.equal(resolved?.algorithm === "Ed25519" && verify(null, message, resolved.publicKey, signature), true);

    const cacheBody = readFileSync(path.join(stateDirectory, "authority-public-key-cache.json"), "utf8");
    assert.match(cacheBody, /authority-key-material-cache\/v1/u);
    assert.equal(cacheBody.includes(prepublished.keyId), true);
    assert.equal(cacheBody.includes("PRIVATE KEY"), false);

    const restarted = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    });
    assert.deepEqual(restarted.keyIds(), [prepublished.keyId]);
    assert.equal(restarted.signingProfile(activeRegistry, 1_002).keyId, prepublished.keyId);

    restarted.destroyPrivateKey(prepublished.keyId);
    assert.deepEqual(restarted.keyIds(), []);
    assert.throws(() => restarted.signingProfile(activeRegistry, 1_003), /ENOENT/u);
  });
});

test("local authority key store reconstructs a lost public cache only from the canonical registry", { skip: process.platform === "win32" }, () => {
  withStoreLayout(({ workspaceRoot, serviceRoot, stateDirectory }) => {
    const opened = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    });
    const prepublished = opened.createPrepublishedKey({ generation: 1, nowMs: 1_000 });
    const activeRegistry = activateKey(createAuthorityKeyRegistryV1({
      authorityId,
      generation: 1,
      globalRevocationEpoch: 1,
      revision: 1,
      entries: [prepublished]
    }), prepublished);
    rmSync(path.join(stateDirectory, "authority-public-key-cache.json"));

    const restarted = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    });
    assert.deepEqual(restarted.keyIds(), [], "private files alone must not invent lifecycle authority");
    assert.deepEqual(restarted.recoverPublicCache(activeRegistry), [prepublished.keyId]);
    assert.deepEqual(restarted.keyIds(), [prepublished.keyId]);
    assert.equal(restarted.signingProfile(activeRegistry, 1_001).keyId, prepublished.keyId);
  });
});

test("local authority key store rejects governed roots, symlinks, broad files, and owner mismatches", { skip: process.platform === "win32" }, () => {
  withStoreLayout(({ root, workspaceRoot, serviceRoot, stateDirectory }) => {
    assert.throws(() => openLocalAuthorityKeyStore({
      serviceStateRoot: path.join(workspaceRoot, ".service-state"),
      stateDirectory: path.join(workspaceRoot, ".service-state", "authority"),
      workspaceRoot,
      authorityId,
      issuer
    }), /FORBIDDEN_ROOT/u);

    const forbiddenCas = path.join(root, "authored-cas");
    mkdirSync(forbiddenCas, { mode: 0o700 });
    assert.throws(() => openLocalAuthorityKeyStore({
      serviceStateRoot: forbiddenCas,
      stateDirectory: path.join(forbiddenCas, "authority"),
      workspaceRoot,
      forbiddenRoots: [forbiddenCas],
      authorityId,
      issuer
    }), /FORBIDDEN_ROOT/u);

    mkdirSync(serviceRoot, { mode: 0o700 });
    const symlinkTarget = path.join(root, "symlink-target");
    mkdirSync(symlinkTarget, { mode: 0o700 });
    symlinkSync(symlinkTarget, stateDirectory, "dir");
    assert.throws(() => openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    }), /DIRECTORY_UNSAFE/u);
    rmSync(stateDirectory);

    const store = openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    });
    const entry = store.createPrepublishedKey({ generation: 1, nowMs: 2_000 });
    const activeRegistry = activateKey(createAuthorityKeyRegistryV1({
      authorityId,
      generation: 1,
      globalRevocationEpoch: 1,
      revision: 1,
      entries: [{ ...entry, purpose: authoritySigningPurpose }]
    }), entry);
    const privatePath = path.join(stateDirectory, "private-keys", `${entry.keyId.slice(-64)}.pk8`);
    chmodSync(privatePath, 0o644);
    assert.throws(() => store.signingProfile(activeRegistry, 2_001), /FILE_UNSAFE/u);
    chmodSync(privatePath, 0o600);

    const cachePath = path.join(stateDirectory, "authority-public-key-cache.json");
    const cacheTarget = path.join(root, "cache-target.json");
    rmSync(cachePath);
    writeFileSync(cacheTarget, "{}\n", { mode: 0o600 });
    symlinkSync(cacheTarget, cachePath);
    assert.throws(() => openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer
    }), /ELOOP|FILE_UNSAFE/u);
  });

  withStoreLayout(({ workspaceRoot, serviceRoot, stateDirectory }) => {
    assert.throws(() => openLocalAuthorityKeyStore({
      serviceStateRoot: serviceRoot,
      stateDirectory,
      workspaceRoot,
      authorityId,
      issuer,
      expectedUid: (process.getuid?.() ?? 0) + 1
    }), /DIRECTORY_UNSAFE/u);
  });
});

function activateKey(
  registry: AuthorityKeyRegistryV1,
  entry: AuthorityKeyRegistryEntryV1
): AuthorityKeyRegistryV1 {
  return firstPinAuthorityKeyV1({
    registry,
    keyId: entry.keyId,
    expectedPinnedKeyId: entry.keyId,
    pinEvidence: "test-out-of-band-pin",
    verifierAcknowledgement: "test-verifier-ack",
    activatedAtMs: entry.notBeforeMs
  });
}

function withStoreLayout(
  run: (layout: {
    readonly root: string;
    readonly workspaceRoot: string;
    readonly serviceRoot: string;
    readonly stateDirectory: string;
  }) => void
): void {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-key-store-"));
  const workspaceRoot = path.join(root, "repo");
  const serviceRoot = path.join(root, "service-state");
  const stateDirectory = path.join(serviceRoot, "authority");
  mkdirSync(workspaceRoot, { mode: 0o700 });
  try {
    run({ root, workspaceRoot, serviceRoot, stateDirectory });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
