import type { ActorIdentity, RoleBinding } from "@harness-anything/kernel";

export function withRoleBinding<
  T extends {
    readonly actor: ActorIdentity;
    readonly roleBindings?: readonly RoleBinding[];
  },
>(binding: T, role: string): T & { readonly roleBindings: readonly RoleBinding[] } {
  return {
    ...binding,
    roleBindings: [
      ...(binding.roleBindings ?? []),
      {
        actor: { kind: "person", id: binding.actor.principal.personId },
        role,
        target: "settings/repository",
        source: "declared",
        expiresAt: null,
      },
    ],
  };
}
