import type { PolicyActionRule, PolicyDeclarationV1 } from "./policy.ts";
import { actionDeclarations, type ActionDeclaration } from "./action-declaration.ts";

const policyActionDeclarations = actionDeclarations.filter(
  (declaration): declaration is ActionDeclaration & { readonly policyAction: string } =>
    declaration.policyAction !== null,
);

export const durablePolicyActions = Object.freeze(policyActionDeclarations.map(({ policyAction }) => policyAction));

/** The roster role standing in for each policy tier until the roster stops granting authority. */
const tierRole = Object.freeze({ contributor: "repo-write", maintainer: "arbiter", admin: "admin" } as const);

const ruleForDeclaration = (declaration: (typeof policyActionDeclarations)[number]): PolicyActionRule => ({
  action: declaration.policyAction,
  anyOf: [
    { allOf: [{ predicate: "hasRoleBinding", role: tierRole[declaration.policyTier] }] },
    { allOf: [{ predicate: "hasRoleBinding", role: "owner" }] },
    { allOf: [{ predicate: "hasDefaultBinding" }] },
  ],
});

/** The single built-in policy package consumed by the kernel AuthorizationPort. */
const defaultPolicyDeclaration = {
  schema: "policy/v1",
  id: "default",
  version: 5,
  predicates: Object.freeze([
    { predicate: "hasRoleBinding", role: "repo-write" },
    { predicate: "hasRoleBinding", role: "arbiter" },
    { predicate: "hasRoleBinding", role: "admin" },
    { predicate: "hasRoleBinding", role: "owner" },
    { predicate: "hasDefaultBinding" },
  ]),
  actions: durablePolicyActions,
  rules: Object.freeze(policyActionDeclarations.map(ruleForDeclaration)),
} satisfies PolicyDeclarationV1;

export const DEFAULT_POLICY: PolicyDeclarationV1 = Object.freeze(defaultPolicyDeclaration);

export const defaultPolicy = DEFAULT_POLICY;
