import { sha256Bytes, sha256Text } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import type { ArtifactEntityKindDefinition } from "../schemas/vertical-definition.ts";
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
  "entityId",
  "title",
  "locator",
  "contentVersion",
  "source",
] as const);

export type ArtifactLocatorKind = "repository-path" | "url" | "external-key";

export interface ArtifactLocator {
  readonly kind: ArtifactLocatorKind;
  readonly value: string;
}

export interface ArtifactDescriptor {
  readonly schema: string;
  readonly typeIdentity: string;
  readonly entityId: string;
  readonly title: string;
  readonly locator: ArtifactLocator;
  readonly contentVersion: string;
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

export function deriveArtifactEntityId(input: {
  readonly idPrefix: string;
  readonly typeIdentity: string;
  readonly sourceIdentity: string;
}): string {
  const prefix = requiredIdentityPart(input.idPrefix, "idPrefix"),
    sourceIdentity = requiredIdentityPart(input.sourceIdentity, "sourceIdentity"),
    digest = sha256(sourceIdentity).slice(0, 16);
  requiredIdentityPart(input.typeIdentity, "typeIdentity");
  return `${prefix}-${digest}`;
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

export function artifactDescriptorSchema(
  artifact: Pick<ArtifactEntityKindDefinition, "descriptorSchemaRef" | "idPrefix" | "locatorKinds">,
  typeIdentity: string,
): EntityDocumentJsonSchema<ArtifactDescriptor> {
  return deepFreeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${artifact.descriptorSchemaRef}#${typeIdentity}`,
    type: "object",
    properties: {
      schema: { type: "string", const: artifact.descriptorSchemaRef },
      typeIdentity: { type: "string", const: typeIdentity },
      entityId: { type: "string", pattern: `^${artifact.idPrefix}-[a-f0-9]{16}$` },
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
      source: { type: "string", minLength: 1 },
    },
    required: ARTIFACT_DESCRIPTOR_FIELDS,
    additionalProperties: false,
  });
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
  const prefix = descriptor.entityId.slice(0, descriptor.entityId.indexOf("-")),
    expected = deriveArtifactEntityId({
      idPrefix: prefix,
      typeIdentity: descriptor.typeIdentity,
      sourceIdentity: descriptor.source,
    });
  if (descriptor.entityId !== expected)
    throw new ArtifactEntityContractError("Artifact descriptor entityId does not match its immutable source identity.");
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
}): ArtifactEntityContractSnapshot {
  return deepFreeze({
    schema: "artifact-entity-contract/v1",
    typeIdentity: input.typeIdentity,
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
    baseActions: ["pin", "unpin", "relate", "unrelate", "archive", "explain"],
    schema: artifactDescriptorSchema(
      {
        descriptorSchemaRef: decoded.descriptorSchemaRef,
        idPrefix: decoded.idPrefix,
        locatorKinds: decoded.locatorKinds,
      },
      decoded.typeIdentity,
    ),
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
  const fields = ["schema", "typeIdentity", "descriptorSchemaRef", "idPrefix", "pathTemplate", "locatorKinds"];
  if (
    !isRecord(value) ||
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

export function artifactImportOperationId(input: {
  readonly entityId: string;
  readonly locator: ArtifactLocator;
  readonly resolution: string;
}): string {
  const identity = `${input.entityId}\u0000${input.locator.kind}:${input.locator.value}\u0000${input.resolution}`;
  return `entity-import-${sha256(identity).slice(0, 32)}`;
}

function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return (
    isRecord(value) &&
    ARTIFACT_DESCRIPTOR_FIELDS.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => (ARTIFACT_DESCRIPTOR_FIELDS as readonly string[]).includes(field)) &&
    typeof value.schema === "string" &&
    typeof value.typeIdentity === "string" &&
    typeof value.entityId === "string" &&
    typeof value.title === "string" &&
    typeof value.contentVersion === "string" &&
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
