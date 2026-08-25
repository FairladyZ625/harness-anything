import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, taskPackagePath } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import {
  isEntityStorageForm,
  type CompositeManifestBlobDeclaration,
  type EntityDocumentCodec,
  type EntityProjectionDeclaration,
  type EntityRegistration,
  type EntityRootResolverDeclaration,
  type EntityStorageForm,
} from "./registry.ts";

export interface EntitySchemaLike {
  readonly ast: object;
}

export type EntityDeclaration = Omit<
  EntityRegistration<string, string>,
  "schema" | "rootResolver" | "projection" | "documentCodec"
> & {
  // Keep the declaration boundary runtime-agnostic. Concrete schema implementations
  // (including Effect Schema) belong to the package that consumes the declaration.
  readonly schema: EntitySchemaLike;
  readonly rootResolver: EntityRootResolverDeclaration;
  readonly projection: EntityProjectionDeclaration;
  readonly documentCodec: EntityDocumentCodec;
};

export type EntityPathDeclaration = Pick<EntityDeclaration, "kind" | "storageForm" | "rootResolver">;

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
  if (!isSchemaLike(candidate.schema)) {
    throw new Error("entity declaration schema must be a schema value");
  }
  if (!candidate.mutabilityContract || Object.keys(candidate.mutabilityContract).length === 0) {
    throw new Error("entity declaration mutability contract must not be empty");
  }
  if (
    !candidate.anchors ||
    typeof candidate.anchors.entityRef !== "string" ||
    !Array.isArray(candidate.anchors.anchors)
  ) {
    throw new Error("entity declaration anchors are required");
  }
  if (!candidate.dispositionMatrix || !candidate.dispositionMatrix.entries) {
    throw new Error("entity declaration disposition matrix is required");
  }
}

function isSchemaLike(value: unknown): value is EntitySchemaLike {
  return typeof value === "function" && "ast" in value && value.ast !== null && typeof value.ast === "object";
}

export function decodeEntityPathDeclaration(input: unknown): EntityPathDeclaration {
  const storageForm = valueAt(input, "storageForm");
  if (!isEntityStorageForm(storageForm)) throw new Error(`unsupported entity storage form: ${String(storageForm)}`);
  const candidate = input as Partial<EntityPathDeclaration>;
  if (typeof candidate.kind !== "string" || candidate.kind.length === 0)
    throw new Error("entity declaration kind must be non-empty");
  validateRootResolver(candidate.rootResolver, storageForm);
  return input as EntityPathDeclaration;
}

export const jsonEntityDocumentCodec: EntityDocumentCodec = {
  decode: (body) => JSON.parse(body) as unknown,
  encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
};

export function resolveEntityDocumentPath(
  rootInput: HarnessLayoutInput,
  declaration: EntityPathDeclaration,
  identity: Readonly<Record<string, string>>,
): string {
  const layout = resolveHarnessLayout(rootInput);
  const resolver = declaration.rootResolver;
  if (declaration.storageForm === "hosted-entity") {
    const host = resolver.host!;
    const declaredHostPath = resolveDeclaredPath(layout.authoredRoot, host.pathTemplate, host.identity, identity);
    const hostPath =
      !localLayoutFileSystem.exists(declaredHostPath) && host.entityKind === "task"
        ? taskPackagePath(rootInput, identity[host.identity[0]!] ?? "")
        : declaredHostPath;
    if (!localLayoutFileSystem.exists(hostPath)) {
      throw new Error(`host entity package not found: ${host.entityKind}/${identity[host.identity[0]!] ?? "unknown"}`);
    }
    const declaredTarget = resolveDeclaredPath(layout.authoredRoot, resolver.pathTemplate, resolver.identity, identity);
    const hostedSuffix = path.relative(declaredHostPath, declaredTarget);
    return path.join(hostPath, hostedSuffix);
  }
  return resolveDeclaredPath(layout.authoredRoot, resolver.pathTemplate, resolver.identity, identity);
}

function validateRootResolver(
  rootResolver: EntityRootResolverDeclaration | undefined,
  storageForm: EntityStorageForm,
): void {
  if (!rootResolver || typeof rootResolver !== "object") throw new Error("entity declaration rootResolver is required");
  validatePathDeclaration(rootResolver.pathTemplate, rootResolver.identity, "rootResolver");
  if (storageForm === "hosted-entity") {
    if (
      !rootResolver.host ||
      typeof rootResolver.host.entityKind !== "string" ||
      rootResolver.host.entityKind.length === 0
    ) {
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
  if (!projection || !isSqlIdentifier(projection.table))
    throw new Error("entity projection table must be a SQLite identifier");
  if (!Array.isArray(projection.columns) || projection.columns.length === 0)
    throw new Error("entity projection columns must not be empty");
  const names = projection.columns.map((column) => column.name);
  if (names.some((name) => !isSqlIdentifier(name)) || new Set(names).size !== names.length) {
    throw new Error("entity projection columns must have unique SQLite identifiers");
  }
  if (projection.columns.filter((column) => column.primaryKey).length !== 1) {
    throw new Error("entity projection must declare exactly one primary key column");
  }
}

function validateCompositeBlob(
  blob: CompositeManifestBlobDeclaration | undefined,
  storageForm: EntityStorageForm,
): void {
  if (storageForm !== "composite-manifest-blob") return;
  if (
    !blob ||
    typeof blob.referenceField !== "string" ||
    blob.referenceField.length === 0 ||
    blob.store !== "content-addressed"
  ) {
    throw new Error(
      "composite-manifest-blob declaration must name its blob reference field and content-addressed store",
    );
  }
}

function isSqlIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function validatePathDeclaration(pathTemplate: string, identity: ReadonlyArray<string>, label: string): void {
  if (typeof pathTemplate !== "string" || pathTemplate.length === 0)
    throw new Error(`${label}.pathTemplate must be non-empty`);
  if (
    !Array.isArray(identity) ||
    identity.length === 0 ||
    identity.some((key) => typeof key !== "string" || key.length === 0)
  ) {
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
  identity: Readonly<Record<string, string>>,
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
  if (normalized !== value || normalized.includes("/"))
    throw new Error(`entity identity must be a portable path segment: ${key}`);
  return normalized;
}

export function readField(entity: Readonly<Record<string, unknown>>, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>(
      (value, segment) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined,
      entity,
    );
}

function valueAt(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}
