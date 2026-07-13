import { isCanonicalEntityKind, type CanonicalEntityKind } from "./canonical-kinds.ts";
import type {
  DeferredRegistryFacet,
  EntityIdentity,
  EntityIdentityCodec,
  EntityRegistration,
  EntityStorageContext,
  EntityStorageLocator,
  LocatedEntityStorage,
  ReadyIdentityCodecFacet,
  ReadyProjectionFacet,
  ReadyStorageLocatorFacet,
  StorageTarget,
  TypedOnlySemanticDiffFacet
} from "./registry-contract.ts";

export interface RegistryEntityRef {
  readonly registryVersion: number;
  readonly entityKind: string;
  readonly canonicalRef: string;
}

export interface RegistrySemanticMutation {
  readonly entity: RegistryEntityRef;
  readonly action: { readonly registryVersion: number; readonly action: string };
}

export interface RegistrySemanticMutationSet {
  readonly registryVersion: number;
  readonly mutations: ReadonlyArray<RegistrySemanticMutation>;
}

export interface StoragePlan {
  readonly schema: "storage-plan/v1";
  readonly registryVersion: number;
  readonly mutations: ReadonlyArray<RegistrySemanticMutation>;
  readonly targets: ReadonlyArray<StorageTarget>;
  readonly touchedPaths: ReadonlyArray<string>;
  readonly consistencyScopes: ReadonlyArray<string>;
}

export interface RegistryMutationIntent {
  readonly entityKind: string;
  readonly identity: EntityIdentity;
  readonly action: string;
  readonly storageContext?: EntityStorageContext;
}

export interface RegistryMutationPlanInput {
  readonly registryVersion: number;
  readonly mutations: ReadonlyArray<RegistryMutationIntent>;
}

export interface RegistryMutationPlanCompilation {
  readonly mutationSet: RegistrySemanticMutationSet;
  readonly storagePlan: StoragePlan;
}

export interface WritableEntityRegistry {
  readonly registrations: ReadonlyMap<CanonicalEntityKind, EntityRegistration<string, CanonicalEntityKind>>;
}

const requiredFacets = ["identityCodec", "storageLocator", "mutationContract", "semanticDiff", "projectionFacet"] as const;
const writableRegistries = new WeakSet<object>();
const registryCompiledStoragePlans = new WeakSet<object>();

export function canonicalIdentityCodec(
  kind: CanonicalEntityKind,
  identityKeys: ReadonlyArray<string>
): ReadyIdentityCodecFacet {
  if (identityKeys.length === 0) throw new Error(`IDENTITY_KEYS_REQUIRED:${kind}`);
  const codec: EntityIdentityCodec = {
    encode: (identity) => `${kind}/${identityKeys.map((key) => encodeSegment(identity[key], key)).join("/")}`,
    decode: (canonicalRef) => {
      const segments = canonicalRef.split("/");
      if (segments.length !== identityKeys.length + 1 || segments[0] !== kind) {
        throw new Error(`INVALID_CANONICAL_ENTITY_REF:${kind}:${canonicalRef}`);
      }
      return Object.fromEntries(identityKeys.map((key, index) => [key, decodeSegment(segments[index + 1]!, key)]));
    }
  };
  return { status: "ready", codec };
}

export function readyStorageLocator(locator: EntityStorageLocator): ReadyStorageLocatorFacet {
  return { status: "ready", locator };
}

export function readyUnionProjectionFacet(
  identityCodec: ReadyIdentityCodecFacet,
  attributionTarget?: ReadyProjectionFacet["attributionTarget"]
): ReadyProjectionFacet {
  return {
    status: "ready",
    project: (entity) => entity,
    resolveCanonicalRef: identityCodec.codec.decode,
    ...(attributionTarget ? { attributionTarget } : {})
  };
}

export function readyIdentityProjectionFacets(
  kind: CanonicalEntityKind,
  identityKeys: ReadonlyArray<string>,
  attributionTarget?: ReadyProjectionFacet["attributionTarget"]
): { readonly identityCodec: ReadyIdentityCodecFacet; readonly projectionFacet: ReadyProjectionFacet } {
  const identityCodec = canonicalIdentityCodec(kind, identityKeys);
  return {
    identityCodec,
    projectionFacet: readyUnionProjectionFacet(identityCodec, attributionTarget)
  };
}

export function deferredRegistryFacet(owner: string, reason: string): DeferredRegistryFacet {
  return { status: "deferred", owner, reason };
}

export function typedOnlySemanticDiff(reason: string): TypedOnlySemanticDiffFacet {
  return { status: "typed-only", reason };
}

export function createWritableEntityRegistry(
  registrations: ReadonlyArray<EntityRegistration<string, CanonicalEntityKind>>
): WritableEntityRegistry {
  const byKind = new Map<CanonicalEntityKind, EntityRegistration<string, CanonicalEntityKind>>();
  for (const registration of registrations) {
    assertWritableRegistration(registration);
    if (byKind.has(registration.kind)) throw new Error(`DUPLICATE_ENTITY_REGISTRATION:${registration.kind}`);
    byKind.set(registration.kind, registration);
  }
  const registry = { registrations: byKind };
  writableRegistries.add(registry);
  return registry;
}

export function assertWritableEntityRegistry(registry: WritableEntityRegistry): void {
  if (!registry || !writableRegistries.has(registry)) throw new Error("WRITABLE_ENTITY_REGISTRY_GATE_REQUIRED");
}

export function assertRegistryCompiledStoragePlan(storagePlan: StoragePlan): void {
  if (!storagePlan || !registryCompiledStoragePlans.has(storagePlan)) {
    throw new Error("REGISTRY_COMPILED_STORAGE_PLAN_REQUIRED");
  }
}

export function compileRegistryMutationPlan(
  registry: WritableEntityRegistry,
  input: RegistryMutationPlanInput
): RegistryMutationPlanCompilation {
  assertWritableEntityRegistry(registry);
  if (!Number.isInteger(input.registryVersion) || input.registryVersion < 0 || input.registryVersion > 0xffff_ffff) {
    throw new Error(`INVALID_REGISTRY_VERSION:${input.registryVersion}`);
  }
  const compiled = input.mutations.map((intent) => compileIntent(registry, input.registryVersion, intent));
  compiled.sort((left, right) => mutationKey(left.mutation).localeCompare(mutationKey(right.mutation), "en"));
  const seenMutations = new Set<string>();
  for (const entry of compiled) {
    const key = mutationKey(entry.mutation);
    if (seenMutations.has(key)) throw new Error(`DUPLICATE_SEMANTIC_MUTATION:${key}`);
    seenMutations.add(key);
  }
  const mutations = compiled.map((entry) => entry.mutation);
  const targets = uniqueSorted(compiled.flatMap((entry) => entry.storage.targets), storageTargetKey);
  const touchedPaths = targets.flatMap((target) => target.path ? [target.path] : []);
  const consistencyScopes = [...new Set(compiled.map((entry) => entry.storage.consistencyScope))].sort();
  const mutationSet: RegistrySemanticMutationSet = { registryVersion: input.registryVersion, mutations };
  const storagePlan: StoragePlan = {
    schema: "storage-plan/v1",
    registryVersion: input.registryVersion,
    mutations,
    targets,
    touchedPaths,
    consistencyScopes
  };
  registryCompiledStoragePlans.add(storagePlan);
  return {
    mutationSet,
    storagePlan
  };
}

function assertWritableRegistration(registration: EntityRegistration<string, CanonicalEntityKind>): void {
  if (!registration || typeof registration !== "object") throw new Error("ENTITY_REGISTRATION_REQUIRED");
  if (!isCanonicalEntityKind(registration.kind)) throw new Error(`UNKNOWN_ENTITY_KIND:${String(registration.kind)}`);
  const candidate = registration as unknown as Record<string, unknown>;
  for (const facet of requiredFacets) {
    if (!Object.hasOwn(candidate, facet) || candidate[facet] === undefined) {
      throw new Error(`REGISTRY_FACET_MISSING:${facet}`);
    }
  }
  for (const facet of ["identityCodec", "storageLocator", "mutationContract", "projectionFacet"] as const) {
    if ((candidate[facet] as { readonly status?: unknown }).status !== "ready") {
      throw new Error(`REGISTRY_FACET_NOT_WRITABLE:${registration.kind}:${facet}`);
    }
  }
  const semanticStatus = (candidate.semanticDiff as { readonly status?: unknown }).status;
  if (semanticStatus !== "ready" && semanticStatus !== "typed-only") {
    throw new Error(`REGISTRY_FACET_NOT_WRITABLE:${registration.kind}:semanticDiff`);
  }
  if (registration.mutationContract.status !== "ready" || registration.mutationContract.actions.length === 0) {
    throw new Error(`REGISTRY_ACTIONS_REQUIRED:${registration.kind}`);
  }
  if (new Set(registration.mutationContract.actions).size !== registration.mutationContract.actions.length) {
    throw new Error(`REGISTRY_ACTIONS_DUPLICATE:${registration.kind}`);
  }
  if (registration.projectionFacet.status !== "ready"
      || typeof registration.projectionFacet.resolveCanonicalRef !== "function") {
    throw new Error(`REGISTRY_PROJECTION_RESOLVER_REQUIRED:${registration.kind}`);
  }
}

function compileIntent(
  registry: WritableEntityRegistry,
  registryVersion: number,
  intent: RegistryMutationIntent
): { readonly mutation: RegistrySemanticMutation; readonly storage: LocatedEntityStorage } {
  if (!isCanonicalEntityKind(intent.entityKind)) throw new Error(`UNKNOWN_ENTITY_KIND:${intent.entityKind}`);
  const registration = registry.registrations.get(intent.entityKind);
  if (!registration) throw new Error(`ENTITY_KIND_NOT_WRITABLE:${intent.entityKind}`);
  if (registration.identityCodec.status !== "ready" || registration.storageLocator.status !== "ready") {
    throw new Error(`REGISTRY_INTERNAL_INCOMPLETE:${intent.entityKind}`);
  }
  if (registration.mutationContract.status !== "ready"
    || !registration.mutationContract.actions.includes(intent.action)) {
    throw new Error(`UNKNOWN_SEMANTIC_ACTION:${intent.entityKind}:${intent.action}`);
  }
  const canonicalRef = registration.identityCodec.codec.encode(intent.identity);
  const decodedIdentity = registration.identityCodec.codec.decode(canonicalRef);
  const storage = registration.storageLocator.locator.locate(decodedIdentity, intent.storageContext ?? {});
  return {
    mutation: {
      entity: { registryVersion, entityKind: intent.entityKind, canonicalRef },
      action: { registryVersion, action: intent.action }
    },
    storage
  };
}

function encodeSegment(value: string | undefined, key: string): string {
  if (!value) throw new Error(`ENTITY_IDENTITY_MISSING:${key}`);
  const encoded = encodeURIComponent(value);
  if (!encoded || encoded.includes("%00")) throw new Error(`ENTITY_IDENTITY_INVALID:${key}`);
  return encoded;
}

function decodeSegment(value: string, key: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || encodeURIComponent(decoded) !== value) throw new Error("non-canonical");
    return decoded;
  } catch {
    throw new Error(`ENTITY_IDENTITY_INVALID:${key}`);
  }
}

function mutationKey(mutation: RegistrySemanticMutation): string {
  return `${mutation.entity.canonicalRef}\0${mutation.action.action}`;
}

function storageTargetKey(target: StorageTarget): string {
  return `${target.kind}\0${target.path ?? ""}\0${target.access}\0${target.referenceField ?? ""}`;
}

function uniqueSorted<T>(values: ReadonlyArray<T>, keyOf: (value: T) => string): ReadonlyArray<T> {
  const byKey = new Map(values.map((value) => [keyOf(value), value]));
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right, "en")).map(([, value]) => value);
}
