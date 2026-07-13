import {
  encodeCanonicalCbor,
  type CanonicalCborValue,
  domainHash
} from "./canonical-cbor.ts";

export const semanticMutationSetV2Domain = "ha/semantic-mutation-set/v2\0";

export interface RegistryEntityRefV2 {
  readonly registryVersion: number;
  readonly entityKind: string;
  readonly canonicalRef: string;
}

export interface RegisteredSemanticActionV2 {
  readonly registryVersion: number;
  readonly action: string;
}

export interface SemanticMutationV2 {
  readonly entity: RegistryEntityRefV2;
  readonly action: RegisteredSemanticActionV2;
}

export interface SemanticMutationSetV2 {
  readonly registryVersion: number;
  readonly mutations: ReadonlyArray<SemanticMutationV2>;
}

export function semanticMutationSetBytesV2(set: SemanticMutationSetV2): Uint8Array {
  validateSemanticMutationSetV2(set);
  return encodeCanonicalCbor(semanticMutationSetWireV2(set));
}

export function semanticMutationSetDigestV2(set: SemanticMutationSetV2): Uint8Array {
  return domainHash(semanticMutationSetV2Domain, semanticMutationSetBytesV2(set));
}

export function validateSemanticMutationSetV2(set: SemanticMutationSetV2): void {
  uint32(set.registryVersion, "registryVersion");
  let previous: Uint8Array | undefined;
  for (const mutation of set.mutations) {
    if (mutation.entity.registryVersion !== set.registryVersion || mutation.action.registryVersion !== set.registryVersion) {
      throw new Error("MUTATION_REGISTRY_VERSION_MISMATCH");
    }
    canonicalText(mutation.entity.entityKind, "entityKind");
    canonicalText(mutation.entity.canonicalRef, "canonicalRef");
    canonicalText(mutation.action.action, "action");
    const encoded = encodeCanonicalCbor(semanticMutationWireV2(mutation));
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(encoded)) >= 0) {
      throw new Error("MUTATIONS_NOT_CANONICAL_SET");
    }
    previous = encoded;
  }
}

export function semanticMutationSetWireV2(set: SemanticMutationSetV2): CanonicalCborValue {
  return {
    registryVersion: set.registryVersion,
    mutations: set.mutations.map(semanticMutationWireV2)
  };
}

export function semanticMutationWireV2(mutation: SemanticMutationV2): CanonicalCborValue {
  return {
    entity: {
      registryVersion: mutation.entity.registryVersion,
      entityKind: mutation.entity.entityKind,
      canonicalRef: mutation.entity.canonicalRef
    },
    action: {
      registryVersion: mutation.action.registryVersion,
      action: mutation.action.action
    }
  };
}

function canonicalText(value: string, name: string): void {
  if (!value || value.trim() !== value) throw new Error(`${name} must be canonical text`);
}

function uint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name} must be uint32`);
}
