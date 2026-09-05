import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import {
  decodeVerticalDefinition,
  type ArtifactEntityKindDefinition,
  type ArtifactRelationDefinition,
  type VerticalDefinition,
} from "../schemas/vertical-definition.ts";
import { baseEntityTypeContract, entityTypeContracts, type EntityTypeContract } from "./base-entity.ts";
import { artifactEntityIdPattern } from "./entity-ref.ts";
import { artifactDescriptorSchema, deepFreeze } from "./artifact-entity.ts";
import {
  entityKindContracts,
  genericAuthoring,
  genericEntityStore,
  noSdkExposure,
  type EntityKindContract,
} from "./entity-kind-registry.ts";
import { artifactEntityActionCatalog } from "./artifact-entity-actions.ts";
import {
  compileGovernedRelationDirections,
  type GovernedRelationCompilationAuthority,
} from "./governed-relation-direction.ts";
import { composeCanonicalRelationDirections, type CanonicalRelationDirection } from "./relation-direction.ts";

export const COMPILED_VERTICAL_CONTRACT_SCHEMA = "compiled-vertical-contract/v1" as const;

export interface CompiledArtifactRelationRequest {
  readonly artifactTypeIdentity: string;
  readonly declaration: ArtifactRelationDefinition;
}

export interface CompiledArtifactKindContract {
  readonly declaration: ArtifactEntityKindDefinition;
  readonly typeIdentity: string;
  readonly entityTypeContract: EntityTypeContract;
  readonly entityKindContract: EntityKindContract;
  /** Decoded, code-vocabulary-checked requests. W1-C owns their governed direction compilation. */
  readonly relationRequests: readonly CompiledArtifactRelationRequest[];
}

export interface CompiledVerticalContract {
  readonly schema: typeof COMPILED_VERTICAL_CONTRACT_SCHEMA;
  readonly typeIdentity: string;
  readonly definition: VerticalDefinition;
  readonly artifactKinds: readonly CompiledArtifactKindContract[];
}

export interface CompiledVerticalRegistry {
  readonly revision: number;
  readonly verticals: readonly CompiledVerticalContract[];
  readonly relationDirections: readonly CanonicalRelationDirection[];
}

export class VerticalContractError extends Error {
  readonly code = "invalid_vertical_contract";

  constructor(message: string) {
    super(message);
    this.name = "VerticalContractError";
  }
}

/**
 * Pure five-stage compiler: strict decode, uniqueness/portability checks, entity contracts,
 * relation-request decoding, then one deeply immutable value for every consumer.
 */
export function compileVerticalContract(
  source: unknown,
  authority?: GovernedRelationCompilationAuthority,
): CompiledVerticalContract {
  let definition: VerticalDefinition;
  try {
    definition = decodeVerticalDefinition(source);
  } catch (error) {
    throw new VerticalContractError(
      `Vertical definition decode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const artifacts = definition.entityKinds.filter(
      (candidate): candidate is ArtifactEntityKindDefinition => candidate.entityType === "artifact",
    ),
    registeredSchemaRefs = new Set(definition.projectionSchemas.map(({ schemaRef }) => schemaRef));
  validateUniqueContracts(definition, artifacts);

  const compiledArtifacts = artifacts.map((artifact) => {
    validateArtifactDeclaration(artifact, registeredSchemaRefs);
    const typeIdentity = `${definition.id}/${artifact.id}@${artifact.version}`,
      identity = Object.freeze({
        field: "entityId",
        pattern: artifactEntityIdPattern(artifact.idPrefix),
        refTemplate: `${typeIdentity}/{id}` as `${string}/{id}`,
      }),
      residency = Object.freeze({ authored: "ledger" as const }),
      entityTypeContract: EntityTypeContract = Object.freeze({
        kind: typeIdentity,
        ...baseEntityTypeContract(identity, residency),
      }),
      relationRequests = Object.freeze(
        (artifact.relations ?? []).map((declaration) =>
          Object.freeze({ artifactTypeIdentity: typeIdentity, declaration }),
        ),
      ),
      entityKindContract: EntityKindContract = Object.freeze({
        ...entityTypeContract,
        schema: artifactDescriptorSchema(artifact, typeIdentity),
        relations: Object.freeze({ directions: Object.freeze([]), edges: Object.freeze([]) }),
        canonicalProjection: Object.freeze({
          embeddedEvents: Object.freeze([]),
          row: Object.freeze({ idField: "entityId", ownerField: null }),
        }),
        ...(artifact.maturityVocabulary
          ? {
              statusVocabulary: Object.freeze([
                Object.freeze({ field: "maturity", words: Object.freeze([...artifact.maturityVocabulary]) }),
              ]),
            }
          : {}),
        actionCatalog: artifact.retired
          ? Object.freeze({
              ...artifactEntityActionCatalog(typeIdentity, identity),
              actions: Object.freeze(
                artifactEntityActionCatalog(typeIdentity, identity).actions.map((action) =>
                  Object.freeze({ ...action, execution: null }),
                ),
              ),
            })
          : artifactEntityActionCatalog(typeIdentity, identity),
        entityStore: genericEntityStore(artifact.store.pathTemplate),
        authoring: genericAuthoring,
        sdkExposure: noSdkExposure,
      });
    return Object.freeze({
      declaration: artifact,
      typeIdentity,
      entityTypeContract,
      entityKindContract,
      relationRequests,
    });
  });

  const compiled = deepFreeze({
    schema: COMPILED_VERTICAL_CONTRACT_SCHEMA,
    typeIdentity: `${definition.id}@${definition.version}`,
    definition,
    artifactKinds: compiledArtifacts,
  });
  compiledRelationDirections(compiled, authority);
  return compiled;
}

export function compiledRelationDirections(
  compiled: CompiledVerticalContract,
  authority?: GovernedRelationCompilationAuthority,
): readonly CanonicalRelationDirection[] {
  try {
    return compileGovernedRelationDirections({
      verticalId: compiled.definition.id,
      artifacts: compiled.artifactKinds,
      ...(authority ? { authority } : {}),
    });
  } catch (error) {
    throw new VerticalContractError(
      `Vertical relation compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Center-side revision fence expressed as a pure value transition. Callers must submit candidates here;
 * stale edge candidates are rejected before they can be compiled into registry rows.
 */
export function acceptVerticalRegistryCandidate(input: {
  readonly current: CompiledVerticalRegistry;
  readonly expectedRevision: number;
  readonly source: unknown;
  readonly decisionAuthority?: GovernedRelationCompilationAuthority;
}): CompiledVerticalRegistry {
  if (input.expectedRevision !== input.current.revision) {
    throw Object.assign(
      new Error(
        `Vertical registry revision is stale: expected ${input.expectedRevision}, current ${input.current.revision}.`,
      ),
      { code: "stale_vertical_registry_revision" },
    );
  }
  const accepted = compileVerticalContract(input.source, input.decisionAuthority),
    verticals = input.current.verticals
      .filter(({ definition }) => definition.id !== accepted.definition.id)
      .concat(accepted)
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id)),
    relationDirections = composeCanonicalRelationDirections(
      verticals.flatMap((vertical) => compiledRelationDirections(vertical, input.decisionAuthority)),
    );
  return deepFreeze({ revision: input.current.revision + 1, verticals, relationDirections });
}

export function emptyCompiledVerticalRegistry(): CompiledVerticalRegistry {
  return Object.freeze({
    revision: 0,
    verticals: Object.freeze([]),
    relationDirections: composeCanonicalRelationDirections([]),
  });
}

function validateUniqueContracts(
  definition: VerticalDefinition,
  artifacts: readonly ArtifactEntityKindDefinition[],
): void {
  const builtinKindIds = new Set<string>(entityTypeContracts.map(({ kind }) => kind)),
    verticalKindIds = new Set<string>(),
    typeIdentities = new Set<string>(entityTypeContracts.map(({ kind }) => kind)),
    idPrefixes = builtinIdPrefixes(),
    pathTemplates = new Set(
      entityKindContracts
        .flatMap(({ entityStore }) => (entityStore ? [entityStore.document.pathTemplate] : []))
        .map(portableCollisionKey),
    );
  for (const candidate of definition.entityKinds) {
    if (verticalKindIds.has(candidate.id)) {
      if (candidate.entityType === "artifact" && builtinKindIds.has(candidate.id)) {
        duplicate("kind id", candidate.id);
      }
      throw new VerticalContractError(`Duplicate vertical kind id: ${candidate.id}.`);
    }
    verticalKindIds.add(candidate.id);
  }
  for (const artifact of artifacts) {
    if (builtinKindIds.has(artifact.id)) duplicate("kind id", artifact.id);
    const typeIdentity = `${definition.id}/${artifact.id}@${artifact.version}`;
    if (typeIdentities.has(typeIdentity)) duplicate("type identity", typeIdentity);
    typeIdentities.add(typeIdentity);
    if (idPrefixes.has(artifact.idPrefix)) duplicate("idPrefix", artifact.idPrefix);
    idPrefixes.add(artifact.idPrefix);
    const pathKey = portableCollisionKey(artifact.store.pathTemplate);
    if (pathTemplates.has(pathKey)) duplicate("store.pathTemplate", artifact.store.pathTemplate);
    pathTemplates.add(pathKey);
  }
}

function validateArtifactDeclaration(
  artifact: ArtifactEntityKindDefinition,
  registeredSchemaRefs: ReadonlySet<string>,
): void {
  portablePathTemplate(artifact.store.pathTemplate);
  if (!registeredSchemaRefs.has(artifact.descriptorSchemaRef)) {
    throw new VerticalContractError(
      `Artifact kind ${artifact.id} descriptorSchemaRef ${artifact.descriptorSchemaRef} ` +
        "is not registered in projectionSchemas.",
    );
  }
  assertUniqueValues(artifact.locatorKinds, `Artifact kind ${artifact.id} locatorKinds`);
  if (artifact.maturityVocabulary) {
    assertUniqueValues(artifact.maturityVocabulary, `Artifact kind ${artifact.id} maturityVocabulary`);
  }
}

function portablePathTemplate(pathTemplate: string): void {
  if (pathTemplate.split("{id}").length !== 2 || /[{}]/u.test(pathTemplate.replace("{id}", ""))) {
    throw new VerticalContractError(`Artifact store.pathTemplate must contain exactly one {id}: ${pathTemplate}`);
  }
  try {
    if (normalizeRelativeDocumentPath(pathTemplate) !== pathTemplate) {
      throw new Error("path is not normalized");
    }
  } catch (error) {
    throw new VerticalContractError(
      `Artifact store.pathTemplate must be a normalized portable relative path: ${pathTemplate} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function portableCollisionKey(pathTemplate: string): string {
  portablePathTemplate(pathTemplate);
  return pathTemplate.toLocaleLowerCase("en-US");
}

function builtinIdPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const contract of entityTypeContracts) {
    prefixes.add(contract.kind.replaceAll("-", "").toUpperCase());
    const patternPrefix = /^\^\(\?:([A-Za-z]+)[_-]|^\^([A-Za-z]+)[_-]/u.exec(
      contract.id.refPattern ?? contract.id.pattern,
    );
    const prefix = patternPrefix?.[1] ?? patternPrefix?.[2];
    if (prefix) prefixes.add(prefix.toUpperCase());
  }
  return prefixes;
}

function assertUniqueValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new VerticalContractError(`${label} must not contain duplicates.`);
  }
}

function duplicate(field: string, value: string): never {
  throw new VerticalContractError(`Duplicate artifact ${field}: ${value}.`);
}
