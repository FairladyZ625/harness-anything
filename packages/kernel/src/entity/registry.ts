import { getEntityKindContract } from "../domain/entity-kind-registry.ts";
import { EntityRelationRecordSchema, schemaRegistry } from "../schemas/registry.ts";
import {
  entityFieldContracts,
  relationFieldContracts,
  type DecisionFieldKey,
  type FactFieldKey,
  type RelationFieldKey,
  type TaskFieldKey,
} from "./field-contracts.ts";
import {
  dispositionMatrix,
  isEntityStorageForm,
  supported,
  unsupported,
  type EntityRegistration,
  type KernelEntityKind,
} from "./registry-contract.ts";
import { sessionEntityRegistration } from "./session-declaration.ts";

export { entityStorageForms } from "./registry-contract.ts";
export type {
  CompositeManifestBlobDeclaration,
  DispositionAction,
  DispositionLevel,
  DispositionMatrixEntry,
  EntityAnchorDeclaration,
  EntityDispositionMatrix,
  EntityDocumentCodec,
  EntityProjectionColumnDeclaration,
  EntityProjectionDeclaration,
  EntityRegistration,
  EntityRootResolverDeclaration,
  EntityStorageForm,
  HostedEntityDeclaration,
  KernelEntityKind,
} from "./registry-contract.ts";

export type EntityRegistryShape = {
  readonly decision: EntityRegistration<DecisionFieldKey>;
  readonly task: EntityRegistration<TaskFieldKey>;
  readonly fact: EntityRegistration<FactFieldKey>;
  readonly relation: EntityRegistration<RelationFieldKey>;
  readonly session: typeof sessionEntityRegistration;
};

function derivedFrameworkRegistration<FieldKey extends string>(
  kind: "decision" | "task" | "fact",
): EntityRegistration<FieldKey> {
  const framework = getEntityKindContract(kind)?.framework;
  if (!framework) throw new Error(`Entity kind ${kind} has no framework registration contract.`);
  const schema = schemaRegistry.find(({ id }) => id === framework.schemaId)?.schema;
  if (!schema) throw new Error(`Entity kind ${kind} names unknown schema ${framework.schemaId}.`);
  return {
    kind,
    schema,
    mutabilityContract: entityFieldContracts[kind] as EntityRegistration<FieldKey>["mutabilityContract"],
    anchors: framework.anchors,
    dispositionMatrix: framework.dispositionMatrix,
    storageForm: framework.storageForm,
  };
}

/** relation/session are framework-only hosted boundaries, not members of the nine-kind authoring authority. */
const frameworkBoundaryRegistrations = {
  relation: {
    kind: "relation",
    schema: EntityRelationRecordSchema,
    mutabilityContract: relationFieldContracts,
    anchors: { entityRef: "relation/{relation_id}", anchors: [] },
    dispositionMatrix: dispositionMatrix([
      supported(
        "D1",
        "retire",
        ["relation_retire"],
        "relation semantic retirement preserves the hosted edge record while removing it from active graph semantics",
      ),
      unsupported("D1", "supersede", "relation replacement is modeled as retire old edge plus append new edge"),
      unsupported("D1", "invalidate", "relation invalidation is modeled as retire or replacing the edge"),
      unsupported("D2", "archive", "relation storage is hosted in source frontmatter and follows the host document"),
      unsupported("D3", "tombstone", "relation exit is represented by retired state, not tombstone"),
      unsupported("D4", "hard-delete", "relation records are provenance-bearing and are not physically deleted"),
    ]),
    storageForm: "host_frontmatter",
  },
  session: sessionEntityRegistration,
} as const;

/** Compatibility projection. Nine-kind members derive schema, mutability, and metadata from kind authority. */
export const entityRegistry = {
  decision: derivedFrameworkRegistration<DecisionFieldKey>("decision"),
  task: derivedFrameworkRegistration<TaskFieldKey>("task"),
  fact: derivedFrameworkRegistration<FactFieldKey>("fact"),
  ...frameworkBoundaryRegistrations,
} satisfies EntityRegistryShape;

export const entityRegistryKinds = Object.keys(entityRegistry) as ReadonlyArray<KernelEntityKind>;

export function getEntityRegistration(kind: KernelEntityKind): EntityRegistryShape[typeof kind] {
  return entityRegistry[kind];
}

export { isEntityStorageForm };
