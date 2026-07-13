import { Schema } from "effect";
import { isCanonicalEntityKind } from "../entity/canonical-kinds.ts";
import { entityRegistry, entityRegistryVersion } from "../entity/registry.ts";
import {
  actorAxesBindingCoreDigestV2,
  type ActorAxesBindingCoreV2
} from "../integrity/actor-axes-binding-integrity-v2.ts";
import {
  encodeCanonicalCbor,
  type CanonicalCborValue,
  domainHash
} from "../integrity/canonical-cbor.ts";
import {
  semanticMutationSetDigestV2,
  semanticMutationSetWireV2,
  validateSemanticMutationSetV2,
  type SemanticMutationSetV2
} from "../integrity/semantic-mutation-integrity-v2.ts";
import { AttributionEventSchema, type AttributionEvent } from "./attribution-event.ts";

export const attributionEventV2Schema = "attribution-event/v2" as const;
export const attributionEventV2Domain = "ha/attribution-event/v2\0";
export const physicalChangeSetV2Domain = "ha/physical-change-set/v2\0";

export type AttributionEventCompleteness = "host-only" | "legacy-partial" | "complete";

export interface PhysicalChangeV2 {
  readonly path: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}

export interface AttributionEventV2 {
  readonly schema: typeof attributionEventV2Schema;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly opId: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly outcome: "COMMITTED";
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actorAxesBinding: ActorAxesBindingCoreV2;
  readonly semanticRequestDigest: string;
  readonly mutationSet: SemanticMutationSetV2;
  readonly semanticMutationSetDigest: string;
  readonly actorAxesBindingDigest: string;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly changeSetDigest: string;
  readonly canonicalEventDigest: string;
}

export type UnionAttributionEvent = AttributionEvent | AttributionEventV2;

export function decodeUnionAttributionEvent(value: unknown): UnionAttributionEvent {
  const row = object(value, "attribution event");
  if (row.schema === "attribution-event/v1") return decodeStrictAttributionEventV1(row);
  if (row.schema === attributionEventV2Schema) return decodeAndVerifyAttributionEventV2(row);
  throw new Error(`ATTRIBUTION_EVENT_SCHEMA_UNSUPPORTED:${String(row.schema)}`);
}

export function decodeStrictAttributionEventV1(value: unknown): AttributionEvent {
  const row = object(value, "attribution-event/v1");
  exactKeys(row, [
    "schema", "eventId", "opId", "journalRecordSchema", "entityId", "kind", "actor",
    "principalSource", "executorSource", "at", "recordedAt", "payloadHash", "payloadRef"
  ], ["authorityIntegrity"], "attribution-event/v1");
  assertStrictLegacyActor(row.actor);
  exactKeys(object(row.payloadRef, "payloadRef"), ["path", "sha256"], [], "payloadRef");
  assertStrictPrincipalSource(row.principalSource);
  if (row.authorityIntegrity !== undefined) assertStrictAuthorityIntegrity(row.authorityIntegrity);
  return Schema.decodeUnknownSync(AttributionEventSchema)(row);
}

export function decodeAndVerifyAttributionEventV2(value: unknown): AttributionEventV2 {
  const row = object(value, attributionEventV2Schema);
  exactKeys(row, [
    "schema", "eventId", "workspaceId", "opId", "revision", "commitSha", "previousCommit", "outcome",
    "occurredAt", "recordedAt", "actorAxesBinding", "semanticRequestDigest", "mutationSet",
    "semanticMutationSetDigest", "actorAxesBindingDigest", "physicalChanges", "changeSetDigest",
    "canonicalEventDigest"
  ], [], attributionEventV2Schema);
  if (row.schema !== attributionEventV2Schema || row.outcome !== "COMMITTED") throw new Error("ATTRIBUTION_EVENT_V2_OUTCOME_INVALID");
  const event: AttributionEventV2 = {
    schema: attributionEventV2Schema,
    eventId: text(row.eventId, "eventId"),
    workspaceId: text(row.workspaceId, "workspaceId"),
    opId: text(row.opId, "opId"),
    revision: eventUint32(row.revision, "revision"),
    commitSha: text(row.commitSha, "commitSha"),
    previousCommit: nullableText(row.previousCommit, "previousCommit"),
    outcome: "COMMITTED",
    occurredAt: text(row.occurredAt, "occurredAt"),
    recordedAt: text(row.recordedAt, "recordedAt"),
    actorAxesBinding: decodeActorAxesBindingCore(row.actorAxesBinding),
    semanticRequestDigest: digest(row.semanticRequestDigest, "semanticRequestDigest"),
    mutationSet: decodeMutationSet(row.mutationSet),
    semanticMutationSetDigest: digest(row.semanticMutationSetDigest, "semanticMutationSetDigest"),
    actorAxesBindingDigest: digest(row.actorAxesBindingDigest, "actorAxesBindingDigest"),
    physicalChanges: list(row.physicalChanges, "physicalChanges").map(decodePhysicalChange),
    changeSetDigest: digest(row.changeSetDigest, "changeSetDigest"),
    canonicalEventDigest: digest(row.canonicalEventDigest, "canonicalEventDigest")
  };
  verifyAttributionEventV2(event);
  return event;
}

export function attributionEventCompleteness(event: UnionAttributionEvent): AttributionEventCompleteness {
  if (event.schema === attributionEventV2Schema) return "complete";
  return event.authorityIntegrity ? "legacy-partial" : "host-only";
}

export function verifyAttributionEventV2(event: AttributionEventV2): void {
  if (event.actorAxesBinding.workspaceId !== event.workspaceId) throw new Error("ATTRIBUTION_EVENT_ACTOR_WORKSPACE_MISMATCH");
  if (event.actorAxesBinding.schemaTuple.event !== 2) throw new Error("ATTRIBUTION_EVENT_SCHEMA_TUPLE_MISMATCH");
  if (event.mutationSet.registryVersion !== entityRegistryVersion
      || event.actorAxesBinding.schemaTuple.entityRegistry !== entityRegistryVersion
      || event.actorAxesBinding.schemaTuple.mutationRegistry !== entityRegistryVersion) {
    throw new Error(`ATTRIBUTION_EVENT_REGISTRY_VERSION_UNSUPPORTED:${event.mutationSet.registryVersion}`);
  }
  validateSemanticMutationSetV2(event.mutationSet);
  for (const mutation of event.mutationSet.mutations) {
    if (!isCanonicalEntityKind(mutation.entity.entityKind)) throw new Error(`UNKNOWN_ENTITY_KIND:${mutation.entity.entityKind}`);
    const registration = entityRegistry[mutation.entity.entityKind];
    if (registration.projectionFacet.status !== "ready") throw new Error(`PROJECTION_FACET_NOT_READY:${mutation.entity.entityKind}`);
    registration.projectionFacet.resolveCanonicalRef(mutation.entity.canonicalRef);
  }
  assertDigest(event.semanticMutationSetDigest, semanticMutationSetDigestV2(event.mutationSet), "SEMANTIC_MUTATION_SET_DIGEST_MISMATCH");
  assertDigest(event.actorAxesBindingDigest, actorAxesBindingCoreDigestV2(event.actorAxesBinding), "ACTOR_AXES_BINDING_DIGEST_MISMATCH");
  assertDigest(event.changeSetDigest, physicalChangeSetDigestV2(event.physicalChanges), "PHYSICAL_CHANGE_SET_DIGEST_MISMATCH");
  assertDigest(event.canonicalEventDigest, canonicalAttributionEventDigestV2(event), "CANONICAL_EVENT_DIGEST_MISMATCH");
}

export function physicalChangeSetDigestV2(changes: ReadonlyArray<PhysicalChangeV2>): Uint8Array {
  validatePhysicalChanges(changes);
  return domainHash(physicalChangeSetV2Domain, encodeCanonicalCbor({
    changes: changes.map((change) => ({
      path: change.path,
      beforeDigest: change.beforeDigest === null ? null : hexBytes(change.beforeDigest),
      afterDigest: change.afterDigest === null ? null : hexBytes(change.afterDigest)
    }))
  }));
}

export function canonicalAttributionEventDigestV2(event: Omit<AttributionEventV2, "canonicalEventDigest"> | AttributionEventV2): Uint8Array {
  return domainHash(attributionEventV2Domain, encodeCanonicalCbor(attributionEventCoreWire(event)));
}

function attributionEventCoreWire(event: Omit<AttributionEventV2, "canonicalEventDigest"> | AttributionEventV2): CanonicalCborValue {
  return {
    schema: event.schema,
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    opId: event.opId,
    revision: event.revision,
    commitSha: event.commitSha,
    previousCommit: event.previousCommit,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    actorAxesBinding: {
      bindingId: event.actorAxesBinding.bindingId,
      principalPersonId: event.actorAxesBinding.principalPersonId,
      executorAgentId: event.actorAxesBinding.executorAgentId,
      workspaceId: event.actorAxesBinding.workspaceId,
      deviceId: event.actorAxesBinding.deviceId,
      viewId: event.actorAxesBinding.viewId,
      sessionId: event.actorAxesBinding.sessionId,
      schemaTuple: { ...event.actorAxesBinding.schemaTuple }
    },
    semanticRequestDigest: hexBytes(event.semanticRequestDigest),
    mutationSet: semanticMutationSetWireV2(event.mutationSet),
    semanticMutationSetDigest: hexBytes(event.semanticMutationSetDigest),
    actorAxesBindingDigest: hexBytes(event.actorAxesBindingDigest),
    physicalChanges: event.physicalChanges.map((change) => ({
      path: change.path,
      beforeDigest: change.beforeDigest === null ? null : hexBytes(change.beforeDigest),
      afterDigest: change.afterDigest === null ? null : hexBytes(change.afterDigest)
    })),
    changeSetDigest: hexBytes(event.changeSetDigest)
  };
}

function decodeActorAxesBindingCore(value: unknown): ActorAxesBindingCoreV2 {
  const row = object(value, "actorAxesBinding");
  exactKeys(row, [
    "bindingId", "principalPersonId", "executorAgentId", "workspaceId", "deviceId", "viewId", "sessionId", "schemaTuple"
  ], [], "actorAxesBinding");
  const tuple = object(row.schemaTuple, "schemaTuple");
  const tupleKeys = [
    "wire", "event", "receipt", "digest", "policy", "commandRegistry", "entityRegistry",
    "mutationRegistry", "localState", "applyJournal"
  ] as const;
  exactKeys(tuple, tupleKeys, [], "schemaTuple");
  return {
    bindingId: text(row.bindingId, "bindingId"),
    principalPersonId: text(row.principalPersonId, "principalPersonId"),
    executorAgentId: nullableText(row.executorAgentId, "executorAgentId"),
    workspaceId: text(row.workspaceId, "workspaceId"),
    deviceId: text(row.deviceId, "deviceId"),
    viewId: text(row.viewId, "viewId"),
    sessionId: text(row.sessionId, "sessionId"),
    schemaTuple: Object.fromEntries(tupleKeys.map((key) => [key, eventUint32(tuple[key], `schemaTuple.${key}`)])) as unknown as ActorAxesBindingCoreV2["schemaTuple"]
  };
}

function decodeMutationSet(value: unknown): SemanticMutationSetV2 {
  const row = object(value, "mutationSet");
  exactKeys(row, ["registryVersion", "mutations"], [], "mutationSet");
  const registryVersion = eventUint32(row.registryVersion, "mutationSet.registryVersion");
  const mutations = list(row.mutations, "mutations").map((entry) => {
    const mutation = object(entry, "mutation");
    exactKeys(mutation, ["entity", "action"], [], "mutation");
    const entity = object(mutation.entity, "mutation.entity");
    const action = object(mutation.action, "mutation.action");
    exactKeys(entity, ["registryVersion", "entityKind", "canonicalRef"], [], "mutation.entity");
    exactKeys(action, ["registryVersion", "action"], [], "mutation.action");
    return {
      entity: {
        registryVersion: eventUint32(entity.registryVersion, "entity.registryVersion"),
        entityKind: text(entity.entityKind, "entityKind"),
        canonicalRef: text(entity.canonicalRef, "canonicalRef")
      },
      action: {
        registryVersion: eventUint32(action.registryVersion, "action.registryVersion"),
        action: text(action.action, "action")
      }
    };
  });
  const set = { registryVersion, mutations };
  validateSemanticMutationSetV2(set);
  return set;
}

function decodePhysicalChange(value: unknown): PhysicalChangeV2 {
  const row = object(value, "physicalChange");
  exactKeys(row, ["path", "beforeDigest", "afterDigest"], [], "physicalChange");
  return {
    path: text(row.path, "physicalChange.path"),
    beforeDigest: nullableDigest(row.beforeDigest, "beforeDigest"),
    afterDigest: nullableDigest(row.afterDigest, "afterDigest")
  };
}

function validatePhysicalChanges(changes: ReadonlyArray<PhysicalChangeV2>): void {
  let previous: Uint8Array | undefined;
  for (const change of changes) {
    if (!isPortablePath(change.path)) throw new Error(`PHYSICAL_CHANGE_PATH_INVALID:${change.path}`);
    if (change.beforeDigest === null && change.afterDigest === null) throw new Error(`PHYSICAL_CHANGE_EMPTY:${change.path}`);
    if (change.beforeDigest !== null) digest(change.beforeDigest, "beforeDigest");
    if (change.afterDigest !== null) digest(change.afterDigest, "afterDigest");
    const encoded = encodeCanonicalCbor({
      path: change.path,
      beforeDigest: change.beforeDigest === null ? null : hexBytes(change.beforeDigest),
      afterDigest: change.afterDigest === null ? null : hexBytes(change.afterDigest)
    });
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(encoded)) >= 0) {
      throw new Error("PHYSICAL_CHANGES_NOT_CANONICAL_SET");
    }
    previous = encoded;
  }
}

function assertStrictLegacyActor(value: unknown): void {
  const actor = object(value, "actor");
  exactKeys(actor, ["principal", "executor"], [], "actor");
  exactKeys(object(actor.principal, "actor.principal"), ["kind", "personId"], [], "actor.principal");
  if (actor.executor !== null) exactKeys(object(actor.executor, "actor.executor"), ["kind", "id"], [], "actor.executor");
}

function assertStrictPrincipalSource(value: unknown): void {
  const source = object(value, "principalSource");
  if (source.kind === "daemon-authenticated") exactKeys(source, ["kind", "providerId", "credentialFingerprint"], [], "principalSource");
  else if (source.kind === "local-configured") exactKeys(source, ["kind", "authority", "authoritySha256"], [], "principalSource");
  else if (source.kind === "migration") exactKeys(source, ["kind", "evidenceRef"], [], "principalSource");
  else throw new Error(`PRINCIPAL_SOURCE_UNSUPPORTED:${String(source.kind)}`);
}

function assertStrictAuthorityIntegrity(value: unknown): void {
  const integrity = object(value, "authorityIntegrity");
  exactKeys(integrity, [
    "schema", "semanticRequestDigest", "semanticMutationSetDigest", "mutationRegistryVersion",
    "actorAxesBindingDigest", "canonicalMutationSet"
  ], [], "authorityIntegrity");
  decodeMutationSet(integrity.canonicalMutationSet);
}

function exactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  name: string
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, name: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) throw new Error(`${name} must be canonical text`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

function eventUint32(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name} must be uint32`);
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} must be lowercase sha256 hex`);
  return value;
}

function nullableDigest(value: unknown, name: string): string | null {
  return value === null ? null : digest(value, name);
}

function hexBytes(value: string): Uint8Array {
  return Buffer.from(digest(value, "digest"), "hex");
}

function assertDigest(actual: string, expected: Uint8Array, code: string): void {
  if (!Buffer.from(actual, "hex").equals(Buffer.from(expected))) throw new Error(code);
}

function isPortablePath(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && /^[\x21-\x7e]+$/u.test(value)
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
