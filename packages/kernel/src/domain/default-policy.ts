import type { PolicyActionRule, PolicyDeclarationV1 } from "./policy.ts";
import { actionDeclarations, type ActionDeclaration } from "./action-declaration.ts";

const policyActionDeclarations = actionDeclarations.filter(
  (declaration): declaration is ActionDeclaration & { readonly policyAction: string } =>
    declaration.policyAction !== null,
);

export const durablePolicyActions = Object.freeze(policyActionDeclarations.map(({ policyAction }) => policyAction));

const roleRule = (
  action: string,
  role: string,
  defaultBindingAllowed: boolean,
  assignmentAllowed: boolean,
): PolicyActionRule => ({
  action,
  anyOf: [
    { allOf: [{ predicate: "hasRoleBinding", role }] },
    { allOf: [{ predicate: "hasRoleBinding", role: "owner" }] },
    ...(defaultBindingAllowed ? [{ allOf: [{ predicate: "hasDefaultBinding" as const }] }] : []),
    ...(assignmentAllowed ? [{ allOf: [{ predicate: "hasAssignmentBinding" as const }] }] : []),
  ],
});

const ruleForDeclaration = (declaration: (typeof policyActionDeclarations)[number]): PolicyActionRule => {
  if (declaration.executionClass === "repo-write") return roleRule(declaration.policyAction, "repo-write", true, true);
  if (declaration.executionClass === "arbiter") return roleRule(declaration.policyAction, "arbiter", true, false);
  return roleRule(declaration.policyAction, "admin", true, false);
};

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
    { predicate: "hasAssignmentBinding" },
  ]),
  actions: durablePolicyActions,
  rules: Object.freeze(policyActionDeclarations.map(ruleForDeclaration)),
} satisfies PolicyDeclarationV1;

export const DEFAULT_POLICY: PolicyDeclarationV1 = Object.freeze(defaultPolicyDeclaration);

export const defaultPolicy = DEFAULT_POLICY;
