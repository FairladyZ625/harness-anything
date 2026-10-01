import { actionDeclarations, type ActionDeclaration, type ActionPolicyTier } from "./action-declaration.ts";
import { parseEntityRef, type EntityRef } from "./entity-ref.ts";

export const basePolicyGroupIds = Object.freeze(["viewer", "contributor", "maintainer", "admin"] as const);
export type BasePolicyGroupId = (typeof basePolicyGroupIds)[number];

export interface PolicyGroup {
  readonly id: string;
  readonly base: boolean;
  readonly scopes: readonly string[];
  readonly composites: readonly string[];
}

const tierRank: Readonly<Record<ActionPolicyTier, number>> = Object.freeze({ contributor: 1, maintainer: 2, admin: 3 });

/** Base groups contain only their minimum tier; effective membership comes from composite inheritance. */
export function deriveBasePolicyGroups(
  declarations: readonly ActionDeclaration[] = actionDeclarations,
): readonly PolicyGroup[] {
  for (const declaration of declarations) {
    if (!Object.hasOwn(tierRank, declaration.policyTier))
      throw new Error(`Action ${declaration.kind} has unknown policy tier ${String(declaration.policyTier)}.`);
    if (declaration.policyAction !== declaration.kind)
      throw new Error(`Action ${declaration.kind} must use its kind as the Keycloak scope.`);
  }
  const exactScopes = (tier: ActionPolicyTier) =>
    Object.freeze(
      declarations
        .filter((item) => item.policyTier === tier)
        .map((item) => item.policyAction)
        .sort(),
    );
  return Object.freeze([
    Object.freeze({ id: "viewer", base: true, scopes: Object.freeze([]), composites: Object.freeze([]) }),
    Object.freeze({
      id: "contributor",
      base: true,
      scopes: exactScopes("contributor"),
      composites: Object.freeze(["viewer"]),
    }),
    Object.freeze({
      id: "maintainer",
      base: true,
      scopes: exactScopes("maintainer"),
      composites: Object.freeze(["contributor"]),
    }),
    Object.freeze({ id: "admin", base: true, scopes: exactScopes("admin"), composites: Object.freeze(["maintainer"]) }),
  ]);
}

export function minimumBasePolicyGroup(declaration: ActionDeclaration): Exclude<BasePolicyGroupId, "viewer"> {
  return declaration.policyTier;
}

export function effectivePolicyGroupScopes(groups: readonly PolicyGroup[], groupId: string): readonly string[] {
  assertAcyclicPolicyGroups(groups);
  const byId = new Map(groups.map((group) => [group.id, group] as const)),
    visited = new Set<string>(),
    scopes = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const group = byId.get(id);
    if (!group) throw new Error(`Unknown policy group ${id}.`);
    visited.add(id);
    for (const scope of group.scopes) scopes.add(scope);
    for (const composite of group.composites) visit(composite);
  };
  visit(groupId);
  return Object.freeze([...scopes].sort());
}

export function assertAcyclicPolicyGroups(groups: readonly PolicyGroup[]): void {
  const byId = new Map(groups.map((group) => [group.id, group] as const));
  if (byId.size !== groups.length) throw new Error("Policy group ids must be unique.");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Policy group inheritance cycle contains ${id}.`);
    if (visited.has(id)) return;
    const group = byId.get(id);
    if (!group) throw new Error(`Unknown policy group ${id}.`);
    visiting.add(id);
    for (const composite of group.composites) visit(composite);
    visiting.delete(id);
    visited.add(id);
  };
  for (const group of groups) visit(group.id);
}

export type AuthorizationResource =
  | { readonly kind: "repository"; readonly repoId: string }
  | { readonly kind: "entity"; readonly repoId: string; readonly entityRef: EntityRef };

export function encodeAuthorizationResource(resource: AuthorizationResource): string {
  return resource.kind === "repository" ? resource.repoId : `${resource.repoId}:${resource.entityRef}`;
}

export function decodeAuthorizationResource(value: string): AuthorizationResource {
  const separator = value.indexOf(":");
  if (separator < 0) {
    if (!value) throw new Error("Repository authorization resource must be non-empty.");
    return Object.freeze({ kind: "repository", repoId: value });
  }
  const repoId = value.slice(0, separator),
    entityRef = value.slice(separator + 1);
  if (!repoId || !entityRef) throw new Error("Entity authorization resource must contain repoId and EntityRef.");
  if (parseEntityRef(entityRef) === null) throw new Error(`Invalid authorization EntityRef ${entityRef}.`);
  return Object.freeze({ kind: "entity", repoId, entityRef });
}

export function tierIncludes(group: BasePolicyGroupId, tier: ActionPolicyTier): boolean {
  return group !== "viewer" && tierRank[tier] <= tierRank[group];
}
