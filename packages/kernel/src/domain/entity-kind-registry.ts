import type { VerticalDefinition } from "../schemas/registry.ts";
import { AGENT_DECLARATION_V1_SCHEMA, SQUAD_DECLARATION_V1_SCHEMA } from "./agent-squad-schema.ts";
import { DEFAULT_POLICY } from "./default-policy.ts";
import { ENTITY_ID_PATTERN, explainEntityJsonSchema, type EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { POLICY_DECLARATION_V1_SCHEMA, validatePolicyDeclarationV1 } from "./policy.ts";
import type { PolicyPredicateName } from "./policy.ts";
import type { RelationDirection } from "./entity-relation.ts";

export type EntityKindDeclaration = VerticalDefinition["entityKinds"][number];
export type EntityPackageScaffold = VerticalDefinition["packageScaffolds"][number];
export const ENTITY_DOCUMENT_POLICY_ID = "typed-entity/v1";
export type EntityRepositoryRootScaffold = VerticalDefinition["repositoryScaffold"]["entityRoots"][number];

export interface EntityKindRegistration {
  readonly id: string;
  readonly entityType: EntityKindDeclaration["entityType"];
  readonly contractEntity: boolean;
  readonly packageKind?: string;
  readonly schemaRef?: string;
  readonly packageScaffold?: EntityPackageScaffold;
  readonly repositoryRoot?: EntityRepositoryRootScaffold;
}

export interface EntityKindRegistry {
  readonly ids: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<EntityKindRegistration>;
  readonly byId: ReadonlyMap<string, EntityKindRegistration>;
}

export interface EntityKindContract<T = unknown> {
  readonly kind: string;
  readonly schema: EntityDocumentJsonSchema<T>;
  readonly id: {
    readonly field: string;
    readonly pattern: string;
    readonly refTemplate: string;
  };
  readonly relations: {
    readonly directions: readonly RelationDirection[];
  };
  readonly transitionCatalog: {
    readonly ref: string;
    readonly transitions: readonly string[];
  } | null;
  readonly document: {
    readonly pathTemplate: string;
    readonly mediaType: "application/json";
    readonly policyId: typeof ENTITY_DOCUMENT_POLICY_ID;
  };
  readonly validate?: (value: unknown) => readonly string[];
  readonly policy?: {
    readonly predicates: readonly PolicyPredicateName[];
    readonly actions: readonly string[];
  };
}

export interface EntityKindExplanation {
  readonly schema: "entity-kind-explanation/v1";
  readonly kind: string;
  readonly documentSchema: {
    readonly id: string;
    readonly fields: ReturnType<typeof explainEntityJsonSchema>;
  };
  readonly id: EntityKindContract["id"];
  readonly relations: EntityKindContract["relations"];
  readonly transitions: {
    readonly catalogRef: string | null;
    readonly available: readonly string[];
  };
  readonly policy?: {
    readonly predicates: readonly PolicyPredicateName[];
    readonly actions: readonly string[];
  };
}

const declarationId = Object.freeze({
  field: "id",
  pattern: ENTITY_ID_PATTERN,
});
const declarationDocument = (pathTemplate: string) =>
  Object.freeze({ pathTemplate, mediaType: "application/json" as const, policyId: ENTITY_DOCUMENT_POLICY_ID });

export const entityKindContracts = Object.freeze([
  {
    kind: "agent",
    schema: AGENT_DECLARATION_V1_SCHEMA,
    id: { ...declarationId, refTemplate: "agent/{id}" },
    relations: { directions: [] },
    transitionCatalog: null,
    document: declarationDocument("agents/{id}.json"),
  },
  {
    kind: "squad",
    schema: SQUAD_DECLARATION_V1_SCHEMA,
    id: { ...declarationId, refTemplate: "squad/{id}" },
    relations: { directions: [] },
    transitionCatalog: null,
    document: declarationDocument("squads/{id}.json"),
  },
  {
    kind: "policy",
    schema: POLICY_DECLARATION_V1_SCHEMA,
    id: { ...declarationId, refTemplate: "policy/{id}" },
    relations: { directions: [] },
    transitionCatalog: null,
    document: declarationDocument("policies/{id}.json"),
    validate: validatePolicyDeclarationV1,
    policy: {
      predicates: Object.freeze(["isOwner", "isExecutorOfExecution", "hasCommandClass", "reviewIndependence"]),
      actions: DEFAULT_POLICY.actions,
    },
  },
] as const satisfies readonly EntityKindContract[]);

const entityKindContractByKind = new Map<string, EntityKindContract>(
  entityKindContracts.map((contract) => [contract.kind, contract]),
);

export function getEntityKindContract(kind: string): EntityKindContract | undefined {
  return entityKindContractByKind.get(kind);
}

export function requireEntityKindContract(kind: string): EntityKindContract {
  const contract = getEntityKindContract(kind);
  if (!contract)
    throw Object.assign(new Error(`Entity kind ${kind} is not registered.`), { code: "entity_kind_not_found" });
  return contract;
}

export function explainEntityKind(kind: string): EntityKindExplanation {
  const contract = requireEntityKindContract(kind);
  return {
    schema: "entity-kind-explanation/v1",
    kind: contract.kind,
    documentSchema: { id: contract.schema.$id, fields: explainEntityJsonSchema(contract.schema) },
    id: contract.id,
    relations: contract.relations,
    transitions: {
      catalogRef: contract.transitionCatalog?.ref ?? null,
      available: contract.transitionCatalog?.transitions ?? [],
    },
    ...(contract.policy ? { policy: contract.policy } : {}),
  };
}

export function entityDocumentPath(contract: EntityKindContract, id: string): string {
  if (!new RegExp(contract.id.pattern, "u").test(id))
    throw Object.assign(new Error(`${id} is not a valid ${contract.kind} id.`), { code: "invalid_entity_id" });
  return contract.document.pathTemplate.replace("{id}", id);
}

export function createEntityKindRegistry(vertical: VerticalDefinition): EntityKindRegistry {
  const packageScaffolds = new Map(vertical.packageScaffolds.map((scaffold) => [scaffold.entityKind, scaffold]));
  const repositoryRoots = new Map(vertical.repositoryScaffold.entityRoots.map((root) => [root.entityKind, root]));
  const entries = vertical.entityKinds.map(
    (entity): EntityKindRegistration => ({
      id: entity.id,
      entityType: entity.entityType,
      contractEntity: entity.contractEntity,
      ...(entity.entityType === "lifecycle" ? { packageKind: entity.packageKind } : { schemaRef: entity.schemaRef }),
      ...(packageScaffolds.get(entity.id) ? { packageScaffold: packageScaffolds.get(entity.id) } : {}),
      ...(repositoryRoots.get(entity.id) ? { repositoryRoot: repositoryRoots.get(entity.id) } : {}),
    }),
  );
  return {
    ids: entries.map((entry) => entry.id),
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

export function getEntityKind(registry: EntityKindRegistry, entityKind: string): EntityKindRegistration | undefined {
  return registry.byId.get(entityKind);
}
