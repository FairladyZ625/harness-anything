import type { JsonRpcMethodContract } from "../protocol/method-registry.ts";
import type { AuthenticatedActor, PeopleRoster } from "./types.ts";

export interface AuthorizationFailure {
  readonly ok: false;
  readonly code: "rbac_forbidden" | "command_class_missing";
  readonly message: string;
}

export interface AuthorizationSuccess {
  readonly ok: true;
}

export function authorizeActorForMethod(
  actor: AuthenticatedActor,
  contract: JsonRpcMethodContract,
  roster: PeopleRoster
): AuthorizationSuccess | AuthorizationFailure {
  if (!contract.commandClass) {
    return { ok: false, code: "command_class_missing", message: `Method is missing commandClass: ${contract.method}` };
  }
  if (actor.roles.some((roleId) => roster.roleAllows(roleId, contract.commandClass!))) return { ok: true };
  return {
    ok: false,
    code: "rbac_forbidden",
    message: `Person ${actor.personId} is not authorized for ${contract.commandClass} method ${contract.method}.`
  };
}
