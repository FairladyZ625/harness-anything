import { roleBindingApplies, type EntityRef, type RoleBinding } from "../../kernel/src/index.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

export const repositoryRoleBindingTarget: EntityRef = "settings/repository";

export function withDerivedCommandClass(binding: RepoCellBinding, commandClass: string): RepoCellBinding {
  // Direct RepoCell lifecycle tests historically enter below transport admission. Preserve only
  // the repo-write proof used by execution.start; arbiter/admin authority must arrive as a real
  // transport-derived or declared RoleBinding.
  if (commandClass !== "repo-write") return binding;
  if (bindingHasRole(binding, commandClass)) return binding;
  const derived: RoleBinding = {
    actor: { kind: "person", id: binding.actor.principal.personId },
    role: commandClass,
    target: repositoryRoleBindingTarget,
    source: "derived",
    expiresAt: null,
  };
  return { ...binding, roleBindings: [...(binding.roleBindings ?? []), derived] };
}

export function bindingHasRole(binding: RepoCellBinding, role: string, target = repositoryRoleBindingTarget): boolean {
  return (binding.roleBindings ?? []).some((candidate) => roleBindingApplies(candidate, binding.actor, role, [target]));
}

export function roleBindingAuthorizationContext(binding: RepoCellBinding): {
  readonly roleBindings: readonly RoleBinding[];
  readonly roleBindingTargets: readonly EntityRef[];
} {
  return {
    roleBindings: binding.roleBindings ?? [],
    roleBindingTargets: [repositoryRoleBindingTarget],
  };
}
