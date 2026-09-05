import {
  entityKindContracts,
  explainEntityKindContract,
  type EntityKindContract,
  type EntityKindExplanation,
} from "./entity-kind-registry.ts";
import type { CompiledArtifactKindContract } from "./vertical-contract.ts";

export const ENTITY_KIND_CATALOG_SCHEMA = Object.freeze({
  id: "entity-kind-catalog/v1" as const,
});

export class EntityKindCatalogContractError extends Error {
  readonly code = "invalid_entity_kind_catalog";
}

/**
 * The nine declared facets of a vertical Artifact kind (governed-entity-design §2). Present only on
 * `origin: "vertical"` rows; built-in kinds are owned by code and carry no declaration to configure.
 */
export interface EntityKindDeclarationV1 {
  readonly id: string;
  readonly version: number;
  readonly idPrefix: string;
  readonly display: { readonly singular: string; readonly plural: string };
  readonly descriptorSchemaRef: string;
  readonly pathTemplate: string;
  readonly locatorKinds: readonly string[];
  readonly maturityVocabulary: readonly string[];
}

export interface EntityKindCatalogRowV1 {
  /** Built-in kind name, or the vertical type identity `<vertical>/<id>@<version>`. */
  readonly kind: string;
  readonly origin: "builtin" | "vertical";
  readonly verticalId: string | null;
  readonly refTemplate: string;
  /** May appear as a node in the relation graph. */
  readonly relationEndpoint: boolean;
  /** Has an executable `import` action, so a caller can create one from a locator. */
  readonly importable: boolean;
  readonly retired: boolean;
  readonly declaration: EntityKindDeclarationV1 | null;
  readonly explanation: EntityKindExplanation;
}

export interface EntityKindCatalogV1 {
  readonly schema: typeof ENTITY_KIND_CATALOG_SCHEMA.id;
  readonly declarationRevision: number;
  readonly kinds: readonly EntityKindCatalogRowV1[];
}

/**
 * The one registered-kind enumeration: code-owned built-in contracts plus the compiled vertical
 * Artifact kinds, every row explained by the same `explainEntityKindContract`. Callers that need the
 * kind universe read this instead of restating a list.
 */
export function buildEntityKindCatalog(
  artifactKinds: readonly CompiledArtifactKindContract[],
  declarationRevision: number,
): EntityKindCatalogV1 {
  return Object.freeze({
    schema: ENTITY_KIND_CATALOG_SCHEMA.id,
    declarationRevision,
    kinds: Object.freeze([
      ...entityKindContracts.map((contract) => catalogRow(contract, "builtin", null, null)),
      ...artifactKinds.map(({ declaration, entityKindContract, typeIdentity }) =>
        catalogRow(
          entityKindContract,
          "vertical",
          typeIdentity.slice(0, typeIdentity.length - `/${declaration.id}@${declaration.version}`.length),
          declaration,
        ),
      ),
    ]),
  });
}

function catalogRow(
  contract: EntityKindContract,
  origin: "builtin" | "vertical",
  verticalId: string | null,
  declaration: CompiledArtifactKindContract["declaration"] | null,
): EntityKindCatalogRowV1 {
  return Object.freeze({
    kind: contract.kind,
    origin,
    verticalId,
    refTemplate: contract.id.refTemplate,
    relationEndpoint: contract.relationEndpoint.eligible,
    importable:
      contract.actionCatalog?.actions.some(({ id, execution }) => id === "import" && execution !== null) === true,
    retired: declaration?.retired === true,
    declaration:
      declaration === null
        ? null
        : Object.freeze({
            id: declaration.id,
            version: declaration.version,
            idPrefix: declaration.idPrefix,
            display: Object.freeze({ singular: declaration.display.singular, plural: declaration.display.plural }),
            descriptorSchemaRef: declaration.descriptorSchemaRef,
            pathTemplate: declaration.store.pathTemplate,
            locatorKinds: Object.freeze([...declaration.locatorKinds]),
            maturityVocabulary: Object.freeze([...(declaration.maturityVocabulary ?? [])]),
          }),
    explanation: explainEntityKindContract(contract),
  });
}

export function validateEntityKindCatalog(value: unknown): readonly string[] {
  if (!catalogRecord(value) || !catalogExact(value, ["schema", "declarationRevision", "kinds"]))
    return ["Entity kind catalog fields are incomplete or unknown"];
  const errors: string[] = [];
  if (value.schema !== ENTITY_KIND_CATALOG_SCHEMA.id) errors.push("Entity kind catalog schema is invalid");
  if (!Number.isSafeInteger(value.declarationRevision) || Number(value.declarationRevision) < 1)
    errors.push("Entity kind catalog declarationRevision must be a positive integer");
  if (!Array.isArray(value.kinds) || value.kinds.length === 0)
    errors.push("Entity kind catalog kinds must be non-empty");
  else {
    for (const [index, row] of value.kinds.entries())
      errors.push(...validateCatalogRow(row).map((issue) => `kinds[${index}]: ${issue}`));
    const names = value.kinds.map((row) => (catalogRecord(row) ? row.kind : null));
    if (new Set(names).size !== names.length) errors.push("Entity kind catalog kinds must be unique");
  }
  return errors;
}

export function serializeEntityKindCatalog(value: unknown): string {
  const issues = validateEntityKindCatalog(value);
  if (issues.length > 0) throw new EntityKindCatalogContractError(`Invalid Entity kind catalog: ${issues.join("; ")}`);
  return JSON.stringify(value);
}

const rowFields = [
  "kind",
  "origin",
  "verticalId",
  "refTemplate",
  "relationEndpoint",
  "importable",
  "retired",
  "declaration",
  "explanation",
];

function validateCatalogRow(value: unknown): readonly string[] {
  if (!catalogRecord(value) || !catalogExact(value, rowFields)) return ["row fields are incomplete or unknown"];
  const errors: string[] = [];
  if (typeof value.kind !== "string" || value.kind.length === 0) errors.push("kind must be a non-empty string");
  if (value.origin !== "builtin" && value.origin !== "vertical") errors.push("origin is invalid");
  if (value.verticalId !== null && typeof value.verticalId !== "string") errors.push("verticalId is invalid");
  if (typeof value.refTemplate !== "string" || !value.refTemplate.endsWith("/{id}"))
    errors.push("refTemplate must end with /{id}");
  if (typeof value.relationEndpoint !== "boolean") errors.push("relationEndpoint must be a boolean");
  if (typeof value.importable !== "boolean") errors.push("importable must be a boolean");
  if (typeof value.retired !== "boolean") errors.push("retired must be a boolean");
  if (value.origin === "vertical" && value.declaration === null) errors.push("vertical rows require a declaration");
  if (value.origin === "builtin" && value.declaration !== null) errors.push("builtin rows carry no declaration");
  if (value.declaration !== null) errors.push(...validateDeclaration(value.declaration));
  if (!catalogRecord(value.explanation) || value.explanation.schema !== "entity-kind-explanation/v1")
    errors.push("explanation must be an entity-kind-explanation/v1 value");
  else if (value.explanation.kind !== value.kind) errors.push("explanation kind must match the row kind");
  return errors;
}

const declarationFields = [
  "id",
  "version",
  "idPrefix",
  "display",
  "descriptorSchemaRef",
  "pathTemplate",
  "locatorKinds",
  "maturityVocabulary",
];

function validateDeclaration(value: unknown): readonly string[] {
  if (!catalogRecord(value) || !catalogExact(value, declarationFields))
    return ["declaration fields are incomplete or unknown"];
  const errors: string[] = [];
  for (const field of ["id", "idPrefix", "descriptorSchemaRef", "pathTemplate"])
    if (typeof value[field] !== "string" || (value[field] as string).length === 0)
      errors.push(`declaration ${field} must be a non-empty string`);
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1)
    errors.push("declaration version must be a positive integer");
  if (
    !catalogRecord(value.display) ||
    typeof value.display.singular !== "string" ||
    typeof value.display.plural !== "string"
  )
    errors.push("declaration display must carry singular and plural");
  if (!Array.isArray(value.locatorKinds) || value.locatorKinds.length === 0)
    errors.push("declaration locatorKinds must be non-empty");
  if (!Array.isArray(value.maturityVocabulary)) errors.push("declaration maturityVocabulary must be an array");
  return errors;
}

function catalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogExact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((key) => fields.includes(key))
  );
}
