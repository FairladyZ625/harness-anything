import path from "node:path";
import {
  consumeKnownError,
  entityContentPath,
  entityContentRoot,
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  type EntityOwnedContentV1,
  type EntityStoreKindContract,
} from "../../kernel/src/index.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

/**
 * Reading what an entity itself owns, by identity (E5 consumer gap 2).
 *
 * `repo.entity.locator.read` reads the *source* a locator points at, addressed from the repository root. Once a
 * source is imported the bytes belong to the entity, and the manifest states their paths relative to the
 * **authored root** — which is configurable (`authoredRoot` in `harness.yaml`, default `harness`). Joining a
 * locator onto the repository root therefore never reaches owned content, and hard-coding a `harness/` prefix
 * would tell a user with a configured authored root that their bytes are gone.
 *
 * So this read knows only two things: an entity identity, and the owned-content manifest that entity was
 * accepted with. Bytes come from the content-addressed objects in canonical storage, never from the working
 * copy, so deleting the source after an import leaves the accepted content readable. The result states the
 * `repositoryPath` this content materializes at under the *current* configuration, so no renderer has to — or
 * is allowed to — assemble that path itself.
 */
export const ENTITY_CONTENT_READ_SCHEMA = "entity-content-read/v1" as const;

/** Per-object text ceiling, the same order as the locator read: over it, a typed result instead of bytes. */
export const ENTITY_CONTENT_READ_MAX_BYTES = 2 * 1024 * 1024;

/** One directory level at a time, truncated and stated rather than silently dropped. */
export const ENTITY_CONTENT_READ_MAX_ENTRIES = 500;

/** A NUL inside otherwise valid UTF-8 is still not text a renderer should be handed. */
const NUL = "\u0000";

export class EntityContentReadContractError extends Error {
  readonly code = "invalid_result";
  constructor(message: string) {
    super(message);
    this.name = "EntityContentReadContractError";
  }
}

export type EntityContentOutcome = "file" | "directory" | "missing" | "too-large" | "binary";

export interface EntityContentEntryV1 {
  /** Entity-relative path; the entity content root itself is the empty string. */
  readonly path: string;
  readonly directory: boolean;
  readonly sizeBytes: number | null;
}

export interface EntityContentReadV1 {
  readonly schema: typeof ENTITY_CONTENT_READ_SCHEMA;
  readonly ok: true;
  readonly outcome: EntityContentOutcome;
  readonly entityRef: string;
  readonly path: string;
  /** Where this content materializes in the repository under the configured authored root. */
  readonly repositoryPath: string;
  readonly content: string | null;
  readonly sizeBytes: number | null;
  readonly mediaType: string | null;
  readonly entries: readonly EntityContentEntryV1[];
  readonly truncated: boolean;
}

export interface EntityContentSource {
  /** The Kind's stable identity, as the entity ref names it. */
  readonly entityKind: string;
  readonly contract: EntityStoreKindContract;
  readonly entityId: string;
  readonly ownedContent: EntityOwnedContentV1 | null;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
}

export function readEntityContent(input: {
  readonly rootDir: string;
  readonly source: EntityContentSource | null;
  readonly requestedPath?: string | undefined;
  readonly maxBytes?: number;
}): EntityContentReadV1 {
  const relative = input.requestedPath === undefined ? "" : normalizeRelativeDocumentPath(input.requestedPath);
  if (!input.source) return contentResult("missing", "", relative, "");
  const { contract, entityId, ownedContent } = input.source,
    entityRef = `${input.source.entityKind}/${entityId}`,
    contentRoot = entityContentRoot(contract, entityId),
    manifestPath = relative ? entityContentPath(contract, entityId, relative) : contentRoot,
    repositoryPath = `${authoredRootPrefix(input.rootDir)}${manifestPath}`;
  if (!ownedContent) return contentResult("missing", entityRef, relative, repositoryPath);

  const bindings = ownedContent.bindings.filter(({ path: bound }) => inside(bound, contentRoot)),
    sizeOf = new Map(ownedContent.content.map(({ sha256, byteLength }) => [sha256, byteLength] as const)),
    mediaOf = new Map(ownedContent.content.map(({ sha256, mediaType }) => [sha256, mediaType] as const)),
    file = bindings.find(({ path: bound }) => bound === manifestPath);
  if (file) {
    const size = sizeOf.get(file.contentSha256),
      maxBytes = input.maxBytes ?? ENTITY_CONTENT_READ_MAX_BYTES,
      base = {
        ...contentResult("file", entityRef, relative, repositoryPath),
        sizeBytes: size ?? null,
        mediaType: mediaOf.get(file.contentSha256) ?? null,
      };
    if (size !== undefined && size > maxBytes) return { ...base, outcome: "too-large" };
    const bytes = input.source.readContentBlob(file.contentSha256);
    if (!bytes) return { ...base, outcome: "missing", sizeBytes: null, mediaType: null };
    base.sizeBytes = size ?? bytes.byteLength;
    if (bytes.byteLength > maxBytes) return { ...base, outcome: "too-large" };
    const text = decodeUtf8(bytes);
    return text === null || text.includes(NUL) ? { ...base, outcome: "binary" } : { ...base, content: text };
  }

  // Every directory the entity holds: the ones it declared with no file of its own, plus the ones its own
  // bindings imply. Nothing physical on disk is consulted, so a directory a user created is never listed here.
  const directories = new Set<string>([contentRoot, ...ownedContent.directories.map(({ path: held }) => held)]);
  for (const { path: bound } of bindings) {
    let parent = bound.slice(0, bound.lastIndexOf("/"));
    while (parent === contentRoot || inside(parent, contentRoot)) {
      directories.add(parent);
      if (parent === contentRoot) break;
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  if (!directories.has(manifestPath)) return contentResult("missing", entityRef, relative, repositoryPath);

  const children: EntityContentEntryV1[] = [
    ...bindings
      .filter(({ path: bound }) => isChild(bound, manifestPath))
      .map(({ path: bound, contentSha256 }) => ({
        path: entityRelative(bound, contentRoot),
        directory: false,
        sizeBytes: sizeOf.get(contentSha256) ?? null,
      })),
    ...[...directories]
      .filter((candidate) => isChild(candidate, manifestPath))
      .map((candidate) => ({ path: entityRelative(candidate, contentRoot), directory: true, sizeBytes: null })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const kept = children.slice(0, ENTITY_CONTENT_READ_MAX_ENTRIES);
  return {
    ...contentResult("directory", entityRef, relative, repositoryPath),
    entries: kept,
    truncated: children.length > kept.length,
  };
}

/** Where the authored root sits inside the repository, resolved from configuration and never hard-coded. */
function authoredRootPrefix(rootDir: string): string {
  const relative = path
    .relative(rootDir, resolveHarnessLayout(rootDir).authoredRoot)
    .split(path.sep)
    .filter(Boolean)
    .join("/");
  return relative ? `${relative}/` : "";
}

function inside(candidate: string, root: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function isChild(candidate: string, parent: string): boolean {
  return inside(candidate, parent) && !candidate.slice(parent.length + 1).includes("/");
}

function entityRelative(bound: string, contentRoot: string): string {
  return bound === contentRoot ? "" : bound.slice(contentRoot.length + 1);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // Bytes that are not UTF-8 are the expected answer here, not a failure to report: the caller asked what
    // this object is, and "not text" is the answer.
    consumeKnownError(error);
    return null;
  }
}

function contentResult(
  outcome: EntityContentOutcome,
  entityRef: string,
  requestedPath: string,
  repositoryPath: string,
): EntityContentReadV1 {
  return {
    schema: ENTITY_CONTENT_READ_SCHEMA,
    ok: true,
    outcome,
    entityRef,
    path: requestedPath,
    repositoryPath,
    content: null,
    sizeBytes: null,
    mediaType: null,
    entries: [],
    truncated: false,
  };
}

const outcomes: readonly EntityContentOutcome[] = ["file", "directory", "missing", "too-large", "binary"];

export function validateEntityContentRead(value: unknown): readonly string[] {
  if (!isJsonObject(value) || value.schema !== ENTITY_CONTENT_READ_SCHEMA || value.ok !== true)
    return ["Entity content read envelope is invalid"];
  const errors: string[] = [];
  if (!outcomes.includes(value.outcome as EntityContentOutcome)) errors.push("outcome is invalid");
  if (typeof value.entityRef !== "string") errors.push("entityRef must be a string");
  if (typeof value.path !== "string") errors.push("path must be a string");
  if (typeof value.repositoryPath !== "string") errors.push("repositoryPath must be a string");
  if (value.content !== null && typeof value.content !== "string") errors.push("content must be a string or null");
  if (value.outcome === "file" && typeof value.content !== "string") errors.push("file outcome requires content");
  if (value.outcome !== "file" && value.content !== null) errors.push("only a file outcome carries content");
  if (value.sizeBytes !== null && (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0))
    errors.push("sizeBytes must be a non-negative integer or null");
  if (value.mediaType !== null && typeof value.mediaType !== "string")
    errors.push("mediaType must be a string or null");
  if (!Array.isArray(value.entries)) errors.push("entries must be an array");
  else if (value.outcome !== "directory" && value.entries.length > 0)
    errors.push("only a directory outcome carries entries");
  else if (
    value.entries.some(
      (entry) =>
        !isJsonObject(entry) ||
        typeof entry.path !== "string" ||
        !entry.path ||
        typeof entry.directory !== "boolean" ||
        (entry.sizeBytes !== null && !Number.isSafeInteger(entry.sizeBytes)),
    )
  )
    errors.push("entries are invalid");
  if (typeof value.truncated !== "boolean") errors.push("truncated must be a boolean");
  return errors;
}

export function serializeEntityContentRead(value: unknown): string {
  const errors = validateEntityContentRead(value);
  if (errors.length) throw new EntityContentReadContractError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
