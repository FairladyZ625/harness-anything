import { sha256Text } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import {
  artifactObservationId,
  canonicalArtifactLocator,
  decodeArtifactDescriptor,
  type ArtifactDescriptor,
  type ArtifactEntityContractSnapshot,
  type ArtifactLocator,
} from "./artifact-entity.ts";
import {
  declarationOwnedContent,
  declarationWritePlan,
  entityArchivedWritePlan,
  entityContentObservedWritePlan,
  entityDeletedWritePlan,
  entityTargetMissingWritePlan,
  entityUpsertWritePlan,
  validateCurrentEntityEvent,
  type EntityArchivedEventV1,
  type EntityContentBlob,
  type EntityContentObservedEventV1,
  type EntityDeclarationClaim,
  type EntityDeletedEventV1,
  type EntityEventV1,
  type EntityTargetMissingEventV1,
  type EntityUpdatedEventV1,
  type EntityUpsertEventV1,
} from "./entity-event.ts";
import { parseEntityJsonSchema, serializeEntityJsonSchemaUnchecked } from "./entity-json-schema.ts";
import {
  entityDocumentPath,
  requireEntityStoreKindContract,
  type EntityStoreKindContract,
} from "./entity-kind-registry.ts";
import { createEntityOwnedContent, entitySchemaVersion, type EntityContentRetirement } from "./entity-owned-content.ts";
import { isRecord, type ActorIdentity, type FrozenWritePlan, type WriteSource } from "./write-chain.contract.ts";

// Compiling a command into an entity event is the writer's side. entity-event.ts keeps the accepted event
// contract every reader replays, so offline maintenance and cold rebuild never load the compilers.

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
  readonly blobs: readonly (EntityDeclarationBlob | EntityContentBlob)[];
}

export interface EntityTargetMissingBundle {
  readonly event: EntityTargetMissingEventV1;
  readonly plan: FrozenWritePlan<"EntityTargetMissing">;
  readonly blobs: readonly [];
}

export interface EntityUpdatedBundle {
  readonly event: EntityUpdatedEventV1;
  readonly plan: FrozenWritePlan<"EntityUpdated">;
  readonly blobs: readonly (EntityDeclarationBlob | EntityContentBlob)[];
}

export interface EntityArchivedBundle {
  readonly event: EntityArchivedEventV1;
  readonly plan: FrozenWritePlan<"EntityArchived">;
  readonly blobs: readonly [];
}

export interface EntityDeletedBundle {
  readonly event: EntityDeletedEventV1;
  readonly plan: FrozenWritePlan<"EntityDelete">;
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
    ownedContent = declarationOwnedContent(contract, entityId, claim),
    event: EntityUpsertEventV1 = {
      ...eventEnvelope(input),
      type: "entity_upserted",
      payload: { entityKind: contract.kind, entityId, declarationDocumentClaim: claim, ownedContent },
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
    readonly sourceContent?: readonly EntityContentBlob[];
    readonly sourceDirectories?: readonly string[];
    readonly retirements?: readonly EntityContentRetirement[];
    readonly heldDirectories?: readonly string[];
  },
): EntityContentObservedBundle {
  const descriptor = decodeArtifactDescriptor(input.contract, input.descriptor),
    { body, claim } = declarationContent(input.contract, descriptor.entityId, descriptor),
    sourceContent = input.sourceContent ?? [],
    ownedContent = declarationOwnedContent(input.contract, descriptor.entityId, claim, sourceContent, {
      directories: input.sourceDirectories,
      retirements: input.retirements,
      heldDirectories: input.heldDirectories,
    }),
    event: EntityContentObservedEventV1 = {
      ...eventEnvelope(input),
      type: "entity_content_observed",
      payload: {
        entityKind: input.contract.kind,
        entityId: descriptor.entityId,
        declarationDocumentClaim: claim,
        ownedContent,
        locator: descriptor.locator,
        sourceIdentity: descriptor.source,
        observedContentVersion: descriptor.contentVersion,
        resolver: input.resolver,
        observationId: input.observationId,
        artifactContract: input.contractSnapshot,
      },
    };
  assertValidCurrent(event);
  return { event, plan: entityContentObservedWritePlan(event), blobs: [blob(claim, body), ...sourceContent] };
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
    /**
     * Owned content restated as manifest metadata; the store already holds those bytes, so only
     * new content is carried.
     */
    readonly sourceContent?: readonly Omit<EntityContentBlob, "body">[];
    readonly sourceDirectories?: readonly string[];
    readonly retirements?: readonly EntityContentRetirement[];
    readonly heldDirectories?: readonly string[];
  },
): EntityUpdatedBundle {
  const descriptor = decodeArtifactDescriptor(input.contract, input.descriptor),
    { body, claim } = declarationContent(input.contract, descriptor.entityId, descriptor),
    sourceContent = input.sourceContent ?? [],
    ownedContent = declarationOwnedContent(input.contract, descriptor.entityId, claim, sourceContent, {
      directories: input.sourceDirectories,
      retirements: input.retirements,
      heldDirectories: input.heldDirectories,
    }),
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
        ownedContent,
        locator: descriptor.locator,
        sourceIdentity: descriptor.source,
        observedContentVersion: descriptor.contentVersion,
        resolver: "descriptor-update",
        observationId,
        artifactContract: input.contractSnapshot,
      },
    };
  assertValidCurrent(event);
  return {
    event,
    plan: declarationWritePlan("EntityUpdated", event, "entity/v1"),
    blobs: [blob(claim, body)],
  };
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

/**
 * Delete retires every path the entity still binds, not just its declaration: an entity that owns a
 * directory of raw source objects must leave none of them behind as an unowned file. The events that
 * carried those bytes stay in the ledger, so the deletion is recoverable history rather than erasure.
 */
export function compileEntityDeleted(
  input: EntityEventEnvelopeInput & {
    readonly entityKind: string;
    readonly entityId: string;
    readonly baseBlobSha256: string;
    readonly reason: string;
    readonly contract?: EntityStoreKindContract;
    readonly contentRetirements?: readonly EntityContentRetirement[];
    /** The footprint the entity held; a delete keeps none of it, so all of it is retired. */
    readonly heldDirectories?: readonly string[];
  },
): EntityDeletedBundle {
  const contract = input.contract ?? requireEntityStoreKindContract(input.entityKind),
    path = normalizeRelativeDocumentPath(entityDocumentPath(contract, input.entityId)),
    ownedContent = createEntityOwnedContent({
      ownerRef: `${contract.kind}/${input.entityId}`,
      schemaId: contract.schema.$id,
      schemaVersion: entitySchemaVersion(contract.schema.$id),
      bindings: [],
      retirements: [
        { path, baseBlobSha256: input.baseBlobSha256 },
        ...(input.contentRetirements ?? []).filter((retired) => retired.path !== path),
      ],
      // A delete states every directory the entity held, because it will hold none of them afterwards. Nothing
      // is derived from what happens to be on disk: a directory the entity never held is not named here and is
      // therefore never touched, however empty it is.
      directoryRetirements: (input.heldDirectories ?? []).map((held) => ({ path: held })),
    }),
    event: EntityDeletedEventV1 = {
      ...eventEnvelope(input),
      type: "entity_deleted",
      payload: {
        entityKind: contract.kind,
        entityId: input.entityId,
        reason: input.reason.trim(),
        ownedContent,
      },
    };
  assertValidCurrent(event);
  return { event, plan: entityDeletedWritePlan(event), blobs: [] };
}

function declarationContent(contract: EntityStoreKindContract, entityId: string, entity: unknown) {
  const body = serializeEntityJsonSchemaUnchecked(entity),
    claim: EntityDeclarationClaim = {
      path: normalizeRelativeDocumentPath(entityDocumentPath(contract, entityId)),
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.entityStore.document.mediaType,
      policyId: contract.entityStore.document.policyId,
    };
  return { body, claim };
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
