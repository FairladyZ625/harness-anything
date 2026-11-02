import { actionDeclarations, actionPresentation, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import type { AuthorizationProvider } from "@harness-anything/kernel";

/** Policy groups are metadata, not a local authorization evaluator. Grants remain in the authority. */
export async function readPolicyMetadata(input: {
  readonly provider: AuthorizationProvider;
  readonly accessToken: string;
}) {
  const groups = await input.provider.readPolicyGroups(input.accessToken);
  return {
    schema: "policy-metadata/v1" as const,
    ok: true as const,
    groups: groups.map((group) => ({
      ...group,
      effectiveScopes: effectivePolicyGroupScopes(groups, group.id),
    })),
    actions: actionDeclarations.map((declaration) => ({
      action: declaration.policyAction,
      presentation: actionPresentation[declaration.kind as keyof typeof actionPresentation],
      executionClass: declaration.executionClass,
      policyTier: declaration.policyTier,
      residencyScope: declaration.residency.scope,
    })),
  };
}
