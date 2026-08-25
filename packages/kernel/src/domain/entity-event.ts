import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { parseEntityJsonSchema, serializeEntityJsonSchema } from "./entity-json-schema.ts";
import { ENTITY_DOCUMENT_POLICY_ID, entityDocumentPath, requireEntityKindContract } from "./entity-kind-registry.ts";
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
export type EntityEventV1 = EventEnvelope<
  "entity-event/v1",
  "entity_upserted",
  ActorIdentity,
  {
    readonly entityKind: string;
    readonly entityId: string;
    readonly declarationDocumentClaim: EntityDeclarationClaim;
  }
>;
export interface EntityUpsertBundle {
  readonly event: EntityEventV1;
  readonly plan: FrozenWritePlan<"EntityUpsert">;
  readonly blobs: readonly [
    { readonly sha256: string; readonly size: number; readonly mediaType: "application/json"; readonly body: string },
  ];
}

export function compileEntityUpsert(input: {
  readonly entityKind: string;
  readonly entity: unknown;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): EntityUpsertBundle {
  const contract = requireEntityKindContract(input.entityKind),
    entity = parseEntityJsonSchema(contract.schema, input.entity, `${input.entityKind} declaration`),
    entityId = isRecord(entity) ? entity[contract.id.field] : undefined;
  const contractErrors = contract.validate?.(entity) ?? [];
  if (contractErrors.length) throw new Error(contractErrors.join("; "));
  if (typeof entityId !== "string") throw new Error(`${input.entityKind} declaration has no string identity`);
  const body = serializeEntityJsonSchema(contract.schema, entity, `${input.entityKind} declaration`),
    claim: EntityDeclarationClaim = {
      path: normalizeRelativeDocumentPath(entityDocumentPath(contract, entityId)),
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.document.mediaType,
      policyId: contract.document.policyId,
    },
    event: EntityEventV1 = {
      schema: "entity-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      type: "entity_upserted",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: { entityKind: contract.kind, entityId, declarationDocumentClaim: claim },
    };
  const errors = validateCurrentEntityEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: entityUpsertWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
  };
}

export function validateEntityEvent(value: unknown): readonly string[] {
  return validateEntityEventFields(value, true);
}
export function validateCurrentEntityEvent(value: unknown): readonly string[] {
  return validateEntityEventFields(value, false);
}
function validateEntityEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "entity-event/v1" ||
    value.type !== "entity_upserted" ||
    !isRecord(value.payload) ||
    !hasFields(value.payload, ["entityKind", "entityId", "declarationDocumentClaim"])
  )
    return ["entity event envelope or payload is invalid"];
  const kind = value.payload.entityKind,
    id = value.payload.entityId,
    claim = value.payload.declarationDocumentClaim;
  if (typeof kind !== "string" || typeof id !== "string") return ["entity event kind and identity are invalid"];
  let contract;
  try {
    contract = requireEntityKindContract(kind);
  } catch {
    return ["entity event kind is not registered"];
  }
  if (
    !new RegExp(contract.id.pattern, "u").test(id) ||
    !isRecord(claim) ||
    !hasFields(claim, ["path", "sha256", "size", "mediaType", "policyId"]) ||
    claim.path !== entityDocumentPath(contract, id) ||
    !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
    !Number.isSafeInteger(claim.size) ||
    (claim.size as number) < 0 ||
    claim.mediaType !== contract.document.mediaType ||
    claim.policyId !== contract.document.policyId
  )
    return ["entity declaration claim is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length ? ["entity event identity is invalid"] : [];
}

export function isEntityEvent(event: { readonly schema: string }): event is EntityEventV1 {
  return event.schema === "entity-event/v1";
}
export function entityUpsertWritePlan(event: EntityEventV1): FrozenWritePlan<"EntityUpsert"> {
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
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
    ];
  return freezeDeclaredWritePlan({ commandType: "EntityUpsert", targets }, ["EntityUpsert"]);
}
export function assertEntityUpsertInputs(
  event: EntityEventV1,
  plan: FrozenWritePlan<"EntityUpsert"> | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): asserts plan is FrozenWritePlan<"EntityUpsert"> {
  assertEntityUpsertWritePlan(event, plan);
  const claim = event.payload.declarationDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256),
    contract = requireEntityKindContract(event.payload.entityKind);
  if (!blob || blob.size !== claim.size || blob.mediaType !== claim.mediaType || sha256Text(blob.body) !== claim.sha256)
    throw new Error("entity upsert declaration blob must be exact");
  let value: unknown;
  try {
    value = JSON.parse(blob.body);
  } catch {
    throw new Error("entity upsert declaration blob must be JSON");
  }
  const entity = parseEntityJsonSchema(contract.schema, value, `${contract.kind} declaration`);
  if (!isRecord(entity) || entity[contract.id.field] !== event.payload.entityId)
    throw new Error("entity upsert declaration identity must match its event");
}

export function assertEntityUpsertWritePlan(
  event: EntityEventV1,
  plan: FrozenWritePlan<"EntityUpsert"> | undefined,
): asserts plan is FrozenWritePlan<"EntityUpsert"> {
  const shape = (value: FrozenWritePlan<"EntityUpsert">) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(entityUpsertWritePlan(event)))
    throw new Error("entity upsert plan must exactly declare event, declaration, projection, and content targets");
}
