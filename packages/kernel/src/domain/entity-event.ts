import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import {
  artifactEntityContractFromSnapshot,
  artifactImportOperationId,
  isArtifactMutationOperationId,
  artifactObservationId,
  canonicalArtifactLocator,
  canonicalArtifactSourceIdentity,
  decodeArtifactDescriptor,
  deriveArtifactEntityId,
  type ArtifactDescriptor,
  type ArtifactEntityContractSnapshot,
  type ArtifactLocator,
} from "./artifact-entity.ts";
import { parseEntityJsonSchema, serializeEntityJsonSchema } from "./entity-json-schema.ts";
import {
  ENTITY_DOCUMENT_POLICY_ID,
  entityDocumentPath,
  requireEntityStoreKindContract,
  type EntityStoreKindContract,
} from "./entity-kind-registry.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

export interface EntityDeclarationClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/json";
  readonly policyId: typeof ENTITY_DOCUMENT_POLICY_ID;
}

interface EntityUpsertPayload {
  readonly entityKind: string;
  readonly entityId: string;
  readonly declarationDocumentClaim: EntityDeclarationClaim;
}

export interface ArtifactContentObservedPayload extends EntityUpsertPayload {
  readonly locator: ArtifactLocator;
  readonly sourceIdentity: string;
  readonly observedContentVersion: string;
  readonly resolver: string;
  readonly observationId: string;
  readonly artifactContract: ArtifactEntityContractSnapshot;
}

export interface ArtifactTargetMissingPayload {
  readonly entityKind: string;
  readonly entityId: string;
  readonly locator: ArtifactLocator;
  readonly sourceIdentity: string;
  readonly resolver: string;
  readonly observationId: string;
  readonly reason: string;
  readonly artifactContract: ArtifactEntityContractSnapshot;
}

export interface ArtifactEntityArchivedPayload {
  readonly entityKind: string;
  readonly entityId: string;
  readonly reason: string;
  readonly artifactContract: ArtifactEntityContractSnapshot;
}

export type EntityUpsertEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_upserted",
  ActorIdentity,
  EntityUpsertPayload
>;
export type EntityContentObservedEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_content_observed",
  ActorIdentity,
  ArtifactContentObservedPayload
>;
export type EntityTargetMissingEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_target_missing",
  ActorIdentity,
  ArtifactTargetMissingPayload
>;
export type EntityUpdatedEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_updated",
  ActorIdentity,
  ArtifactContentObservedPayload
>;
export type EntityArchivedEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_archived",
  ActorIdentity,
  ArtifactEntityArchivedPayload
>;
export type EntityEventV1 =
  | EntityUpsertEventV1
  | EntityContentObservedEventV1
  | EntityTargetMissingEventV1
  | EntityUpdatedEventV1
  | EntityArchivedEventV1;

// Append-only history predating the generic store carries the upsert payload under this retired envelope.
export type LegacyAgentEntityEventV1 = EventEnvelope<
  "agent-entity-event/v1",
  "agent_entity_written",
  ActorIdentity,
  EntityUpsertPayload
>;
export type StoredEntityEventV1 = EntityEventV1 | LegacyAgentEntityEventV1;
export type EntityDeclarationEventV1 =
  | EntityUpsertEventV1
  | EntityContentObservedEventV1
  | EntityUpdatedEventV1
  | LegacyAgentEntityEventV1;

const entityEventEnvelopes: ReadonlyArray<readonly [schema: string, type: string]> = [
  ["entity-event/v1", "entity_upserted"],
  ["entity-event/v1", "entity_content_observed"],
  ["entity-event/v1", "entity_target_missing"],
  ["entity-event/v1", "entity_updated"],
  ["entity-event/v1", "entity_archived"],
  ["agent-entity-event/v1", "agent_entity_written"],
];
const LEGACY_AGENT_ENTITY_POLICY_ID = "typed-agent-entity/v1";

interface EntityDeclarationBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/json";
  readonly body: string;
}

export interface EntityUpsertBundle {
  readonly event: EntityUpsertEventV1;
  readonly plan: FrozenWritePlan<"EntityUpsert">;
  readonly blobs: readonly [EntityDeclarationBlob];
}

export interface EntityContentObservedBundle {
  readonly event: EntityContentObservedEventV1;
  readonly plan: FrozenWritePlan<"EntityContentObserved">;
  readonly blobs: readonly [EntityDeclarationBlob];
}

export interface EntityTargetMissingBundle {
  readonly event: EntityTargetMissingEventV1;
  readonly plan: FrozenWritePlan<"EntityTargetMissing">;
  readonly blobs: readonly [];
}

export interface EntityUpdatedBundle {
  readonly event: EntityUpdatedEventV1;
  readonly plan: FrozenWritePlan<"EntityUpdated">;
  readonly blobs: readonly [EntityDeclarationBlob];
}

export interface EntityArchivedBundle {
  readonly event: EntityArchivedEventV1;
  readonly plan: FrozenWritePlan<"EntityArchived">;
  readonly blobs: readonly [];
}

interface EntityEventEnvelopeInput {
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}

export function compileEntityUpsert(
  input: EntityEventEnvelopeInput & {
    readonly entityKind: string;
    readonly entity: unknown;
  },
): EntityUpsertBundle {
  const contract = requireEntityStoreKindContract(input.entityKind),
    entity = parseEntityJsonSchema(contract.schema, input.entity, `${input.entityKind} declaration`),
    entityId = isRecord(entity) ? entity[contract.id.field] : undefined;
  const contractErrors = contract.entityStore.validate?.(entity) ?? [];
  if (contractErrors.length) throw new Error(contractErrors.join("; "));
  if (typeof entityId !== "string") throw new Error(`${input.entityKind} declaration has no string identity`);
  const { body, claim } = declarationContent(contract, entityId, entity),
    event: EntityUpsertEventV1 = {
      ...eventEnvelope(input),
      type: "entity_upserted",
      payload: { entityKind: contract.kind, entityId, declarationDocumentClaim: claim },
    };
  assertValidCurrent(event);
  return { event, plan: entityUpsertWritePlan(event), blobs: [blob(claim, body)] };
}

export function compileEntityContentObserved(
  input: EntityEventEnvelopeInput & {
    readonly contract: EntityStoreKindContract;
    readonly contractSnapshot: ArtifactEntityContractSnapshot;
    readonly descriptor: ArtifactDescriptor;
    readonly resolver: string;
    readonly observationId: string;
  },
): EntityContentObservedBundle {
  const descriptor = decodeArtifactDescriptor(input.contract, input.descriptor),
    { body, claim } = declarationContent(input.contract, descriptor.entityId, descriptor),
    event: EntityContentObservedEventV1 = {
      ...eventEnvelope(input),
      type: "entity_content_observed",
      payload: {
        entityKind: input.contract.kind,
        entityId: descriptor.entityId,
        declarationDocumentClaim: claim,
        locator: descriptor.locator,
        sourceIdentity: descriptor.source,
        observedContentVersion: descriptor.contentVersion,
        resolver: input.resolver,
        observationId: input.observationId,
        artifactContract: input.contractSnapshot,
      },
    };
  assertValidCurrent(event);
  return { event, plan: entityContentObservedWritePlan(event), blobs: [blob(claim, body)] };
}

export function compileEntityTargetMissing(
  input: EntityEventEnvelopeInput & {
    readonly contractSnapshot: ArtifactEntityContractSnapshot;
    readonly entityId: string;
    readonly locator: ArtifactLocator;
    readonly sourceIdentity: string;
    readonly resolver: string;
    readonly observationId: string;
    readonly reason: string;
  },
): EntityTargetMissingBundle {
  const event: EntityTargetMissingEventV1 = {
    ...eventEnvelope(input),
    type: "entity_target_missing",
    payload: {
      entityKind: input.contractSnapshot.typeIdentity,
      entityId: input.entityId,
      locator: canonicalArtifactLocator(input.locator),
      sourceIdentity: input.sourceIdentity,
      resolver: input.resolver,
      observationId: input.observationId,
      reason: input.reason,
      artifactContract: input.contractSnapshot,
    },
  };
  assertValidCurrent(event);
  return { event, plan: entityTargetMissingWritePlan(event), blobs: [] };
}

export function compileEntityUpdated(
  input: EntityEventEnvelopeInput & {
    readonly contract: EntityStoreKindContract;
    readonly contractSnapshot: ArtifactEntityContractSnapshot;
    readonly descriptor: ArtifactDescriptor;
  },
): EntityUpdatedBundle {
  const descriptor = decodeArtifactDescriptor(input.contract, input.descriptor),
    { body, claim } = declarationContent(input.contract, descriptor.entityId, descriptor),
    observationId = artifactObservationId({
      entityId: descriptor.entityId,
      locator: descriptor.locator,
      resolution: descriptor.contentVersion,
    }),
    event: EntityUpdatedEventV1 = {
      ...eventEnvelope(input),
      type: "entity_updated",
      payload: {
        entityKind: input.contract.kind,
        entityId: descriptor.entityId,
        declarationDocumentClaim: claim,
        locator: descriptor.locator,
        sourceIdentity: descriptor.source,
        observedContentVersion: descriptor.contentVersion,
        resolver: "descriptor-update",
        observationId,
        artifactContract: input.contractSnapshot,
      },
    };
  assertValidCurrent(event);
  return { event, plan: declarationWritePlan("EntityUpdated", event, "entity/v1"), blobs: [blob(claim, body)] };
}

export function compileEntityArchived(
  input: EntityEventEnvelopeInput & {
    readonly contractSnapshot: ArtifactEntityContractSnapshot;
    readonly entityId: string;
    readonly reason: string;
  },
): EntityArchivedBundle {
  const event: EntityArchivedEventV1 = {
    ...eventEnvelope(input),
    type: "entity_archived",
    payload: {
      entityKind: input.contractSnapshot.typeIdentity,
      entityId: input.entityId,
      reason: input.reason.trim(),
      artifactContract: input.contractSnapshot,
    },
  };
  assertValidCurrent(event);
  return { event, plan: entityArchivedWritePlan(event), blobs: [] };
}

export function validateEntityEvent(value: unknown): readonly string[] {
  return validateEntityEventFields(value, true);
}

export function validateCurrentEntityEvent(value: unknown): readonly string[] {
  return validateEntityEventFields(value, false);
}

function validateEntityEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields,
    envelopeFields = [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ];
  if (
    !isRecord(value) ||
    !hasFields(value, envelopeFields) ||
    (!allowUnknownFields && value.schema !== "entity-event/v1") ||
    !isEntityEventEnvelope(value.schema, value.type) ||
    !isRecord(value.payload)
  )
    return ["entity event envelope or payload is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length) return ["entity event identity is invalid"];
  if (value.type === "entity_content_observed")
    return validateObservedPayload(value.payload, hasFields, String(value.opId), allowUnknownFields);
  if (value.type === "entity_updated") {
    const updatedEntityId = String(value.payload.entityId);
    return validateObservedPayload(value.payload, hasFields, String(value.opId), allowUnknownFields, (opId) =>
      isArtifactMutationOperationId("update", updatedEntityId, opId),
    );
  }
  if (value.type === "entity_archived") {
    const payload = value.payload;
    try {
      artifactEntityContractFromSnapshot(payload.artifactContract, allowUnknownFields);
    } catch {
      return ["entity archive artifact contract is invalid"];
    }
    return typeof payload.entityKind === "string" &&
      typeof payload.entityId === "string" &&
      typeof payload.reason === "string" &&
      payload.reason.length > 0
      ? []
      : ["entity archive payload is invalid"];
  }
  if (value.type === "entity_target_missing")
    return validateMissingPayload(value.payload, hasFields, String(value.opId), allowUnknownFields);
  return validateUpsertPayload(value.schema, value.payload, hasFields);
}

export function isEntityEvent(event: { readonly schema: string; readonly type: string }): event is StoredEntityEventV1 {
  return isEntityEventEnvelope(event.schema, event.type);
}

export function isEntityDeclarationEvent(event: StoredEntityEventV1): event is EntityDeclarationEventV1 {
  return event.type !== "entity_target_missing" && event.type !== "entity_archived";
}

export function entityUpsertWritePlan(event: EntityUpsertEventV1): FrozenWritePlan<"EntityUpsert"> {
  return declarationWritePlan("EntityUpsert", event, "document/v1");
}

export function entityContentObservedWritePlan(
  event: EntityContentObservedEventV1,
): FrozenWritePlan<"EntityContentObserved"> {
  return declarationWritePlan("EntityContentObserved", event, "entity/v1");
}

export function entityTargetMissingWritePlan(
  event: EntityTargetMissingEventV1,
): FrozenWritePlan<"EntityTargetMissing"> {
  return freezeDeclaredWritePlan(
    {
      commandType: "EntityTargetMissing",
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "entity/v1", key: event.payload.entityId },
      ],
    },
    ["EntityTargetMissing"],
  );
}

export function entityArchivedWritePlan(event: EntityArchivedEventV1): FrozenWritePlan<"EntityArchived"> {
  return freezeDeclaredWritePlan(
    {
      commandType: "EntityArchived",
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "entity/v1", key: event.payload.entityId },
      ],
    },
    ["EntityArchived"],
  );
}

export function assertEntityEventInputs(
  event: EntityEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  if (event.type === "entity_target_missing" || event.type === "entity_archived") {
    assertExactWritePlan(
      plan,
      event.type === "entity_archived" ? entityArchivedWritePlan(event) : entityTargetMissingWritePlan(event),
    );
    if (blobs.length) throw new Error("entity target-missing event must not carry content blobs");
    return;
  }
  const expected =
    event.type === "entity_content_observed"
      ? entityContentObservedWritePlan(event)
      : event.type === "entity_updated"
        ? declarationWritePlan("EntityUpdated", event, "entity/v1")
        : entityUpsertWritePlan(event);
  assertExactWritePlan(plan, expected);
  const claim = event.payload.declarationDocumentClaim,
    declarationBlob = blobs.find((candidate) => candidate.sha256 === claim.sha256),
    contract = contractForDeclarationEvent(event);
  if (
    !declarationBlob ||
    declarationBlob.size !== claim.size ||
    declarationBlob.mediaType !== claim.mediaType ||
    sha256Text(declarationBlob.body) !== claim.sha256
  )
    throw new Error("entity declaration blob must be exact");
  let value: unknown;
  try {
    value = JSON.parse(declarationBlob.body);
  } catch {
    throw new Error("entity declaration blob must be JSON");
  }
  const entity =
    event.type === "entity_content_observed" || event.type === "entity_updated"
      ? decodeArtifactDescriptor(contract, value)
      : parseEntityJsonSchema(contract.schema, value, `${contract.kind} declaration`);
  if (!isRecord(entity) || entity[contract.id.field] !== event.payload.entityId)
    throw new Error("entity declaration identity must match its event");
  if (
    event.type === "entity_content_observed" &&
    (entity.source !== event.payload.sourceIdentity ||
      entity.contentVersion !== event.payload.observedContentVersion ||
      stableStringify(entity.locator) !== stableStringify(event.payload.locator))
  )
    throw new Error("entity observation fields must match its declaration descriptor");
}

/** Retained for generic-store callers; all current entity variants use the shared assertion above. */
export function assertEntityUpsertInputs(
  event: EntityEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  assertEntityEventInputs(event, plan, blobs);
}

export function assertEntityUpsertWritePlan(event: EntityEventV1, plan: FrozenWritePlan | undefined): void {
  const expected =
    event.type === "entity_target_missing"
      ? entityTargetMissingWritePlan(event)
      : event.type === "entity_archived"
        ? entityArchivedWritePlan(event)
        : event.type === "entity_content_observed"
          ? entityContentObservedWritePlan(event)
          : event.type === "entity_updated"
            ? declarationWritePlan("EntityUpdated", event, "entity/v1")
            : entityUpsertWritePlan(event);
  assertExactWritePlan(plan, expected);
}

export function contractForDeclarationEvent(event: EntityDeclarationEventV1): EntityStoreKindContract {
  return event.type === "entity_content_observed" || event.type === "entity_updated"
    ? artifactEntityContractFromSnapshot(event.payload.artifactContract)
    : requireEntityStoreKindContract(event.payload.entityKind);
}

function validateObservedPayload(
  payload: Record<string, unknown>,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields,
  opId: string,
  allowUnknownFields: boolean,
  acceptsOperation?: (opId: string) => boolean,
): readonly string[] {
  const fields = [
    "entityKind",
    "entityId",
    "declarationDocumentClaim",
    "locator",
    "sourceIdentity",
    "observedContentVersion",
    "resolver",
    "observationId",
    "artifactContract",
  ];
  if (!hasFields(payload, fields)) return ["entity_content_observed payload is invalid"];
  const common = validateArtifactPayload(payload, allowUnknownFields);
  if (common.length) return common;
  if (typeof payload.observedContentVersion !== "string" || !payload.observedContentVersion)
    return ["entity observed content version is invalid"];
  if (!validObservationIdentity(payload, payload.observedContentVersion, opId, acceptsOperation))
    return ["entity observed idempotency identity is invalid"];
  let contract: EntityStoreKindContract;
  try {
    contract = artifactEntityContractFromSnapshot(payload.artifactContract, allowUnknownFields);
  } catch {
    return ["entity artifact contract is invalid"];
  }
  return validateClaim(payload, contract, hasFields);
}

function validateMissingPayload(
  payload: Record<string, unknown>,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields,
  opId: string,
  allowUnknownFields: boolean,
): readonly string[] {
  const fields = [
    "entityKind",
    "entityId",
    "locator",
    "sourceIdentity",
    "resolver",
    "observationId",
    "reason",
    "artifactContract",
  ];
  if (!hasFields(payload, fields)) return ["entity_target_missing payload is invalid"];
  const common = validateArtifactPayload(payload, allowUnknownFields);
  if (common.length) return common;
  if (typeof payload.reason !== "string" || !payload.reason) return ["entity target-missing reason is invalid"];
  return validObservationIdentity(payload, `missing:${payload.reason}`, opId)
    ? []
    : ["entity missing idempotency identity is invalid"];
}

function validateArtifactPayload(payload: Record<string, unknown>, allowUnknownFields: boolean): readonly string[] {
  let contract: EntityStoreKindContract;
  try {
    contract = artifactEntityContractFromSnapshot(payload.artifactContract, allowUnknownFields);
  } catch {
    return ["entity artifact contract is invalid"];
  }
  const locator = payload.locator,
    snapshot = payload.artifactContract as ArtifactEntityContractSnapshot;
  let expectedEntityId: string;
  try {
    expectedEntityId = deriveArtifactEntityId({
      idPrefix: snapshot.idPrefix,
      typeIdentity: contract.kind,
      sourceIdentity: String(payload.sourceIdentity),
    });
    if (canonicalArtifactSourceIdentity(String(payload.sourceIdentity)) !== payload.sourceIdentity)
      return ["entity artifact source identity is not canonical"];
  } catch {
    return ["entity artifact source identity is invalid"];
  }
  if (
    payload.entityKind !== contract.kind ||
    typeof payload.entityId !== "string" ||
    typeof payload.sourceIdentity !== "string" ||
    expectedEntityId !== payload.entityId ||
    !isRecord(locator) ||
    !(["repository-path", "url", "external-key"] as const).includes(locator.kind as never) ||
    typeof locator.value !== "string" ||
    typeof payload.resolver !== "string" ||
    !payload.resolver ||
    typeof payload.observationId !== "string" ||
    !/^obs_[0-9a-f]{24}$/u.test(payload.observationId)
  )
    return ["entity artifact observation identity is invalid"];
  try {
    const canonical = canonicalArtifactLocator(locator as unknown as ArtifactLocator);
    if (canonical.value !== locator.value) return ["entity artifact locator is not canonical"];
  } catch {
    return ["entity artifact locator is invalid"];
  }
  return [];
}

function validateUpsertPayload(
  schema: unknown,
  payload: Record<string, unknown>,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields,
): readonly string[] {
  if (!hasFields(payload, ["entityKind", "entityId", "declarationDocumentClaim"]))
    return ["entity upsert payload is invalid"];
  let contract: EntityStoreKindContract;
  try {
    contract = requireEntityStoreKindContract(String(payload.entityKind));
  } catch {
    return ["entity event kind is not registered"];
  }
  if (typeof payload.entityId !== "string" || !new RegExp(contract.id.pattern, "u").test(payload.entityId))
    return ["entity event kind and identity are invalid"];
  return validateClaim(payload, contract, hasFields, schema);
}

function validObservationIdentity(
  payload: Record<string, unknown>,
  resolution: string,
  opId: string,
  acceptsOperation?: (opId: string) => boolean,
): boolean {
  const locator = payload.locator as unknown as ArtifactLocator,
    entityId = String(payload.entityId),
    expected = artifactObservationId({ entityId, locator, resolution }),
    accepts =
      acceptsOperation ??
      ((candidate: string) => candidate === artifactImportOperationId({ entityId, locator, resolution }));
  return payload.observationId === expected && accepts(opId);
}

function validateClaim(
  payload: Record<string, unknown>,
  contract: EntityStoreKindContract,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields = hasOnlyFields,
  schema: unknown = "entity-event/v1",
): readonly string[] {
  const claim = payload.declarationDocumentClaim;
  if (
    !isRecord(claim) ||
    !hasFields(claim, ["path", "sha256", "size", "mediaType", "policyId"]) ||
    claim.path !== entityDocumentPath(contract, String(payload.entityId)) ||
    !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
    !Number.isSafeInteger(claim.size) ||
    Number(claim.size) < 0 ||
    claim.mediaType !== contract.entityStore.document.mediaType ||
    !acceptedPolicyIds(schema).includes(String(claim.policyId))
  )
    return ["entity declaration claim is invalid"];
  return [];
}

function declarationContent(contract: EntityStoreKindContract, entityId: string, entity: unknown) {
  const body = serializeEntityJsonSchema(contract.schema, entity, `${contract.kind} declaration`),
    claim: EntityDeclarationClaim = {
      path: normalizeRelativeDocumentPath(entityDocumentPath(contract, entityId)),
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.entityStore.document.mediaType,
      policyId: contract.entityStore.document.policyId,
    };
  return { body, claim };
}

function declarationWritePlan<Command extends "EntityUpsert" | "EntityContentObserved" | "EntityUpdated">(
  commandType: Command,
  event: EntityDeclarationEventV1,
  projection: string,
): FrozenWritePlan<Command> {
  const claim = event.payload.declarationDocumentClaim,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      { kind: "projection_invalidation", projection, key: claim.path },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
    ];
  return freezeDeclaredWritePlan({ commandType, targets }, [commandType]);
}

function assertExactWritePlan(plan: FrozenWritePlan | undefined, expected: FrozenWritePlan): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(expected))
    throw new Error("entity write plan must exactly declare its event, declaration, projection, and content targets");
}

function eventEnvelope(input: EntityEventEnvelopeInput) {
  return {
    schema: "entity-event/v1" as const,
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
  };
}

function blob(claim: EntityDeclarationClaim, body: string): EntityDeclarationBlob {
  return { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body };
}

function assertValidCurrent(event: EntityEventV1): void {
  const errors = validateCurrentEntityEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
}

function acceptedPolicyIds(schema: unknown): readonly string[] {
  return schema === "agent-entity-event/v1"
    ? [ENTITY_DOCUMENT_POLICY_ID, LEGACY_AGENT_ENTITY_POLICY_ID]
    : [ENTITY_DOCUMENT_POLICY_ID];
}

function isEntityEventEnvelope(schema: unknown, type: unknown): boolean {
  return entityEventEnvelopes.some(
    ([registeredSchema, registeredType]) => registeredSchema === schema && registeredType === type,
  );
}
