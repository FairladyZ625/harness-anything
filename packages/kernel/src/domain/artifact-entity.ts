import { sha256Bytes, sha256Text, stablePayloadHash } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import type {
  ArtifactEntityKindDefinition,
  EntityAttributeDeclaration,
  EntityKindSchemaVersion,
} from "../schemas/vertical-definition.ts";
import { artifactEntityIdPattern } from "./entity-ref.ts";
import {
  parseEntityJsonSchema,
  serializeEntityJsonSchema,
  type EntityDocumentJsonSchema,
} from "./entity-json-schema.ts";
import {
  genericAuthoring,
  genericEntityStore,
  noSdkExposure,
  type EntityKindContract,
  type EntityStoreKindContract,
} from "./entity-kind-registry.ts";
import { isRecord } from "./write-chain.contract.ts";

export const ARTIFACT_DESCRIPTOR_FIELDS = Object.freeze([
  "schema",
  "typeIdentity",
  "kindVersion",
  "entityId",
  "title",
  "locator",
  "contentVersion",
  "attributes",
  "source",
] as const);

/** Attribute values are pure JSON scalars: they describe the material, never how to act on it. */
export type ArtifactAttributeValue = string | number | boolean;

export type ArtifactLocatorKind = "repository-path" | "url" | "external-key";

export interface ArtifactLocator {
  readonly kind: ArtifactLocatorKind;
  readonly value: string;
}

export interface ArtifactDescriptor {
  readonly schema: string;
  /** The kind's stable opaque ref; it does not move when the kind is renamed or gains a schema version. */
  readonly typeIdentity: string;
  /** The immutable kind schema version this instance was accepted against. */
  readonly kindVersion: number;
  readonly entityId: string;
  readonly title: string;
  readonly locator: ArtifactLocator;
  readonly contentVersion: string;
  readonly attributes: Readonly<Record<string, ArtifactAttributeValue>>;
  readonly source: string;
}

export type ArtifactSourceIdentityInput =
  | {
      readonly kind: "repository-path";
      readonly repositoryId: string;
      readonly path: string;
    }
  | { readonly kind: "url"; readonly url: string }
  | {
      readonly kind: "external-key";
      readonly provider: string;
      readonly project: string;
      readonly externalKey: string;
    };

export type ArtifactContentWitness =
  | { readonly kind: "git-object"; readonly objectId: string }
  | { readonly kind: "external-revision"; readonly revision: string }
  | { readonly kind: "content"; readonly content: string | Uint8Array };

export interface ArtifactEntityContractSnapshot {
  readonly schema: "artifact-entity-contract/v1";
  readonly typeIdentity: string;
  /** The immutable kind schema version explicitly pinned when the event was accepted. */
  readonly kindVersion: number;
  readonly descriptorSchemaRef: string;
  readonly idPrefix: string;
  readonly pathTemplate: string;
  readonly locatorKinds: readonly ArtifactLocatorKind[];
}

export class ArtifactEntityContractError extends Error {
  readonly code = "invalid_artifact_entity";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactEntityContractError";
  }
}

export function canonicalSourceIdentity(input: ArtifactSourceIdentityInput): string {
  if (input.kind === "repository-path") {
    const repositoryId = requiredIdentityPart(input.repositoryId, "repositoryId"),
      documentPath = normalizeRelativeDocumentPath(input.path);
    return `repo:${repositoryId}:${documentPath}`;
  }
  if (input.kind === "url") return canonicalArtifactUrl(input.url);
  return [
    requiredIdentityPart(input.provider, "provider"),
    requiredIdentityPart(input.project, "project"),
    requiredIdentityPart(input.externalKey, "externalKey"),
  ].join(":");
}

export function canonicalArtifactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ArtifactEntityContractError("Artifact URL must be an absolute URL.");
  }
  if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:"))
    throw new ArtifactEntityContractError("Artifact URL must use http or https.");
  if (parsed.username || parsed.password)
    throw new ArtifactEntityContractError("Artifact URL must not contain credentials.");
  parsed.hash = "";
  const sorted = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
  );
  parsed.search = "";
  for (const [key, item] of sorted) parsed.searchParams.append(key, item);
  return parsed.toString();
}

/**
 * Mint one instance identity. The suffix is 128 bits of caller-supplied randomness, never a function of
 * the source: an entity keeps this identity when its file is renamed, moved, or re-pointed at another
 * source, and two entities that happen to hold identical bytes stay distinct. The domain validates the
 * shape and leaves the randomness to the application boundary so replay stays pure.
 */
export function mintArtifactEntityId(input: { readonly idPrefix: string; readonly randomBytes: Uint8Array }): string {
  const prefix = requiredIdentityPart(input.idPrefix, "idPrefix");
  if (!/^[A-Z][A-Z0-9]{0,15}$/u.test(prefix))
    throw new ArtifactEntityContractError("Artifact idPrefix must be an uppercase alphanumeric prefix.");
  if (input.randomBytes.byteLength !== ARTIFACT_ENTITY_ID_BYTES)
    throw new ArtifactEntityContractError(`Artifact entity identity needs ${ARTIFACT_ENTITY_ID_BYTES} random bytes.`);
  return `${prefix}-${Buffer.from(input.randomBytes).toString("hex")}`;
}

export const ARTIFACT_ENTITY_ID_BYTES = 16;

export function isArtifactEntityId(idPrefix: string, value: unknown): value is string {
  return typeof value === "string" && new RegExp(artifactEntityIdPattern(idPrefix), "u").test(value);
}

export function deriveArtifactContentVersion(witness: ArtifactContentWitness): string {
  if (witness.kind === "git-object") {
    const objectId = witness.objectId.trim().toLowerCase();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(objectId))
      throw new ArtifactEntityContractError("Git object id must be a 40- or 64-character hexadecimal digest.");
    return `git:${objectId}`;
  }
  if (witness.kind === "external-revision") return `revision:${requiredIdentityPart(witness.revision, "revision")}`;
  const bytes =
    typeof witness.content === "string"
      ? new TextEncoder().encode(normalizeArtifactText(witness.content))
      : witness.content;
  return `sha256:${sha256Bytes(bytes)}`;
}

/**
 * The descriptor contract of one pinned kind schema version. `attributes` is closed over exactly the
 * declared names of that version, so an instance accepted against version 1 keeps validating against
 * version 1 after version 2 is published, and a kind declared at runtime needs no source branch.
 */
export function artifactDescriptorSchema(
  artifact: Pick<ArtifactEntityKindDefinition, "descriptorSchemaRef" | "idPrefix" | "locatorKinds">,
  typeIdentity: string,
  schemaVersion: EntityKindSchemaVersion,
): EntityDocumentJsonSchema<ArtifactDescriptor> {
  return deepFreeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: artifactDescriptorSchemaId(artifact.descriptorSchemaRef, typeIdentity, schemaVersion.version),
    type: "object",
    properties: {
      schema: { type: "string", const: artifact.descriptorSchemaRef },
      typeIdentity: { type: "string", const: typeIdentity },
      kindVersion: { type: "integer", enum: [schemaVersion.version] },
      entityId: { type: "string", pattern: `^${artifact.idPrefix}-[a-f0-9]{32}$` },
      title: { type: "string", minLength: 1 },
      locator: {
        type: "object",
        properties: {
          kind: { type: "string", enum: artifact.locatorKinds },
          value: { type: "string", minLength: 1 },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
      contentVersion: { type: "string", minLength: 1 },
      attributes: attributesSchema(schemaVersion.attributes),
      source: { type: "string", minLength: 1 },
    },
    required: ARTIFACT_DESCRIPTOR_FIELDS,
    additionalProperties: false,
  });
}

export function artifactDescriptorSchemaId(descriptorSchemaRef: string, typeIdentity: string, version: number): string {
  return `${descriptorSchemaRef}#${typeIdentity}/v${version}`;
}

function attributesSchema(attributes: EntityKindSchemaVersion["attributes"]) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(
      Object.entries(attributes).map(([name, declaration]) => [name, attributeNode(declaration)]),
    ),
    required: Object.entries(attributes)
      .filter(([, declaration]) => declaration.required === true)
      .map(([name]) => name),
    additionalProperties: false,
  };
}

function attributeNode(declaration: EntityAttributeDeclaration) {
  return declaration.type === "string"
    ? { type: "string" as const, ...(declaration.enum ? { enum: [...declaration.enum] } : {}) }
    : { type: declaration.type, ...(declaration.enum ? { enum: [...declaration.enum] } : {}) };
}

export function decodeArtifactDescriptor(
  contract: Pick<EntityKindContract, "kind" | "schema">,
  value: unknown,
): ArtifactDescriptor {
  const descriptor = parseEntityJsonSchema(contract.schema, value, `${contract.kind} artifact descriptor`);
  if (!isArtifactDescriptor(descriptor))
    throw new ArtifactEntityContractError("Artifact descriptor fields do not match artifact-descriptor/v1.");
  const locator = canonicalArtifactLocator(descriptor.locator);
  if (locator.value !== descriptor.locator.value)
    throw new ArtifactEntityContractError("Artifact descriptor locator must already be canonical.");
  if (descriptor.typeIdentity !== contract.kind)
    throw new ArtifactEntityContractError("Artifact descriptor typeIdentity does not match its kind contract.");
  if (canonicalArtifactSourceIdentity(descriptor.source) !== descriptor.source)
    throw new ArtifactEntityContractError("Artifact descriptor source identity must already be canonical.");
  // `source` is a binding the center records, not a seed the identity is recomputed from: reading an entity
  // never re-derives its id, which is what lets a move keep the id while restating where the material came from.
  return deepFreeze({ ...descriptor, locator });
}

export function encodeArtifactDescriptor(
  contract: Pick<EntityKindContract, "kind" | "schema">,
  value: unknown,
): string {
  return serializeEntityJsonSchema(
    contract.schema,
    decodeArtifactDescriptor(contract, value),
    `${contract.kind} descriptor`,
  );
}

export function canonicalArtifactLocator(locator: ArtifactLocator): ArtifactLocator {
  if (locator.kind === "repository-path")
    return Object.freeze({ kind: locator.kind, value: normalizeRelativeDocumentPath(locator.value) });
  if (locator.kind === "url") return Object.freeze({ kind: locator.kind, value: canonicalArtifactUrl(locator.value) });
  return Object.freeze({ kind: locator.kind, value: canonicalExternalLocator(locator.value) });
}

export function artifactEntityContractSnapshot(input: {
  readonly declaration: Pick<
    ArtifactEntityKindDefinition,
    "descriptorSchemaRef" | "idPrefix" | "locatorKinds" | "store"
  >;
  readonly typeIdentity: string;
  readonly kindVersion: number;
}): ArtifactEntityContractSnapshot {
  return deepFreeze({
    schema: "artifact-entity-contract/v1",
    typeIdentity: input.typeIdentity,
    kindVersion: input.kindVersion,
    descriptorSchemaRef: input.declaration.descriptorSchemaRef,
    idPrefix: input.declaration.idPrefix,
    pathTemplate: input.declaration.store.pathTemplate,
    locatorKinds: [...input.declaration.locatorKinds] as ArtifactLocatorKind[],
  });
}

export function artifactEntityContractFromSnapshot(
  snapshot: unknown,
  allowUnknownFields = false,
): EntityStoreKindContract {
  const decoded = decodeArtifactEntityContractSnapshot(snapshot, allowUnknownFields),
    identity = Object.freeze({
      field: "entityId",
      pattern: artifactEntityIdPattern(decoded.idPrefix),
      refTemplate: `${decoded.typeIdentity}/{id}` as `${string}/{id}`,
    });
  return deepFreeze({
    kind: decoded.typeIdentity,
    id: identity,
    residency: { authored: "ledger" as const },
    relationEndpoint: { eligible: true as const },
    baseActions: ["pin", "unpin", "relate", "unrelate", "update", "archive", "explain"],
    // The event pins which kind schema version it was accepted against; the declared attribute names of
    // that version live in the kind record, which never rewrites a published version. Replaying an event
    // therefore checks the envelope and the pin, and leaves attribute admission to the kind contract.
    schema: deepFreeze({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: artifactDescriptorSchemaId(decoded.descriptorSchemaRef, decoded.typeIdentity, decoded.kindVersion),
      type: "object",
      properties: {
        schema: { type: "string", const: decoded.descriptorSchemaRef },
        typeIdentity: { type: "string", const: decoded.typeIdentity },
        kindVersion: { type: "integer", enum: [decoded.kindVersion] },
        entityId: { type: "string", pattern: `^${decoded.idPrefix}-[a-f0-9]{32}$` },
        title: { type: "string", minLength: 1 },
        locator: {
          type: "object",
          properties: {
            kind: { type: "string", enum: decoded.locatorKinds },
            value: { type: "string", minLength: 1 },
          },
          required: ["kind", "value"],
          additionalProperties: false,
        },
        contentVersion: { type: "string", minLength: 1 },
        attributes: { type: "object", properties: {}, required: [], additionalProperties: true },
        source: { type: "string", minLength: 1 },
      },
      required: ARTIFACT_DESCRIPTOR_FIELDS,
      additionalProperties: false,
    }),
    relations: { directions: [], edges: [] },
    canonicalProjection: { embeddedEvents: [], row: { idField: "entityId", ownerField: null } },
    actionCatalog: null,
    entityStore: genericEntityStore(decoded.pathTemplate),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  });
}

export function decodeArtifactEntityContractSnapshot(
  value: unknown,
  allowUnknownFields = false,
): ArtifactEntityContractSnapshot {
  if (!isRecord(value)) throw new ArtifactEntityContractError("Artifact entity contract snapshot is invalid.");
  if (!Object.hasOwn(value, "kindVersion") || !Number.isSafeInteger(value.kindVersion) || Number(value.kindVersion) < 1)
    throw new ArtifactEntityContractError(
      "Artifact entity contract snapshot kindVersion must be a positive safe integer.",
    );
  const fields = [
    "schema",
    "typeIdentity",
    "kindVersion",
    "descriptorSchemaRef",
    "idPrefix",
    "pathTemplate",
    "locatorKinds",
  ];
  if (
    (!allowUnknownFields && Object.keys(value).some((field) => !fields.includes(field))) ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.schema !== "artifact-entity-contract/v1" ||
    typeof value.typeIdentity !== "string" ||
    !value.typeIdentity ||
    typeof value.descriptorSchemaRef !== "string" ||
    !value.descriptorSchemaRef ||
    typeof value.idPrefix !== "string" ||
    !/^[A-Z][A-Z0-9]{0,15}$/u.test(value.idPrefix) ||
    typeof value.pathTemplate !== "string" ||
    value.pathTemplate.split("{id}").length !== 2 ||
    !Array.isArray(value.locatorKinds) ||
    value.locatorKinds.length === 0 ||
    value.locatorKinds.some((kind) => !(["repository-path", "url", "external-key"] as const).includes(kind as never)) ||
    new Set(value.locatorKinds).size !== value.locatorKinds.length
  )
    throw new ArtifactEntityContractError("Artifact entity contract snapshot is invalid.");
  normalizeRelativeDocumentPath(value.pathTemplate);
  return deepFreeze(value as unknown as ArtifactEntityContractSnapshot);
}

export function artifactObservationId(input: {
  readonly entityId: string;
  readonly locator: ArtifactLocator;
  readonly resolution: string;
}): string {
  const identity = `${input.entityId}\u0000${input.locator.kind}:${input.locator.value}\u0000${input.resolution}`;
  return `obs_${sha256(identity).slice(0, 24)}`;
}

/**
 * Import is idempotent on the *intent*, not on the instance it produces: the same source, locator and observed
 * content is one operation however many times it is presented. Keying this on the entity id would break the
 * moment identity became a mint instead of a hash of the path — a retry would mint a second id, compute a
 * second opId, and store a duplicate entity for the same material.
 *
 * The intent is scoped to the binding the source is living under. A source that has been released — its entity
 * deleted, or the binding moved to another source — has ended the import that claimed it, so presenting the same
 * bytes again is a *new* intent and must mint a new instance instead of replaying a receipt for an entity that
 * no longer exists. The generation is counted off the accepted release events of that one source, so a retry
 * inside the same generation still recomputes the original operation and returns the outcome it was accepted
 * with. It is written into the id so a reader can recompute the identity from the id alone.
 *
 * The intent is also scoped to the Kind it is presented under. One file can be material for a Research Note and
 * for an ADR at the same time, and those are two observations of it, not one: without the Kind in the identity
 * the second import recomputes the first Kind's operation and is refused as `is not the requested observation`.
 * The Kind is named by its stable identity, never by a display name or alias, so renaming a Kind leaves every
 * accepted operation recomputable.
 */
export function artifactImportOperationId(input: {
  readonly entityKind: string;
  readonly sourceIdentity: string;
  readonly locator: ArtifactLocator;
  readonly resolution: string;
  readonly bindingGeneration?: number;
}): string {
  const generation = input.bindingGeneration ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error(`source binding generation ${String(input.bindingGeneration)} is not a generation`);
  if (!input.entityKind) throw new Error("an import operation identity requires the Kind it is presented under");
  const scope = generation === 0 ? "" : `\u0000binding-generation:${generation}`,
    identity =
      `${input.entityKind}\u0000${input.sourceIdentity}\u0000` +
      `${input.locator.kind}:${input.locator.value}\u0000${input.resolution}${scope}`;
  return `entity-import-${sha256(identity).slice(0, 32)}${generation === 0 ? "" : `-b${generation}`}`;
}

/** The binding generation an import operation id was minted under, read back from the id itself. */
export function importBindingGeneration(opId: string): number {
  const match = /-b([1-9][0-9]{0,9})$/u.exec(opId);
  return match ? Number(match[1]) : 0;
}

/** The fence identifies the version being edited; the stated payload distinguishes competing intents at that
 * fence. Hash only mutation inputs, with stable object ordering so transport key order does not change a retry. */
export function artifactMutationOperationId(input: {
  readonly mutation: "update" | "archive" | "delete";
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly request: Readonly<Record<string, unknown>>;
}): string {
  const fields =
      input.mutation === "update"
        ? ["entityKind", "title", "locator", "contentVersion", "attributes"]
        : ["entityKind", "reason"],
    intent = Object.fromEntries(
      fields.filter((key) => input.request[key] !== undefined).map((key) => [key, input.request[key]]),
    );
  return `entity-${input.mutation}-${input.entityId}-${input.expectedVersion}-${stablePayloadHash(intent)}`;
}

export function isArtifactMutationOperationId(
  mutation: "update" | "archive" | "delete",
  entityId: string,
  opId: string,
): boolean {
  const prefix = `entity-${mutation}-${entityId}-`;
  return opId.startsWith(prefix) && /^(?:0|[1-9][0-9]*)-[a-f0-9]{64}$/u.test(opId.slice(prefix.length));
}

function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return (
    isRecord(value) &&
    ARTIFACT_DESCRIPTOR_FIELDS.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => (ARTIFACT_DESCRIPTOR_FIELDS as readonly string[]).includes(field)) &&
    typeof value.schema === "string" &&
    typeof value.typeIdentity === "string" &&
    Number.isSafeInteger(value.kindVersion) &&
    Number(value.kindVersion) >= 1 &&
    typeof value.entityId === "string" &&
    typeof value.title === "string" &&
    typeof value.contentVersion === "string" &&
    isRecord(value.attributes) &&
    Object.values(value.attributes).every(
      (attribute) => typeof attribute === "string" || typeof attribute === "number" || typeof attribute === "boolean",
    ) &&
    typeof value.source === "string" &&
    isRecord(value.locator) &&
    typeof value.locator.kind === "string" &&
    typeof value.locator.value === "string"
  );
}

function canonicalExternalLocator(value: string): string {
  const parts = value.split(":");
  if (parts.length < 3)
    throw new ArtifactEntityContractError("External locator must be provider:project:external-key.");
  return [
    requiredIdentityPart(parts[0], "provider"),
    requiredIdentityPart(parts[1], "project"),
    requiredIdentityPart(parts.slice(2).join(":"), "externalKey"),
  ].join(":");
}

export function canonicalArtifactSourceIdentity(value: string): string {
  if (value.startsWith("repo:")) {
    const separator = value.indexOf(":", "repo:".length);
    if (separator < 0) throw new ArtifactEntityContractError("Repository source identity is incomplete.");
    return canonicalSourceIdentity({
      kind: "repository-path",
      repositoryId: value.slice("repo:".length, separator),
      path: value.slice(separator + 1),
    });
  }
  if (/^https?:\/\//iu.test(value)) return canonicalArtifactUrl(value);
  return canonicalExternalLocator(value);
}

function requiredIdentityPart(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000\r\n]/u.test(value))
    throw new ArtifactEntityContractError(`Artifact ${label} must be a non-empty canonical string.`);
  return value;
}

function normalizeArtifactText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function sha256(value: string): string {
  return sha256Text(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
