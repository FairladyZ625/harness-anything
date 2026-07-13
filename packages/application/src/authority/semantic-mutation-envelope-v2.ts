import type { RegistryMutationPlanInput, StoragePlan, WriteOp } from "../../../kernel/src/index.ts";
import {
  semanticMutationSetBytesV2,
  semanticMutationSetDigestV2,
  semanticMutationSetWireV2,
  validateSemanticMutationSetV2,
  type RegistryEntityRefV2,
  type SemanticMutationSetV2
} from "../../../kernel/src/index.ts";
import {
  actorAxesBindingDigestV2,
  type ActorAxesBindingClaimsV2,
  type ProtocolSchemaTupleV2
} from "./actor-axes-binding-v2.ts";
import {
  canonicalCborBytesEqual,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  type CanonicalCborValue,
  domainHash
} from "./canonical-cbor.ts";

export const semanticMutationEnvelopeV2Schema = "semantic-mutation-envelope/v2" as const;
export const semanticRequestV2Domain = "ha/semantic-request/v2\0";

export {
  semanticMutationSetBytesV2,
  semanticMutationSetDigestV2,
  semanticMutationSetV2Domain
} from "../../../kernel/src/index.ts";
export type {
  RegisteredSemanticActionV2,
  RegistryEntityRefV2,
  SemanticMutationSetV2,
  SemanticMutationV2
} from "../../../kernel/src/index.ts";

export type ContentValueV2 =
  | { readonly kind: "inline"; readonly size: bigint; readonly bytes: Uint8Array }
  | { readonly kind: "cas"; readonly size: bigint; readonly casRef: string };

export interface SemanticBaseCasV2 {
  readonly entityRef: RegistryEntityRefV2;
  readonly expectedSemanticVersion: string | null;
  readonly expectedStateDigest: Uint8Array | null;
}

export interface PathCasV2 {
  readonly path: string;
  readonly expectedEpoch: string;
  readonly expectedRevision: bigint;
  readonly expectedBlobDigest: Uint8Array;
}

export interface TypedSemanticRequestV2 {
  readonly kind: "typed";
  readonly command: { readonly registryVersion: number; readonly name: string; readonly version: number };
  readonly canonicalPayload: ContentValueV2;
  readonly canonicalPayloadDigest: Uint8Array;
  readonly baseCas: ReadonlyArray<SemanticBaseCasV2>;
  readonly declaredPathCas: ReadonlyArray<PathCasV2>;
}

export interface TransparentFileCandidateV2 {
  readonly path: string;
  readonly base: {
    readonly workspaceEpoch: string;
    readonly revision: bigint;
    readonly blobDigest: Uint8Array;
    readonly bytes: ContentValueV2;
  };
  readonly candidate: { readonly blobDigest: Uint8Array; readonly bytes: ContentValueV2 };
}

export interface TransparentFileRequestV2 {
  readonly kind: "transparent-file";
  readonly interpretation: "full-semantic" | "host-prose-only";
  readonly files: ReadonlyArray<TransparentFileCandidateV2>;
}

export type SemanticIntentV2 = TypedSemanticRequestV2 | TransparentFileRequestV2;

export interface OperationIdV2 {
  readonly namespace: {
    readonly schema: "operation-namespace/v1";
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly authorityGeneration: bigint;
    readonly namespaceId: string;
    readonly expiresAt: bigint;
    readonly issuer: string;
    readonly keyId: string;
    readonly proof: Uint8Array;
  };
  readonly clientRandom128: Uint8Array;
}

export interface OperationBindingV2 {
  readonly bindingId: string;
  readonly actorAxesBindingDigest: Uint8Array;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly admissionTokenRef: { readonly tokenId: string; readonly tokenDigest: Uint8Array };
}

export interface SemanticMutationEnvelopeV2 {
  readonly schema: typeof semanticMutationEnvelopeV2Schema;
  readonly workspaceId: string;
  readonly operationId: OperationIdV2;
  readonly binding: OperationBindingV2;
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly intent: SemanticIntentV2;
  readonly claimedMutationSet: SemanticMutationSetV2;
  readonly claimedSemanticMutationSetDigest: Uint8Array;
  readonly claimedSemanticRequestDigest: Uint8Array;
}

export interface AuthorizedOperationAttemptV2 {
  readonly requestId: string;
  readonly presentationToken: Uint8Array;
  readonly envelope: Uint8Array;
}

export interface AuthoritySemanticCompilationV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly decodedBytes: bigint;
}

export interface AuthoritySemanticCompilerV2 {
  readonly compile: (envelope: SemanticMutationEnvelopeV2) => Promise<AuthoritySemanticCompilationV2>;
}

export interface OperationNamespaceVerifierV2 {
  readonly verify: (operationId: OperationIdV2) => Promise<void>;
}

export class SemanticAdmissionErrorV2 extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
    this.name = "SemanticAdmissionErrorV2";
  }
}

export function encodeSemanticMutationEnvelopeV2(envelope: SemanticMutationEnvelopeV2): Uint8Array {
  validateEnvelope(envelope);
  return encodeCanonicalCbor(envelopeWire(envelope, true));
}

export function decodeSemanticMutationEnvelopeV2(bytes: Uint8Array): SemanticMutationEnvelopeV2 {
  const envelope = envelopeFromWire(decodeCanonicalCbor(bytes));
  validateEnvelope(envelope);
  if (!canonicalCborBytesEqual(encodeSemanticMutationEnvelopeV2(envelope), bytes)) {
    throw new SemanticAdmissionErrorV2("ENVELOPE_CBOR_NON_CANONICAL");
  }
  return envelope;
}

export function semanticRequestDigestV2(envelope: Omit<SemanticMutationEnvelopeV2, "claimedSemanticRequestDigest">): Uint8Array {
  validateMutationSet(envelope.claimedMutationSet);
  return domainHash(semanticRequestV2Domain, encodeCanonicalCbor(envelopeWire({
    ...envelope,
    claimedSemanticRequestDigest: new Uint8Array(32)
  }, false)));
}

export function operationIdDiagnosticV2(operationId: OperationIdV2): string {
  return `${operationId.namespace.namespaceId}:${Buffer.from(operationId.clientRandom128).toString("hex")}`;
}

export function validateEnvelopeBindingV2(
  envelope: SemanticMutationEnvelopeV2,
  claims: ActorAxesBindingClaimsV2
): void {
  if (envelope.workspaceId !== claims.workspaceId || envelope.operationId.namespace.workspaceId !== claims.workspaceId) {
    throw new SemanticAdmissionErrorV2("TOKEN_WORKSPACE_MISMATCH");
  }
  if (envelope.operationId.namespace.deviceId !== claims.deviceId
    || envelope.binding.bindingId !== claims.bindingId
    || envelope.binding.deviceId !== claims.deviceId
    || envelope.binding.viewId !== claims.viewId
    || envelope.binding.sessionId !== claims.sessionId) {
    throw new SemanticAdmissionErrorV2("TOKEN_BINDING_MISMATCH");
  }
  if (!bytesEqual(envelope.binding.actorAxesBindingDigest, actorAxesBindingDigestV2(claims))) {
    throw new SemanticAdmissionErrorV2("ACTOR_AXES_BINDING_DIGEST_MISMATCH");
  }
}

export function assertMutationClaimMatchesV2(
  envelope: SemanticMutationEnvelopeV2,
  recomputed: SemanticMutationSetV2
): void {
  const claimedBytes = semanticMutationSetBytesV2(envelope.claimedMutationSet);
  const recomputedBytes = semanticMutationSetBytesV2(recomputed);
  if (!canonicalCborBytesEqual(claimedBytes, recomputedBytes)) {
    throw new SemanticAdmissionErrorV2("SEMANTIC_MUTATION_MISMATCH");
  }
  const recomputedDigest = semanticMutationSetDigestV2(recomputed);
  if (!bytesEqual(envelope.claimedSemanticMutationSetDigest, recomputedDigest)) {
    throw new SemanticAdmissionErrorV2("SEMANTIC_MUTATION_DIGEST_MISMATCH");
  }
  const requestDigest = semanticRequestDigestV2(envelope);
  if (!bytesEqual(envelope.claimedSemanticRequestDigest, requestDigest)) {
    throw new SemanticAdmissionErrorV2("REQUEST_DIGEST_MISMATCH");
  }
}

export function assertStoragePlanMatchesMutationSetV2(
  mutationSet: SemanticMutationSetV2,
  storagePlan: StoragePlan
): void {
  if (storagePlan.registryVersion !== mutationSet.registryVersion) {
    throw new SemanticAdmissionErrorV2("STORAGE_PLAN_REGISTRY_VERSION_MISMATCH");
  }
  const plannedSet: SemanticMutationSetV2 = {
    registryVersion: storagePlan.registryVersion,
    mutations: storagePlan.mutations
  };
  if (!canonicalCborBytesEqual(semanticMutationSetBytesV2(mutationSet), semanticMutationSetBytesV2(plannedSet))) {
    throw new SemanticAdmissionErrorV2("STORAGE_PLAN_MUTATION_SET_MISMATCH");
  }
}

function envelopeWire(envelope: SemanticMutationEnvelopeV2, includeRequestDigest: boolean): CanonicalCborValue {
  const core: Record<string, CanonicalCborValue> = {
    schema: envelope.schema,
    workspaceId: envelope.workspaceId,
    operationId: operationIdWire(envelope.operationId),
    binding: bindingWire(envelope.binding),
    schemaTuple: { ...envelope.schemaTuple },
    intent: intentWire(envelope.intent),
    claimedMutationSet: mutationSetWire(envelope.claimedMutationSet),
    claimedSemanticMutationSetDigest: envelope.claimedSemanticMutationSetDigest
  };
  if (includeRequestDigest) core.claimedSemanticRequestDigest = envelope.claimedSemanticRequestDigest;
  return core;
}

function envelopeFromWire(value: CanonicalCborValue): SemanticMutationEnvelopeV2 {
  const wire = exactRecord(value, [
    "schema", "workspaceId", "operationId", "binding", "schemaTuple", "intent", "claimedMutationSet",
    "claimedSemanticMutationSetDigest", "claimedSemanticRequestDigest"
  ], "SemanticMutationEnvelopeV2");
  if (wire.schema !== semanticMutationEnvelopeV2Schema) throw new SemanticAdmissionErrorV2("ENVELOPE_SCHEMA_UNSUPPORTED");
  return {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: text(wire.workspaceId, "workspaceId"),
    operationId: operationIdFromWire(wire.operationId),
    binding: bindingFromWire(wire.binding),
    schemaTuple: schemaTupleFromEnvelopeWire(wire.schemaTuple),
    intent: intentFromWire(wire.intent),
    claimedMutationSet: mutationSetFromWire(wire.claimedMutationSet),
    claimedSemanticMutationSetDigest: digest(wire.claimedSemanticMutationSetDigest, "claimedSemanticMutationSetDigest"),
    claimedSemanticRequestDigest: digest(wire.claimedSemanticRequestDigest, "claimedSemanticRequestDigest")
  };
}

function operationIdWire(operationId: OperationIdV2): CanonicalCborValue {
  return {
    namespace: { ...operationId.namespace },
    clientRandom128: operationId.clientRandom128
  };
}

function operationIdFromWire(value: CanonicalCborValue): OperationIdV2 {
  const wire = exactRecord(value, ["namespace", "clientRandom128"], "OperationIdV2");
  const namespace = exactRecord(wire.namespace, ["schema", "workspaceId", "deviceId", "authorityGeneration", "namespaceId", "expiresAt", "issuer", "keyId", "proof"], "OperationNamespaceV1");
  if (namespace.schema !== "operation-namespace/v1") throw new SemanticAdmissionErrorV2("OP_NAMESPACE_SCHEMA_UNSUPPORTED");
  return {
    namespace: {
      schema: "operation-namespace/v1",
      workspaceId: text(namespace.workspaceId, "namespace.workspaceId"),
      deviceId: text(namespace.deviceId, "namespace.deviceId"),
      authorityGeneration: uint64(namespace.authorityGeneration, "namespace.authorityGeneration"),
      namespaceId: text(namespace.namespaceId, "namespace.namespaceId"),
      expiresAt: uint64(namespace.expiresAt, "namespace.expiresAt"),
      issuer: text(namespace.issuer, "namespace.issuer"),
      keyId: text(namespace.keyId, "namespace.keyId"),
      proof: bytes(namespace.proof, "namespace.proof")
    },
    clientRandom128: fixedBytes(wire.clientRandom128, 16, "clientRandom128")
  };
}

function bindingWire(binding: OperationBindingV2): CanonicalCborValue {
  return {
    bindingId: binding.bindingId,
    actorAxesBindingDigest: binding.actorAxesBindingDigest,
    deviceId: binding.deviceId,
    viewId: binding.viewId,
    sessionId: binding.sessionId,
    admissionTokenRef: { tokenId: binding.admissionTokenRef.tokenId, tokenDigest: binding.admissionTokenRef.tokenDigest }
  };
}

function bindingFromWire(value: CanonicalCborValue): OperationBindingV2 {
  const wire = exactRecord(value, ["bindingId", "actorAxesBindingDigest", "deviceId", "viewId", "sessionId", "admissionTokenRef"], "OperationBindingV2");
  const token = exactRecord(wire.admissionTokenRef, ["tokenId", "tokenDigest"], "admissionTokenRef");
  return {
    bindingId: text(wire.bindingId, "bindingId"), actorAxesBindingDigest: digest(wire.actorAxesBindingDigest, "actorAxesBindingDigest"),
    deviceId: text(wire.deviceId, "deviceId"), viewId: text(wire.viewId, "viewId"), sessionId: text(wire.sessionId, "sessionId"),
    admissionTokenRef: { tokenId: text(token.tokenId, "tokenId"), tokenDigest: digest(token.tokenDigest, "tokenDigest") }
  };
}

function intentWire(intent: SemanticIntentV2): CanonicalCborValue {
  if (intent.kind === "typed") return {
    kind: intent.kind,
    command: { ...intent.command }, canonicalPayload: contentWire(intent.canonicalPayload), canonicalPayloadDigest: intent.canonicalPayloadDigest,
    baseCas: intent.baseCas.map((entry) => ({ entityRef: entityWire(entry.entityRef), expectedSemanticVersion: entry.expectedSemanticVersion, expectedStateDigest: entry.expectedStateDigest })),
    declaredPathCas: intent.declaredPathCas.map(pathCasWire)
  };
  return {
    kind: intent.kind,
    interpretation: intent.interpretation,
    files: intent.files.map((file) => ({
      path: file.path,
      base: { workspaceEpoch: file.base.workspaceEpoch, revision: file.base.revision, blobDigest: file.base.blobDigest, bytes: contentWire(file.base.bytes) },
      candidate: { blobDigest: file.candidate.blobDigest, bytes: contentWire(file.candidate.bytes) }
    }))
  };
}

function intentFromWire(value: CanonicalCborValue): SemanticIntentV2 {
  const kind = text((value as Record<string, CanonicalCborValue>)?.kind, "intent.kind");
  if (kind === "typed") {
    const wire = exactRecord(value, ["kind", "command", "canonicalPayload", "canonicalPayloadDigest", "baseCas", "declaredPathCas"], "TypedSemanticRequestV2");
    const command = exactRecord(wire.command, ["registryVersion", "name", "version"], "typed.command");
    return {
      kind,
      command: { registryVersion: uint32(command.registryVersion, "command.registryVersion"), name: text(command.name, "command.name"), version: uint32(command.version, "command.version") },
      canonicalPayload: contentFromWire(wire.canonicalPayload), canonicalPayloadDigest: digest(wire.canonicalPayloadDigest, "canonicalPayloadDigest"),
      baseCas: list(wire.baseCas, "baseCas").map((entry) => { const row = exactRecord(entry, ["entityRef", "expectedSemanticVersion", "expectedStateDigest"], "SemanticBaseCasV2"); return { entityRef: entityFromWire(row.entityRef), expectedSemanticVersion: nullableText(row.expectedSemanticVersion, "expectedSemanticVersion"), expectedStateDigest: nullableDigest(row.expectedStateDigest, "expectedStateDigest") }; }),
      declaredPathCas: list(wire.declaredPathCas, "declaredPathCas").map(pathCasFromWire)
    };
  }
  if (kind === "transparent-file") {
    const wire = exactRecord(value, ["kind", "interpretation", "files"], "TransparentFileRequestV2");
    if (wire.interpretation !== "full-semantic" && wire.interpretation !== "host-prose-only") throw new SemanticAdmissionErrorV2("INVALID_TRANSPARENT_INTERPRETATION");
    return {
      kind,
      interpretation: wire.interpretation,
      files: list(wire.files, "files").map((entry) => {
        const file = exactRecord(entry, ["path", "base", "candidate"], "TransparentFileCandidateV2");
        const base = exactRecord(file.base, ["workspaceEpoch", "revision", "blobDigest", "bytes"], "transparent.base");
        const candidate = exactRecord(file.candidate, ["blobDigest", "bytes"], "transparent.candidate");
        return { path: text(file.path, "path"), base: { workspaceEpoch: text(base.workspaceEpoch, "workspaceEpoch"), revision: uint64(base.revision, "revision"), blobDigest: digest(base.blobDigest, "blobDigest"), bytes: contentFromWire(base.bytes) }, candidate: { blobDigest: digest(candidate.blobDigest, "blobDigest"), bytes: contentFromWire(candidate.bytes) } };
      })
    };
  }
  throw new SemanticAdmissionErrorV2("SEMANTIC_INTENT_VARIANT_REQUIRED");
}

function mutationSetWire(set: SemanticMutationSetV2): CanonicalCborValue { return semanticMutationSetWireV2(set); }
function entityWire(entity: RegistryEntityRefV2): CanonicalCborValue { return { registryVersion: entity.registryVersion, entityKind: entity.entityKind, canonicalRef: entity.canonicalRef }; }
function mutationSetFromWire(value: CanonicalCborValue): SemanticMutationSetV2 { const wire = exactRecord(value, ["registryVersion", "mutations"], "SemanticMutationSetV2"); return { registryVersion: uint32(wire.registryVersion, "registryVersion"), mutations: list(wire.mutations, "mutations").map((entry) => { const row = exactRecord(entry, ["entity", "action"], "SemanticMutationV2"); const action = exactRecord(row.action, ["registryVersion", "action"], "RegisteredSemanticActionV2"); return { entity: entityFromWire(row.entity), action: { registryVersion: uint32(action.registryVersion, "action.registryVersion"), action: text(action.action, "action") } }; }) }; }
function entityFromWire(value: CanonicalCborValue): RegistryEntityRefV2 { const row = exactRecord(value, ["registryVersion", "entityKind", "canonicalRef"], "RegistryEntityRefV2"); return { registryVersion: uint32(row.registryVersion, "entity.registryVersion"), entityKind: text(row.entityKind, "entityKind"), canonicalRef: text(row.canonicalRef, "canonicalRef") }; }

function contentWire(value: ContentValueV2): CanonicalCborValue { return value.kind === "inline" ? { kind: value.kind, size: value.size, bytes: value.bytes } : { kind: value.kind, size: value.size, casRef: value.casRef }; }
function contentFromWire(value: CanonicalCborValue): ContentValueV2 { const kind = text((value as Record<string, CanonicalCborValue>)?.kind, "content.kind"); if (kind === "inline") { const row = exactRecord(value, ["kind", "size", "bytes"], "inline content"); return { kind, size: uint64(row.size, "size"), bytes: bytes(row.bytes, "bytes") }; } if (kind === "cas") { const row = exactRecord(value, ["kind", "size", "casRef"], "cas content"); return { kind, size: uint64(row.size, "size"), casRef: text(row.casRef, "casRef") }; } throw new SemanticAdmissionErrorV2("CONTENT_VARIANT_REQUIRED"); }
function pathCasWire(value: PathCasV2): CanonicalCborValue { return { path: value.path, expectedEpoch: value.expectedEpoch, expectedRevision: value.expectedRevision, expectedBlobDigest: value.expectedBlobDigest }; }
function pathCasFromWire(value: CanonicalCborValue): PathCasV2 { const row = exactRecord(value, ["path", "expectedEpoch", "expectedRevision", "expectedBlobDigest"], "PathCasV2"); return { path: text(row.path, "path"), expectedEpoch: text(row.expectedEpoch, "expectedEpoch"), expectedRevision: uint64(row.expectedRevision, "expectedRevision"), expectedBlobDigest: digest(row.expectedBlobDigest, "expectedBlobDigest") }; }

function validateEnvelope(envelope: SemanticMutationEnvelopeV2): void {
  text(envelope.workspaceId, "workspaceId");
  if (envelope.operationId.clientRandom128.length !== 16) throw new SemanticAdmissionErrorV2("OP_ID_RANDOM_LENGTH");
  validateMutationSet(envelope.claimedMutationSet);
  digest(envelope.claimedSemanticMutationSetDigest, "claimedSemanticMutationSetDigest");
  digest(envelope.claimedSemanticRequestDigest, "claimedSemanticRequestDigest");
  if (envelope.intent.kind === "transparent-file" && envelope.intent.files.length === 0) throw new SemanticAdmissionErrorV2("TRANSPARENT_FILES_REQUIRED");
}

function validateMutationSet(set: SemanticMutationSetV2): void {
  try {
    validateSemanticMutationSetV2(set);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_MUTATION_SET";
    throw new SemanticAdmissionErrorV2(code, code);
  }
}

function schemaTupleFromEnvelopeWire(value: CanonicalCborValue): ProtocolSchemaTupleV2 { const keys = ["wire", "event", "receipt", "digest", "policy", "commandRegistry", "entityRegistry", "mutationRegistry", "localState", "applyJournal"] as const; const wire = exactRecord(value, keys, "ProtocolSchemaTupleV2"); return Object.fromEntries(keys.map((key) => [key, uint32(wire[key], key)])) as unknown as ProtocolSchemaTupleV2; }
function exactRecord(value: CanonicalCborValue, keys: ReadonlyArray<string>, name: string): Record<string, CanonicalCborValue> { if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be a map`); const actual = Object.keys(value); if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw new SemanticAdmissionErrorV2("UNKNOWN_OR_MISSING_FIELD", name); return value as Record<string, CanonicalCborValue>; }
function list(value: CanonicalCborValue, name: string): ReadonlyArray<CanonicalCborValue> { if (!Array.isArray(value)) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be array`); return value; }
function text(value: CanonicalCborValue | undefined, name: string): string { if (typeof value !== "string" || !value || value.trim() !== value) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be canonical text`); return value; }
function nullableText(value: CanonicalCborValue, name: string): string | null { return value === null ? null : text(value, name); }
function bytes(value: CanonicalCborValue, name: string): Uint8Array { if (!(value instanceof Uint8Array)) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be bytes`); return value; }
function fixedBytes(value: CanonicalCborValue, length: number, name: string): Uint8Array { const output = bytes(value, name); if (output.length !== length) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} length`); return output; }
function digest(value: CanonicalCborValue, name: string): Uint8Array { return fixedBytes(value, 32, name); }
function nullableDigest(value: CanonicalCborValue, name: string): Uint8Array | null { return value === null ? null : digest(value, name); }
function uint32(value: CanonicalCborValue | number, name: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be uint32`); return value; }
function uint64(value: CanonicalCborValue, name: string): bigint { if (typeof value !== "number" && typeof value !== "bigint") throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be uint64`); const output = BigInt(value); if (output < 0n) throw new SemanticAdmissionErrorV2("INVALID_ENVELOPE", `${name} must be uint64`); return output; }
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }
