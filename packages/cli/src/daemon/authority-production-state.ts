import { readFileSync, realpathSync } from "node:fs";
import { verify } from "node:crypto";
import path from "node:path";
import {
  actorAxesBindingTokenDigestV2,
  assertAuthorityKeyRegistryV1,
  createAuthorityKeyLifecycleServiceV1,
  encodeCanonicalCbor,
  type ActorAxesBindingClaimsV2,
  type ActorAxesBindingRecordV2,
  type ActorAxesBindingRuntimeV2,
  type ActorAxesProofKeyResolverV2,
  type AuthorityKeyRegistryV1,
  type AuthorityKeyLifecycleServiceV1,
  type OperationIdV2,
  type OperationNamespaceVerifierV2,
  type ProtocolSchemaTupleV2,
  type RevocationEpochTupleV2
} from "../../../application/src/index.ts";
import {
  openLocalAuthorityKeyStore,
  type LocalAuthorityKeyStore
} from "../../../daemon/src/index.ts";
import type { WriteAttribution } from "../../../kernel/src/index.ts";
import { stableStringify } from "../../../kernel/src/index.ts";
import { authorityDurableAdapterMarker, type AuthorityDurableAdapterMarker } from "./authority-lifecycle.ts";
import type { DurableAuthorityStateTable } from "./authority-service-state.ts";

const productionManifestSchema = "authority-production-composition/v1" as const;
const bindingStateSchema = "authority-binding-state/v1" as const;
const namespaceStateSchema = "authority-operation-namespace-state/v1" as const;
const operationNamespaceProofDomain = "ha/operation-namespace/v1\0";

export interface AuthorityProductionManifestV1 {
  readonly schema: typeof productionManifestSchema;
  readonly serviceStateRoot: string;
  readonly repos: ReadonlyArray<AuthorityProductionRepoConfigV1>;
}

export interface AuthorityProductionRepoConfigV1 {
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
  readonly revocationEpochs: RevocationEpochTupleV2;
  readonly admissionTokenRef: string;
  readonly allowedExecutorAgentIds: ReadonlyArray<string>;
  readonly operationNamespace: OperationIdV2["namespace"];
  readonly bootstrapBindings: ReadonlyArray<AuthorityBootstrapBindingV1>;
}

export interface AuthorityBootstrapBindingV1 {
  readonly tokenId: string;
  readonly tokenDigest: Uint8Array;
  readonly maxOperations: number;
  readonly record: ActorAxesBindingRecordV2;
}

export interface DurableAuthorityBindingRuntimeV2 extends ActorAxesBindingRuntimeV2, AuthorityDurableAdapterMarker {
  readonly registerIssuedToken: (input: {
    readonly claims: ActorAxesBindingClaimsV2;
    readonly token: Uint8Array;
    readonly attribution: WriteAttribution;
  }) => void;
}

interface DurableBindingRowV1 {
  readonly schema: typeof bindingStateSchema;
  readonly tokenId: string;
  readonly tokenDigest: string;
  readonly maxOperations: number;
  readonly consumedOperations: number;
  readonly record: ActorAxesBindingRecordV2;
}

interface DurableNamespaceRowV1 {
  readonly schema: typeof namespaceStateSchema;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly authorityGeneration: string;
  readonly namespaceId: string;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly proof: string;
}

export function loadAuthorityProductionManifest(manifestPath: string): AuthorityProductionManifestV1 {
  const absoluteManifest = realpathSync(path.resolve(manifestPath));
  const root = strictObject(JSON.parse(readFileSync(absoluteManifest, "utf8")), "manifest");
  if (root.schema !== productionManifestSchema || !Array.isArray(root.repos)) {
    throw new Error("AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID");
  }
  const serviceStateRoot = absolutePath(root.serviceStateRoot, "serviceStateRoot", path.dirname(absoluteManifest));
  const repos = root.repos.map((value, index) => parseRepo(value, index, path.dirname(absoluteManifest)));
  const ids = new Set(repos.map((repo) => repo.repoId));
  if (ids.size !== repos.length) throw new Error("AUTHORITY_PRODUCTION_MANIFEST_DUPLICATE_REPO");
  if (repos.some((repo) => pathsOverlap(serviceStateRoot, repo.canonicalRoot))) {
    throw new Error("AUTHORITY_PRODUCTION_SERVICE_STATE_MUST_BE_EXTERNAL");
  }
  return { schema: productionManifestSchema, serviceStateRoot, repos };
}

export function openAuthorityProductionKeyMaterial(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly serviceStateRoot: string;
}): {
  readonly registry: AuthorityKeyRegistryV1;
  readonly keyStore: LocalAuthorityKeyStore;
  readonly keyLifecycle: AuthorityKeyLifecycleServiceV1;
} {
  const registry = JSON.parse(readFileSync(input.config.keyRegistryPath, "utf8")) as AuthorityKeyRegistryV1;
  assertAuthorityKeyRegistryV1(registry);
  if (registry.authorityId !== input.config.authorityId
    || registry.generation !== input.config.authorityGeneration) {
    throw new Error("AUTHORITY_PRODUCTION_KEY_REGISTRY_SCOPE_MISMATCH");
  }
  if (BigInt(registry.globalRevocationEpoch) !== input.config.revocationEpochs.global) {
    throw new Error(
      "AUTHORITY_PRODUCTION_KEY_REGISTRY_EPOCH_MISMATCH: production startup rejected because registry globalRevocationEpoch and token revocationEpochs.global differ; reconcile authority-production.json with authority-key-registry.json before restarting"
    );
  }
  const keyStore = openLocalAuthorityKeyStore({
    serviceStateRoot: input.serviceStateRoot,
    stateDirectory: input.config.keyStateDirectory,
    workspaceRoot: input.config.canonicalRoot,
    authorityId: input.config.authorityId,
    issuer: input.config.issuer,
    forbiddenRoots: [input.config.canonicalRoot]
  });
  keyStore.recoverPublicCache(registry);
  return {
    registry,
    keyStore,
    keyLifecycle: createAuthorityKeyLifecycleServiceV1({
      registry,
      revocationEpochs: input.config.revocationEpochs
    })
  };
}

export function createDurableAuthorityBindingRuntimeV2(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly table: DurableAuthorityStateTable;
  readonly proofKeys: ActorAxesProofKeyResolverV2;
  readonly nowMs?: () => number;
}): DurableAuthorityBindingRuntimeV2 {
  const nowMs = input.nowMs ?? Date.now;
  for (const binding of input.config.bootstrapBindings) {
    ensureBindingRow(input.table, bindingRow({
      tokenId: binding.tokenId,
      tokenDigest: binding.tokenDigest,
      maxOperations: binding.maxOperations,
      consumedOperations: 0,
      record: binding.record
    }));
  }
  const runtime: DurableAuthorityBindingRuntimeV2 = {
    ...authorityDurableAdapterMarker,
    proofKeys: input.proofKeys,
    validatePresentationToken: async (candidate) => tokenMatches(input.table, candidate),
    getBinding: async (bindingId) => input.table.entries<DurableBindingRowV1>()
      .map(([, row]) => row)
      .find((row) => row.record.bindingId === bindingId)?.record,
    currentAuthorityGeneration: () => BigInt(input.config.authorityGeneration),
    currentRevocationEpochs: async (claims) => claims.executorAgentId === null
      ? { ...input.config.revocationEpochs, executor: 0n }
      : input.config.revocationEpochs,
    nowMs: () => BigInt(nowMs()),
    consumeOperation: async (tokenId, maximum) => {
      const row = input.table.get<DurableBindingRowV1>(bindingKey(tokenId));
      if (!validBindingRow(row) || maximum !== row.maxOperations
        || row.consumedOperations >= row.maxOperations || !row.record.active) return false;
      ensureBindingRow(input.table, { ...row, consumedOperations: row.consumedOperations + 1 }, true);
      return true;
    },
    validateAdmissionTokenRef: async (candidate) => tokenMatches(input.table, candidate),
    registerIssuedToken: ({ claims, token, attribution }) => {
      const record: ActorAxesBindingRecordV2 = {
        bindingId: claims.bindingId,
        principalPersonId: claims.principalPersonId,
        executorAgentId: claims.executorAgentId,
        workspaceId: claims.workspaceId,
        deviceId: claims.deviceId,
        viewId: claims.viewId,
        sessionId: claims.sessionId,
        active: true,
        attribution
      };
      ensureBindingRow(input.table, bindingRow({
        tokenId: claims.tokenId,
        tokenDigest: actorAxesBindingTokenDigestV2(token),
        maxOperations: claims.maxOperations,
        consumedOperations: 0,
        record
      }));
    }
  };
  return runtime;
}

export function createDurableOperationNamespaceVerifierV2(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly table: DurableAuthorityStateTable;
  readonly proofKeys: ActorAxesProofKeyResolverV2;
  readonly nowMs?: () => number;
}): OperationNamespaceVerifierV2 & AuthorityDurableAdapterMarker {
  const configured = namespaceRow(input.config.operationNamespace);
  const existing = input.table.get<DurableNamespaceRowV1>(namespaceKey(configured.namespaceId));
  if (existing && stableStringify(existing) !== stableStringify(configured)) {
    throw new Error("AUTHORITY_OPERATION_NAMESPACE_DURABLE_MISMATCH");
  }
  if (!existing) input.table.put(namespaceKey(configured.namespaceId), configured);
  return {
    ...authorityDurableAdapterMarker,
    verify: async (operationId) => {
      const candidate = namespaceRow(operationId.namespace);
      const durable = input.table.get<DurableNamespaceRowV1>(namespaceKey(candidate.namespaceId));
      if (!durable || stableStringify(durable) !== stableStringify(candidate)
        || stableStringify(candidate) !== stableStringify(configured)) {
        throw new Error("OP_NAMESPACE_DURABLE_MISMATCH");
      }
      if (operationId.clientRandom128.byteLength !== 16
        || BigInt(input.nowMs?.() ?? Date.now()) > operationId.namespace.expiresAt) {
        throw new Error("OP_NAMESPACE_EXPIRED_OR_RANDOM_INVALID");
      }
      const key = input.proofKeys.resolve({
        algorithm: "Ed25519",
        issuer: candidate.issuer,
        keyId: candidate.keyId
      });
      if (!key || key.algorithm !== "Ed25519" || !verify(
        null,
        namespaceProofBytes(operationId.namespace),
        key.publicKey,
        operationId.namespace.proof
      )) throw new Error("OP_NAMESPACE_PROOF_INVALID");
    }
  };
}

export function authorityNamespaceProofBytes(namespace: Omit<OperationIdV2["namespace"], "proof">): Uint8Array {
  return Buffer.concat([
    Buffer.from(operationNamespaceProofDomain, "utf8"),
    Buffer.from(encodeCanonicalCbor({
      schema: namespace.schema,
      workspaceId: namespace.workspaceId,
      deviceId: namespace.deviceId,
      authorityGeneration: namespace.authorityGeneration,
      namespaceId: namespace.namespaceId,
      expiresAt: namespace.expiresAt,
      issuer: namespace.issuer,
      keyId: namespace.keyId
    }))
  ]);
}

function namespaceProofBytes(namespace: OperationIdV2["namespace"]): Uint8Array {
  const { proof: _proof, ...unsigned } = namespace;
  return authorityNamespaceProofBytes(unsigned);
}

function tokenMatches(
  table: DurableAuthorityStateTable,
  input: { readonly bindingId: string; readonly tokenId: string; readonly tokenDigest: Uint8Array }
): boolean {
  const row = table.get<DurableBindingRowV1>(bindingKey(input.tokenId));
  return validBindingRow(row) && row.record.active && row.record.bindingId === input.bindingId
    && row.tokenDigest === Buffer.from(input.tokenDigest).toString("base64url");
}

function bindingRow(input: Omit<DurableBindingRowV1, "schema" | "tokenDigest"> & { readonly tokenDigest: Uint8Array }): DurableBindingRowV1 {
  return {
    schema: bindingStateSchema,
    tokenId: requiredText(input.tokenId, "tokenId"),
    tokenDigest: digest32(input.tokenDigest, "tokenDigest"),
    maxOperations: requiredPositiveInteger(input.maxOperations, "maxOperations"),
    consumedOperations: nonNegativeInteger(input.consumedOperations, "consumedOperations"),
    record: input.record
  };
}

function ensureBindingRow(table: DurableAuthorityStateTable, row: DurableBindingRowV1, replace = false): void {
  const key = bindingKey(row.tokenId);
  const existing = table.get<DurableBindingRowV1>(key);
  if (existing && !replace && JSON.stringify(existing) !== JSON.stringify(row)) {
    throw new Error("AUTHORITY_BINDING_DURABLE_MISMATCH");
  }
  if (!existing || replace) table.put(key, row);
}

function validBindingRow(value: DurableBindingRowV1 | undefined): value is DurableBindingRowV1 {
  return value?.schema === bindingStateSchema && value.tokenDigest.length === 43
    && Number.isSafeInteger(value.maxOperations) && Number.isSafeInteger(value.consumedOperations);
}

function namespaceRow(value: OperationIdV2["namespace"]): DurableNamespaceRowV1 {
  if (value.schema !== "operation-namespace/v1") throw new Error("OP_NAMESPACE_SCHEMA_UNSUPPORTED");
  return {
    schema: namespaceStateSchema,
    workspaceId: requiredText(value.workspaceId, "namespace.workspaceId"),
    deviceId: requiredText(value.deviceId, "namespace.deviceId"),
    authorityGeneration: value.authorityGeneration.toString(),
    namespaceId: requiredText(value.namespaceId, "namespace.namespaceId"),
    expiresAt: value.expiresAt.toString(),
    issuer: requiredText(value.issuer, "namespace.issuer"),
    keyId: requiredText(value.keyId, "namespace.keyId"),
    proof: Buffer.from(value.proof).toString("base64url")
  };
}

function parseRepo(value: unknown, index: number, manifestDirectory: string): AuthorityProductionRepoConfigV1 {
  const row = strictObject(value, `repos[${index}]`);
  const schemaTuple = parseSchemaTuple(row.schemaTuple);
  const authorityGeneration = requiredPositiveInteger(row.authorityGeneration, "authorityGeneration");
  const operationNamespace = parseNamespace(row.operationNamespace);
  if (operationNamespace.authorityGeneration !== BigInt(authorityGeneration)) {
    throw new Error("AUTHORITY_PRODUCTION_NAMESPACE_GENERATION_MISMATCH");
  }
  return {
    repoId: requiredText(row.repoId, "repoId"),
    canonicalRoot: absolutePath(row.canonicalRoot, "canonicalRoot", manifestDirectory),
    workspaceId: requiredText(row.workspaceId, "workspaceId"),
    deviceId: requiredText(row.deviceId, "deviceId"),
    viewId: requiredText(row.viewId, "viewId"),
    sessionId: requiredText(row.sessionId, "sessionId"),
    authorityId: requiredText(row.authorityId, "authorityId"),
    issuer: requiredText(row.issuer, "issuer"),
    keyRegistryPath: absolutePath(row.keyRegistryPath, "keyRegistryPath", manifestDirectory),
    keyStateDirectory: absolutePath(row.keyStateDirectory, "keyStateDirectory", manifestDirectory),
    schemaTuple,
    authorityGeneration,
    revocationEpochs: parseEpochs(row.revocationEpochs),
    admissionTokenRef: requiredText(row.admissionTokenRef, "admissionTokenRef"),
    allowedExecutorAgentIds: Array.isArray(row.allowedExecutorAgentIds)
      ? row.allowedExecutorAgentIds.map((entry) => requiredText(entry, "allowedExecutorAgentIds"))
      : [],
    operationNamespace,
    bootstrapBindings: Array.isArray(row.bootstrapBindings)
      ? row.bootstrapBindings.map((binding, bindingIndex) => parseBootstrapBinding(binding, bindingIndex))
      : []
  };
}

function parseBootstrapBinding(value: unknown, index: number): AuthorityBootstrapBindingV1 {
  const row = strictObject(value, `bootstrapBindings[${index}]`);
  const record = strictObject(row.record, `bootstrapBindings[${index}].record`);
  const attribution = parseWriteAttribution(record.attribution, `bootstrapBindings[${index}].record.attribution`);
  return {
    tokenId: requiredText(row.tokenId, "bootstrap.tokenId"),
    tokenDigest: base64Digest(row.tokenDigest, "bootstrap.tokenDigest"),
    maxOperations: requiredPositiveInteger(row.maxOperations, "bootstrap.maxOperations"),
    record: {
      bindingId: requiredText(record.bindingId, "bindingId"),
      principalPersonId: requiredText(record.principalPersonId, "principalPersonId"),
      executorAgentId: record.executorAgentId === null ? null : requiredText(record.executorAgentId, "executorAgentId"),
      workspaceId: requiredText(record.workspaceId, "workspaceId"),
      deviceId: requiredText(record.deviceId, "deviceId"),
      viewId: requiredText(record.viewId, "viewId"),
      sessionId: requiredText(record.sessionId, "sessionId"),
      active: record.active === true,
      attribution
    }
  };
}

function parseNamespace(value: unknown): OperationIdV2["namespace"] {
  const row = strictObject(value, "operationNamespace");
  if (row.schema !== "operation-namespace/v1") throw new Error("OP_NAMESPACE_SCHEMA_UNSUPPORTED");
  return {
    schema: row.schema,
    workspaceId: requiredText(row.workspaceId, "namespace.workspaceId"),
    deviceId: requiredText(row.deviceId, "namespace.deviceId"),
    authorityGeneration: decimalBigInt(row.authorityGeneration, "namespace.authorityGeneration"),
    namespaceId: requiredText(row.namespaceId, "namespace.namespaceId"),
    expiresAt: decimalBigInt(row.expiresAt, "namespace.expiresAt"),
    issuer: requiredText(row.issuer, "namespace.issuer"),
    keyId: requiredText(row.keyId, "namespace.keyId"),
    proof: base64Bytes(row.proof, "namespace.proof")
  };
}

function parseWriteAttribution(value: unknown, name: string): WriteAttribution {
  const row = strictObject(value, name);
  const actor = strictObject(row.actor, `${name}.actor`);
  const principal = strictObject(actor.principal, `${name}.actor.principal`);
  if (principal.kind !== "person") throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}.actor.principal.kind`);
  const executor = actor.executor === null ? null : strictObject(actor.executor, `${name}.actor.executor`);
  if (executor && executor.kind !== "agent") throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}.actor.executor.kind`);
  const principalSource = parsePrincipalSource(row.principalSource, `${name}.principalSource`);
  const executorSource = row.executorSource;
  if (executorSource !== "none" && executorSource !== "client-asserted") {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}.executorSource`);
  }
  if ((executor === null && executorSource !== "none")
    || (executor !== null && executorSource !== "client-asserted")) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}.executorSource`);
  }
  return {
    actor: {
      principal: { kind: "person", personId: requiredText(principal.personId, `${name}.actor.principal.personId`) },
      executor: executor ? { kind: "agent", id: requiredText(executor.id, `${name}.actor.executor.id`) } : null
    },
    principalSource,
    executorSource
  };
}

function parsePrincipalSource(
  value: unknown,
  name: string
): WriteAttribution["principalSource"] {
  const row = strictObject(value, name);
  if (row.kind === "daemon-authenticated") return {
    kind: row.kind,
    providerId: requiredText(row.providerId, `${name}.providerId`),
    credentialFingerprint: requiredText(row.credentialFingerprint, `${name}.credentialFingerprint`)
  };
  if (row.kind === "local-configured"
    && (row.authority === "persons.yaml" || row.authority === "people.yaml-legacy" || row.authority === "harness.yaml")) {
    return {
      kind: row.kind,
      authority: row.authority,
      authoritySha256: requiredText(row.authoritySha256, `${name}.authoritySha256`)
    };
  }
  if (row.kind === "migration") return {
    kind: row.kind,
    evidenceRef: requiredText(row.evidenceRef, `${name}.evidenceRef`)
  };
  throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}.kind`);
}

function parseSchemaTuple(value: unknown): ProtocolSchemaTupleV2 {
  const row = strictObject(value, "schemaTuple");
  const keys = ["wire", "event", "receipt", "digest", "policy", "commandRegistry", "entityRegistry", "mutationRegistry", "localState", "applyJournal"] as const;
  return Object.fromEntries(keys.map((key) => [key, nonNegativeInteger(row[key], `schemaTuple.${key}`)])) as unknown as ProtocolSchemaTupleV2;
}

function parseEpochs(value: unknown): RevocationEpochTupleV2 {
  const row = strictObject(value, "revocationEpochs");
  const keys = ["global", "workspace", "device", "view", "principal", "executor"] as const;
  return Object.fromEntries(keys.map((key) => [key, decimalBigInt(row[key], `revocationEpochs.${key}`)])) as unknown as RevocationEpochTupleV2;
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0")) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return value;
}

function absolutePath(value: unknown, name: string, base: string): string {
  const candidate = requiredText(value, name);
  return path.resolve(base, candidate);
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return Number(value);
}

function decimalBigInt(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return BigInt(value);
}

function base64Bytes(value: unknown, name: string): Uint8Array {
  const text = requiredText(value, name);
  const bytes = Buffer.from(text, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== text) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return bytes;
}

function base64Digest(value: unknown, name: string): Uint8Array {
  const bytes = base64Bytes(value, name);
  if (bytes.byteLength !== 32) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return bytes;
}

function digest32(value: Uint8Array, name: string): string {
  if (value.byteLength !== 32) throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  return Buffer.from(value).toString("base64url");
}

function bindingKey(tokenId: string): string {
  return `token:${requiredText(tokenId, "tokenId")}`;
}

function namespaceKey(namespaceId: string): string {
  return `namespace:${requiredText(namespaceId, "namespaceId")}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
