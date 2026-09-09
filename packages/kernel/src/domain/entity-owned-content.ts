import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { hasOnlyFields, isRecord, normalizeContentAddressedInputs } from "./write-chain.contract.ts";

export const ENTITY_OWNED_CONTENT_SCHEMA = "entity-owned-content/v1";
export const MAX_ENTITY_CONTENT_OBJECT_BYTES = 50_000_000;

export interface EntityContentObjectRef {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface EntityContentBinding {
  readonly path: string;
  readonly contentSha256: string;
  readonly policyId: string;
}

export interface EntityContentRetirement {
  readonly path: string;
  readonly baseBlobSha256: string;
}

/**
 * A directory the entity owns that holds no file of its own. Git has no empty-tree entry, so the only
 * durable record of such a directory is this manifest; materialization recreates it from here rather
 * than from an invented placeholder file.
 */
export interface EntityContentDirectory {
  readonly path: string;
}

export interface EntityOwnedContentV1 {
  readonly schema: typeof ENTITY_OWNED_CONTENT_SCHEMA;
  readonly ownerRef: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly content: readonly EntityContentObjectRef[];
  readonly bindings: readonly EntityContentBinding[];
  readonly directories: readonly EntityContentDirectory[];
  readonly retirements: readonly EntityContentRetirement[];
}

export function entitySchemaVersion(schemaId: string): number {
  const match = /(?:\/v|@)([1-9][0-9]*)$/u.exec(schemaId);
  if (!match) throw new Error(`entity schema id ${schemaId} has no positive version`);
  return Number(match[1]);
}

export function createEntityOwnedContent(input: {
  readonly ownerRef: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly bindings: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly policyId: string;
  }[];
  readonly directories?: readonly EntityContentDirectory[];
  readonly retirements?: readonly EntityContentRetirement[];
}): EntityOwnedContentV1 {
  const content = normalizeContentAddressedInputs(input.bindings)
      .map(({ sha256, size: byteLength, mediaType }) => ({ sha256, byteLength, mediaType }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
    manifest: EntityOwnedContentV1 = {
      schema: ENTITY_OWNED_CONTENT_SCHEMA,
      ownerRef: input.ownerRef,
      schemaId: input.schemaId,
      schemaVersion: input.schemaVersion,
      content,
      bindings: input.bindings
        .map(({ path, sha256: contentSha256, policyId }) => ({
          path: normalizeRelativeDocumentPath(path),
          contentSha256,
          policyId,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      directories: (input.directories ?? [])
        .map(({ path }) => ({ path: normalizeRelativeDocumentPath(path) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      retirements: (input.retirements ?? [])
        .map(({ path, baseBlobSha256 }) => ({ path: normalizeRelativeDocumentPath(path), baseBlobSha256 }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
    errors = validateEntityOwnedContent(manifest);
  if (errors.length) throw new Error(errors.join("; "));
  return Object.freeze({
    ...manifest,
    content: Object.freeze(manifest.content.map((entry) => Object.freeze(entry))),
    bindings: Object.freeze(manifest.bindings.map((entry) => Object.freeze(entry))),
    directories: Object.freeze(manifest.directories.map((entry) => Object.freeze(entry))),
    retirements: Object.freeze(manifest.retirements.map((entry) => Object.freeze(entry))),
  });
}

export function validateEntityOwnedContent(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      "schema",
      "ownerRef",
      "schemaId",
      "schemaVersion",
      "content",
      "bindings",
      "directories",
      "retirements",
    ]) ||
    value.schema !== ENTITY_OWNED_CONTENT_SCHEMA ||
    typeof value.ownerRef !== "string" ||
    !/^[^/]+(?:\/[^/]+)+$/u.test(value.ownerRef) ||
    typeof value.schemaId !== "string" ||
    !value.schemaId ||
    !Number.isSafeInteger(value.schemaVersion) ||
    Number(value.schemaVersion) < 1 ||
    !Array.isArray(value.content) ||
    !Array.isArray(value.bindings) ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.retirements)
  )
    return ["entity owned-content manifest is invalid"];
  const content = value.content as unknown[],
    bindings = value.bindings as unknown[],
    directories = value.directories as unknown[],
    retirements = value.retirements as unknown[],
    contentErrors = content.flatMap(validateContentObject),
    bindingErrors = bindings.flatMap(validateBinding),
    directoryErrors = directories.flatMap(validateDirectory),
    retirementErrors = retirements.flatMap(validateRetirement);
  if (contentErrors.length || bindingErrors.length || directoryErrors.length || retirementErrors.length)
    return [...contentErrors, ...bindingErrors, ...directoryErrors, ...retirementErrors];
  const contentRefs = content as unknown as readonly EntityContentObjectRef[],
    contentByHash = new Map(contentRefs.map((entry) => [entry.sha256, entry])),
    bindingRows = bindings as unknown as readonly EntityContentBinding[],
    directoryRows = directories as unknown as readonly EntityContentDirectory[],
    retirementRows = retirements as unknown as readonly EntityContentRetirement[];
  if (contentByHash.size !== contentRefs.length) return ["entity content object hashes must be unique"];
  if (new Set(bindingRows.map(({ path }) => path.toLocaleLowerCase("en-US"))).size !== bindingRows.length)
    return ["entity content binding paths must be unique"];
  if (new Set(retirementRows.map(({ path }) => path.toLocaleLowerCase("en-US"))).size !== retirementRows.length)
    return ["entity content retirement paths must be unique"];
  if (bindingRows.some(({ contentSha256 }) => !contentByHash.has(contentSha256)))
    return ["entity content binding must reference a declared content object"];
  if (new Set(directoryRows.map(({ path }) => path.toLocaleLowerCase("en-US"))).size !== directoryRows.length)
    return ["entity content directory paths must be unique"];
  const bound = new Set(bindingRows.map(({ path }) => path.toLocaleLowerCase("en-US")));
  // A directory that also holds a bound file is already implied by that file; recording it separately would
  // let one manifest state two different reasons for the same path to exist.
  if (
    directoryRows.some(
      ({ path }) =>
        bound.has(path.toLocaleLowerCase("en-US")) ||
        [...bound].some((file) => file.startsWith(`${path.toLocaleLowerCase("en-US")}/`)),
    )
  )
    return ["entity content directory must not contain a bound file"];
  const retired = new Set(retirementRows.map(({ path }) => path.toLocaleLowerCase("en-US")));
  return bindingRows.some(({ path }) => retired.has(path.toLocaleLowerCase("en-US")))
    ? ["entity content cannot bind and retire the same path"]
    : [];
}

export function entityOwnedDirectories(manifest: EntityOwnedContentV1): readonly string[] {
  return manifest.directories.map(({ path }) => path);
}

export function entityOwnedContentClaims(manifest: EntityOwnedContentV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  return manifest.content.map(({ sha256, byteLength: size, mediaType }) => ({ sha256, size, mediaType }));
}

export function entityOwnedDocumentClaims(manifest: EntityOwnedContentV1): readonly {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: string;
}[] {
  const content = new Map(manifest.content.map((entry) => [entry.sha256, entry]));
  return manifest.bindings.map(({ path, contentSha256, policyId }) => {
    const object = content.get(contentSha256);
    if (!object) throw new Error(`entity content object ${contentSha256} is unavailable in its manifest`);
    return { path, sha256: object.sha256, size: object.byteLength, mediaType: object.mediaType, policyId };
  });
}

function validateContentObject(value: unknown): readonly string[] {
  return isRecord(value) &&
    hasOnlyFields(value, ["sha256", "byteLength", "mediaType"]) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    Number(value.byteLength) <= MAX_ENTITY_CONTENT_OBJECT_BYTES &&
    typeof value.mediaType === "string" &&
    value.mediaType.length > 0
    ? []
    : ["entity content object reference is invalid"];
}

function validateBinding(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["path", "contentSha256", "policyId"]) ||
    typeof value.path !== "string" ||
    typeof value.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentSha256) ||
    typeof value.policyId !== "string" ||
    !value.policyId
  )
    return ["entity content binding is invalid"];
  try {
    return normalizeRelativeDocumentPath(value.path) === value.path
      ? []
      : ["entity content binding path is not canonical"];
  } catch {
    return ["entity content binding path is invalid"];
  }
}

function validateDirectory(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["path"]) || typeof value.path !== "string")
    return ["entity content directory is invalid"];
  try {
    return normalizeRelativeDocumentPath(value.path) === value.path
      ? []
      : ["entity content directory path is not canonical"];
  } catch {
    return ["entity content directory path is invalid"];
  }
}

function validateRetirement(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["path", "baseBlobSha256"]) ||
    typeof value.path !== "string" ||
    typeof value.baseBlobSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.baseBlobSha256)
  )
    return ["entity content retirement is invalid"];
  try {
    return normalizeRelativeDocumentPath(value.path) === value.path
      ? []
      : ["entity content retirement path is not canonical"];
  } catch {
    return ["entity content retirement path is invalid"];
  }
}
