import { type ActionDeclaration } from "./action-declaration.ts";
import type { EntityKindContract } from "./entity-kind-registry.ts";
import type { VerticalDefinition } from "./vertical-definition.ts";

/** The generic artifact CRUD Actions a compiled Artifact kind projects into the declaration space. */
export const artifactActionIds = Object.freeze(["import", "update", "archive", "delete"] as const);
export type ArtifactActionId = (typeof artifactActionIds)[number];

type ProjectedSource = Pick<EntityKindContract, "kind" | "actionCatalog">;

const projectedDeclaration = (kind: string, action: ArtifactActionId): ActionDeclaration =>
  Object.freeze({
    kind: `${kind}/${action}`,
    catalogId: `${kind}/${action}`,
    executionClass: "repo-write" as const,
    policyAction: `${kind}/${action}`,
    policyTier: "contributor" as const,
    residency: Object.freeze({ scope: "canonical" as const, writer: "center-repo-cell" as const }),
    receiptSettlement: "canonical-acceptance" as const,
  });

/**
 * Project one runtime Artifact kind contract into canonical ActionDeclarations. The kind's own
 * action catalog decides which Actions are executable (a retired kind drops `import`), so the
 * declaration set follows the runtime declaration instead of a parallel static list
 * (dec_2446BC2F8C68630F71AE3E3BD7/CH4).
 */
export function projectArtifactActionDeclarations(contracts: readonly ProjectedSource[]): readonly ActionDeclaration[] {
  return Object.freeze(
    contracts.flatMap(({ kind, actionCatalog }) =>
      (actionCatalog?.actions ?? []).flatMap((action) => {
        if (action.execution === null) return [];
        const actionId = action.id as ArtifactActionId;
        return (artifactActionIds as readonly string[]).includes(actionId)
          ? [projectedDeclaration(kind, actionId)]
          : [];
      }),
    ),
  );
}

/**
 * Runtime declaration registry. `compileVerticalContract` registers every compiled Artifact kind,
 * and Policy derivation / the Keycloak adapter read the same set. Registration is idempotent by
 * catalogId because a kind's identity is stable for its lifetime.
 */
const projectedByCatalogId = new Map<string, ActionDeclaration>();

export function registerArtifactActionDeclarations(contracts: readonly ProjectedSource[]): void {
  // Replace each kind's previous projection so an active -> retired transition removes the
  // import scope instead of leaving a stale grantable name (F5 from the re-review).
  const replaced = new Set(contracts.map(({ kind }) => kind));
  for (const catalogId of projectedByCatalogId.keys())
    if (replaced.has(catalogId.slice(0, catalogId.lastIndexOf("/")))) projectedByCatalogId.delete(catalogId);
  for (const declaration of projectArtifactActionDeclarations(contracts))
    projectedByCatalogId.set(declaration.catalogId as string, declaration);
}

export function registeredArtifactActionDeclarations(): readonly ActionDeclaration[] {
  return Object.freeze([...projectedByCatalogId.values()]);
}

export function registeredArtifactActionPolicyActions(): readonly string[] {
  return Object.freeze([...projectedByCatalogId.keys()]);
}

/**
 * Scope inventory from an accepted vertical declaration, without compiling relations. Policy sync
 * runs in a different process from the writer that compiled the runtime registry, so it reads the
 * canonical declaration itself instead of relying on module state.
 */
export function artifactActionPoliciesByKind(
  definition: Pick<VerticalDefinition, "entityKinds">,
): ReadonlyMap<string, readonly string[]> {
  const byKind = new Map<string, readonly string[]>();
  for (const entity of definition.entityKinds) {
    if (entity.entityType !== "artifact") continue;
    const kind = `entity-kind/${entity.kindId}`,
      actions = entity.retired
        ? (["update", "archive", "delete"] as const)
        : (["import", "update", "archive", "delete"] as const);
    byKind.set(kind, Object.freeze(actions.map((action) => `${kind}/${action}`)));
  }
  return byKind;
}

export function artifactActionPolicyActionsForDefinition(
  definition: Pick<VerticalDefinition, "entityKinds">,
): readonly string[] {
  return Object.freeze([...artifactActionPoliciesByKind(definition).values()].flat());
}
