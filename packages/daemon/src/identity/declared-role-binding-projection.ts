import {
  projectDeclaredRoleBindings,
  roleBindingActorMatches,
  roleBindingExpired,
  type ActorIdentity,
  type RoleBinding,
} from "../../../kernel/src/index.ts";
import { loadPeopleRoster } from "./people-roster.ts";

/** Read-only projection of authored Person/Role declarations for AuthorizationPort input. */
export function declaredRoleBindingsForActor(rootDir: string, actor: ActorIdentity): readonly RoleBinding[] {
  const roster = loadPeopleRoster({ rootDir }),
    person = roster.people.find((candidate) => candidate.personId === actor.principal.personId),
    evaluatedAt = new Date().toISOString();
  return Object.freeze([
    ...projectDeclaredRoleBindings({
      actor,
      roleIds: person?.roles ?? [],
      target: "settings/repository",
    }),
    ...roster.bindings.filter(
      (candidate) => roleBindingActorMatches(candidate.actor, actor) && !roleBindingExpired(candidate, evaluatedAt),
    ),
  ]);
}
