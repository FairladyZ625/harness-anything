import type { ActorIdentity } from "./actor-identity.ts";
import type { EntityRef } from "./entity-ref.ts";
import type { RoleBinding } from "./role-binding.ts";

/** The non-transferable owner role is derived from the creator's principal axis. */
export function deriveOwnerRoleBinding(createdBy: ActorIdentity, target: EntityRef): RoleBinding {
  const binding: RoleBinding = {
    actor: { kind: "person", id: createdBy.principal.personId },
    role: "owner",
    target,
    source: "derived",
    expiresAt: null,
  };
  return Object.freeze(binding);
}
