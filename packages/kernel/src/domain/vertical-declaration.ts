import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  decodeForwardCompatibleVerticalDefinition,
  decodeVerticalDefinition,
  type VerticalDefinition,
} from "../schemas/vertical-definition.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isFrozenWritePlan,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

// Canonical authored paths are relative to the authored `harness/` root.
export const VERTICAL_DECLARATION_PATH = "vertical.json" as const;
export const VERTICAL_DECLARATION_POLICY_ID = "vertical-declaration/v1" as const;

export interface VerticalDeclarationDocumentV1 {
  readonly schema: "repository-vertical-declaration/v1";
  readonly revision: number;
  readonly definition: VerticalDefinition;
}

export type VerticalDeclarationEventType = "vertical_declared" | "vertical_kind_upserted" | "vertical_kind_retired";

export type VerticalDeclarationEventV1 = EventEnvelope<
  "vertical-declaration-event/v1",
  VerticalDeclarationEventType,
  ActorIdentity,
  {
    readonly declaration: VerticalDeclarationDocumentV1;
    readonly kindId: string | null;
    readonly reason: string | null;
    readonly declarationDocumentClaim: {
      readonly path: typeof VERTICAL_DECLARATION_PATH;
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: "application/json";
      readonly policyId: typeof VERTICAL_DECLARATION_POLICY_ID;
    };
  }
> & { readonly entity: { readonly kind: "vertical-declaration"; readonly id: "default" } };

export interface VerticalDeclarationBundle {
  readonly event: VerticalDeclarationEventV1;
  readonly plan: FrozenWritePlan<VerticalDeclarationEventType>;
  readonly blobs: readonly [
    { readonly sha256: string; readonly size: number; readonly mediaType: "application/json"; readonly body: string },
  ];
}

export function applyVerticalKindCommand(input: {
  readonly definition: VerticalDefinition;
  readonly revision: number;
  readonly expectedVersion: number;
  readonly kind: "upsert" | "retire";
  readonly kindId: string;
  readonly declaration?: unknown;
  readonly retiredAt?: string;
  readonly reason?: string;
}): VerticalDefinition {
  const kindId = input.kindId.trim(),
    index = input.definition.entityKinds.findIndex(({ id }) => id === kindId);
  if (!kindId) verticalError("missing_field", "Vertical kind action requires kindId.");
  if (input.kind === "upsert" && index >= 0 && input.expectedVersion === 0)
    verticalError("kind_exists", `Vertical kind ${kindId} already exists.`);
  if (input.expectedVersion !== input.revision)
    verticalError(
      "revision_conflict",
      `Vertical declaration expected revision ${input.expectedVersion}, current revision is ${input.revision}.`,
    );
  if (input.kind === "retire") {
    if (index < 0) verticalError("entity_not_found", `Vertical kind ${kindId} does not exist.`);
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 1 || reason.length > 199)
      verticalError("invalid_field", "Vertical kind retirement reason must contain 1..199 characters.");
    if (!input.retiredAt) verticalError("missing_field", "Vertical kind retirement requires retiredAt.");
    return decodeVerticalDefinition({
      ...input.definition,
      entityKinds: input.definition.entityKinds.map((declaration) =>
        declaration.id === kindId ? { ...declaration, retired: true, retiredAt: input.retiredAt, reason } : declaration,
      ),
    });
  }
  if (!isRecord(input.declaration)) verticalError("invalid_field", "Vertical kind declaration must be an object.");
  const entityKinds = [...input.definition.entityKinds];
  if (index < 0) entityKinds.push(input.declaration as VerticalDefinition["entityKinds"][number]);
  else entityKinds[index] = input.declaration as VerticalDefinition["entityKinds"][number];
  return decodeVerticalDefinition({ ...input.definition, entityKinds });
}

function verticalError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function compileVerticalDeclarationEvent(input: {
  readonly type: VerticalDeclarationEventType;
  readonly definition: unknown;
  readonly kindId?: string;
  readonly reason?: string;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): VerticalDeclarationBundle {
  const definition = decodeVerticalDefinition(input.definition),
    declaration: VerticalDeclarationDocumentV1 = {
      schema: "repository-vertical-declaration/v1",
      revision: input.workspaceRevision,
      definition,
    },
    body = `${JSON.stringify(declaration, null, 2)}\n`,
    claim = {
      path: VERTICAL_DECLARATION_PATH,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "application/json" as const,
      policyId: VERTICAL_DECLARATION_POLICY_ID,
    },
    event: VerticalDeclarationEventV1 = {
      schema: "vertical-declaration-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      entity: { kind: "vertical-declaration", id: "default" },
      type: input.type,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        declaration,
        kindId: input.kindId ?? null,
        reason: input.type === "vertical_kind_retired" ? (input.reason ?? null) : null,
        declarationDocumentClaim: claim,
      },
    };
  const errors = validateCurrentVerticalDeclarationEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return { event, plan: verticalDeclarationWritePlan(event), blobs: [{ ...claim, body }] };
}

export function parseVerticalDeclarationDocument(value: unknown): VerticalDeclarationDocumentV1 {
  if (
    !isRecord(value) ||
    value.schema !== "repository-vertical-declaration/v1" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw new Error("repository vertical declaration is invalid");
  return {
    schema: value.schema,
    revision: Number(value.revision),
    definition: decodeVerticalDefinition(value.definition),
  };
}

export function validateVerticalDeclarationEvent(value: unknown): readonly string[] {
  return validateVerticalDeclarationEventFields(value, true);
}

export function validateCurrentVerticalDeclarationEvent(value: unknown): readonly string[] {
  return validateVerticalDeclarationEventFields(value, false);
}

function validateVerticalDeclarationEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["schema", "eventId", "workspaceRevision", "opId", "entity", "type", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "vertical-declaration-event/v1" ||
    !["vertical_declared", "vertical_kind_upserted", "vertical_kind_retired"].includes(String(value.type)) ||
    !isRecord(value.entity) ||
    value.entity.kind !== "vertical-declaration" ||
    value.entity.id !== "default" ||
    !isRecord(value.payload) ||
    !isRecord(value.payload.declarationDocumentClaim)
  )
    return ["vertical declaration event envelope or payload is invalid"];
  try {
    const declaration = parseVerticalDeclarationDocumentForValidation(value.payload.declaration, allowUnknownFields),
      claim = value.payload.declarationDocumentClaim;
    if (
      declaration.revision !== value.workspaceRevision ||
      claim.path !== VERTICAL_DECLARATION_PATH ||
      claim.mediaType !== "application/json" ||
      claim.policyId !== VERTICAL_DECLARATION_POLICY_ID ||
      !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
      !Number.isSafeInteger(claim.size)
    )
      return ["vertical declaration claim is invalid"];
    if (
      value.type === "vertical_kind_retired" &&
      (typeof value.payload.reason !== "string" ||
        value.payload.reason.trim().length < 1 ||
        value.payload.reason.length > 199)
    )
      return ["vertical kind retirement reason must contain 1..199 characters"];
    if (value.type !== "vertical_kind_retired" && value.payload.reason !== null)
      return ["non-retirement vertical events must carry a null reason"];
  } catch {
    return ["vertical declaration snapshot is invalid"];
  }
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["vertical declaration event identity is invalid"]
    : [];
}

function parseVerticalDeclarationDocumentForValidation(
  value: unknown,
  allowUnknownFields: boolean,
): VerticalDeclarationDocumentV1 {
  if (
    !isRecord(value) ||
    value.schema !== "repository-vertical-declaration/v1" ||
    !Number.isSafeInteger(value.revision)
  )
    throw new Error("repository vertical declaration is invalid");
  return {
    schema: value.schema,
    revision: Number(value.revision),
    definition: allowUnknownFields
      ? decodeForwardCompatibleVerticalDefinition(value.definition)
      : decodeVerticalDefinition(value.definition),
  };
}

export function isVerticalDeclarationEvent(event: { readonly schema: string }): event is VerticalDeclarationEventV1 {
  return event.schema === "vertical-declaration-event/v1";
}

export function verticalDeclarationWritePlan(
  event: VerticalDeclarationEventV1,
): FrozenWritePlan<VerticalDeclarationEventType> {
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
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
      { kind: "projection_invalidation", projection: "entity/v1", key: "vertical-declaration/default" },
    ];
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, [
    "vertical_declared",
    "vertical_kind_upserted",
    "vertical_kind_retired",
  ]);
}

export function assertVerticalDeclarationEventInputs(
  event: VerticalDeclarationEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  const expected = verticalDeclarationWritePlan(event),
    shape = (candidate: FrozenWritePlan) =>
      stableStringify({ commandType: candidate.commandType, targets: candidate.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(expected))
    throw new Error("vertical declaration write plan is not exact");
  const claim = event.payload.declarationDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  if (!blob || blob.size !== claim.size || blob.mediaType !== claim.mediaType || sha256Text(blob.body) !== claim.sha256)
    throw new Error("vertical declaration blob must be exact");
  const parsed = parseVerticalDeclarationDocument(JSON.parse(blob.body));
  if (stableStringify(parsed) !== stableStringify(event.payload.declaration))
    throw new Error("vertical declaration blob does not match event snapshot");
}
