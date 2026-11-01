import { type ActionDeclaration } from "./action-declaration.ts";
import type { EntityKindContract } from "./entity-kind-registry.ts";

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
  for (const declaration of projectArtifactActionDeclarations(contracts))
    projectedByCatalogId.set(declaration.catalogId as string, declaration);
}

export function registeredArtifactActionDeclarations(): readonly ActionDeclaration[] {
  return Object.freeze([...projectedByCatalogId.values()]);
}

export function registeredArtifactActionPolicyActions(): readonly string[] {
  return Object.freeze([...projectedByCatalogId.keys()]);
}
