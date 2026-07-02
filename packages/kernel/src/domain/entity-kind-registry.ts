import type { VerticalDefinition } from "../schemas/registry.ts";

export type EntityKindDeclaration = VerticalDefinition["entityKinds"][number];
export type EntityPackageScaffold = VerticalDefinition["packageScaffolds"][number];
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

export function createEntityKindRegistry(vertical: VerticalDefinition): EntityKindRegistry {
  const packageScaffolds = new Map(vertical.packageScaffolds.map((scaffold) => [scaffold.entityKind, scaffold]));
  const repositoryRoots = new Map(vertical.repositoryScaffold.entityRoots.map((root) => [root.entityKind, root]));
  const entries = vertical.entityKinds.map((entity): EntityKindRegistration => ({
    id: entity.id,
    entityType: entity.entityType,
    contractEntity: entity.contractEntity,
    ...(entity.entityType === "lifecycle" ? { packageKind: entity.packageKind } : { schemaRef: entity.schemaRef }),
    ...(packageScaffolds.get(entity.id) ? { packageScaffold: packageScaffolds.get(entity.id) } : {}),
    ...(repositoryRoots.get(entity.id) ? { repositoryRoot: repositoryRoots.get(entity.id) } : {})
  }));
  return {
    ids: entries.map((entry) => entry.id),
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry]))
  };
}

export function getEntityKind(registry: EntityKindRegistry, entityKind: string): EntityKindRegistration | undefined {
  return registry.byId.get(entityKind);
}
