import {
  projectDeclaredRoleBindings,
  roleBindingActorMatches,
  roleBindingExpired,
  type ActorIdentity,
  type PeopleRosterDocumentV1,
  type RoleBinding,
} from "@harness-anything/kernel";
import { loadPeopleRosterIfPresent } from "./people-roster.ts";

/** Read-only projection of authored Person/Role declarations for AuthorizationPort input. */
export function declaredRoleBindingsForActor(
  rootDir: string,
  actor: ActorIdentity,
  roster = loadPeopleRosterIfPresent({ rootDir }),
): readonly RoleBinding[] | undefined {
  if (roster === null) return undefined;
  return declaredRoleBindingsFromRoster(roster, actor, new Date().toISOString());
}

/** The same projection for a roster the caller already holds (for example the writer-cut people document). */
export function declaredRoleBindingsFromRoster(
  roster: Readonly<Pick<PeopleRosterDocumentV1, "people" | "roles" | "bindings">>,
  actor: ActorIdentity,
  evaluatedAt: string,
): readonly RoleBinding[] {
  const person = roster.people.find((candidate) => candidate.personId === actor.principal.personId),
    roleIds = person?.roles ?? [],
    commandClasses = roster.roles
      .filter((role) => roleIds.includes(role.roleId))
      .flatMap((role) => role.commandClasses);
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
