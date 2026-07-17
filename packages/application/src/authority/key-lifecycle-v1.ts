import { createPublicKey, verify } from "node:crypto";
import {
  authorityClockSkewMs,
  authorityKeyRegistryEntryDigest,
  authorityTokenTtlMs,
  createAuthorityKeyRegistryV1,
  type AuthorityKeyRegistryEntryV1,
  type AuthorityKeyRegistryV1
} from "./key-registry-v1.ts";
import type { RevocationEpochTupleV2 } from "./actor-axes-binding-v2.ts";

const authorityKeyRotationProofDomain = "ha/authority-key-rotation/v1\0";

export interface AuthorityKeyLifecycleSnapshotV1 {
  readonly registry: AuthorityKeyRegistryV1;
  readonly authorityGeneration: bigint;
  readonly revocationEpochs: RevocationEpochTupleV2;
}

export interface AuthorityKeyLifecycleServiceV1 {
  readonly snapshot: () => AuthorityKeyLifecycleSnapshotV1;
  readonly firstPin: (input: Omit<Parameters<typeof firstPinAuthorityKeyV1>[0], "registry">) => AuthorityKeyLifecycleSnapshotV1;
  readonly prepublish: (input: Omit<Parameters<typeof prepublishAuthorityKeyV1>[0], "registry">) => AuthorityKeyLifecycleSnapshotV1;
  readonly rotate: (input: Omit<Parameters<typeof rotateAuthorityKeyV1>[0], "registry">) => AuthorityKeyLifecycleSnapshotV1;
  readonly revoke: (input: { readonly keyId: string }) => AuthorityKeyLifecycleSnapshotV1;
}

export function createAuthorityKeyLifecycleServiceV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly revocationEpochs: RevocationEpochTupleV2;
}): AuthorityKeyLifecycleServiceV1 {
  let registry = input.registry;
  let revocationEpochs = input.revocationEpochs;
  const snapshot = (): AuthorityKeyLifecycleSnapshotV1 => ({
    registry,
    authorityGeneration: BigInt(registry.generation),
    revocationEpochs
  });
  return {
    snapshot,
    firstPin: (transition) => {
      registry = firstPinAuthorityKeyV1({ registry, ...transition });
      return snapshot();
    },
    prepublish: (transition) => {
      registry = prepublishAuthorityKeyV1({ registry, ...transition });
      return snapshot();
    },
    rotate: (transition) => {
      registry = rotateAuthorityKeyV1({ registry, ...transition });
      return snapshot();
    },
    revoke: ({ keyId }) => {
      const revoked = revokeAuthorityKeyV1({ registry, keyId, revocationEpochs });
      registry = revoked.registry;
      revocationEpochs = revoked.revocationEpochs;
      return snapshot();
    }
  };
}

export function firstPinAuthorityKeyV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly keyId: string;
  readonly expectedPinnedKeyId: string;
  readonly pinEvidence: string;
  readonly verifierAcknowledgement: string;
  readonly activatedAtMs: number;
}): AuthorityKeyRegistryV1 {
  if (input.keyId !== input.expectedPinnedKeyId) {
    throw new Error(
      "AUTHORITY_KEY_FIRST_PIN_KEY_MISMATCH: first pin rejected because keyId does not match the out-of-band pin; verify expectedPinnedKeyId and retry"
    );
  }
  const candidate = input.registry.entries.find((entry) => entry.keyId === input.keyId);
  if (!candidate || candidate.state !== "PREPUBLISHED" || candidate.generation !== input.registry.generation) {
    throw new Error(
      "AUTHORITY_KEY_FIRST_PIN_PREPUBLISHED_REQUIRED: first pin rejected because the current-generation PREPUBLISHED key is missing; add that key to authority-key-registry.json and retry"
    );
  }
  if (input.registry.entries.some((entry) =>
    entry.generation === input.registry.generation && entry.state === "ACTIVE_SIGNING")) {
    throw new Error(
      "AUTHORITY_KEY_FIRST_PIN_ACTIVE_SIGNER_EXISTS: first pin rejected because an active signer already exists; use the predecessor-proof rotation transition"
    );
  }
  requiredLifecycleText(input.pinEvidence, "pinEvidence");
  requiredLifecycleText(input.verifierAcknowledgement, "verifierAcknowledgement");
  nonNegativeLifecycleInteger(input.activatedAtMs, "activatedAtMs");
  if (input.activatedAtMs < candidate.notBeforeMs) {
    throw new Error(
      "AUTHORITY_KEY_FIRST_PIN_BEFORE_NOT_BEFORE: first pin rejected before the key validity window; wait until entry.notBeforeMs and retry"
    );
  }
  return createAuthorityKeyRegistryV1({
    authorityId: input.registry.authorityId,
    generation: input.registry.generation,
    globalRevocationEpoch: input.registry.globalRevocationEpoch,
    revision: input.registry.revision + 1,
    entries: input.registry.entries.map((entry) => entry.keyId === input.keyId ? {
      ...entry,
      state: "ACTIVE_SIGNING" as const,
      activationEvidence: {
        kind: "FIRST_PIN" as const,
        pinEvidence: input.pinEvidence,
        verifierAcknowledgement: input.verifierAcknowledgement,
        activatedAtMs: input.activatedAtMs
      }
    } : entry)
  });
}

export function authorityKeyRotationProofBytesV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly successor: AuthorityKeyRegistryEntryV1;
}): Uint8Array {
  const successorDigest = authorityKeyRegistryEntryDigest({
    ...input.successor,
    state: "PREPUBLISHED",
    notAfterMs: null,
    verifyUntilMs: null,
    predecessorProof: null,
    activationEvidence: null
  });
  return Buffer.concat([
    Buffer.from(authorityKeyRotationProofDomain, "utf8"),
    Buffer.from(input.registry.manifestDigest, "utf8"),
    Buffer.from([0]),
    successorDigest
  ]);
}

export function prepublishAuthorityKeyV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly successor: AuthorityKeyRegistryEntryV1;
  readonly predecessorProof: string;
}): AuthorityKeyRegistryV1 {
  const predecessor = input.registry.entries.find((entry) =>
    entry.generation === input.registry.generation && entry.state === "ACTIVE_SIGNING");
  if (!predecessor || input.successor.state !== "PREPUBLISHED"
    || input.successor.generation !== input.registry.generation
    || input.successor.predecessorKeyId !== predecessor.keyId) {
    throw new Error(
      "AUTHORITY_KEY_PREPUBLISH_PREDECESSOR_REQUIRED: prepublish rejected because the current active predecessor is not named by the successor; set predecessorKeyId from the ACTIVE_SIGNING entry"
    );
  }
  if (input.registry.entries.some((entry) => entry.keyId === input.successor.keyId)) {
    throw new Error(
      "AUTHORITY_KEY_PREPUBLISH_DUPLICATE: prepublish rejected because successor keyId already exists; create a new Ed25519 key and retry"
    );
  }
  requiredLifecycleText(input.predecessorProof, "predecessorProof");
  return createAuthorityKeyRegistryV1({
    authorityId: input.registry.authorityId,
    generation: input.registry.generation,
    globalRevocationEpoch: input.registry.globalRevocationEpoch,
    revision: input.registry.revision + 1,
    entries: [...input.registry.entries, {
      ...input.successor,
      predecessorProof: input.predecessorProof,
      activationEvidence: null
    }]
  });
}

export function rotateAuthorityKeyV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly successorKeyId: string;
  readonly verifierAcknowledgement: string;
  readonly cutoverAtMs: number;
}): AuthorityKeyRegistryV1 {
  requiredLifecycleText(input.verifierAcknowledgement, "verifierAcknowledgement");
  nonNegativeLifecycleInteger(input.cutoverAtMs, "cutoverAtMs");
  const predecessor = input.registry.entries.find((entry) =>
    entry.generation === input.registry.generation && entry.state === "ACTIVE_SIGNING");
  const successor = input.registry.entries.find((entry) => entry.keyId === input.successorKeyId);
  if (!predecessor || !successor || successor.state !== "PREPUBLISHED"
    || successor.generation !== input.registry.generation) {
    throw new Error(
      "AUTHORITY_KEY_ROTATION_STATE_INVALID: rotation rejected because one current ACTIVE_SIGNING predecessor and one current PREPUBLISHED successor are required; inspect authority-key-registry.json and retry"
    );
  }
  if (successor.predecessorKeyId !== predecessor.keyId || successor.predecessorProof === null) {
    throw new Error(
      "AUTHORITY_KEY_ROTATION_PREDECESSOR_MISMATCH: rotation rejected because the successor does not name the active predecessor and its proof; create a predecessor-signed transition record"
    );
  }
  if (input.cutoverAtMs < predecessor.notBeforeMs || input.cutoverAtMs < successor.notBeforeMs) {
    throw new Error(
      "AUTHORITY_KEY_ROTATION_BEFORE_NOT_BEFORE: rotation rejected before a key validity window; wait until both entry.notBeforeMs values and retry"
    );
  }
  const signature = Buffer.from(successor.predecessorProof, "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== successor.predecessorProof) {
    throw new Error(
      "AUTHORITY_KEY_ROTATION_PROOF_ENCODING_INVALID: rotation rejected because predecessorProof is not canonical base64url; replace it with an Ed25519 signature"
    );
  }
  const predecessorPublicKey = createPublicKey({
    key: Buffer.from(predecessor.publicKeySpki, "base64url"),
    format: "der",
    type: "spki"
  });
  const proofRegistry = createAuthorityKeyRegistryV1({
    authorityId: input.registry.authorityId,
    generation: input.registry.generation,
    globalRevocationEpoch: input.registry.globalRevocationEpoch,
    revision: input.registry.revision - 1,
    entries: input.registry.entries.filter((entry) => entry.keyId !== successor.keyId)
  });
  if (!verify(
    null,
    authorityKeyRotationProofBytesV1({ registry: proofRegistry, successor }),
    predecessorPublicKey,
    signature
  )) {
    throw new Error(
      "AUTHORITY_KEY_ROTATION_PROOF_INVALID: rotation rejected because predecessorProof did not verify with the active key; sign the canonical transition bytes with the predecessor private key"
    );
  }
  const verifyUntilMs = input.cutoverAtMs + authorityTokenTtlMs + authorityClockSkewMs;
  return createAuthorityKeyRegistryV1({
    authorityId: input.registry.authorityId,
    generation: input.registry.generation,
    globalRevocationEpoch: input.registry.globalRevocationEpoch,
    revision: input.registry.revision + 1,
    entries: input.registry.entries.map((entry) => {
      if (entry.keyId === predecessor.keyId) {
        return { ...entry, state: "VERIFY_ONLY" as const, notAfterMs: input.cutoverAtMs, verifyUntilMs };
      }
      if (entry.keyId === successor.keyId) {
        return {
          ...entry,
          state: "ACTIVE_SIGNING" as const,
          activationEvidence: {
            kind: "PREDECESSOR_PROOF" as const,
            pinEvidence: null,
            verifierAcknowledgement: input.verifierAcknowledgement,
            activatedAtMs: input.cutoverAtMs
          }
        };
      }
      return entry;
    })
  });
}

export function revokeAuthorityKeyV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly keyId: string;
  readonly revocationEpochs: RevocationEpochTupleV2;
}): {
  readonly registry: AuthorityKeyRegistryV1;
  readonly authorityGeneration: bigint;
  readonly revocationEpochs: RevocationEpochTupleV2;
} {
  if (input.revocationEpochs.global !== BigInt(input.registry.globalRevocationEpoch)) {
    throw new Error(
      "AUTHORITY_KEY_REVOKE_EPOCH_MISMATCH: revoke rejected because registry globalRevocationEpoch and token revocationEpochs.global differ; reconcile authority-production.json before retrying"
    );
  }
  const target = input.registry.entries.find((entry) =>
    entry.keyId === input.keyId
    && entry.generation === input.registry.generation
    && (entry.state === "ACTIVE_SIGNING" || entry.state === "VERIFY_ONLY"));
  if (!target) {
    throw new Error(
      "AUTHORITY_KEY_REVOKE_ELIGIBLE_KEY_REQUIRED: revoke rejected because the current-generation key is not verification-eligible; inspect authority-key-registry.json and choose an ACTIVE_SIGNING or VERIFY_ONLY key"
    );
  }
  const nextGeneration = input.registry.generation + 1;
  const nextGlobalEpoch = input.registry.globalRevocationEpoch + 1;
  if (!Number.isSafeInteger(nextGeneration) || !Number.isSafeInteger(nextGlobalEpoch)) {
    throw new Error(
      "AUTHORITY_KEY_REVOKE_COUNTER_OVERFLOW: revoke rejected because generation or global epoch cannot advance safely; replace the authority lifecycle counters before retrying"
    );
  }
  const registry = createAuthorityKeyRegistryV1({
    authorityId: input.registry.authorityId,
    generation: nextGeneration,
    globalRevocationEpoch: nextGlobalEpoch,
    revision: input.registry.revision + 1,
    entries: input.registry.entries.map((entry) =>
      entry.generation === input.registry.generation
        && (entry.state === "ACTIVE_SIGNING" || entry.state === "VERIFY_ONLY")
        ? { ...entry, state: "REVOKED" as const, verifyUntilMs: null }
        : entry)
  });
  return {
    registry,
    authorityGeneration: BigInt(nextGeneration),
    revocationEpochs: { ...input.revocationEpochs, global: BigInt(nextGlobalEpoch) }
  };
}

function requiredLifecycleText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `AUTHORITY_KEY_LIFECYCLE_FIELD_REQUIRED:${label}: transition rejected because ${label} is missing; provide ${label} and retry`
    );
  }
}

function nonNegativeLifecycleInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `AUTHORITY_KEY_LIFECYCLE_TIME_INVALID:${label}: transition rejected because ${label} is invalid; provide a non-negative integer timestamp`
    );
  }
}
