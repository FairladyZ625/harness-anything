import {
  projectDeclaredRoleBindings,
  roleBindingActorMatches,
  roleBindingExpired,
  type ActorIdentity,
  type RoleBinding,
} from "../../../kernel/src/index.ts";
import { loadPeopleRosterIfPresent } from "./people-roster.ts";

/** Read-only projection of authored Person/Role declarations for AuthorizationPort input. */
export function declaredRoleBindingsForActor(
  rootDir: string,
  actor: ActorIdentity,
): readonly RoleBinding[] | undefined {
  const roster = loadPeopleRosterIfPresent({ rootDir });
  if (roster === null) return undefined;
  const person = roster.people.find((candidate) => candidate.personId === actor.principal.personId),
    roleIds = person?.roles ?? [],
    commandClasses = roster.roles
      .filter((role) => roleIds.includes(role.roleId))
      .flatMap((role) => role.commandClasses),
    evaluatedAt = new Date().toISOString();
  return Object.freeze([
    ...projectDeclaredRoleBindings({
      actor,
      roleIds: [...roleIds, ...commandClasses],
      target: "settings/repository",
    }),
    ...roster.bindings.filter(
      (candidate) => roleBindingActorMatches(candidate.actor, actor) && !roleBindingExpired(candidate, evaluatedAt),
    ),
  ]);
}
