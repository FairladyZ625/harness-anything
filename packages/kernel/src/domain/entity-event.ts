import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import {
  artifactEntityContractFromSnapshot,
  artifactImportOperationId,
  importBindingGeneration,
  isArtifactMutationOperationId,
  artifactObservationId,
  canonicalArtifactLocator,
  canonicalArtifactSourceIdentity,
  decodeArtifactDescriptor,
  isArtifactEntityId,
  type ArtifactEntityContractSnapshot,
  type ArtifactLocator,
} from "./artifact-entity.ts";
import { parseEntityJsonSchema } from "./entity-json-schema.ts";
import {
  createEntityOwnedContent,
  entityDirectoryFootprint,
  entityOwnedContentClaims,
  entityOwnedDirectories,
  entityOwnedDocumentClaims,
  entityRetiredDirectories,
  entitySchemaVersion,
  validateEntityOwnedContent,
  type EntityContentRetirement,
  type EntityOwnedContentV1,
} from "./entity-owned-content.ts";
import {
  ENTITY_DOCUMENT_POLICY_ID,
  entityContentPath,
  entityContentRoot,
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
  readonly ownedContent: EntityOwnedContentV1;
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

export interface EntityDeletedPayload {
  readonly entityKind: string;
  readonly entityId: string;
  readonly reason: string;
  readonly ownedContent: EntityOwnedContentV1;
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
export type EntityDeletedEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_deleted",
  ActorIdentity,
  EntityDeletedPayload
>;
export type EntityEventV1 =
  | EntityUpsertEventV1
  | EntityContentObservedEventV1
  | EntityTargetMissingEventV1
  | EntityUpdatedEventV1
  | EntityArchivedEventV1
  | EntityDeletedEventV1;

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
  ["entity-event/v1", "entity_deleted"],
  ["agent-entity-event/v1", "agent_entity_written"],
];
const LEGACY_AGENT_ENTITY_POLICY_ID = "typed-agent-entity/v1";

/**
 * One raw source object the center takes ownership of. `relativePath` is the object's place inside the
 * entity's own content root, never the path it happened to be read from: two entities that import a file
 * called `raw.pdf` from different sources must not settle on the same authored target.
 */
export interface EntityContentBlob {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: string;
  readonly body: Uint8Array;
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
  if (value.type === "entity_deleted") return validateDeletedPayload(value.payload, hasFields, allowUnknownFields);
  if (value.type === "entity_target_missing")
    return validateMissingPayload(value.payload, hasFields, String(value.opId), allowUnknownFields);
  return validateUpsertPayload(value.schema, value.payload, hasFields, allowUnknownFields);
}

export function isEntityEvent(event: { readonly schema: string; readonly type: string }): event is StoredEntityEventV1 {
  return isEntityEventEnvelope(event.schema, event.type);
}

export function isEntityDeclarationEvent(event: StoredEntityEventV1): event is EntityDeclarationEventV1 {
  return event.type !== "entity_target_missing" && event.type !== "entity_archived" && event.type !== "entity_deleted";
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

export function entityDeletedWritePlan(event: EntityDeletedEventV1): FrozenWritePlan<"EntityDelete"> {
  return freezeDeclaredWritePlan(
    {
      commandType: "EntityDelete",
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        ...event.payload.ownedContent.retirements.map((retirement) => ({
          kind: "authored_file_delete" as const,
          path: retirement.path,
          operation: "delete" as const,
          baseSha256: retirement.baseBlobSha256,
        })),
        ...entityRetiredDirectories(event.payload.ownedContent).map((path) => ({
          kind: "authored_directory" as const,
          path,
          operation: "retire" as const,
        })),
        { kind: "projection_invalidation", projection: "entity/v1", key: event.payload.entityId },
      ],
    },
    ["EntityDelete"],
  );
}

export function assertEntityEventInputs(
  event: EntityEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string | Uint8Array;
  }[],
): void {
  if (event.type === "entity_target_missing" || event.type === "entity_archived" || event.type === "entity_deleted") {
    assertExactWritePlan(
      plan,
      event.type === "entity_archived"
        ? entityArchivedWritePlan(event)
        : event.type === "entity_deleted"
          ? entityDeletedWritePlan(event)
          : entityTargetMissingWritePlan(event),
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
    typeof declarationBlob.body !== "string" ||
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
    readonly body: string | Uint8Array;
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
        : event.type === "entity_deleted"
          ? entityDeletedWritePlan(event)
          : event.type === "entity_content_observed"
            ? entityContentObservedWritePlan(event)
            : event.type === "entity_updated"
              ? declarationWritePlan("EntityUpdated", event, "entity/v1")
              : entityUpsertWritePlan(event);
  assertExactWritePlan(plan, expected);
}

export function contractForDeclarationEvent(event: EntityDeclarationEventV1): EntityStoreKindContract {
  return event.type === "entity_content_observed" || event.type === "entity_updated"
    ? artifactEntityContractFromSnapshot(
        event.payload.artifactContract,
        isRecord(event.payload.artifactContract) && !Object.hasOwn(event.payload.artifactContract, "kindVersion"),
      )
    : requireEntityStoreKindContract(event.payload.entityKind);
}

export function ownedContentForDeclarationEvent(event: EntityDeclarationEventV1): EntityOwnedContentV1 {
  // The manifest an event was accepted with is the only description of what that event owns. Recomputing one
  // from the registry a reader happens to hold today would answer a question about the present, not the event.
  if (event.payload.ownedContent === undefined) return acceptedShapeOwnedContent(event);
  return event.payload.ownedContent;
}

/**
 * The manifest an event accepted before manifests existed states. Upserts were accepted under a shape that
 * admitted exactly one owned file — the declaration document the payload already names — and no directory and
 * no retirement, so that claim is the whole manifest and reading it invents nothing. The artifact declarations
 * carried source content the payload does not enumerate, so theirs cannot be recovered from the event at all.
 */
function acceptedShapeOwnedContent(event: EntityDeclarationEventV1): EntityOwnedContentV1 {
  if (event.type === "entity_content_observed" || event.type === "entity_updated")
    throw new Error(`${event.type} event carries no owned-content manifest`);
  return declarationOwnedContent(
    requireEntityStoreKindContract(event.payload.entityKind),
    event.payload.entityId,
    event.payload.declarationDocumentClaim,
  );
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
    ...(allowUnknownFields ? [] : ["ownedContent"]),
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
  const historical = isRecord(payload.artifactContract) && !Object.hasOwn(payload.artifactContract, "kindVersion"),
    historicalOperation = historical
      ? (candidate: string) =>
          candidate === legacyArtifactImportOperationId(payload, payload.observedContentVersion as string)
      : undefined;
  if (!validObservationIdentity(payload, payload.observedContentVersion, opId, acceptsOperation ?? historicalOperation))
    return ["entity observed idempotency identity is invalid"];
  let contract: EntityStoreKindContract;
  try {
    contract = artifactEntityContractFromSnapshot(payload.artifactContract, allowUnknownFields);
  } catch {
    return ["entity artifact contract is invalid"];
  }
  return validateClaim(payload, contract, hasFields, "entity-event/v1", true);
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
  const historical = isRecord(payload.artifactContract) && !Object.hasOwn(payload.artifactContract, "kindVersion"),
    historicalOperation = historical
      ? (candidate: string) => candidate === legacyArtifactImportOperationId(payload, `missing:${payload.reason}`)
      : undefined;
  return validObservationIdentity(payload, `missing:${payload.reason}`, opId, historicalOperation)
    ? []
    : ["entity missing idempotency identity is invalid"];
}

function validateDeletedPayload(
  payload: Record<string, unknown>,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields,
  _allowUnknownFields: boolean,
): readonly string[] {
  if (!hasFields(payload, ["entityKind", "entityId", "reason", "ownedContent"]))
    return ["entity delete payload is invalid"];
  const errors = validateEntityOwnedContent(payload.ownedContent);
  if (errors.length) return errors;
  const manifest = payload.ownedContent as EntityOwnedContentV1;
  let contract: EntityStoreKindContract;
  try {
    // A kind declared at runtime is not in the kernel registry; the manifest states the schema the event was
    // accepted against, so a delete replays without asking today's registry what that kind looks like.
    contract = requireEntityStoreKindContract(String(payload.entityKind));
  } catch {
    return manifest.ownerRef === `${String(payload.entityKind)}/${String(payload.entityId)}` &&
      manifest.content.length === 0 &&
      manifest.bindings.length === 0 &&
      manifest.retirements.length >= 1 &&
      typeof payload.reason === "string" &&
      payload.reason.trim().length > 0
      ? []
      : ["entity delete owned-content retirement is invalid"];
  }
  if (
    typeof payload.entityId !== "string" ||
    !new RegExp(contract.id.pattern, "u").test(payload.entityId) ||
    typeof payload.reason !== "string" ||
    !payload.reason.trim()
  )
    return ["entity delete identity or reason is invalid"];
  return manifest.ownerRef === `${contract.kind}/${payload.entityId}` &&
    manifest.schemaId === contract.schema.$id &&
    manifest.schemaVersion === entitySchemaVersion(contract.schema.$id) &&
    manifest.content.length === 0 &&
    manifest.bindings.length === 0 &&
    manifest.directories.length === 0 &&
    manifest.retirements.some(({ path }) => path === entityDocumentPath(contract, String(payload.entityId)))
    ? []
    : ["entity delete owned-content retirement is invalid"];
}

function validateArtifactPayload(payload: Record<string, unknown>, allowUnknownFields: boolean): readonly string[] {
  let contract: EntityStoreKindContract;
  try {
    contract = artifactEntityContractFromSnapshot(payload.artifactContract, allowUnknownFields);
  } catch {
    return ["entity artifact contract is invalid"];
  }
  const locator = payload.locator,
    snapshot = payload.artifactContract as ArtifactEntityContractSnapshot,
    historical = isRecord(snapshot) && !Object.hasOwn(snapshot, "kindVersion"),
    validEntityId = historical
      ? typeof payload.entityId === "string" &&
        new RegExp(`^${snapshot.idPrefix}-[a-f0-9]{16}$`, "u").test(payload.entityId)
      : isArtifactEntityId(snapshot.idPrefix, payload.entityId);
  try {
    if (canonicalArtifactSourceIdentity(String(payload.sourceIdentity)) !== payload.sourceIdentity)
      return ["entity artifact source identity is not canonical"];
  } catch {
    return ["entity artifact source identity is invalid"];
  }
  // The identity is opaque: the event states which source it is bound to, and replay checks the identity's
  // shape rather than recomputing it, so a move restates the binding without minting a second entity.
  if (
    payload.entityKind !== contract.kind ||
    typeof payload.entityId !== "string" ||
    typeof payload.sourceIdentity !== "string" ||
    !validEntityId ||
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
  allowUnknownFields: boolean,
): readonly string[] {
  if (
    !hasFields(payload, [
      "entityKind",
      "entityId",
      "declarationDocumentClaim",
      ...(allowUnknownFields ? [] : ["ownedContent"]),
    ])
  )
    return ["entity upsert payload is invalid"];
  let contract: EntityStoreKindContract;
  try {
    contract = requireEntityStoreKindContract(String(payload.entityKind));
  } catch {
    return ["entity event kind is not registered"];
  }
  if (typeof payload.entityId !== "string" || !new RegExp(contract.id.pattern, "u").test(payload.entityId))
    return ["entity event kind and identity are invalid"];
  return validateClaim(payload, contract, hasFields, schema, allowUnknownFields);
}

function validObservationIdentity(
  payload: Record<string, unknown>,
  resolution: string,
  opId: string,
  acceptsOperation?: (opId: string) => boolean,
): boolean {
  const locator = payload.locator as unknown as ArtifactLocator,
    entityId = String(payload.entityId),
    sourceIdentity = String(payload.sourceIdentity),
    expected = artifactObservationId({ entityId, locator, resolution }),
    accepts =
      acceptsOperation ??
      ((candidate: string) =>
        // The generation the import was accepted under is part of the id, so the check stays an exact
        // recomputation even though the reader cannot see the binding history the writer counted.
        candidate ===
        artifactImportOperationId({
          entityKind: String(payload.entityKind),
          sourceIdentity,
          locator,
          resolution,
          bindingGeneration: importBindingGeneration(candidate),
        }));
  return payload.observationId === expected && accepts(opId);
}

function legacyArtifactImportOperationId(payload: Record<string, unknown>, resolution: string): string {
  const locator = payload.locator as ArtifactLocator;
  return `entity-import-${sha256Text(
    `${String(payload.entityId)}\u0000${locator.kind}:${locator.value}\u0000${resolution}`,
  ).slice(0, 32)}`;
}

function validateClaim(
  payload: Record<string, unknown>,
  contract: EntityStoreKindContract,
  hasFields: typeof hasOnlyFields | typeof hasRequiredFields = hasOnlyFields,
  schema: unknown = "entity-event/v1",
  allowAdditionalOwnedContent = false,
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
  // Historical parsing retains the accepted shape; only current writes require an ownership manifest.
  if (payload.ownedContent === undefined)
    return hasFields === hasRequiredFields ? [] : ["entity owned-content manifest is missing"];
  const manifestErrors = validateEntityOwnedContent(payload.ownedContent);
  if (manifestErrors.length) return manifestErrors;
  const manifest = payload.ownedContent as EntityOwnedContentV1,
    declarationBinding = manifest.bindings.find(({ path }) => path === claim.path),
    declarationObject = manifest.content.find(({ sha256 }) => sha256 === claim.sha256);
  return manifest.ownerRef === `${contract.kind}/${String(payload.entityId)}` &&
    manifest.schemaId === contract.schema.$id &&
    manifest.schemaVersion === entitySchemaVersion(contract.schema.$id) &&
    declarationBinding?.contentSha256 === claim.sha256 &&
    declarationBinding?.policyId === claim.policyId &&
    declarationObject?.byteLength === claim.size &&
    declarationObject?.mediaType === claim.mediaType &&
    (allowAdditionalOwnedContent ||
      (manifest.bindings.length === 1 &&
        manifest.content.length === 1 &&
        manifest.directories.length === 0 &&
        manifest.retirements.length === 0))
    ? []
    : ["entity owned-content manifest must exactly bind its declaration"];
}

export function declarationOwnedContent(
  contract: EntityStoreKindContract,
  entityId: string,
  claim: EntityDeclarationClaim,
  sourceContent: readonly EntityContentBlob[] = [],
  owned: {
    readonly directories?: readonly string[];
    readonly retirements?: readonly EntityContentRetirement[];
    /** The footprint the previous accepted manifest held, so this one can state what fell out of it. */
    readonly heldDirectories?: readonly string[];
  } = {},
): EntityOwnedContentV1 {
  const bindings = [
      claim,
      ...sourceContent.map(({ relativePath, sha256, size, mediaType, policyId }) => ({
        path: entityContentPath(contract, entityId, relativePath),
        sha256,
        size,
        mediaType,
        policyId,
      })),
    ],
    directories = (owned.directories ?? []).map((relativePath) => ({
      path: entityContentPath(contract, entityId, relativePath),
    })),
    bound = new Set(bindings.map(({ path }) => path)),
    // Only a directory the entity itself held can fall out of its own footprint, which is what keeps a directory
    // the user made inside the content root out of every retirement this entity will ever state.
    footprint = new Set(
      entityDirectoryFootprint(entityContentRoot(contract, entityId), {
        directories,
        bindings: bindings.map(({ path }) => ({ path })),
      }),
    );
  return createEntityOwnedContent({
    ownerRef: `${contract.kind}/${entityId}`,
    schemaId: contract.schema.$id,
    schemaVersion: entitySchemaVersion(contract.schema.$id),
    bindings,
    directories,
    // A path this observation still binds is not retired by it: an update that rewrites a file states the new
    // bytes, and only the paths that fell out of the snapshot are retired.
    retirements: (owned.retirements ?? []).filter(({ path }) => !bound.has(path)),
    directoryRetirements: (owned.heldDirectories ?? [])
      .filter((held) => !footprint.has(held))
      .map((path) => ({ path })),
  });
}

export function declarationWritePlan<Command extends "EntityUpsert" | "EntityContentObserved" | "EntityUpdated">(
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
      ...entityOwnedDocumentClaims(ownedContentForDeclarationEvent(event))
        .filter((owned) => owned.path !== claim.path)
        .map((owned) => ({
          kind: "authored_file" as const,
          path: owned.path,
          operation: "replace" as const,
          sha256: owned.sha256,
          size: owned.size,
          mediaType: owned.mediaType,
        })),
      ...ownedContentForDeclarationEvent(event).retirements.map((retired) => ({
        kind: "authored_file_delete" as const,
        path: retired.path,
        operation: "delete" as const,
        baseSha256: retired.baseBlobSha256,
      })),
      ...entityOwnedDirectories(ownedContentForDeclarationEvent(event)).map((path) => ({
        kind: "authored_directory" as const,
        path,
        operation: "create" as const,
      })),
      ...entityRetiredDirectories(ownedContentForDeclarationEvent(event)).map((path) => ({
        kind: "authored_directory" as const,
        path,
        operation: "retire" as const,
      })),
      { kind: "projection_invalidation", projection, key: claim.path },
      ...entityOwnedContentClaims(ownedContentForDeclarationEvent(event)).map((owned) => ({
        kind: "content_blob" as const,
        sha256: owned.sha256,
        size: owned.size,
        mediaType: owned.mediaType,
      })),
    ];
  return freezeDeclaredWritePlan({ commandType, targets }, [commandType]);
}

function assertExactWritePlan(plan: FrozenWritePlan | undefined, expected: FrozenWritePlan): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(expected))
    throw new Error("entity write plan must exactly declare its event, declaration, projection, and content targets");
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
