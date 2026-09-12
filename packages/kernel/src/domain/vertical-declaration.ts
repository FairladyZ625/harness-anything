import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  decodeForwardCompatibleVerticalDefinition,
  decodeVerticalDefinition,
  type ArtifactEntityKindDefinition,
  type VerticalDefinition,
} from "../schemas/vertical-definition.ts";
import { ENTITY_KIND_ID_PATTERN, entityKindRef } from "./entity-ref.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isFrozenWritePlan,
  sameWriteTargets,
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

export interface VerticalDeclarationReadV1 {
  readonly schema: "repository-vertical-declaration-read/v1";
  readonly declarationRevision: number;
  readonly declaration: VerticalDefinition;
}

export const VERTICAL_DECLARATION_READ_SCHEMA = Object.freeze({
  id: "repository-vertical-declaration-read/v1",
  required: Object.freeze(["schema", "declarationRevision", "declaration"]),
});

export class VerticalDeclarationReadContractError extends Error {}

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

export type VerticalKindCommandKind = "upsert" | "publish-schema" | "retire";

export interface VerticalKindCommandResult {
  readonly definition: VerticalDefinition;
  /** The kind's stable opaque ref, unchanged by rename, schema publication and archive. */
  readonly kindRef: string;
  /** The kind's newest published schema version after the command. */
  readonly kindVersion: number;
}

/**
 * The one authority over declared Kind metadata. A Kind is minted once with an opaque identity and an
 * immutable version 1 of its attribute schema; later commands publish further versions, rewrite the
 * mutable facets, or archive it. Nothing here can rewrite a published version or move an identity, so
 * an instance that pinned version 1 keeps reading version 1 for the life of the ledger.
 */
export function applyVerticalKindCommand(input: {
  readonly definition: VerticalDefinition;
  /** The canonical revision this command would be accepted at; it becomes the touched Kind's fence. */
  readonly acceptedRevision: number;
  readonly expectedVersion: number;
  readonly kind: VerticalKindCommandKind;
  readonly kindId: string;
  /** Center-minted opaque identity, required only when the command creates the Kind. */
  readonly mintedKindId?: string;
  readonly declaration?: unknown;
  readonly attributes?: unknown;
  readonly retiredAt?: string;
  readonly reason?: string;
}): VerticalKindCommandResult {
  const requested = input.kindId.trim();
  if (!requested) verticalError("missing_field", "Vertical kind action requires kindId.");
  const index = input.definition.entityKinds.findIndex((candidate) => matchesKind(candidate, requested)),
    current = index < 0 ? null : input.definition.entityKinds[index]!;
  if (current && current.entityType !== "artifact")
    verticalError("invalid_field", `Vertical kind ${requested} is not a declared Artifact kind.`);
  const artifact = current as ArtifactEntityKindDefinition | null,
    existing = (): ArtifactEntityKindDefinition =>
      artifact ?? verticalError("entity_not_found", `Vertical kind ${requested} does not exist.`);
  if (input.kind !== "upsert") existing();
  // A Kind is its own concurrency subject: the fence is the revision that Kind was last accepted at,
  // so writing a sibling Kind never stales it. `expectedVersion: 0` is the intent to create, which an
  // existing Kind answers by name rather than as a stale fence.
  if (artifact && input.kind === "upsert" && input.expectedVersion === 0)
    verticalError("kind_exists", `Vertical kind ${artifact.id} already exists.`);
  const fence = artifact ? acceptedRevision(artifact) : 0;
  if (input.expectedVersion !== fence)
    verticalError(
      "revision_conflict",
      `Vertical kind ${requested} expected revision ${input.expectedVersion}, current revision is ${fence}.`,
    );

  if (input.kind === "retire") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 1 || reason.length > 199)
      verticalError("invalid_field", "Vertical kind retirement reason must contain 1..199 characters.");
    if (!input.retiredAt) verticalError("missing_field", "Vertical kind retirement requires retiredAt.");
    const retired = accept(existing(), { retired: true, retiredAt: input.retiredAt, reason }, input.acceptedRevision);
    return kindResult(replaceKind(input.definition, index, retired), retired);
  }

  if (input.kind === "publish-schema") {
    const target = existing();
    if (target.retired === true)
      verticalError("kind_retired", `Vertical kind ${target.id} is archived and accepts no new schema version.`);
    const published = [...target.schemaVersions],
      next = {
        version: published.length + 1,
        attributes: attributeDeclarations(input.attributes),
      } as unknown as ArtifactEntityKindDefinition["schemaVersions"][number],
      republished = accept(target, { schemaVersions: [...published, next] }, input.acceptedRevision);
    return kindResult(replaceKind(input.definition, index, republished), republished);
  }

  if (!isRecord(input.declaration)) verticalError("invalid_field", "Vertical kind declaration must be an object.");
  const {
    attributes,
    kindId: declaredKindId,
    schemaVersions: declaredVersions,
    revision: declaredRevision,
    ...facets
  } = input.declaration;
  if (!artifact) {
    if (declaredRevision !== undefined)
      verticalError("invalid_field", "A new vertical kind may not choose the revision it is accepted at.");
    if (declaredVersions !== undefined)
      verticalError(
        "invalid_field",
        "A new vertical kind states its attributes; its schema version list is minted by the center.",
      );
    const mintedKindId = String(input.mintedKindId ?? "");
    if (!new RegExp(`^${ENTITY_KIND_ID_PATTERN}$`, "u").test(mintedKindId))
      verticalError("missing_field", "Creating a vertical kind requires a minted opaque kind id.");
    if (declaredKindId !== undefined)
      verticalError("invalid_field", "A new vertical kind may not choose its own opaque kind id.");
    const created = {
      ...facets,
      kindId: mintedKindId,
      revision: input.acceptedRevision,
      schemaVersions: [{ version: 1, attributes: attributeDeclarations(attributes) }],
    } as unknown as ArtifactEntityKindDefinition;
    return kindResult(
      decodeVerticalDefinition({ ...input.definition, entityKinds: [...input.definition.entityKinds, created] }),
      created,
    );
  }
  if (declaredKindId !== undefined && declaredKindId !== artifact.kindId)
    verticalError("destructive_kind_change", "A vertical kind keeps the opaque identity it was minted with.");
  // A caller may restate the revision it read back, but restating an older one is a stale write.
  if (declaredRevision !== undefined && declaredRevision !== artifact.revision)
    verticalError(
      "revision_conflict",
      `Vertical kind ${artifact.id} was read at revision ${String(declaredRevision)}, ` +
        `current revision is ${acceptedRevision(artifact)}.`,
    );
  const declaredIdPrefix = facets.idPrefix,
    declaredPathTemplate = isRecord(facets.store) ? facets.store.pathTemplate : undefined;
  if (declaredIdPrefix !== undefined && declaredIdPrefix !== artifact.idPrefix)
    verticalError("destructive_kind_change", "idPrefix is immutable because existing entity ids depend on it.");
  if (declaredPathTemplate !== undefined && declaredPathTemplate !== artifact.store.pathTemplate)
    verticalError(
      "destructive_kind_change",
      "store.pathTemplate is immutable because existing entity documents depend on it.",
    );
  // A restated declaration may carry the versions it read back, but it can never change one: a
  // published interpretation is what the instances pinned to it are still validated against.
  if (
    (attributes !== undefined &&
      stableStringify(attributeDeclarations(attributes)) !== stableStringify(latest(artifact).attributes)) ||
    (declaredVersions !== undefined && stableStringify(declaredVersions) !== stableStringify(artifact.schemaVersions))
  )
    verticalError(
      "immutable_schema_version",
      `Schema version ${latest(artifact).version} of ${artifact.id} is published; ` +
        "publish a new version instead of rewriting it.",
    );
  const restated = accept(
    artifact,
    { ...facets, kindId: artifact.kindId, schemaVersions: [...artifact.schemaVersions] },
    input.acceptedRevision,
    true,
  );
  return kindResult(replaceKind(input.definition, index, restated), restated);
}

/** The revision a Kind's next writer must present. Every accepted row carries one; see the schema. */
function acceptedRevision(artifact: ArtifactEntityKindDefinition): number {
  return artifact.revision ?? 0;
}

/**
 * Stamp the Kind with the revision it is being accepted at — but only when the command actually
 * changes it. A restatement that alters nothing leaves the fence where it was, so an idempotent retry
 * stays a no-op instead of appending an event and invalidating every fence a caller already holds.
 */
function accept(
  artifact: ArtifactEntityKindDefinition,
  change: Record<string, unknown>,
  acceptedAt: number,
  replaceFacets = false,
): ArtifactEntityKindDefinition {
  const next = { ...(replaceFacets ? {} : artifact), ...change } as unknown as ArtifactEntityKindDefinition;
  return { ...next, revision: kindFacets(next) === kindFacets(artifact) ? artifact.revision : acceptedAt };
}

/** Everything about a Kind row except the fence, compared the way the stored document would be. */
function kindFacets(row: ArtifactEntityKindDefinition): string {
  return stableStringify(
    Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== "revision" && value !== undefined)),
  );
}

function matchesKind(candidate: VerticalDefinition["entityKinds"][number], requested: string): boolean {
  if (candidate.entityType !== "artifact") return candidate.id === requested;
  return candidate.kindId === requested || entityKindRef(candidate.kindId) === requested || candidate.id === requested;
}

function replaceKind(
  definition: VerticalDefinition,
  index: number,
  next: ArtifactEntityKindDefinition,
): VerticalDefinition {
  const entityKinds = [...definition.entityKinds];
  entityKinds[index] = next;
  return decodeVerticalDefinition({ ...definition, entityKinds });
}

function kindResult(definition: VerticalDefinition, artifact: ArtifactEntityKindDefinition): VerticalKindCommandResult {
  return { definition, kindRef: entityKindRef(artifact.kindId), kindVersion: latest(artifact).version };
}

function latest(artifact: ArtifactEntityKindDefinition): ArtifactEntityKindDefinition["schemaVersions"][number] {
  return [...artifact.schemaVersions].sort((left, right) => left.version - right.version).at(-1)!;
}

/**
 * Attribute declarations are accepted as a plain map so a caller declares values, never behaviour.
 * Unsupported constructs are refused here rather than at the caller's first import.
 */
function attributeDeclarations(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) verticalError("invalid_field", "Vertical kind attributes must be an object.");
  return value;
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
  const definition = stampAcceptedRevisions(decodeVerticalDefinition(input.definition), input.workspaceRevision),
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

/**
 * A declaration only becomes installed Kind state when an event accepts it, so that event is where a
 * Kind first gets a fence. Rows accepted earlier keep theirs: declaring is not a reason to invalidate
 * a revision every other caller is already holding.
 */
function stampAcceptedRevisions(definition: VerticalDefinition, workspaceRevision: number): VerticalDefinition {
  return {
    ...definition,
    entityKinds: definition.entityKinds.map((candidate) =>
      candidate.entityType === "artifact" && candidate.revision === undefined
        ? { ...candidate, revision: workspaceRevision }
        : candidate,
    ),
  };
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

export function buildVerticalDeclarationRead(document: VerticalDeclarationDocumentV1): VerticalDeclarationReadV1 {
  return {
    schema: "repository-vertical-declaration-read/v1",
    declarationRevision: document.revision,
    declaration: document.definition,
  };
}

export function validateVerticalDeclarationRead(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.schema !== "repository-vertical-declaration-read/v1" ||
    !Number.isSafeInteger(value.declarationRevision) ||
    Number(value.declarationRevision) < 1
  )
    return ["repository vertical declaration read envelope is invalid"];
  try {
    decodeVerticalDefinition(value.declaration);
    return [];
  } catch (error) {
    void error;
    return ["repository vertical declaration read declaration is invalid"];
  }
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
  const expected = verticalDeclarationWritePlan(event);
  if (
    !plan ||
    !isFrozenWritePlan(plan) ||
    plan.commandType !== expected.commandType ||
    !sameWriteTargets(plan.targets, expected.targets)
  )
    throw new Error("vertical declaration write plan is not exact");
  const claim = event.payload.declarationDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  if (!blob) throw new Error("vertical declaration blob must be exact");
  const parsed = parseVerticalDeclarationDocument(JSON.parse(blob.body));
  if (stableStringify(parsed) !== stableStringify(event.payload.declaration))
    throw new Error("vertical declaration blob does not match event snapshot");
}
