import path from "node:path";
import { Effect, Schema } from "effect";
import { declaredEntityId } from "../domain/entity-id.ts";
import type { WriteError } from "../domain/index.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import type { WriteCoordinator } from "../ports/index.ts";
import { writeCoordinatedPayload, type PayloadHasher } from "../write-coordination/write-helpers.ts";
import {
  isEntityStorageForm,
  type CompositeManifestBlobDeclaration,
  type EntityDocumentCodec,
  type EntityProjectionDeclaration,
  type EntityRegistration,
  type EntityRootResolverDeclaration,
  type EntityStorageForm
} from "./registry.ts";

export type EntityDeclaration = Omit<
  EntityRegistration<string, string>,
  "schema" | "rootResolver" | "projection" | "documentCodec"
> & {
  readonly schema: Schema.Schema<any, any, never>;
  readonly rootResolver: EntityRootResolverDeclaration;
  readonly projection: EntityProjectionDeclaration;
  readonly documentCodec: EntityDocumentCodec;
};

export type EntityPathDeclaration = Pick<EntityDeclaration, "kind" | "storageForm" | "rootResolver">;

export interface DeclaredEntityDocumentWritePayload {
  readonly entityDocument: {
    readonly declaration: EntityPathDeclaration;
    readonly identity: Readonly<Record<string, string>>;
    readonly body: string;
    readonly blobRef?: DeclaredContentAddressedBlobRef;
  };
}

export interface DeclaredContentAddressedBlobRef {
  readonly ref: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

export function decodeEntityDeclaration(input: unknown): EntityDeclaration {
  const pathDeclaration = decodeEntityPathDeclaration(input);
  const storageForm = pathDeclaration.storageForm;
  const candidate = input as Partial<EntityDeclaration>;
  validateFiveTuple(candidate);
  validateDocumentCodec(candidate.documentCodec);
  validateProjection(candidate.projection);
  validateCompositeBlob(candidate.blob, storageForm);
  return input as EntityDeclaration;
}

function validateFiveTuple(candidate: Partial<EntityDeclaration>): void {
  if (!Schema.isSchema(candidate.schema)) {
    throw new Error("entity declaration schema must be an Effect Schema");
  }
  if (!candidate.mutabilityContract || Object.keys(candidate.mutabilityContract).length === 0) {
    throw new Error("entity declaration mutability contract must not be empty");
  }
  if (!candidate.anchors || typeof candidate.anchors.entityRef !== "string" || !Array.isArray(candidate.anchors.anchors)) {
    throw new Error("entity declaration anchors are required");
  }
  if (!candidate.dispositionMatrix || !candidate.dispositionMatrix.entries) {
    throw new Error("entity declaration disposition matrix is required");
  }
}

export function decodeEntityPathDeclaration(input: unknown): EntityPathDeclaration {
  const storageForm = valueAt(input, "storageForm");
  if (!isEntityStorageForm(storageForm)) throw new Error(`unsupported entity storage form: ${String(storageForm)}`);
  const candidate = input as Partial<EntityPathDeclaration>;
  if (typeof candidate.kind !== "string" || candidate.kind.length === 0) throw new Error("entity declaration kind must be non-empty");
  validateRootResolver(candidate.rootResolver, storageForm);
  return input as EntityPathDeclaration;
}

export const jsonEntityDocumentCodec: EntityDocumentCodec = {
  decode: (body) => JSON.parse(body) as unknown,
  encode: (value) => `${JSON.stringify(value, null, 2)}\n`
};

export function resolveEntityDocumentPath(
  rootInput: HarnessLayoutInput,
  declaration: EntityPathDeclaration,
  identity: Readonly<Record<string, string>>
): string {
  const layout = resolveHarnessLayout(rootInput);
  const resolver = declaration.rootResolver;
  if (declaration.storageForm === "hosted-entity") {
    const host = resolver.host!;
    const hostPath = resolveDeclaredPath(layout.authoredRoot, host.pathTemplate, host.identity, identity);
    if (!localLayoutFileSystem.exists(hostPath)) {
      throw new Error(`host entity package not found: ${host.entityKind}/${identity[host.identity[0]!] ?? "unknown"}`);
    }
  }
  return resolveDeclaredPath(layout.authoredRoot, resolver.pathTemplate, resolver.identity, identity);
}

export function writeDeclaredEntity(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  declaration: EntityDeclaration,
  identity: Readonly<Record<string, string>>,
  value: unknown,
  options: { readonly flush?: boolean; readonly opIdPrefix?: string } = {}
): Effect.Effect<void, WriteError> {
  const decoded = Schema.decodeUnknownSync(declaration.schema)(value) as Readonly<Record<string, unknown>>;
  const bodyRef = declaration.storageForm === "composite-manifest-blob"
    ? readField(decoded, declaration.blob!.referenceField)
    : undefined;
  if (declaration.storageForm === "composite-manifest-blob") {
    if (!isContentAddressedBlobReference(bodyRef)) throw new Error(`composite manifest is missing a valid ${declaration.blob!.referenceField}`);
  }
  const identityKey = declaration.rootResolver.identity.at(-1)!;
  const entityId = declaredEntityId(declaration.kind, identity[identityKey] ?? "");
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId,
    kind: "doc_write",
    ...(options.opIdPrefix ? { opIdPrefix: options.opIdPrefix } : {}),
    payload: {
      entityDocument: {
        declaration: {
          kind: declaration.kind,
          storageForm: declaration.storageForm,
          rootResolver: declaration.rootResolver
        },
        identity,
        body: declaration.documentCodec.encode(decoded),
        ...(isContentAddressedBlobReference(bodyRef) ? { blobRef: bodyRef } : {})
      }
    } satisfies DeclaredEntityDocumentWritePayload
  }, { flush: options.flush });
}

function validateRootResolver(rootResolver: EntityRootResolverDeclaration | undefined, storageForm: EntityStorageForm): void {
  if (!rootResolver || typeof rootResolver !== "object") throw new Error("entity declaration rootResolver is required");
  validatePathDeclaration(rootResolver.pathTemplate, rootResolver.identity, "rootResolver");
  if (storageForm === "hosted-entity") {
    if (!rootResolver.host || typeof rootResolver.host.entityKind !== "string" || rootResolver.host.entityKind.length === 0) {
      throw new Error("hosted-entity rootResolver must declare a host entity kind");
    }
    validatePathDeclaration(rootResolver.host.pathTemplate, rootResolver.host.identity, "rootResolver.host");
  }
}

function validateDocumentCodec(codec: EntityDocumentCodec | undefined): void {
  if (!codec || typeof codec.decode !== "function" || typeof codec.encode !== "function") {
    throw new Error("entity declaration documentCodec must provide decode and encode");
  }
}

function validateProjection(projection: EntityProjectionDeclaration | undefined): void {
  if (!projection || !isSqlIdentifier(projection.table)) throw new Error("entity projection table must be a SQLite identifier");
  if (!Array.isArray(projection.columns) || projection.columns.length === 0) throw new Error("entity projection columns must not be empty");
  const names = projection.columns.map((column) => column.name);
  if (names.some((name) => !isSqlIdentifier(name)) || new Set(names).size !== names.length) {
    throw new Error("entity projection columns must have unique SQLite identifiers");
  }
  if (projection.columns.filter((column) => column.primaryKey).length !== 1) {
    throw new Error("entity projection must declare exactly one primary key column");
  }
}

function validateCompositeBlob(blob: CompositeManifestBlobDeclaration | undefined, storageForm: EntityStorageForm): void {
  if (storageForm !== "composite-manifest-blob") return;
  if (!blob || typeof blob.referenceField !== "string" || blob.referenceField.length === 0 || blob.store !== "content-addressed") {
    throw new Error("composite-manifest-blob declaration must name its blob reference field and content-addressed store");
  }
}

function isSqlIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function validatePathDeclaration(pathTemplate: string, identity: ReadonlyArray<string>, label: string): void {
  if (typeof pathTemplate !== "string" || pathTemplate.length === 0) throw new Error(`${label}.pathTemplate must be non-empty`);
  if (!Array.isArray(identity) || identity.length === 0 || identity.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new Error(`${label}.identity must declare non-empty keys`);
  }
  const placeholders = [...pathTemplate.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!);
  if (placeholders.length === 0 || placeholders.some((key) => !identity.includes(key))) {
    throw new Error(`${label}.pathTemplate placeholders must be declared by identity`);
  }
  const probe = renderPathTemplate(pathTemplate, Object.fromEntries(identity.map((key) => [key, "probe"])));
  normalizeRelativeDocumentPath(probe);
}

function resolveDeclaredPath(
  authoredRoot: string,
  template: string,
  keys: ReadonlyArray<string>,
  identity: Readonly<Record<string, string>>
): string {
  const values = Object.fromEntries(keys.map((key) => [key, normalizeIdentitySegment(identity[key], key)]));
  const relativePath = normalizeRelativeDocumentPath(renderPathTemplate(template, values));
  return path.join(authoredRoot, relativePath);
}

function renderPathTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^{}]+)\}/gu, (_placeholder, key: string) => values[key] ?? `{${key}}`);
}

function normalizeIdentitySegment(value: string | undefined, key: string): string {
  if (!value) throw new Error(`entity identity is missing: ${key}`);
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value || normalized.includes("/")) throw new Error(`entity identity must be a portable path segment: ${key}`);
  return normalized;
}

export function readField(entity: Readonly<Record<string, unknown>>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, segment) => (
    value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined
  ), entity);
}

function isContentAddressedBlobReference(value: unknown): value is DeclaredContentAddressedBlobRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.ref === "string" && typeof ref.sha256 === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256) &&
    typeof ref.size === "number" && Number.isSafeInteger(ref.size) && ref.size >= 0 &&
    typeof ref.mediaType === "string" && ref.mediaType.length > 0;
}

function valueAt(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}
