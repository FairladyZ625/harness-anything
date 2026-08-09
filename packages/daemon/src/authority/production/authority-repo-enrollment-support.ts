import { createPublicKey, randomUUID, sign, verify } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  assertAuthorityKeyRegistryV1,
  type AuthorityKeyRegistryV1,
  type ProtocolSchemaTupleV2
} from "@harness-anything/application";
import path from "node:path";
import {
  type LocalAuthorityKeyStore
} from "../local-key-store.ts";
import {
  authorityNamespaceProofBytes,
  loadAuthorityProductionManifest,
  type AuthorityProductionRepoConfigV1
} from "./authority-production-state.ts";

const defaultNamespaceTtlMs = 365 * 24 * 60 * 60 * 1_000;
const productionManifestSchema = "authority-production-composition/v1" as const;
const switchRecordSchema = "authority-trust-domain-switch/v1" as const;

interface JsonManifest {
  readonly schema: typeof productionManifestSchema;
  readonly serviceStateRoot: string;
  readonly repos: ReadonlyArray<Record<string, unknown>>;
}

function createNamespace(input: {
  readonly repoId: string;
  readonly authorityId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly expiresAt: number;
}): {
  readonly schema: "operation-namespace/v1";
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly authorityGeneration: bigint;
  readonly namespaceId: string;
  readonly expiresAt: bigint;
  readonly issuer: string;
  readonly keyId: string;
} {
  return {
    schema: "operation-namespace/v1",
    workspaceId: authorityRepoRequiredText(input.workspaceId, "workspaceId"),
    deviceId: authorityRepoRequiredText(input.deviceId, "deviceId"),
    authorityGeneration: 1n,
    namespaceId: authorityRepoRequiredText(input.namespaceId, "namespaceId"),
    expiresAt: BigInt(authorityRepoNonNegativeInteger(input.expiresAt, "expiresAt")),
    issuer: authorityRepoRequiredText(input.issuer, "issuer"),
    keyId: authorityRepoRequiredText(input.keyId, "keyId")
  };
}

function signedNamespaceJson(
  namespace: ReturnType<typeof createNamespace>,
  proof: Uint8Array
): Record<string, unknown> {
  return {
    ...namespace,
    authorityGeneration: namespace.authorityGeneration.toString(),
    expiresAt: namespace.expiresAt.toString(),
    proof: Buffer.from(proof).toString("base64url")
  };
}

function manifestRepoJson(input: {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly authorityId: string;
  readonly issuer: string;
  readonly keyRegistryPath: string;
  readonly keyStateDirectory: string;
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly authorityGeneration: number;
  readonly revocationEpochs: Record<string, string>;
  readonly admissionTokenRef: string;
  readonly allowedExecutorAgentIds: ReadonlyArray<string>;
  readonly operationNamespace: Record<string, unknown>;
  readonly bootstrapBindings: ReadonlyArray<unknown>;
}): Record<string, unknown> {
  return {
    repoId: requiredRepoId(input.repoId),
    canonicalRoot: input.canonicalRoot,
    workspaceId: authorityRepoRequiredText(input.workspaceId, "workspaceId"),
    deviceId: authorityRepoRequiredText(input.deviceId, "deviceId"),
    viewId: authorityRepoRequiredText(input.viewId, "viewId"),
    sessionId: authorityRepoRequiredText(input.sessionId, "sessionId"),
    authorityId: authorityRepoRequiredText(input.authorityId, "authorityId"),
    issuer: authorityRepoRequiredText(input.issuer, "issuer"),
    keyRegistryPath: input.keyRegistryPath,
    keyStateDirectory: input.keyStateDirectory,
    schemaTuple: input.schemaTuple,
    authorityGeneration: input.authorityGeneration,
    revocationEpochs: input.revocationEpochs,
    admissionTokenRef: authorityRepoRequiredText(input.admissionTokenRef, "admissionTokenRef"),
    allowedExecutorAgentIds: [...input.allowedExecutorAgentIds],
    operationNamespace: input.operationNamespace,
    bootstrapBindings: [...input.bootstrapBindings]
  };
}

function authorityDomainSnapshot(
  config: AuthorityProductionRepoConfigV1,
  registry: AuthorityKeyRegistryV1,
  namespaceProofVerified: boolean
): Record<string, unknown> {
  return {
    authorityId: config.authorityId,
    issuer: config.issuer,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    viewId: config.viewId,
    sessionId: config.sessionId,
    authorityGeneration: config.authorityGeneration,
    keyRegistryPath: config.keyRegistryPath,
    keyStateDirectory: config.keyStateDirectory,
    keyId: config.operationNamespace.keyId,
    registryManifestDigest: registry.manifestDigest,
    publicKeyRegistry: registry,
    namespaceId: config.operationNamespace.namespaceId,
    namespaceProofVerified,
    namespace: signedNamespaceSnapshot(config.operationNamespace)
  };
}

function signWithAuthorityKey(message: Uint8Array, profile: ReturnType<LocalAuthorityKeyStore["signingProfile"]>): Buffer {
  if (profile.algorithm !== "Ed25519") throw new Error("AUTHORITY_REPO_ED25519_SIGNER_REQUIRED");
  return sign(null, message, profile.privateKey);
}

function signedNamespaceSnapshot(namespace: AuthorityProductionRepoConfigV1["operationNamespace"]): Record<string, unknown> {
  return {
    schema: namespace.schema,
    workspaceId: namespace.workspaceId,
    deviceId: namespace.deviceId,
    authorityGeneration: namespace.authorityGeneration.toString(),
    namespaceId: namespace.namespaceId,
    expiresAt: namespace.expiresAt.toString(),
    issuer: namespace.issuer,
    keyId: namespace.keyId,
    proof: Buffer.from(namespace.proof).toString("base64url")
  };
}

function switchRecordJson(input: {
  readonly state: "prepared" | "applied";
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly recordedAt: string;
  readonly appliedAt?: string;
  readonly sharedAuthorityDetected: boolean;
  readonly previous: Record<string, unknown>;
  readonly next: Record<string, unknown>;
  readonly ledgerContinuity: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schema: switchRecordSchema,
    state: input.state,
    repoId: input.repoId,
    canonicalRoot: input.canonicalRoot,
    recordedAt: input.recordedAt,
    ...(input.appliedAt ? { appliedAt: input.appliedAt } : {}),
    sharedAuthorityDetected: input.sharedAuthorityDetected,
    previous: input.previous,
    next: input.next,
    ledgerContinuity: input.ledgerContinuity
  };
}

function verifyNamespaceAgainstRegistry(
  config: AuthorityProductionRepoConfigV1,
  registry: AuthorityKeyRegistryV1
): boolean {
  const entry = registry.entries.find((candidate) =>
    candidate.keyId === config.operationNamespace.keyId
    && candidate.authorityId === config.authorityId
    && candidate.issuer === config.issuer
    && candidate.generation === config.authorityGeneration
  );
  if (!entry) throw new Error("AUTHORITY_REPO_OLD_NAMESPACE_KEY_NOT_FOUND");
  const publicKey = createPublicKey({
    key: Buffer.from(entry.publicKeySpki, "base64url"),
    format: "der",
    type: "spki"
  });
  const verified = verify(
    null,
    authorityNamespaceProofBytes({
      schema: config.operationNamespace.schema,
      workspaceId: config.operationNamespace.workspaceId,
      deviceId: config.operationNamespace.deviceId,
      authorityGeneration: config.operationNamespace.authorityGeneration,
      namespaceId: config.operationNamespace.namespaceId,
      expiresAt: config.operationNamespace.expiresAt,
      issuer: config.operationNamespace.issuer,
      keyId: config.operationNamespace.keyId
    }),
    publicKey,
    config.operationNamespace.proof
  );
  if (!verified) throw new Error("AUTHORITY_REPO_OLD_NAMESPACE_PROOF_INVALID");
  return true;
}

function readRegistry(registryPath: string): AuthorityKeyRegistryV1 {
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as AuthorityKeyRegistryV1;
  assertAuthorityKeyRegistryV1(registry);
  return registry;
}

function readManifest(manifestPath: string): JsonManifest {
  const parsed = readJsonManifest(manifestPath);
  if (parsed.schema !== productionManifestSchema || !Array.isArray(parsed.repos)) {
    throw new Error("AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID");
  }
  return parsed;
}

function readOptionalManifest(manifestPath: string): JsonManifest | undefined {
  if (!pathEntryExists(manifestPath)) return undefined;
  return readManifest(manifestPath);
}

function readJsonManifest(manifestPath: string): JsonManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (parsed.schema !== productionManifestSchema || typeof parsed.serviceStateRoot !== "string" || !Array.isArray(parsed.repos)) {
    throw new Error("AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID");
  }
  return {
    schema: productionManifestSchema,
    serviceStateRoot: parsed.serviceStateRoot,
    repos: parsed.repos.map((repo) => {
      if (!repo || typeof repo !== "object" || Array.isArray(repo)) throw new Error("AUTHORITY_PRODUCTION_MANIFEST_REPO_INVALID");
      return repo as Record<string, unknown>;
    })
  };
}

function appendManifestRepo(
  existing: JsonManifest | undefined,
  serviceStateRoot: string,
  repo: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema: productionManifestSchema,
    serviceStateRoot: existing?.serviceStateRoot ?? serviceStateRoot,
    repos: [...(existing?.repos ?? []), repo]
  };
}

function replaceManifestRepo(
  existing: JsonManifest,
  repoId: string,
  replacement: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema: productionManifestSchema,
    serviceStateRoot: existing.serviceStateRoot,
    repos: existing.repos.map((repo) => readManifestRepoId(repo) === repoId ? replacement : repo)
  };
}

function writeManifestAtomically(
  manifestPath: string,
  manifest: Record<string, unknown>,
  newUuid: () => string
): void {
  ensureParentDirectory(manifestPath);
  const temporary = `${manifestPath}.${newUuid()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    loadAuthorityProductionManifest(temporary);
    rejectExistingSymlink(manifestPath, "manifestPath");
    renameSync(temporary, manifestPath);
  } finally {
    removeCreatedFile(temporary);
  }
}

function writeJsonExclusive(filePath: string, value: unknown): void {
  ensureParentDirectory(filePath);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    rejectExistingSymlink(filePath, "outputPath");
    renameSync(temporary, filePath);
  } finally {
    removeCreatedFile(temporary);
  }
}

function writeJsonAtomically(filePath: string, value: unknown, newUuid: () => string): void {
  ensureParentDirectory(filePath);
  const temporary = `${filePath}.${newUuid()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    rejectExistingSymlink(filePath, "outputPath");
    renameSync(temporary, filePath);
  } finally {
    removeCreatedFile(temporary);
  }
}

function existingRealPath(value: string, label: string): string {
  const absolute = authorityRepoAbsolutePath(value);
  if (!existsSync(absolute)) throw new Error(`AUTHORITY_REPO_PATH_NOT_FOUND:${label}:${absolute}`);
  return realpathSync(absolute);
}

function resolveManifestPath(value: string, manifestPath: string): string {
  return authorityRepoRealpathIfPresent(path.resolve(path.dirname(manifestPath), value));
}

function authorityRepoAbsolutePath(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error("AUTHORITY_REPO_PATH_INVALID");
  }
  return path.resolve(value);
}

function assertExternalServiceState(serviceStateRoot: string, repoRoot: string): void {
  if (samePath(serviceStateRoot, repoRoot) || authorityRepoIsDescendant(serviceStateRoot, repoRoot) || authorityRepoIsDescendant(repoRoot, serviceStateRoot)) {
    throw new Error("AUTHORITY_REPO_SERVICE_STATE_MUST_BE_EXTERNAL");
  }
}

function assertNewFile(filePath: string, label: string): void {
  if (pathEntryExists(filePath)) throw new Error(`AUTHORITY_REPO_OUTPUT_EXISTS:${label}:${filePath}`);
}

function rejectExistingSymlink(filePath: string, label: string): void {
  if (!pathEntryExists(filePath)) return;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`AUTHORITY_REPO_OUTPUT_SYMLINK_UNSAFE:${label}`);
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (authorityRepoIsMissing(error)) return false;
    throw error;
  }
}

function jsonShellArgument(value: string): string {
  return JSON.stringify(value);
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function removeCreatedFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!authorityRepoIsMissing(error)) throw error;
  }
}

function readManifestRepoId(repo: Record<string, unknown>): string | undefined {
  return typeof repo.repoId === "string" ? repo.repoId : undefined;
}

function oneEpochJson(): Record<string, string> {
  return { global: "1", workspace: "1", device: "1", view: "1", principal: "1", executor: "1" };
}

function requiredRepoId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("AUTHORITY_REPO_ID_INVALID: use letters, digits, dot, underscore, or hyphen");
  }
  return value;
}

function authorityRepoRequiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`AUTHORITY_REPO_FIELD_INVALID:${label}`);
  }
  return value;
}

function authorityRepoPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`AUTHORITY_REPO_FIELD_INVALID:${label}`);
  return value;
}

function authorityRepoNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`AUTHORITY_REPO_FIELD_INVALID:${label}`);
  return value;
}

function samePath(left: string, right: string): boolean {
  return authorityRepoRealpathIfPresent(left) === authorityRepoRealpathIfPresent(right);
}

function authorityRepoRealpathIfPresent(value: string): string {
  try {
    return realpathSync(value);
  } catch (error) {
    if (authorityRepoIsMissing(error)) return path.resolve(value);
    throw error;
  }
}

function authorityRepoIsDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(authorityRepoRealpathIfPresent(root), authorityRepoRealpathIfPresent(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function authorityRepoIsMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

export { defaultNamespaceTtlMs, createNamespace, signedNamespaceJson, manifestRepoJson, authorityDomainSnapshot, signWithAuthorityKey, signedNamespaceSnapshot, switchRecordJson, verifyNamespaceAgainstRegistry, readRegistry, readManifest, readOptionalManifest, readJsonManifest, appendManifestRepo, replaceManifestRepo, writeManifestAtomically, writeJsonExclusive, writeJsonAtomically, existingRealPath, resolveManifestPath, authorityRepoAbsolutePath, assertExternalServiceState, assertNewFile, rejectExistingSymlink, pathEntryExists, jsonShellArgument, ensureParentDirectory, removeCreatedFile, readManifestRepoId, oneEpochJson, requiredRepoId, authorityRepoRequiredText, authorityRepoPositiveInteger, authorityRepoNonNegativeInteger, samePath, authorityRepoRealpathIfPresent, authorityRepoIsDescendant, authorityRepoIsMissing };
