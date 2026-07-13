import {
  createHmac,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject
} from "node:crypto";
import {
  actorAxesBindingCoreDigestV2,
  actorAxesBindingCoreV2Domain,
  type WriteAttribution,
  type ProtocolSchemaTupleV2Core
} from "../../../kernel/src/index.ts";
import {
  canonicalCborBytesEqual,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  type CanonicalCborValue,
  domainHash
} from "./canonical-cbor.ts";

export const actorAxesBindingV2Schema = "actor-axes-binding/v2" as const;
export const actorAxesBindingV2Domain = "ha/actor-axes-binding/v2\0";
export const actorAxesBindingTokenDigestV2Domain = "ha/actor-axes-binding-token-digest/v2\0";
export { actorAxesBindingCoreV2Domain };

export type ProtocolSchemaTupleV2 = ProtocolSchemaTupleV2Core;

export interface RevocationEpochTupleV2 {
  readonly global: bigint;
  readonly workspace: bigint;
  readonly device: bigint;
  readonly view: bigint;
  readonly principal: bigint;
  readonly executor: bigint;
}

export interface RegistryEntityRefScopeV2 {
  readonly registryVersion: number;
  readonly entityKind: string;
  readonly canonicalRef: string;
}

export type ResourceScopeV2 =
  | { readonly kind: "workspace" }
  | { readonly kind: "entity-ref"; readonly entityRef: RegistryEntityRefScopeV2 }
  | { readonly kind: "entity-ref-prefix"; readonly entityKind: string; readonly canonicalIdPrefix: string }
  | { readonly kind: "portable-path"; readonly path: string }
  | { readonly kind: "portable-path-prefix"; readonly path: string };

export interface PathFootprintCeilingV2 {
  readonly exactPaths: ReadonlyArray<string>;
  readonly prefixPaths: ReadonlyArray<string>;
}

export interface ActorAxesBindingClaimsV2 {
  readonly tokenId: string;
  readonly bindingId: string;
  readonly principalPersonId: string;
  readonly executorAgentId: string | null;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly allowedEntityKinds: ReadonlyArray<string>;
  readonly allowedActions: ReadonlyArray<string>;
  readonly resourceScopes: ReadonlyArray<ResourceScopeV2>;
  readonly pathFootprint: PathFootprintCeilingV2 | null;
  readonly maxBytes: bigint;
  readonly maxMutations: number;
  readonly maxOperations: number;
  readonly authorityGeneration: bigint;
  readonly channelNonceDigest: Uint8Array;
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly issuedAt: bigint;
  readonly notBefore: bigint;
  readonly expiresAt: bigint;
  readonly revocationEpochs: RevocationEpochTupleV2;
}

export interface BindingProofHeaderV2 {
  readonly algorithm: "Ed25519" | "HMAC-SHA-256";
  readonly issuer: string;
  readonly keyId: string;
}

export interface ActorAxesBindingV2 {
  readonly schema: typeof actorAxesBindingV2Schema;
  readonly header: BindingProofHeaderV2;
  readonly claims: ActorAxesBindingClaimsV2;
  readonly proof: Uint8Array;
}

export type ActorAxesSigningProfileV2 =
  | { readonly algorithm: "Ed25519"; readonly issuer: string; readonly keyId: string; readonly privateKey: KeyObject }
  | { readonly algorithm: "HMAC-SHA-256"; readonly issuer: string; readonly keyId: string; readonly secret: Uint8Array };

export type ActorAxesVerificationKeyV2 =
  | { readonly algorithm: "Ed25519"; readonly publicKey: KeyObject }
  | { readonly algorithm: "HMAC-SHA-256"; readonly secret: Uint8Array };

export interface ActorAxesProofKeyResolverV2 {
  readonly resolve: (header: BindingProofHeaderV2) => ActorAxesVerificationKeyV2 | undefined;
}

export interface ActorAxesBindingRecordV2 {
  readonly bindingId: string;
  readonly principalPersonId: string;
  readonly executorAgentId: string | null;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly active: boolean;
  readonly attribution: WriteAttribution;
}

export interface ActorAxesBindingRuntimeV2 {
  readonly proofKeys: ActorAxesProofKeyResolverV2;
  readonly validatePresentationToken: (input: {
    readonly bindingId: string;
    readonly tokenId: string;
    readonly tokenDigest: Uint8Array;
  }) => Promise<boolean>;
  readonly getBinding: (bindingId: string) => Promise<ActorAxesBindingRecordV2 | undefined>;
  readonly currentAuthorityGeneration: () => bigint;
  readonly currentRevocationEpochs: (claims: ActorAxesBindingClaimsV2) => Promise<RevocationEpochTupleV2>;
  readonly nowMs: () => bigint;
  readonly consumeOperation: (tokenId: string, maximum: number) => Promise<boolean>;
  readonly validateAdmissionTokenRef: (input: {
    readonly bindingId: string;
    readonly tokenId: string;
    readonly tokenDigest: Uint8Array;
  }) => Promise<boolean>;
}

export interface VerifiedActorAxesBindingV2 {
  readonly token: ActorAxesBindingV2;
  readonly attribution: WriteAttribution;
}

export function issueActorAxesBindingV2(
  claims: ActorAxesBindingClaimsV2,
  profile: ActorAxesSigningProfileV2
): Uint8Array {
  validateClaims(claims);
  const header: BindingProofHeaderV2 = {
    algorithm: profile.algorithm,
    issuer: nonBlank(profile.issuer, "issuer"),
    keyId: nonBlank(profile.keyId, "keyId")
  };
  const input = bindingProofInput(header, claims);
  const proof = profile.algorithm === "Ed25519"
    ? sign(null, input, profile.privateKey)
    : createHmac("sha256", profile.secret).update(input).digest();
  return encodeActorAxesBindingV2({ schema: actorAxesBindingV2Schema, header, claims, proof });
}

export function verifyActorAxesBindingV2(
  bytes: Uint8Array,
  resolver: ActorAxesProofKeyResolverV2
): ActorAxesBindingV2 {
  const token = decodeActorAxesBindingV2(bytes);
  const key = resolver.resolve(token.header);
  if (!key || key.algorithm !== token.header.algorithm) throw new Error("TOKEN_PROOF_ALGORITHM_DISABLED");
  const input = bindingProofInput(token.header, token.claims);
  const valid = key.algorithm === "Ed25519"
    ? verify(null, input, key.publicKey, token.proof)
    : token.proof.length === 32 && timingSafeEqual(
      Buffer.from(token.proof),
      createHmac("sha256", key.secret).update(input).digest()
    );
  if (!valid) throw new Error("TOKEN_PROOF_INVALID");
  return token;
}

export async function validateActorAxesBindingPresentationV2(
  bytes: Uint8Array,
  runtime: ActorAxesBindingRuntimeV2,
  expected: {
    readonly workspaceId: string;
    readonly channelNonceDigest: Uint8Array;
    readonly schemaTuple: ProtocolSchemaTupleV2;
  }
): Promise<VerifiedActorAxesBindingV2> {
  const token = verifyActorAxesBindingV2(bytes, runtime.proofKeys);
  const claims = token.claims;
  const now = runtime.nowMs();
  if (now < claims.issuedAt || now < claims.notBefore) throw new Error("TOKEN_NOT_YET_VALID");
  if (now > claims.expiresAt) throw new Error("TOKEN_EXPIRED");
  if (!await runtime.validatePresentationToken({
    bindingId: claims.bindingId,
    tokenId: claims.tokenId,
    tokenDigest: domainHash(actorAxesBindingTokenDigestV2Domain, bytes)
  })) throw new Error("TOKEN_ID_UNKNOWN_OR_REUSED");
  if (claims.workspaceId !== expected.workspaceId) throw new Error("TOKEN_WORKSPACE_MISMATCH");
  if (!Buffer.from(claims.channelNonceDigest).equals(Buffer.from(expected.channelNonceDigest))) throw new Error("TOKEN_CHANNEL_MISMATCH");
  if (!sameProtocolSchemaTupleV2(claims.schemaTuple, expected.schemaTuple)) throw new Error("TOKEN_SCHEMA_MISMATCH");
  if (claims.authorityGeneration !== runtime.currentAuthorityGeneration()) throw new Error("TOKEN_AUTHORITY_GENERATION_MISMATCH");
  const epochs = await runtime.currentRevocationEpochs(claims);
  if (!sameEpochs(claims.revocationEpochs, epochs)) throw new Error("TOKEN_REVOKED");
  const binding = await runtime.getBinding(claims.bindingId);
  if (!binding || !binding.active) throw new Error("BINDING_UNKNOWN_OR_REVOKED");
  if (binding.principalPersonId !== claims.principalPersonId
    || binding.executorAgentId !== claims.executorAgentId
    || binding.workspaceId !== claims.workspaceId
    || binding.deviceId !== claims.deviceId
    || binding.viewId !== claims.viewId
    || binding.sessionId !== claims.sessionId
    || binding.attribution.actor.principal.personId !== claims.principalPersonId
    || (binding.attribution.actor.executor?.id ?? null) !== claims.executorAgentId) {
    throw new Error("BINDING_MISMATCH");
  }
  return { token, attribution: binding.attribution };
}

export async function consumeActorAxesBindingOperationV2(
  verified: VerifiedActorAxesBindingV2,
  runtime: ActorAxesBindingRuntimeV2
): Promise<void> {
  if (!await runtime.consumeOperation(verified.token.claims.tokenId, verified.token.claims.maxOperations)) {
    throw new Error("TOKEN_OPERATION_LIMIT_EXCEEDED");
  }
}

export function encodeActorAxesBindingV2(token: ActorAxesBindingV2): Uint8Array {
  validateClaims(token.claims);
  return encodeCanonicalCbor(tokenWire(token));
}

export function decodeActorAxesBindingV2(bytes: Uint8Array): ActorAxesBindingV2 {
  const wire = record(decodeCanonicalCbor(bytes), ["schema", "header", "claims", "proof"], "ActorAxesBindingV2");
  if (wire.schema !== actorAxesBindingV2Schema) throw new Error("TOKEN_SCHEMA_UNSUPPORTED");
  const headerWire = record(wire.header, ["algorithm", "issuer", "keyId"], "BindingProofHeaderV2");
  if (headerWire.algorithm !== "Ed25519" && headerWire.algorithm !== "HMAC-SHA-256") {
    throw new Error("TOKEN_PROOF_ALGORITHM_UNKNOWN");
  }
  const token: ActorAxesBindingV2 = {
    schema: actorAxesBindingV2Schema,
    header: {
      algorithm: headerWire.algorithm,
      issuer: bindingText(headerWire.issuer, "issuer"),
      keyId: bindingText(headerWire.keyId, "keyId")
    },
    claims: claimsFromWire(wire.claims),
    proof: bytesValue(wire.proof, "proof")
  };
  validateClaims(token.claims);
  if (!canonicalCborBytesEqual(encodeActorAxesBindingV2(token), bytes)) {
    throw new Error("TOKEN_CBOR_NON_CANONICAL");
  }
  return token;
}

export function actorAxesBindingTokenDigestV2(bytes: Uint8Array): Uint8Array {
  decodeActorAxesBindingV2(bytes);
  return domainHash(actorAxesBindingTokenDigestV2Domain, bytes);
}

export function actorAxesBindingDigestV2(claims: ActorAxesBindingClaimsV2): Uint8Array {
  validateClaims(claims);
  return actorAxesBindingCoreDigestV2({
    bindingId: claims.bindingId,
    principalPersonId: claims.principalPersonId,
    executorAgentId: claims.executorAgentId,
    workspaceId: claims.workspaceId,
    deviceId: claims.deviceId,
    viewId: claims.viewId,
    sessionId: claims.sessionId,
    schemaTuple: claims.schemaTuple
  });
}

export function sameProtocolSchemaTupleV2(left: ProtocolSchemaTupleV2, right: ProtocolSchemaTupleV2): boolean {
  return left.wire === right.wire
    && left.event === right.event
    && left.receipt === right.receipt
    && left.digest === right.digest
    && left.policy === right.policy
    && left.commandRegistry === right.commandRegistry
    && left.entityRegistry === right.entityRegistry
    && left.mutationRegistry === right.mutationRegistry
    && left.localState === right.localState
    && left.applyJournal === right.applyJournal;
}

function bindingProofInput(header: BindingProofHeaderV2, claims: ActorAxesBindingClaimsV2): Buffer {
  return Buffer.concat([
    Buffer.from(actorAxesBindingV2Domain, "utf8"),
    Buffer.from(encodeCanonicalCbor({
      schema: actorAxesBindingV2Schema,
      header: headerWire(header),
      claims: claimsWire(claims)
    }))
  ]);
}

function tokenWire(token: ActorAxesBindingV2): CanonicalCborValue {
  return {
    schema: token.schema,
    header: headerWire(token.header),
    claims: claimsWire(token.claims),
    proof: token.proof
  };
}

function headerWire(header: BindingProofHeaderV2): CanonicalCborValue {
  return { algorithm: header.algorithm, issuer: header.issuer, keyId: header.keyId };
}

function claimsWire(claims: ActorAxesBindingClaimsV2): CanonicalCborValue {
  return {
    tokenId: claims.tokenId,
    bindingId: claims.bindingId,
    principalPersonId: claims.principalPersonId,
    executorAgentId: claims.executorAgentId,
    workspaceId: claims.workspaceId,
    deviceId: claims.deviceId,
    viewId: claims.viewId,
    sessionId: claims.sessionId,
    allowedEntityKinds: [...claims.allowedEntityKinds],
    allowedActions: [...claims.allowedActions],
    resourceScopes: claims.resourceScopes.map(scopeWire),
    pathFootprint: claims.pathFootprint && {
      exactPaths: [...claims.pathFootprint.exactPaths],
      prefixPaths: [...claims.pathFootprint.prefixPaths]
    },
    maxBytes: claims.maxBytes,
    maxMutations: claims.maxMutations,
    maxOperations: claims.maxOperations,
    authorityGeneration: claims.authorityGeneration,
    channelNonceDigest: claims.channelNonceDigest,
    schemaTuple: schemaTupleWire(claims.schemaTuple),
    issuedAt: claims.issuedAt,
    notBefore: claims.notBefore,
    expiresAt: claims.expiresAt,
    revocationEpochs: epochWire(claims.revocationEpochs)
  };
}

function claimsFromWire(value: CanonicalCborValue): ActorAxesBindingClaimsV2 {
  const wire = record(value, [
    "tokenId", "bindingId", "principalPersonId", "executorAgentId", "workspaceId", "deviceId", "viewId", "sessionId",
    "allowedEntityKinds", "allowedActions", "resourceScopes", "pathFootprint", "maxBytes", "maxMutations", "maxOperations",
    "authorityGeneration", "channelNonceDigest", "schemaTuple", "issuedAt", "notBefore", "expiresAt", "revocationEpochs"
  ], "ActorAxesBindingClaimsV2");
  const executor = wire.executorAgentId === null ? null : bindingText(wire.executorAgentId, "executorAgentId");
  return {
    tokenId: bindingText(wire.tokenId, "tokenId"), bindingId: bindingText(wire.bindingId, "bindingId"),
    principalPersonId: bindingText(wire.principalPersonId, "principalPersonId"), executorAgentId: executor,
    workspaceId: bindingText(wire.workspaceId, "workspaceId"), deviceId: bindingText(wire.deviceId, "deviceId"),
    viewId: bindingText(wire.viewId, "viewId"), sessionId: bindingText(wire.sessionId, "sessionId"),
    allowedEntityKinds: textArray(wire.allowedEntityKinds, "allowedEntityKinds"),
    allowedActions: textArray(wire.allowedActions, "allowedActions"),
    resourceScopes: array(wire.resourceScopes, "resourceScopes").map(scopeFromWire),
    pathFootprint: wire.pathFootprint === null ? null : footprintFromWire(wire.pathFootprint),
    maxBytes: bindingUint64(wire.maxBytes, "maxBytes"), maxMutations: bindingUint32(wire.maxMutations, "maxMutations"),
    maxOperations: bindingUint32(wire.maxOperations, "maxOperations"), authorityGeneration: bindingUint64(wire.authorityGeneration, "authorityGeneration"),
    channelNonceDigest: bytesValue(wire.channelNonceDigest, "channelNonceDigest"), schemaTuple: schemaTupleFromWire(wire.schemaTuple),
    issuedAt: bindingUint64(wire.issuedAt, "issuedAt"), notBefore: bindingUint64(wire.notBefore, "notBefore"), expiresAt: bindingUint64(wire.expiresAt, "expiresAt"),
    revocationEpochs: epochsFromWire(wire.revocationEpochs)
  };
}

function validateClaims(claims: ActorAxesBindingClaimsV2): void {
  for (const [name, value] of Object.entries({
    tokenId: claims.tokenId, bindingId: claims.bindingId, principalPersonId: claims.principalPersonId,
    workspaceId: claims.workspaceId, deviceId: claims.deviceId, viewId: claims.viewId, sessionId: claims.sessionId
  })) nonBlank(value, name);
  if (claims.executorAgentId !== null) nonBlank(claims.executorAgentId, "executorAgentId");
  sortedSet(claims.allowedEntityKinds, "allowedEntityKinds");
  sortedSet(claims.allowedActions, "allowedActions");
  sortedCborSet(claims.resourceScopes, "resourceScopes", scopeWire);
  if (claims.resourceScopes.length === 0) throw new Error("resourceScopes must be non-empty");
  for (const scope of claims.resourceScopes) {
    if (scope.kind === "entity-ref") {
      bindingUint32(scope.entityRef.registryVersion, "resourceScopes.entityRef.registryVersion");
      nonBlank(scope.entityRef.entityKind, "resourceScopes.entityRef.entityKind");
      nonBlank(scope.entityRef.canonicalRef, "resourceScopes.entityRef.canonicalRef");
    } else if (scope.kind === "entity-ref-prefix") {
      nonBlank(scope.entityKind, "resourceScopes.entityKind");
      nonBlank(scope.canonicalIdPrefix, "resourceScopes.canonicalIdPrefix");
    } else if (scope.kind === "portable-path" || scope.kind === "portable-path-prefix") {
      if (!isPortablePath(scope.path)) throw new Error("resource scope path must be canonical portable ASCII");
    }
  }
  if (claims.channelNonceDigest.length !== 32) throw new Error("channelNonceDigest must be 32 bytes");
  bindingUint32(claims.maxMutations, "maxMutations");
  bindingUint32(claims.maxOperations, "maxOperations");
  if (claims.maxBytes < 0n || claims.authorityGeneration < 0n) throw new Error("token uint64 claims must be non-negative");
  if (claims.notBefore > claims.expiresAt || claims.issuedAt > claims.expiresAt) throw new Error("invalid token time window");
  if (claims.executorAgentId === null && claims.revocationEpochs.executor !== 0n) throw new Error("null executor requires zero executor epoch");
  validateSchemaTuple(claims.schemaTuple);
  Object.values(claims.revocationEpochs).forEach((value) => {
    if (value < 0n) throw new Error("revocation epoch must be non-negative");
  });
  if (claims.pathFootprint) {
    sortedSet(claims.pathFootprint.exactPaths, "pathFootprint.exactPaths", true);
    sortedSet(claims.pathFootprint.prefixPaths, "pathFootprint.prefixPaths", true);
    for (const path of [...claims.pathFootprint.exactPaths, ...claims.pathFootprint.prefixPaths]) {
      if (!isPortablePath(path)) throw new Error("pathFootprint path must be canonical portable ASCII");
    }
  }
}

function scopeWire(scope: ResourceScopeV2): CanonicalCborValue {
  if (scope.kind === "workspace") return { kind: scope.kind };
  if (scope.kind === "entity-ref") return { kind: scope.kind, entityRef: { ...scope.entityRef } };
  if (scope.kind === "entity-ref-prefix") return { kind: scope.kind, entityKind: scope.entityKind, canonicalIdPrefix: scope.canonicalIdPrefix };
  return { kind: scope.kind, path: scope.path };
}

function scopeFromWire(value: CanonicalCborValue): ResourceScopeV2 {
  const input = value as Record<string, CanonicalCborValue>;
  const kind = bindingText(input?.kind, "resourceScopes.kind");
  if (kind === "workspace") { record(value, ["kind"], "workspace scope"); return { kind }; }
  if (kind === "entity-ref") {
    const row = record(value, ["kind", "entityRef"], kind);
    const entity = record(row.entityRef, ["registryVersion", "entityKind", "canonicalRef"], "entityRef");
    return { kind, entityRef: { registryVersion: bindingUint32(entity.registryVersion, "registryVersion"), entityKind: bindingText(entity.entityKind, "entityKind"), canonicalRef: bindingText(entity.canonicalRef, "canonicalRef") } };
  }
  if (kind === "entity-ref-prefix") { const row = record(value, ["kind", "entityKind", "canonicalIdPrefix"], kind); return { kind, entityKind: bindingText(row.entityKind, "entityKind"), canonicalIdPrefix: bindingText(row.canonicalIdPrefix, "canonicalIdPrefix") }; }
  if (kind === "portable-path" || kind === "portable-path-prefix") { const row = record(value, ["kind", "path"], kind); return { kind, path: bindingText(row.path, "path") }; }
  throw new Error("unknown resource scope kind");
}

function footprintFromWire(value: CanonicalCborValue): PathFootprintCeilingV2 {
  const wire = record(value, ["exactPaths", "prefixPaths"], "PathFootprintCeilingV2");
  return { exactPaths: textArray(wire.exactPaths, "exactPaths"), prefixPaths: textArray(wire.prefixPaths, "prefixPaths") };
}

function schemaTupleWire(tuple: ProtocolSchemaTupleV2): CanonicalCborValue {
  return { ...tuple };
}

function schemaTupleFromWire(value: CanonicalCborValue): ProtocolSchemaTupleV2 {
  const keys = ["wire", "event", "receipt", "digest", "policy", "commandRegistry", "entityRegistry", "mutationRegistry", "localState", "applyJournal"] as const;
  const wire = record(value, keys, "ProtocolSchemaTupleV2");
  return Object.fromEntries(keys.map((key) => [key, bindingUint32(wire[key], key)])) as unknown as ProtocolSchemaTupleV2;
}

function validateSchemaTuple(tuple: ProtocolSchemaTupleV2): void {
  for (const [key, value] of Object.entries(tuple)) bindingUint32(value, key);
  if (Object.keys(tuple).length !== 10) throw new Error("ProtocolSchemaTupleV2 fields mismatch");
}

function epochWire(epochs: RevocationEpochTupleV2): CanonicalCborValue { return { ...epochs }; }
function epochsFromWire(value: CanonicalCborValue): RevocationEpochTupleV2 {
  const keys = ["global", "workspace", "device", "view", "principal", "executor"] as const;
  const wire = record(value, keys, "RevocationEpochTupleV2");
  return Object.fromEntries(keys.map((key) => [key, bindingUint64(wire[key], key)])) as unknown as RevocationEpochTupleV2;
}

function sameEpochs(left: RevocationEpochTupleV2, right: RevocationEpochTupleV2): boolean {
  return left.global === right.global
    && left.workspace === right.workspace
    && left.device === right.device
    && left.view === right.view
    && left.principal === right.principal
    && left.executor === right.executor;
}

export function isPortablePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || !/^[\x21-\x7e]+$/.test(path)) return false;
  if (/[*?[\]{}]/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sortedSet(values: ReadonlyArray<string>, name: string, allowEmpty = false): void {
  if (!allowEmpty && values.length === 0) throw new Error(`${name} must be non-empty`);
  values.forEach((value) => nonBlank(value, name));
  sortedCborSet(values, name, (value) => value);
}

function sortedCborSet<T>(values: ReadonlyArray<T>, name: string, toWire: (value: T) => CanonicalCborValue): void {
  let previous: Uint8Array | undefined;
  for (const value of values) {
    const encoded = encodeCanonicalCbor(toWire(value));
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(encoded)) >= 0) throw new Error(`${name} must be sorted and duplicate-free`);
    previous = encoded;
  }
}

function record(value: CanonicalCborValue, keys: ReadonlyArray<string>, name: string): Record<string, CanonicalCborValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`${name} must be a map`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw new Error(`${name} has unknown or missing fields`);
  return value as Record<string, CanonicalCborValue>;
}

function array(value: CanonicalCborValue, name: string): ReadonlyArray<CanonicalCborValue> { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value; }
function textArray(value: CanonicalCborValue, name: string): ReadonlyArray<string> { return array(value, name).map((entry) => bindingText(entry, name)); }
function bindingText(value: CanonicalCborValue | undefined, name: string): string { if (typeof value !== "string") throw new Error(`${name} must be text`); return nonBlank(value, name); }
function nonBlank(value: string, name: string): string { if (!value || value.trim() !== value) throw new Error(`${name} must be non-blank canonical text`); return value; }
function bytesValue(value: CanonicalCborValue, name: string): Uint8Array { if (!(value instanceof Uint8Array)) throw new Error(`${name} must be bytes`); return value; }
function bindingUint32(value: CanonicalCborValue | number, name: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name} must be uint32`); return value; }
function bindingUint64(value: CanonicalCborValue, name: string): bigint { if ((typeof value !== "number" && typeof value !== "bigint") || BigInt(value) < 0n) throw new Error(`${name} must be uint64`); return BigInt(value); }
