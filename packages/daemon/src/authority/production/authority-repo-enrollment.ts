import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAuthorityKeyRegistryV1,
  firstPinAuthorityKeyV1,
  type ProtocolSchemaTupleV2
} from "@harness-anything/application";
import { openLocalAuthorityKeyStore } from "../local-key-store.ts";
import {
  authorityNamespaceProofBytes,
  loadAuthorityProductionManifest
} from "./authority-production-state.ts";
import {
  appendManifestRepo,
  assertExternalServiceState,
  assertNewFile,
  authorityDomainSnapshot,
  createNamespace,
  defaultNamespaceTtlMs,
  existingRealPath,
  manifestRepoJson,
  authorityRepoNonNegativeInteger,
  oneEpochJson,
  authorityRepoPositiveInteger,
  readManifest,
  readManifestRepoId,
  readOptionalManifest,
  readRegistry,
  resolveManifestPath,
  removeCreatedFile,
  replaceManifestRepo,
  requiredRepoId,
  samePath,
  shellArgument,
  signWithAuthorityKey,
  signedNamespaceJson,
  switchRecordJson,
  verifyNamespaceAgainstRegistry,
  writeJsonAtomically,
  writeJsonExclusive,
  writeManifestAtomically,
  authorityRepoAbsolutePath
} from "./authority-repo-enrollment-support.ts";

export const productionAuthoritySchemaTupleV2 = {
  wire: 2,
  event: 2,
  receipt: 2,
  digest: 2,
  policy: 2,
  commandRegistry: 1,
  entityRegistry: 1,
  mutationRegistry: 1,
  localState: 1,
  applyJournal: 1
} as const satisfies ProtocolSchemaTupleV2;

export interface AuthorityRepoEnrollmentInput {
  readonly repoId: string;
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly serviceStateRoot: string;
  readonly keyRegistryPath?: string;
  readonly namespaceTtlMs?: number;
  readonly allowedExecutorAgentIds?: ReadonlyArray<string>;
  readonly nowMs?: number;
  readonly newUuid?: () => string;
}

export interface AuthorityRepoResignInput {
  readonly repoId: string;
  readonly manifestPath: string;
  readonly keyRegistryPath?: string;
  readonly switchRecordPath?: string;
  readonly namespaceTtlMs?: number;
  readonly nowMs?: number;
  readonly newUuid?: () => string;
}

export interface AuthorityRepoEnrollmentResult {
  readonly manifestPath: string;
  readonly keyRegistryPath: string;
  readonly keyStateDirectory: string;
  readonly serviceStateRoot: string;
  readonly report: Readonly<Record<string, unknown>>;
}

export interface AuthorityRepoResignResult {
  readonly manifestPath: string;
  readonly keyRegistryPath: string;
  readonly keyStateDirectory: string;
  readonly switchRecordPath: string;
  readonly report: Readonly<Record<string, unknown>>;
}

export function enrollAuthorityRepo(input: AuthorityRepoEnrollmentInput): AuthorityRepoEnrollmentResult {
  const nowMs = authorityRepoNonNegativeInteger(input.nowMs ?? Date.now(), "nowMs");
  const newUuid = input.newUuid ?? randomUUID;
  const repoId = requiredRepoId(input.repoId);
  const repoRoot = existingRealPath(input.repoRoot, "repoRoot");
  const manifestPath = authorityRepoAbsolutePath(input.manifestPath);
  const serviceStateRoot = authorityRepoAbsolutePath(input.serviceStateRoot);
  assertExternalServiceState(serviceStateRoot, repoRoot);
  const namespaceTtlMs = authorityRepoPositiveInteger(input.namespaceTtlMs ?? defaultNamespaceTtlMs, "namespaceTtlMs");
  const existing = readOptionalManifest(manifestPath);
  if (existing?.repos.some((repo) => readManifestRepoId(repo) === repoId)) {
    throw new Error("AUTHORITY_REPO_ALREADY_ENROLLED:" + repoId);
  }
  if (existing && resolveManifestPath(existing.serviceStateRoot, manifestPath) !== serviceStateRoot) {
    throw new Error("AUTHORITY_REPO_SERVICE_STATE_ROOT_MISMATCH");
  }

  const authorityId = "authority.repo." + repoId;
  const issuer = authorityId;
  const authorityDirectory = path.join(serviceStateRoot, "authority", repoId);
  const keyStateDirectory = path.join(authorityDirectory, "keys");
  const keyRegistryPath = authorityRepoAbsolutePath(input.keyRegistryPath ?? path.join(authorityDirectory, "authority-key-registry.json"));
  assertNewFile(keyRegistryPath, "keyRegistryPath");
  const keyStore = openLocalAuthorityKeyStore({
    serviceStateRoot,
    stateDirectory: keyStateDirectory,
    workspaceRoot: repoRoot,
    authorityId,
    issuer,
    forbiddenRoots: [repoRoot]
  });

  let generatedKeyId: string | undefined;
  let registryWritten = false;
  try {
    const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: Math.max(0, nowMs - 1) });
    generatedKeyId = prepublished.keyId;
    const registry = firstPinAuthorityKeyV1({
      registry: createAuthorityKeyRegistryV1({
        authorityId,
        generation: 1,
        globalRevocationEpoch: 1,
        revision: 1,
        entries: [prepublished]
      }),
      keyId: prepublished.keyId,
      expectedPinnedKeyId: prepublished.keyId,
      pinEvidence: "ha authority repo enroll:" + repoId,
      verifierAcknowledgement: "local enrollment generated and pinned this repository authority key",
      activatedAtMs: nowMs
    });
    const workspaceId = "workspace-" + repoId;
    const deviceId = "device-" + newUuid();
    const viewId = "view-" + newUuid();
    const sessionId = "session-" + newUuid();
    const namespace = createNamespace({
      repoId,
      authorityId,
      issuer,
      keyId: prepublished.keyId,
      workspaceId,
      deviceId,
      viewId,
      sessionId,
      namespaceId: "namespace-" + newUuid(),
      expiresAt: nowMs + namespaceTtlMs
    });
    const proof = signWithAuthorityKey(authorityNamespaceProofBytes(namespace), keyStore.signingProfile(registry, nowMs));
    const manifestRepo = manifestRepoJson({
      repoId,
      canonicalRoot: repoRoot,
      workspaceId: namespace.workspaceId,
      deviceId: namespace.deviceId,
      viewId,
      sessionId,
      authorityId,
      issuer,
      keyRegistryPath,
      keyStateDirectory,
      schemaTuple: productionAuthoritySchemaTupleV2,
      authorityGeneration: 1,
      revocationEpochs: oneEpochJson(),
      admissionTokenRef: "admission-" + newUuid(),
      allowedExecutorAgentIds: [...(input.allowedExecutorAgentIds ?? ["codex"])],
      operationNamespace: signedNamespaceJson(namespace, proof),
      bootstrapBindings: []
    });
    writeJsonExclusive(keyRegistryPath, registry);
    registryWritten = true;
    writeManifestAtomically(manifestPath, appendManifestRepo(existing, serviceStateRoot, manifestRepo), newUuid);
    return {
      manifestPath,
      keyRegistryPath,
      keyStateDirectory,
      serviceStateRoot,
      report: {
        schema: "authority-repo-enrollment-report/v1",
        repoId,
        canonicalRoot: repoRoot,
        authorityId,
        issuer,
        keyId: prepublished.keyId,
        manifestPath,
        keyRegistryPath,
        keyStateDirectory,
        namespaceId: namespace.namespaceId,
        namespaceExpiresAt: namespace.expiresAt.toString(),
        trustDomain: "independent-per-repository",
        peopleRoster: {
          project: "<repo-root>/harness/people.yaml",
          machine: "<daemon-user-root>/people.yaml",
          note: "The daemon merges the machine roster first and the repository roster as an overlay."
        },
        nextCommands: {
          daemonStart: "ha --repo " + repoId + " daemon start --service --authority-manifest " + shellArgument(manifestPath),
          firstGovernanceWrite: "ha --repo " + repoId + " task create --title " + shellArgument("first governance write")
        }
      }
    };
  } catch (error) {
    if (registryWritten) removeCreatedFile(keyRegistryPath);
    if (generatedKeyId) {
      try {
        keyStore.destroyPrivateKey(generatedKeyId);
      } catch {
        // Preserve the original failure without exposing key material.
      }
    }
    throw error;
  }
}

export function resignAuthorityRepo(input: AuthorityRepoResignInput): AuthorityRepoResignResult {
  const nowMs = authorityRepoNonNegativeInteger(input.nowMs ?? Date.now(), "nowMs");
  const newUuid = input.newUuid ?? randomUUID;
  const repoId = requiredRepoId(input.repoId);
  const manifestPath = existingRealPath(input.manifestPath, "manifestPath");
  const existing = readManifest(manifestPath);
  const loaded = loadAuthorityProductionManifest(manifestPath);
  const oldConfig = loaded.repos.find((repo) => repo.repoId === repoId);
  if (!oldConfig) throw new Error("AUTHORITY_REPO_NOT_FOUND:" + repoId);
  const oldRegistry = readRegistry(oldConfig.keyRegistryPath);
  if (oldRegistry.authorityId !== oldConfig.authorityId || oldRegistry.generation !== oldConfig.authorityGeneration) {
    throw new Error("AUTHORITY_REPO_OLD_KEY_REGISTRY_SCOPE_MISMATCH");
  }
  const oldNamespaceProof = verifyNamespaceAgainstRegistry(oldConfig, oldRegistry);
  const serviceStateRoot = loaded.serviceStateRoot;
  const namespaceTtlMs = authorityRepoPositiveInteger(input.namespaceTtlMs ?? defaultNamespaceTtlMs, "namespaceTtlMs");
  const nextAuthorityId = "authority.repo." + repoId + "." + newUuid();
  const nextIssuer = nextAuthorityId;
  const authorityDirectory = path.join(serviceStateRoot, "authority", repoId, nextAuthorityId);
  const keyStateDirectory = path.join(authorityDirectory, "keys");
  const keyRegistryPath = authorityRepoAbsolutePath(input.keyRegistryPath ?? path.join(authorityDirectory, "authority-key-registry.json"));
  assertNewFile(keyRegistryPath, "keyRegistryPath");
  const switchRecordPath = authorityRepoAbsolutePath(input.switchRecordPath ?? path.join(
    serviceStateRoot,
    "authority",
    repoId,
    "trust-domain-switches",
    nowMs + "-" + newUuid() + ".json"
  ));
  assertNewFile(switchRecordPath, "switchRecordPath");
  assertExternalServiceState(serviceStateRoot, oldConfig.canonicalRoot);

  const keyStore = openLocalAuthorityKeyStore({
    serviceStateRoot,
    stateDirectory: keyStateDirectory,
    workspaceRoot: oldConfig.canonicalRoot,
    authorityId: nextAuthorityId,
    issuer: nextIssuer,
    forbiddenRoots: [oldConfig.canonicalRoot]
  });
  let generatedKeyId: string | undefined;
  let registryWritten = false;
  let manifestReplaced = false;
  try {
    const prepublished = keyStore.createPrepublishedKey({ generation: 1, nowMs: Math.max(0, nowMs - 1) });
    generatedKeyId = prepublished.keyId;
    const registry = firstPinAuthorityKeyV1({
      registry: createAuthorityKeyRegistryV1({
        authorityId: nextAuthorityId,
        generation: 1,
        globalRevocationEpoch: 1,
        revision: 1,
        entries: [prepublished]
      }),
      keyId: prepublished.keyId,
      expectedPinnedKeyId: prepublished.keyId,
      pinEvidence: "ha authority repo resign:" + repoId,
      verifierAcknowledgement: "local enrollment generated a new independent repository trust domain",
      activatedAtMs: nowMs
    });
    const nextNamespace = createNamespace({
      repoId,
      authorityId: nextAuthorityId,
      issuer: nextIssuer,
      keyId: prepublished.keyId,
      workspaceId: oldConfig.workspaceId,
      deviceId: oldConfig.deviceId,
      viewId: oldConfig.viewId,
      sessionId: oldConfig.sessionId,
      namespaceId: "namespace-" + newUuid(),
      expiresAt: nowMs + namespaceTtlMs
    });
    const nextProof = signWithAuthorityKey(authorityNamespaceProofBytes(nextNamespace), keyStore.signingProfile(registry, nowMs));
    const nextManifestRepo = manifestRepoJson({
      repoId,
      canonicalRoot: oldConfig.canonicalRoot,
      workspaceId: nextNamespace.workspaceId,
      deviceId: nextNamespace.deviceId,
      viewId: oldConfig.viewId,
      sessionId: oldConfig.sessionId,
      authorityId: nextAuthorityId,
      issuer: nextIssuer,
      keyRegistryPath,
      keyStateDirectory,
      schemaTuple: oldConfig.schemaTuple,
      authorityGeneration: 1,
      revocationEpochs: oneEpochJson(),
      admissionTokenRef: "admission-" + newUuid(),
      allowedExecutorAgentIds: [...oldConfig.allowedExecutorAgentIds],
      operationNamespace: signedNamespaceJson(nextNamespace, nextProof),
      bootstrapBindings: []
    });
    writeJsonExclusive(keyRegistryPath, registry);
    registryWritten = true;
    const sharedAuthorityDetected = loaded.repos
      .filter((repo) => repo.repoId !== repoId)
      .some((repo) => repo.authorityId === oldConfig.authorityId
        && samePath(repo.keyRegistryPath, oldConfig.keyRegistryPath)
        && samePath(repo.keyStateDirectory, oldConfig.keyStateDirectory));
    const nextConfig = {
      ...oldConfig,
      authorityId: nextAuthorityId,
      issuer: nextIssuer,
      keyRegistryPath,
      keyStateDirectory,
      authorityGeneration: 1,
      operationNamespace: { ...nextNamespace, proof: nextProof }
    };
    const preparedRecord = switchRecordJson({
      state: "prepared",
      repoId,
      canonicalRoot: oldConfig.canonicalRoot,
      recordedAt: new Date(nowMs).toISOString(),
      sharedAuthorityDetected,
      previous: authorityDomainSnapshot(oldConfig, oldRegistry, oldNamespaceProof),
      next: authorityDomainSnapshot(nextConfig, registry, true),
      ledgerContinuity: {
        kind: "historical-ledger-retained-under-previous-trust-domain",
        previousNamespaceId: oldConfig.operationNamespace.namespaceId,
        nextNamespaceId: nextNamespace.namespaceId,
        evidence: "The previous public key registry and namespace are retained in this switch record; new writes use only the next namespace."
      }
    });
    writeJsonExclusive(switchRecordPath, preparedRecord);
    writeManifestAtomically(manifestPath, replaceManifestRepo(existing, repoId, nextManifestRepo), newUuid);
    manifestReplaced = true;
    writeJsonAtomically(switchRecordPath, { ...preparedRecord, state: "applied", appliedAt: new Date().toISOString() }, newUuid);
    return {
      manifestPath,
      keyRegistryPath,
      keyStateDirectory,
      switchRecordPath,
      report: {
        schema: "authority-repo-resign-report/v1",
        repoId,
        manifestPath,
        switchRecordPath,
        previous: authorityDomainSnapshot(oldConfig, oldRegistry, oldNamespaceProof),
        next: authorityDomainSnapshot(nextConfig, registry, true),
        sharedAuthorityDetected,
        ledgerContinuity: "See the applied switch record for the previous namespace and public key evidence."
      }
    };
  } catch (error) {
    if (manifestReplaced) {
      try {
        writeManifestAtomically(manifestPath, { ...existing }, newUuid);
      } catch {
        // Preserve the original failure; the prepared record remains operator-visible.
      }
    }
    if (registryWritten) removeCreatedFile(keyRegistryPath);
    if (generatedKeyId) {
      try {
        keyStore.destroyPrivateKey(generatedKeyId);
      } catch {
        // Preserve the original failure without exposing key material.
      }
    }
    throw error;
  }
}
